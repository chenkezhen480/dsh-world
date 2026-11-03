"""Windows adapter for the independent dsh-world WeChat module."""
import argparse
from contextlib import contextmanager
from http.client import IncompleteRead
import json
import sqlite3
import sys
import time
from concurrent.futures import Future
from threading import Thread
from pathlib import Path
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from outgoing import deliverMessages, prepareMessages
from snapshot import NotSent, SnapshotBusy
from groups import DEFAULT_CONTEXT_MESSAGES, mentionedIds, recentContext
from incoming import ImageUnavailable, admitReference
from binding import WechatOffline
from sender import BuildStale
from messages import messageKey, messageOrder, normalizeMessage, messageNormalizer, messageEntry, displayMessage
from quotes import MessageContentError, isAppMessage
from reading import readHistory
from presence import GroupPresence, seedPresence, speakerName, unreadAfter
from datetime import datetime, timezone

BUFFER_SECONDS = 3
BUFFER_POLL_SECONDS = 0.1
MAX_BUFFER_SECONDS = 30
MAX_BATCH_ROWS = 16
MAX_PRIVATE_IMAGES = 2
CONTROL_TIMEOUT_SECONDS = 5
REPLY_TIMEOUT_SECONDS = 190
# Exit code for "a person must check WeChat and run acknowledge"; the plugin stops restarting the adapter on it.
EXIT_NEEDS_HUMAN = 2
# Exit code for "the native bridge must be built again"; the plugin builds it and starts the adapter again.
EXIT_NEEDS_BUILD = 3
# A reply whose send never started (no stable snapshot of the chat) is handed out again this many times in all.
SEND_ATTEMPTS = 3


class NeedsHuman(RuntimeError):
    pass


def pendingText(chatId, key):
    return f'上次消息结果尚未确认：{chatId} / {key}。核对家和微信后使用 acknowledge，不自动重发。'


class HomeRequestError(RuntimeError):
    pass


@contextmanager
def exclusiveRun(directory):
    import msvcrt
    stream = (directory / 'runtime.lock').open('a+b')
    try:
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError('此账号已有微信适配器在运行，不能同时操作') from error
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
    finally:
        stream.close()


def validateConfig(config, requireChats=True):
    for name in ('account', 'selfId', 'dbDir', 'moduleFile'):
        if not isinstance(config.get(name), str) or not config[name].strip():
            raise ValueError(f'请先配置 {name}')
    if any(c in config['account'] for c in '/\\:') or config['account'] in ('.', '..'):
        raise ValueError('account 必须是明确的账号目录名')
    if 'processId' in config and (type(config['processId']) is not int or config['processId'] <= 0):
        raise ValueError('旧 processId 配置必须为正整数；可删除此字段，由绑定账号自动识别进程')
    chats = config.get('chats')
    if not isinstance(chats, list) or (requireChats and not chats):
        raise ValueError('请显式选择至少一个聊天')
    if any(not isinstance(chat, dict) or not chat.get('id') or not chat.get('name') for chat in chats):
        raise ValueError('聊天需要稳定 id 和明确 name')
    if len({chat['id'] for chat in chats}) != len(chats):
        raise ValueError('聊天 id 不能重复')
    if any(chat['id'].endswith('@chatroom') and chat.get('trigger') != 'mention' for chat in chats):
        raise ValueError('群聊需要显式配置 trigger: mention')
    if not 1 <= config.get('pageSize', 50) <= 100:
        raise ValueError('pageSize 应在 1–100 之间')
    if not 0.5 <= config.get('pollSeconds', 2) <= 60:
        raise ValueError('pollSeconds 应在 0.5–60 之间')
    if 'mediaRoots' in config and (not isinstance(config['mediaRoots'], list) or any(not isinstance(root, str) or not Path(root).is_absolute() for root in config['mediaRoots'])):
        raise ValueError('mediaRoots 需要绝对目录数组')
    return config


def newMessages(database, chatId, sinceSeq, pageSize):
    found = {}
    offset = 0
    while True:
        page = database.get_messages(chatId, limit=pageSize, offset=offset)
        for row in page:
            if int(row['sort_seq']) >= sinceSeq:
                found[messageKey(row)] = row
        if len(page) < pageSize or any(int(row['sort_seq']) < sinceSeq for row in page):
            break
        offset += len(page)
    return sorted(found.values(), key=messageOrder)


