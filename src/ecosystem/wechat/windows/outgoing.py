"""Validate and snapshot ordered outbound messages before anything is sent."""
import hashlib
import json
import shutil
from pathlib import Path
from snapshot import NotSent


def serverConfirmed(row):
    return int(row.get('server_id') or 0) > 0


def mediaDigestMatches(row, digest, raw=None):
    # get_messages already decodes WeChat's compressed XML; raw content may be Zstandard bytes.
    values = [row.get('content'), *(raw or {}).values()]
    data = b' '.join(value if isinstance(value, bytes) else value.encode('utf-8')
                     for value in values if isinstance(value, (str, bytes)))
    return digest.encode('ascii') in data.lower() or bytes.fromhex(digest) in data


def prepareMessages(messages, config, stateDir):
    if not isinstance(messages, list) or not 1 <= len(messages) <= 16:
        raise ValueError('每次回复需要 1–16 条消息')
    prepared = []
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError('消息必须是对象')
        kind = message.get('type')
        if kind == 'text':
            text = message.get('text')
            if not isinstance(text, str) or not text.strip() or '\0' in text or len(text.encode('utf-8')) >= 4095:
                raise ValueError('每条文字需要 1–4094 UTF-8 字节')
            prepared.append(dict(type=kind, text=text))
            continue
        if kind not in ('image', 'sticker'):
            raise ValueError('只支持文字、图片和表情包')
        if kind == 'sticker' and message.get('stickerId'):
            root = (Path(config['moduleFile']).parent / 'stickers').resolve()
            try: stickers = json.loads((root / 'index.json').read_text(encoding='utf-8-sig'))['stickers']
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise ValueError('表情库还没有可用的索引') from error
            sticker = next((sticker for sticker in stickers if sticker.get('id') == message['stickerId']), None)
            if not sticker:
                raise ValueError('表情包 ID 不在表情库中，请先用 sticker_search 查')
            path = (root / 'files' / str(sticker.get('file'))).resolve()
            if not path.is_relative_to(root / 'files'):
                raise ValueError('表情包路径越界')
        else:
            if not isinstance(message.get('path'), str) or not Path(message['path']).is_absolute():
                raise ValueError('媒体需要绝对文件路径')
            path = Path(message['path']).resolve()
            roots = [Path(root).resolve() for root in config.get('mediaRoots', [])]
            if not any(path.is_relative_to(root) for root in roots):
                raise ValueError('媒体不在允许发送的目录里')
        if not path.is_file() or not 0 < path.stat().st_size <= 10 * 1024 * 1024:
            raise ValueError('媒体需要是 10MB 以内的本地文件')
        from PIL import Image
        outputDir = stateDir / 'outgoing'
        outputDir.mkdir(parents=True, exist_ok=True)
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        with Image.open(path) as image:
            if image.format not in ('PNG', 'JPEG', 'WEBP', 'GIF') or image.width <= 0 or image.height <= 0:
                raise ValueError('媒体格式不支持')
            extension = '.gif' if kind == 'sticker' else '.png'
            snapshot = outputDir / (digest + extension)
            if kind == 'sticker':
                if max(image.size) > 1024:
                    raise ValueError('表情包尺寸不能超过 1024')
                if image.format == 'GIF':
                    shutil.copyfile(path, snapshot)
                else:
                    frames = []
                    durations = []
                    for index in range(getattr(image, 'n_frames', 1)):
                        if (index + 1) * image.width * image.height > 64_000_000:
                            raise ValueError('动画解码体积过大，请选择更短的表情')
                        image.seek(index)
                        frames.append(image.convert('RGBA'))
                        durations.append(image.info.get('duration', 100))
                    frames[0].save(snapshot, format='GIF', save_all=True, append_images=frames[1:], duration=durations, loop=0)
                if snapshot.stat().st_size > 1024 * 1024:
                    raise ValueError('转换后的表情包超过 1MB，请换图片发送')
            else:
                image.convert('RGBA').save(snapshot, format='PNG')
        prepared.append(dict(type=kind, path=str(snapshot)))
    return prepared


def blankFrame(frame):
    """Nothing to see: fully transparent, or a single flat colour (many stickers fade in from one)."""
    if frame.getchannel('A').point(lambda alpha: 255 if alpha > 16 else 0).getbbox() is None:
        return True
    return frame.convert('RGB').getcolors(maxcolors=1) is not None


def stillSticker(path):
    """A GIF sticker as one still PNG beside it, for a WeChat build that cannot send stickers: its first frame, or the
    last when the first is blank."""
    from PIL import Image
    still = Path(path).with_suffix('.still.png')
    with Image.open(path) as image:
        frame = image.convert('RGBA')
        if blankFrame(frame) and getattr(image, 'n_frames', 1) > 1:
            image.seek(image.n_frames - 1)
            frame = image.convert('RGBA')
        frame.save(still, format='PNG')
    return str(still)


def deliverMessages(messages, send, confirmed=None):
    for index, message in enumerate(messages):
        try:
            send(message)
        except NotSent:
            # Nothing of this reply has reached WeChat yet, so the whole job may be tried again; once an earlier
            # message went out, a later one that did not start is part of a half-sent reply and stays uncertain.
            if index == 0: raise
            raise RuntimeError(f'第 {index+1}/{len(messages)} 条发送未开始；停止整批，不重发已处理消息')
        except Exception as error:
            raise RuntimeError(f'第 {index+1}/{len(messages)} 条发送未确认；停止整批，不重发已处理消息：{error}') from error
        if confirmed:
            confirmed(index + 1)
