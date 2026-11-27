"""One durable metadata row per account/group; no message body, wake or model call."""
from datetime import datetime, timezone
import json
from messages import hasSender, messageKey, messageOrder, recentEntries
from snapshot import SnapshotBusy


class GroupPresence:
    def __init__(self, db):
        self.db = db
        db.execute('''CREATE TABLE IF NOT EXISTS groupPresence(
          accountId TEXT, chatId TEXT, count INTEGER NOT NULL,
          seq INTEGER, shard TEXT, localId INTEGER, lastAt TEXT, speaker TEXT, self INTEGER,
          readSeq INTEGER NOT NULL DEFAULT 0, readShard TEXT NOT NULL DEFAULT '', readId INTEGER NOT NULL DEFAULT 0,
          seen TEXT NOT NULL DEFAULT '[]', readSeen TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY(accountId,chatId))''')

    def _get(self, account, chat):
        return self.db.execute('SELECT count,seq,shard,localId,lastAt,speaker,self,readSeq,readShard,readId,seen,readSeen '
                               'FROM groupPresence WHERE accountId=? AND chatId=? LIMIT 1', (account, chat)).fetchone()

    def observe(self, account, chat, row, speaker, *, unread=True):
        if row['type'] == '系统消息' or not hasSender(row): return
        order = messageOrder(row)
        previous = self._get(account, chat)
        if previous and order[0] < previous[1]: return
        sameSeq = bool(previous and order[0] == previous[1])
        seen = set(json.loads(previous[10])) if sameSeq else set()
        key = messageKey(row)
        if key in seen: return
        seen.add(key)
        read = tuple(previous[7:10]) if previous else (0, '', 0)
        own = row['sender_username'] == account
        count = (previous[0] if previous else 0) + int(unread and not own and (order > read or (sameSeq and order[0] == read[0])))
        at = datetime.fromtimestamp(int(row['create_time']), timezone.utc).isoformat()
        metadata = (at, str(speaker)[:80], int(own))
        if sameSeq and order < tuple(previous[1:4]):
            order, metadata = tuple(previous[1:4]), tuple(previous[4:7])
        with self.db:
            self.db.execute('INSERT INTO groupPresence VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) '
                            'ON CONFLICT(accountId,chatId) DO UPDATE SET count=excluded.count,seq=excluded.seq,'
                            'shard=excluded.shard,localId=excluded.localId,lastAt=excluded.lastAt,speaker=excluded.speaker,self=excluded.self,seen=excluded.seen',
                            (account, chat, count, *order, *metadata, *read, json.dumps(sorted(seen)), previous[11] if previous else '[]'))

    def markRead(self, account, chat, through, countRemaining=None, seenKeys=()):
        previous = self._get(account, chat)
        boundary = tuple(through)
        if not previous:
            with self.db:
                self.db.execute('INSERT INTO groupPresence(accountId,chatId,count,seq,shard,localId,readSeq,readShard,readId,readSeen) VALUES (?,?,0,0,\'\',0,?,?,?,?)', (account, chat, *boundary, json.dumps(sorted(seenKeys))))
            return
        read = max(tuple(previous[7:10]), boundary)
        seen = set(json.loads(previous[10]))
        if boundary[0] == previous[1]: seen.update(seenKeys)
        readSeen = set(json.loads(previous[11])) if boundary[0] == previous[7] else set()
        if boundary < tuple(previous[7:10]) or (boundary == tuple(previous[7:10]) and not set(seenKeys) - readSeen): return
        readSeen.update(seenKeys)
        remaining = 0
        if boundary < tuple(previous[1:4]):
            if countRemaining is None: raise ValueError('旧读取结果需要核对尚未读到的群消息')
            remaining = min(previous[0], countRemaining(boundary, tuple(previous[1:4])))
        with self.db:
            self.db.execute('UPDATE groupPresence SET count=?,readSeq=?,readShard=?,readId=?,seen=?,readSeen=? WHERE accountId=? AND chatId=?',
                            (remaining, *read, json.dumps(sorted(seen)), json.dumps(sorted(readSeen)), account, chat))

    def snapshot(self, config):
        groups = []
        for chat in config['chats']:
            if not chat['id'].endswith('@chatroom'): continue
            row = self._get(config['selfId'], chat['id'])
            if row and row[4]:
                groups.append(dict(chatId=chat['id'], count=min(100, row[0]), lastAt=row[4], lastSpeaker=row[5], lastSelf=bool(row[6])))
        # Keep the existing control poll bounded even with many configured groups.
        return sorted(groups, key=lambda item: (item['count'] > 0, item['lastAt']), reverse=True)[:8]


def speakerName(database, config, row):
    sender = row.get('sender_username')
    if not sender: return ''
    return config.get('people', {}).get(sender) or database.get_nickname(sender) or sender


def seedPresence(database, store, config, chat):
    presence = store.presence
    previous = presence._get(config['selfId'], chat['id'])
    if not chat['id'].endswith('@chatroom') or (previous and previous[4]): return
    cursor = store.cursor(chat['id'])
    if cursor is None: return
    found = recentEntries(database, chat['id'], lambda row: row if int(row['sort_seq']) <= cursor and row['type'] != '系统消息' and hasSender(row) else None,
                          config.get('pageSize', 50), 1)
    if found:
        latest = next(reversed(found.values()))
        presence.observe(config['selfId'], chat['id'], latest, speakerName(database, config, latest), unread=False)


def unreadAfter(database, config, chat, after, until):
    offset, size, found = 0, config.get('pageSize', 50), set()
    while True:
        rows = database.get_messages(chat, limit=size, offset=offset)
        if offset == 0 and (not rows or max(int(row['sort_seq']) for row in rows) < until[0]):
            raise SnapshotBusy('群消息快照落后于已观察位置，保留未读等待重读')
        for row in rows:
            order = messageOrder(row)
            if after < order <= until and row['type'] != '系统消息':
                if not hasSender(row): continue
                if row['sender_username'] != config['selfId']: found.add(order)
        if len(rows) < size or any(int(row['sort_seq']) < after[0] for row in rows): return len(found)
        offset += len(rows)