def followingRows(chat, first, candidates, store):
    """What the sender of `first` added after it that can join its request, and whether nothing more can (someone else
    spoke, a message that goes on its own, or a limit was reached)."""
    group = chat['id'].endswith('@chatroom')
    rows, images, length = [], int(first['type'] == '图片'), len(str(first['content'])) if first['type'] == '文本' else 0
    for row in candidates:
        if messageOrder(row) <= messageOrder(first) or store.seen(chat['id'], messageKey(row)):
            continue
        if row.get('sender_username') != first.get('sender_username') or row['type'] not in (('文本',) if group else ('文本', '图片')) or len(rows) + 1 == MAX_BATCH_ROWS:
            return rows, True
        if row['type'] == '图片':
            if images == MAX_PRIVATE_IMAGES: return rows, True
            images += 1
        else:
            text = str(row['content'])
            # Merged, the request still has to fit the home's 2000-character limit.
            if not text.strip() or length + len(text) + 1 > 2000: return rows, True
            length += len(text) + 1
        rows.append(row)
    return rows, False


def mergeFollowing(database, chat, config, message, rows):
    """Adds what `bufferMessages` gathered to the request of the first message: texts in order, pictures as media."""
    group = chat['id'].endswith('@chatroom')
    # A later group line does not call her itself, so it is read as plain text; the request keeps the identity that did.
    normalize = messageNormalizer(database, chat, config) if group else None
    for row in rows:
        extra = normalize(row) if group else incomingMessage(database, chat, row, config)
        if extra is None: raise RuntimeError('接收批次包含无法识别的消息')
        if extra['text']:
            message['text'] = '\n'.join(text for text in (message['text'], extra['text']) if text)
            if not group: message['identity'] = extra['identity']
        if extra.get('media'): message.setdefault('media', []).extend(extra['media'])


def bufferMessages(config, database, store, chat, first, *, clock=None, sleep=None):
    """Waits until the sender of `first` has been quiet for the buffer time, each new message of theirs starting the wait
    again, so a thought typed as several messages reaches her as one request. The whole wait is capped."""
    clock, sleep = clock or time.monotonic, sleep or time.sleep
    quiet = config.get('bufferSeconds', BUFFER_SECONDS)
    latest = clock() + MAX_BUFFER_SECONDS
    deadline = min(clock() + quiet, latest)
    batch = [first]
    while True:
        if clock() >= deadline: return batch
        candidates = newMessages(database, chat['id'], int(first['sort_seq']), config.get('pageSize', 50))
        # A slow read must not take in a message that arrived after the window closed; it starts the next request.
        if clock() > deadline: return batch
        following, closed = followingRows(chat, first, candidates, store)
        if len(following) >= len(batch):
            batch = [first, *following]
            deadline = min(clock() + quiet, latest)
        if closed: return batch
        remaining = deadline - clock()
        if remaining <= 0: return batch
        sleep(min(BUFFER_POLL_SECONDS, remaining))


