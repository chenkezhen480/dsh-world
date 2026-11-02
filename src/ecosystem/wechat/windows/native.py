"""Account-scoped use of the pinned dependency; no automatic account selection."""
import json
import os
import time
from pathlib import Path
from snapshot import NotSent, SnapshotBusy, SnapshotTimeout, checkedSnapshot, fileStamp, hasCurrentWalFrames
from binding import findAccountProcess, checkAccountProcess, WechatOffline


def connect(config, stateDir):
    import psutil
    from wechatauto.db import WeChatDB
    from wechatauto.param import WxParam
    WxParam.ENABLE_FILE_LOGGER = False

    root = Path(config['dbDir']).resolve()
    account = config['account']
    process = findAccountProcess(config)
    config = {**config, 'processId': process.pid}
    started = process.create_time()

    def checkProcess():
        try:
            checkAccountProcess(psutil.Process(config['processId']), config, started)
        except (psutil.NoSuchProcess, psutil.ZombieProcess) as error:
            raise WechatOffline('原微信进程已退出') from error

    checkProcess()

    class ScopedDatabase(WeChatDB):
        def _merge_wal(self, dst, wal_path, key, from_frame):
            # The dependency rewrites the page count even when every WAL frame is obsolete.
            if not hasCurrentWalFrames(self, wal_path):
                return 0
            return super()._merge_wal(dst, wal_path, key, from_frame)

        def _open_unlocked(self, rel):
            checkProcess()
            try:
                return checkedSnapshot(self, rel, super()._open_unlocked)
            except Exception:
                checkProcess()
                raise

        def _warn_once(self, key, message, *args):
            if key[0] == 'shard':
                raise RuntimeError('消息分片读取不完整，停止且不推进消息位置')
            return super()._warn_once(key, message, *args)

        def _refresh_db_files(self):
            list((Path(self.account_dir) / 'db_storage' / 'message').iterdir())
            super()._refresh_db_files()
            if self.unkeyed:
                raise RuntimeError('新增数据库密钥不完整，请重新绑定')

        def get_messages(self, user, limit=20, offset=0):
            checkProcess()
            def versions():
                return [(rel, fileStamp(self._db_path(rel)), fileStamp(wal) if (wal := self._wal_path(rel)) else None)
                        for rel in self._message_dbs()]
            try:
                before = versions()
                rows = super().get_messages(user, limit, offset)
                if not before or before != versions():
                    raise SnapshotBusy('读取期间消息分片发生变化，本轮不推进消息位置')
                return rows
            except Exception:
                checkProcess()
                raise

        def _auto_diagnose_key_failure(self, rel):
            raise RuntimeError('她的账号数据库密钥校验失败，请重新绑定；不扫描其他账号')

        def _collect_db_files(self):
            return [(rel, path, size) for rel, path, size in super()._collect_db_files()
                    if rel.replace('\\', '/').startswith(('contact/', 'message/', 'session/'))]

        def _find_weixin_pids(self):
            checkProcess()
            return [config['processId']]

        def _load_or_extract_keys(self, master_key=None):
            self.master_key = self.cfg_dword = None
            path = Path(self.keys_file)
            if path.is_file():
                self._keys = {name: bytes.fromhex(value) for name, value in json.loads(path.read_text(encoding='utf-8')).items()}
            self._keys = {name: key for name, key in self._keys.items() if self._key_works(name)}
            if any(not self._key_works(name) for name, _, _ in self._db_files):
                self._keys.update(self.extract_keys())
            missing = [name for name, _, _ in self._db_files if not self._key_works(name)]
            self.unkeyed = missing
            if missing:
                raise RuntimeError('她的账号数据库密钥不完整；不改选其他账号')
            self._save_keys()

        def _save_keys(self):
            if not self._keys:
                return
            path = Path(self.keys_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix('.tmp')
            with temporary.open('w', encoding='utf-8') as stream:
                json.dump({name: key.hex() for name, key in self._keys.items()}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)

    try:
        database = ScopedDatabase(db_dir=str(root), account=account, workdir=str(stateDir / 'decrypted'), keys_file=str(stateDir / 'keys.json'))
    except Exception:
        checkProcess()
        raise
    if database.account != account or database.wxid != config['selfId']:
        raise RuntimeError('账号标识与配置不符')
    from incoming import IncomingImages
    images = IncomingImages(database, config, checkProcess)
    database.readImage = images.read
    database.readSticker = images.readSticker
    database.readReference = images.readReference

    sender = None
    def getSender():
        nonlocal sender
        if sender is None:
            from sender import NativeSender
            sender = NativeSender(config, checkProcess)
        return sender

    def close():
        nonlocal sender
        if sender is not None:
            sender.close()
            sender = None

    def send(chat, item):
        import hashlib
        from outgoing import mediaDigestMatches, serverConfirmed, stillSticker
        from sender import sendsStickers
        checkProcess()
        item = dict(type='text', text=item) if isinstance(item, str) else item
        if item['type'] == 'sticker' and not sendsStickers(getSender().profile):
            item = dict(type='image', path=stillSticker(item['path']))
        kind = {'text': 1, 'image': 2, 'sticker': 3}[item['type']]
        value = item['text'] if kind == 1 else item['path']
        def stableRows(deadline):
            while time.monotonic() < deadline:
                try:
                    return database.get_messages(chat['id'], limit=50)
                except SnapshotBusy:
                    time.sleep(0.2)
            raise SnapshotTimeout('未能获取稳定的目标聊天快照，请人工核对本次发送')
        try: before = {(row['shard'], row['local_id']) for row in stableRows(time.monotonic() + 20)}
        except SnapshotTimeout as error: raise NotSent(str(error)) from error  # nothing has been sent yet
        getSender().send(chat['id'], kind, value)
        digest = None
        if kind != 1:
            with open(value, 'rb') as stream:
                digest = hashlib.file_digest(stream, 'md5').hexdigest()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            checkProcess()
            rows = stableRows(deadline)
            for row in rows:
                if (row['shard'], row['local_id']) in before or row.get('sender_username') != config['selfId']:
                    continue
                if row['type'] != {1: '文本', 2: '图片', 3: '动画表情'}[kind]:
                    continue
                raw = database.get_message_row(chat['id'], row['local_id'], shard=row['shard'])
                if raw is None or not serverConfirmed(raw):
                    continue
                # WeChatDB strips text on read; normalize only the comparison, never the sent value.
                if (kind == 1 and str(row['content']) == value.strip()) or (kind != 1 and mediaDigestMatches(row, digest, raw)):
                    return
            time.sleep(0.5)
        raise RuntimeError('原生操作已提交但目标聊天尚未确认，需人工核对；不自动重发')

    def probe():
        nativeSender = getSender()
        return dict(version=nativeSender.profile['version'], **nativeSender.send(config['chats'][0]['id'], 0))

    send.probe = probe
    send.close = close
    send.processId = config['processId']
    return database, send
