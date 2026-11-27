"""Read-only group history; cursors identify the oldest returned row, not a shifting offset."""
import base64
import hashlib
import json
from pathlib import Path
from messages import MAX_CONTEXT_BYTES, displayMessage, hasSender, messageEntry, messageNormalizer, recentEntries
from incoming import ImageUnavailable
from quotes import isAppMessage
from stickers import StickerUnavailable, fetchSticker, stickerKind


def readHistoryImage(database, config, request, chat):
    """One picture of a configured group, named by the message ID that `readHistory` returned for it."""
    imageId = request['imageId']
    shard, _, localId = imageId.rpartition(':') if isinstance(imageId, str) and len(imageId) <= 256 else ('', '', '')
    if not shard or not localId.isdigit():
        raise ValueError('图片消息 ID 无效')
    raw = database.get_message_row(chat['id'], int(localId), local_type=3, shard=shard)
    if not raw or (raw.get('local_type') or 0) & 0xffffffff != 3:
        raise ValueError('这个 ID 不是本群里的图片消息')
    row = dict(local_id=int(localId), shard=shard, sort_seq=int(raw.get('sort_seq') or 0), create_time=int(raw.get('create_time') or 0),
               sender_username=raw.get('sender_username'), type='图片', content='【群图片】')
    message = displayMessage({**row, 'type': '文本'}, messageNormalizer(database, chat, config))
    if not message:
        raise ValueError('这张图片的消息无法显示')
    entry = messageEntry(row, message)
    try: entry['image'] = database.readImage(chat['id'], row)
    except ImageUnavailable as error: raise ValueError(f'图片未读取：{error}') from error
    return dict(messages=[entry])


def saveReceivedSticker(database, config, request):
    """Fetch the original of a sticker someone sent (private or group) and stage it for the host's sticker library."""
    chatId, accountId = request.get('chatId'), request.get('accountId')
    if accountId != config['selfId'] or not any(chat['id'] == chatId for chat in config['chats']):
        raise ValueError('读取目标不属于绑定账号的已配置聊天')
    if not config.get('fetchStickers', True):
        raise ValueError('未开启表情包下载（fetchStickers 为 false）')
    messageId = request['stickerId']
    shard, _, localId = messageId.rpartition(':') if isinstance(messageId, str) and len(messageId) <= 256 else ('', '', '')
    if not shard or not localId.isdigit():
        raise ValueError('表情包消息 ID 无效')
    raw = database.get_message_row(chatId, int(localId), shard=shard)
    if not raw or (raw.get('local_type') or 0) & 0xffffffff not in (47, 11000):
        raise ValueError('这个 ID 不是聊天里的表情包消息')
    try:
        data = fetchSticker(raw['content'])
        extension, mediaType = stickerKind(data)
    except StickerUnavailable as error:
        raise ValueError(str(error)) from error
    digest = hashlib.md5(data).hexdigest()
    staging = Path(config['moduleFile']).parent / 'stickers' / 'incoming'
    staging.mkdir(parents=True, exist_ok=True)
    name = f'{digest}.{extension}'
    (staging / name).write_bytes(data)
    return dict(sticker=dict(md5=digest, file=name, mediaType=mediaType, bytes=len(data)))


def readHistory(database, config, request):
    if 'stickerId' in request:
        return saveReceivedSticker(database, config, request)
    chatId, accountId = request.get('chatId'), request.get('accountId')
    chat = next((chat for chat in config['chats'] if chat['id'] == chatId), None)
    if accountId != config['selfId'] or not chat or not chatId.endswith('@chatroom'):
        raise ValueError('读取目标不属于绑定账号的已配置群聊')
    if 'imageId' in request:
        return readHistoryImage(database, config, request, chat)
    limit = request.get('limit', 10)
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError('群消息分页数量必须为 1–20')
    boundary = None
    if 'cursor' in request:
        try:
            cursor = request['cursor']
            if not isinstance(cursor, str) or not cursor or len(cursor) > 1024: raise ValueError()
            value = json.loads(base64.b64decode(cursor, altchars=b'-_', validate=True))
            if not isinstance(value, list) or len(value) != 5 or value[:2] != [accountId, chatId]: raise ValueError()
            seq, shard, localId = value[2:]
            if type(seq) is not int or type(localId) is not int or not isinstance(shard, str) or not shard: raise ValueError()
            boundary = seq, shard, localId
        except (ValueError, TypeError, UnicodeError) as error:
            raise ValueError('群消息游标无效或不属于当前账号和群聊') from error
    normalize = messageNormalizer(database, chat, config)
    observed = {}
    def historyEntry(row):
        if row['type'] == '系统消息' or not hasSender(row): return None
        text = str(row['content'])
        if row['type'] == '图片': text = '【图片，未读取；要看请调用 wechat_image，messageId 用本条的 id】'
        elif row['type'] == '动画表情': text = '【表情包，未读取；想收进表情库就调用 sticker_save，messageId 用本条的 id】'
        elif row['type'] != '文本' and not isAppMessage(row): text = f"【{row['type']}，未读取内容】"
        elif len(text) > 2000: text = '【文本超过 2000 字，未读取正文】'
        message = displayMessage(row, normalize) if isAppMessage(row) else normalize({**row, 'type': '文本', 'content': text}, includeSelf=True)
        if not message and isAppMessage(row):
            message = normalize({**row, 'type': '文本', 'content': f"【{row['type']}，未读取内容】"}, includeSelf=True)
        if not message: return None
        observed[(int(row['sort_seq']), row['shard'], int(row['local_id']))] = {
            key: row[key] for key in ('sort_seq', 'shard', 'local_id', 'create_time', 'sender_username', 'type')}
        return messageEntry(row, message)
    found = recentEntries(database, chatId, historyEntry, config.get('pageSize', 50), limit + 1, before=boundary)
    keys = list(reversed(found))
    selected = []
    for key in keys[:limit]:
        if len(json.dumps([found[item] for item in reversed(selected + [key])], ensure_ascii=False).encode('utf-8')) > MAX_CONTEXT_BYTES: break
        selected.append(key)
    if keys and not selected: raise ValueError('单条群消息超出读取容量')
    result = dict(messages=[found[key] for key in reversed(selected)])
    if selected and 'cursor' not in request:
        result['readThrough'] = list(selected[0])
        result['readRows'] = [observed[key] for key in sorted(observed) if key[0] == selected[0][0] and key <= selected[0]]
    if len(keys) > len(selected):
        result['nextCursor'] = base64.urlsafe_b64encode(json.dumps([accountId, chatId, *selected[-1]], ensure_ascii=False).encode('utf-8')).decode('ascii')
    return result