def incomingMessage(database, chat, row, config):
    if not chat['id'].endswith('@chatroom'):
        if row['type'] in ('图片', '动画表情'):
            isImage = row['type'] == '图片'
            label = '微信图片' if isImage else '微信表情包'
            message = normalizeMessage({**row, 'type': '文本', 'content': f'【{label}】'}, chat['id'], config['selfId'], config.get('people'), conversationName=chat.get('name'))
            if message is None: return None
            entry = messageEntry(row, message)
            try: entry['image'] = (database.readImage if isImage else database.readSticker)(chat['id'], row)
            except ImageUnavailable as error:
                unread = '图片未读取' if isImage else '微信表情包，未读取'
                entry['text'] = f'【{unread}：{error}】'
            return dict(text='', identity=message['identity'], media=[entry])
        return admitReference(database, chat['id'], normalizeMessage(row, chat['id'], config['selfId'], config.get('people'), conversationName=chat.get('name')))
    if (row['type'] != '文本' and not isAppMessage(row)) or row.get('sender_username') == config['selfId']:
        return None
    raw = database.get_message_row(chat['id'], row['local_id'], shard=row['shard'])
    if raw is None:
        raise RuntimeError('群消息原始来源无法读取，停止且不推进位置')
    mentions = mentionedIds(raw['source'])
    if config['selfId'] not in mentions:
        return None
    normalize = messageNormalizer(database, chat, config)
    message = normalize(row)
    if not message:
        return None
    message['identity']['mentionIds'] = ['wechat:' + wxid for wxid in mentions]
    def contextMessage(previous):
        if (previous['type'] not in ('文本', '图片') and not isAppMessage(previous)) or (previous['type'] == '文本' and len(str(previous['content'])) > 2000):
            return None
        normalized = displayMessage({**previous, 'type': '文本', 'content': '【群图片】'} if previous['type'] == '图片' else previous, normalize)
        if not normalized: return None
        entry = messageEntry(previous, normalized)
        if previous['type'] == '图片':
            entry['imageRow'] = {key: previous[key] for key in ('local_id','shard','sort_seq','create_time','type','sender_username')}
        return entry
    message['context'] = recentContext(database, chat['id'], row, contextMessage, config.get('pageSize', 50), config.get('contextMessages', DEFAULT_CONTEXT_MESSAGES))
    imageCount = 0
    for entry in reversed(message['context']):
        picture = entry.pop('imageRow', None)
        if picture is None: continue
        imageCount += 1
        if imageCount > 2:
            entry['text'] = '【较早图片，本轮只附最近两张】'
            continue
        try:
            entry['image'] = database.readImage(chat['id'], picture)
        except ImageUnavailable as error:
            entry['text'] = f'【图片未读取：{error}】'
    return admitReference(database, chat['id'], message)


class MessageStore:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS cursors(chatId TEXT PRIMARY KEY, seq INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS messages(chatId TEXT, messageId TEXT, seq INTEGER NOT NULL,
            status TEXT NOT NULL, PRIMARY KEY(chatId,messageId));
          CREATE TABLE IF NOT EXISTS receipts(replyId TEXT PRIMARY KEY, total INTEGER NOT NULL,
            confirmed INTEGER NOT NULL, status TEXT NOT NULL, posted INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS messageFaults(chatId TEXT, messageId TEXT, error TEXT NOT NULL,
            PRIMARY KEY(chatId,messageId));
        ''')
        self.presence = GroupPresence(self.db)
        self.notSent = {}  # replyId -> attempts that gave up before sending; in memory, a restart starts over

    def cursor(self, chatId):
        row = self.db.execute('SELECT seq FROM cursors WHERE chatId=?', (chatId,)).fetchone()
        return row[0] if row else None

    def baseline(self, chatId, seq, rows=()):
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO cursors VALUES (?,?)', (chatId, seq))
            self.db.executemany('INSERT OR IGNORE INTO messages VALUES (?,?,?,?)',
                                [(chatId, messageKey(row), seq, 'done') for row in rows])

    def seen(self, chatId, key):
        return self.db.execute('SELECT 1 FROM messages WHERE chatId=? AND messageId=? LIMIT 1', (chatId, key)).fetchone() is not None

    def begin(self, chatId, key, seq):
        with self.db:
            self.db.execute('INSERT INTO messages VALUES (?,?,?,?)', (chatId, key, seq, 'pending'))

    def finish(self, chatId, key, seq):
        with self.db:
            self.db.execute('UPDATE messages SET status=? WHERE chatId=? AND messageId=?', ('done', chatId, key))
            self.db.execute('UPDATE cursors SET seq=MAX(seq,?) WHERE chatId=?', (seq, chatId))

    def beginBatch(self, chatId, rows):
        with self.db:
            self.db.executemany("INSERT INTO messages VALUES (?,?,?,'pending')", [(chatId, messageKey(row), int(row['sort_seq'])) for row in rows])

    def fault(self, chatId, row, error, *, rejected=False):
        key = messageKey(row)
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO messageFaults VALUES (?,?,?)', (chatId, key, str(error)))
            if rejected:
                self.db.execute("INSERT INTO messages VALUES (?,?,?,'rejected')", (chatId, key, int(row['sort_seq'])))
                self.db.execute('UPDATE cursors SET seq=MAX(seq,?) WHERE chatId=?', (int(row['sort_seq']), chatId))
        print(f'微信消息 {chatId} / {key}：{error}', file=sys.stderr, flush=True)

    def finishBatch(self, chatId, rows):
        with self.db:
            result = self.db.executemany("UPDATE messages SET status='done' WHERE chatId=? AND messageId=? AND status='pending'", [(chatId, messageKey(row)) for row in rows])
            if result.rowcount != len(rows): raise RuntimeError('接收批次状态不一致，停止且不推进位置')
            self.db.execute('UPDATE cursors SET seq=MAX(seq,?) WHERE chatId=?', (max(int(row['sort_seq']) for row in rows), chatId))

    def checkPending(self):
        row = self.db.execute("SELECT chatId,messageId FROM messages WHERE status='pending' ORDER BY rowid LIMIT 1").fetchone()
        if row:
            raise NeedsHuman(pendingText(row[0], row[1]))

    def pendingChats(self):
        """The chats waiting for a person to check an unconfirmed message, each with its oldest such message."""
        pending = {}
        for chatId, key in self.db.execute("SELECT chatId,messageId FROM messages WHERE status='pending' ORDER BY rowid"):
            pending.setdefault(chatId, key)
        return pending

    def acknowledge(self, chatId, key):
        row = self.db.execute("SELECT seq FROM messages WHERE chatId=? AND messageId=? AND status='pending' LIMIT 1", (chatId, key)).fetchone()
        if not row:
            raise ValueError('没有这条待核对消息')
        self.finish(chatId, key, row[0])

    def close(self):
        self.db.close()

    def beginReply(self, replyId, total, chatId=None, seq=None):
        if not isinstance(replyId, str) or len(replyId) != 64 or any(c not in '0123456789abcdef' for c in replyId) or not 1 <= total <= 16:
            raise ValueError('回复缺少有效归档 ID 或消息数量，停止发送')
        with self.db:
            if chatId is not None:
                self.db.execute('INSERT INTO messages VALUES (?,?,?,?)', (chatId, 'outgoing:' + replyId, seq, 'pending'))
            self.db.execute('INSERT INTO receipts VALUES (?,?,0,?,0)', (replyId, total, 'uncertain'))

    def reply(self, replyId):
        row = self.db.execute('SELECT confirmed,status FROM receipts WHERE replyId=? LIMIT 1', (replyId,)).fetchone()
        return dict(id=replyId, confirmed=row[0], status=row[1]) if row else None

    def confirmReply(self, replyId, confirmed):
        with self.db:
            result = self.db.execute('UPDATE receipts SET confirmed=?, status=CASE WHEN total=? THEN ? ELSE ? END, posted=0 '
                                    'WHERE replyId=? AND confirmed<? AND total>=?',
                                    (confirmed, confirmed, 'sent', 'uncertain', replyId, confirmed, confirmed))
            if result.rowcount != 1:
                raise ValueError('回执进度无效')

    def abandonReply(self, replyId, chatId):
        """Undo `beginReply` for a reply that never started sending; the home still holds the job as claimed."""
        with self.db:
            self.db.execute("DELETE FROM receipts WHERE replyId=? AND confirmed=0 AND status='uncertain'", (replyId,))
            self.db.execute("DELETE FROM messages WHERE chatId=? AND messageId=? AND status='pending'", (chatId, 'outgoing:' + replyId))

    def failReply(self, replyId):
        with self.db:
            self.db.execute("UPDATE receipts SET status='failed', posted=0 WHERE replyId=? AND confirmed=0", (replyId,))

    def pendingReceipts(self, afterId='', limit=50):
        return [dict(id=row[0], confirmed=row[1], status=row[2]) for row in self.db.execute(
            'SELECT replyId,confirmed,status FROM receipts WHERE posted=0 AND replyId>? ORDER BY replyId LIMIT ?', (afterId, limit))]

    def receiptPosted(self, receipt):
        with self.db:
            self.db.execute('UPDATE receipts SET posted=1 WHERE replyId=? AND confirmed=? AND status=?',
                            (receipt['id'], receipt['confirmed'], receipt['status']))


def postHome(moduleFile, message):
    retryable = len(message) == 1 and next(iter(message)) in ('receipt', 'outbox', 'status', 'readResult')
    for attempt in range(5):
        try:
            return postHomeOnce(moduleFile, message, CONTROL_TIMEOUT_SECONDS if retryable else REPLY_TIMEOUT_SECONDS)
        except HTTPError as error:
            with error:
                try: detail = error.read(1024).decode('utf-8', errors='replace')
                except (IncompleteRead, URLError, TimeoutError, ConnectionError) as readError:
                    detail = f'响应正文未读完：{readError}'
            transient = error.code in (502, 503, 504)
            failure = HomeRequestError if transient else RuntimeError
            if not retryable or not transient or attempt == 4:
                raise failure(f'DSH HTTP {error.code}: {detail or error.reason}') from error
        except (IncompleteRead, URLError, TimeoutError, ConnectionError) as error:
            if not retryable or attempt == 4:
                raise HomeRequestError(f'DSH 请求未确认：{error}') from error
        time.sleep(2 ** attempt)


def postHomeOnce(moduleFile, message, timeout):
    connection = json.loads(Path(moduleFile).read_text(encoding='utf-8-sig'))
    if message.get('reference') and connection.get('references') is not True:
        raise RuntimeError('引用消息需要新版宿主支持，请更新并重载 DSH 的 dsh-world 插件')
    if message.get('media') and connection.get('protocol', 0) < 3:
        raise RuntimeError('私聊图片需要新版宿主协议，请更新并重载 DSH 的 dsh-world 插件')
    origin = urlparse(connection['origin'])
    if origin.scheme != 'http' or origin.hostname not in ('127.0.0.1', 'localhost', '::1') or connection.get('path') != '/dsh-world/wechat/ask':
        raise ValueError('微信模块地址必须是本机 DSH 的独立接口')
    request = Request(connection['origin'].rstrip('/') + connection['path'],
                      data=json.dumps(message, ensure_ascii=False).encode(),
                      headers={'Content-Type': 'application/json', 'x-dsh-world-token': connection['token']}, method='POST')
    with urlopen(request, timeout=timeout) as response:
        result = json.load(response)
    if result.get('accepted') is not True:
        raise RuntimeError('DSH 没有确认请求')
    return result


def askHome(moduleFile, message):
    result = postHome(moduleFile, message)
    if not isinstance(result.get('text'), str):
        raise RuntimeError('DSH 没有返回明确的微信回复')
    return result


def reportReceipt(moduleFile, receipt):
    postHome(moduleFile, dict(receipt=receipt))


def flushReceipts(moduleFile, store, report=reportReceipt):
    afterId = ''
    while True:
        receipts = store.pendingReceipts(afterId)
        if not receipts:
            return
        for receipt in receipts:
            report(moduleFile, receipt)
            store.receiptPosted(receipt)
            afterId = receipt['id']


def pollOutgoing(config):
    binding = dict(accountId=config['selfId'], chats=[dict(id=chat['id'], name=chat['name']) for chat in config['chats']])
    if config.get('_presence') is not None: binding['presence'] = config['_presence']
    result = postHome(config['moduleFile'], dict(outbox=binding))
    syncSettings(config, result.get('settings'))
    return result


def reportStatus(config, state):
    # Best effort: the console shows this, and a missing module file must not take the adapter down while it waits.
    try: postHome(config['moduleFile'], dict(status=dict(wechat=state)))
    except Exception: pass


def syncSettings(config, settings):
    # The console owns these two numbers; a missing or odd value keeps what the adapter already runs with.
    if not isinstance(settings, dict): return
    context, buffer = settings.get('contextMessages'), settings.get('bufferSeconds')
    if isinstance(context, int) and not isinstance(context, bool) and 1 <= context <= 20: config['contextMessages'] = context
    if isinstance(buffer, (int, float)) and not isinstance(buffer, bool) and 0 <= buffer <= 30: config['bufferSeconds'] = buffer


def flushReading(config, database, request, store=None):
    if not isinstance(request, dict) or not isinstance(request.get('id'), str):
        raise ValueError('无效的群消息读取任务')
    result = dict(id=request['id'], accountId=config['selfId'], chatId=request.get('chatId'))
    try: result.update(readHistory(database, config, request))
    except (SnapshotBusy, WechatOffline): raise
    except Exception as error: result['error'] = str(error)[:1000] or type(error).__name__
    through = result.pop('readThrough', None)
    boundaryRows = result.pop('readRows', [])
    accepted = postHome(config['moduleFile'], dict(readResult=result))
    if store is not None and through is not None and accepted.get('readAccepted') is True:
        latest = boundaryRows[-1]
        store.presence.observe(config['selfId'], request['chatId'], latest, speakerName(database, config, latest), unread=False)
        store.presence.markRead(config['selfId'], request['chatId'], through,
                                lambda after, until: unreadAfter(database, config, request['chatId'], after, until),
                                [messageKey(row) for row in boundaryRows])


def flushOutgoing(config, database, store, send, *, poll=pollOutgoing, report=reportReceipt):
    for _ in range(config.get('pageSize', 50)):
        if config.get('_presence') is not None:
            config['_presence']['groups'] = store.presence.snapshot(config)
        work = poll(config)
        if work.get('read') is not None:
            flushReading(config, database, work['read'], store)
        job = work.get('job')
        if job is None:
            if work.get('read') is not None: continue
            return
        if not isinstance(job, dict) or job.get('accountId') != config['selfId']:
            raise ValueError('发送任务不属于绑定的微信账号')
        chat = next((chat for chat in config['chats'] if chat['id'] == job.get('chatId')), None)
        if chat is None:
            raise ValueError('发送目标不在已配置聊天中')
        replyId, items = job.get('id'), job.get('messages')
        if not isinstance(replyId, str) or len(replyId) != 64 or any(c not in '0123456789abcdef' for c in replyId) or not isinstance(items, list) or not 1 <= len(items) <= 16:
            raise ValueError('无效的发送任务')
        previous = store.reply(replyId)
        if previous:
            report(config['moduleFile'], previous)
            store.receiptPosted(previous)
            continue
        baselineChat(database, store, chat['id'], config.get('pageSize', 50))
        seq, key = store.cursor(chat['id']), 'outgoing:' + replyId
        store.beginReply(replyId, len(items), chat['id'], seq)
        try:
            prepared = prepareMessages(items, config, Path(config['moduleFile']).parent / 'wechat-outgoing')
        except Exception:
            store.failReply(replyId)
            store.finish(chat['id'], key, seq)
            flushReceipts(config['moduleFile'], store, report)
            raise
        try:
            deliverMessages(prepared, lambda item: send(chat, item), lambda count: store.confirmReply(replyId, count))
            store.finish(chat['id'], key, seq)
        except NotSent as error:
            # Nothing was sent: forget this attempt and let the next poll hand the same job out again (#23),
            # but only so many times; after that it stays as an unconfirmed send for a person to check.
            attempts = store.notSent[replyId] = store.notSent.get(replyId, 0) + 1
            if attempts >= SEND_ATTEMPTS:
                store.notSent.pop(replyId, None)
                raise RuntimeError(f'连续 {attempts} 次发送前都未能获取稳定的目标聊天快照，消息没有发出；请人工核对后处理') from error
            store.abandonReply(replyId, chat['id'])
            print(f'微信发送尚未开始（第 {attempts}/{SEND_ATTEMPTS} 次），稍后重试同一任务：{error}', file=sys.stderr, flush=True)
            raise
        else:
            store.notSent.pop(replyId, None)
        finally:
            flushReceipts(config['moduleFile'], store, report)


def baselineChat(database, store, chatId, pageSize):
    if store.cursor(chatId) is not None:
        return
    latest = database.get_messages(chatId, limit=1)
    seq = int(latest[0]['sort_seq']) if latest else 0
    rows = [row for row in newMessages(database, chatId, seq, pageSize) if int(row['sort_seq']) == seq]
    store.baseline(chatId, seq, rows)


def askWhileSending(config, message, database, store, send, ask, report, poll):
    result = Future()
    def request():
        try: result.set_result(ask(config['moduleFile'], message))
        except BaseException as error: result.set_exception(error)
    # Only HTTP waits on this thread; all database/native operations stay on the one sender thread.
    Thread(target=request, daemon=True).start()
    while True:
        try:
            flushOutgoing(config, database, store, send, poll=poll, report=report)
        except HomeRequestError as error:
            print(f'微信发送队列暂时无法同步，继续等待本轮结果：{error}', file=sys.stderr, flush=True)
        except SnapshotBusy:
            pass
        if result.done():
            return result.result()
        time.sleep(config.get('pollSeconds', 2))


def watch(config, database, store, send, ask=askHome, report=reportReceipt, poll=pollOutgoing):
    pageSize = config.get('pageSize', 50)
    paused, held = None, {}
    while True:
        try:
            flushReceipts(config['moduleFile'], store, report)
            flushOutgoing(config, database, store, send, poll=poll, report=report)
            # An unconfirmed message holds back only its own chat: a failed group request used to stop private chats too.
            pending = store.pendingChats()
            for chatId, key in pending.items():
                if held.get(chatId) != key:
                    print(f'微信入站处理暂缓（仅此聊天，其他聊天照常）：{pendingText(chatId, key)}', file=sys.stderr, flush=True)
            held = pending
            paused = None
            for chat in config['chats']:
                if chat['id'] in pending:
                    continue
                baselineChat(database, store, chat['id'], pageSize)
                seedPresence(database, store, config, chat)
                for row in newMessages(database, chat['id'], store.cursor(chat['id']), pageSize):
                    if store.seen(chat['id'], messageKey(row)):
                        continue
                    if chat['id'].endswith('@chatroom') and row['type'] != '系统消息':
                        store.presence.observe(config['selfId'], chat['id'], row, speakerName(database, config, row))
                    try: message = incomingMessage(database, chat, row, config)
                    except MessageContentError as error:
                        store.fault(chat['id'], row, error, rejected=True)
                        continue
                    group = chat['id'].endswith('@chatroom')
                    if group and message is None:
                        # No delivery to track: retain only the group's counter and receive position.
                        store.finish(chat['id'], messageKey(row), int(row['sort_seq']))
                        flushOutgoing(config, database, store, send, poll=poll, report=report)
                        continue
                    if message and message.get('reference', {}).get('error'):
                        store.fault(chat['id'], row, message['reference']['error'])
                    # Only a message she is asked about waits for what its sender adds; in a group, that is one that calls her.
                    rows = bufferMessages(config, database, store, chat, row) if message and row['type'] in ('文本', '图片') else [row]
                    mergeFollowing(database, chat, config, message, rows[1:])
                    store.beginBatch(chat['id'], rows)
                    if message:
                        askWhileSending(config, message, database, store, send, ask, report, poll)
                    store.finishBatch(chat['id'], rows)
                    flushOutgoing(config, database, store, send, poll=poll, report=report)
            config['_presence'] = dict(observedAt=datetime.now(timezone.utc).isoformat(), groups=store.presence.snapshot(config))
        except (NeedsHuman, HomeRequestError) as error:
            if paused != str(error):
                print(f'微信入站处理暂缓，继续轮询独立发送任务：{error}', file=sys.stderr, flush=True)
                paused = str(error)
        except SnapshotBusy:
            # Re-read an unstable snapshot next poll; no message is re-sent here.
            pass
        time.sleep(config.get('pollSeconds', 2))


def watchConnected(config, stateDir, store, connect, *, ask=askHome, report=reportReceipt, poll=pollOutgoing, sleep=time.sleep, status=reportStatus):
    waiting = False
    while True:
        try:
            database, send = connect(config, stateDir)
            try:
                ready = send.probe()
                print(f"微信{'已重新连接' if waiting else '账号已绑定'}，版本 {ready['version']}，PID {send.processId}；继续原聊天游标。", flush=True)
                waiting = False
                return watch(config, database, store, send, ask, report, poll)
            finally:
                send.close()
        except WechatOffline:
            status(config, 'offline')
            if not waiting:
                print('指定微信账号已离线，暂停收发，等待原账号重新登录；无需重启 DSH。', flush=True)
            waiting = True
            sleep(config.get('pollSeconds', 2))


def run(args, config, stateDir):
    store = MessageStore(stateDir / 'state.sqlite')
    send = None
    try:
        if args.command == 'acknowledge':
            store.acknowledge(args.chat, args.message_id)
            print('已记录核对结果；这条消息不会再次发送。')
            return
        if args.command in ('watch', 'send') and not args.allow_send:
            raise ValueError('发送需要显式提供 --allow-send；先使用 status/chats 核对账号')
        if args.command == 'watch' and not Path(config['moduleFile']).is_file():
            raise ValueError('微信模块尚未启动，请先在 DSH 开启世界及 wechat 配置')
        if args.command == 'watch' and json.loads(Path(config['moduleFile']).read_text(encoding='utf-8-sig')).get('references') is not True:
            raise ValueError('新版适配器需要支持引用消息的宿主，请同时更新并重载 DSH 的 dsh-world 插件')
        from native import connect
        if args.command == 'watch':
            print('开始监听所选聊天；Ctrl+C 停止。', flush=True)
            watchConnected(config, stateDir, store, connect)
            return
        database, send = connect(config, stateDir)
        if args.command == 'probe':
            print(json.dumps(dict(nativeReady=True, processId=send.processId, **send.probe())))
        elif args.command == 'chats':
            if not 1 <= args.limit <= 100 or args.offset < 0:
                raise ValueError('分页参数无效')
            rows = database.get_sessions(limit=args.offset + args.limit + 1)
            chats = []
            for row in rows[args.offset:args.offset+args.limit]:
                contact = next((item for item in database.search_contact(row['username']) if item['username'] == row['username']), {})
                chats.append(dict(id=row['username'], name=contact.get('remark') or contact.get('nick_name') or row['username']))
            print(json.dumps(dict(chats=chats, hasMore=len(rows) > args.offset+args.limit), ensure_ascii=False))
        elif args.command == 'send':
            chat = next((chat for chat in config['chats'] if chat['id'] == args.chat), None)
            if not chat or not args.text or len(args.text) > 2000:
                raise ValueError('请选择已配置的聊天，并提供 1–2000 字正文')
            store.checkPending()
            send.probe()
            key = 'manual:' + str(time.time_ns())
            baselineChat(database, store, chat['id'], config.get('pageSize', 50))
            seq = store.cursor(chat['id'])
            store.begin(chat['id'], key, seq)
            send(chat, args.text)
            store.finish(chat['id'], key, seq)
            print('发送已核对')
    finally:
        try:
            if send is not None: send.close()
        finally:
            store.close()


def main():
    parser = argparse.ArgumentParser(description='dsh-world 独立微信模块的 Windows 适配器')
    parser.add_argument('command', choices=['status', 'probe', 'chats', 'watch', 'send', 'acknowledge'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--chat')
    parser.add_argument('--text')
    parser.add_argument('--message-id')
    parser.add_argument('--limit', type=int, default=20)
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--allow-send', action='store_true', help='显式允许微信原生发消息')
    args = parser.parse_args()
    configPath = Path(args.config).resolve()
    config = json.loads(configPath.read_text(encoding='utf-8-sig'))
    if args.command == 'status':
        from importlib.metadata import version
        configured = all(config.get(k) for k in ('account', 'selfId', 'dbDir', 'chats'))
        print(json.dumps(dict(dependency=version('wechatauto-replica'), configured=configured,
                             moduleReady=Path(config.get('moduleFile', '')).is_file()), ensure_ascii=False))
        return
    validateConfig(config, requireChats=args.command != 'chats')
    stateDir = configPath.parent / config['account']
    stateDir.mkdir(parents=True, exist_ok=True)
    config['engineDir'] = str(configPath.parent / 'engine')
    with exclusiveRun(stateDir):
        run(args, config, stateDir)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('已停止微信适配器。')
    except NeedsHuman as error:
        print(f'微信适配器停止：{error}', file=sys.stderr)
        sys.exit(EXIT_NEEDS_HUMAN)
    except BuildStale as error:
        print(f'微信适配器停止：{error}', file=sys.stderr)
        sys.exit(EXIT_NEEDS_BUILD)
    except Exception as error:
        print(f'微信适配器停止：{error}', file=sys.stderr)
        sys.exit(1)
