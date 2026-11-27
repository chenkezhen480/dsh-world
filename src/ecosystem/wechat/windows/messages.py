"""Shared platform IDs, sender identity and display entries for incoming and explicit reads."""
from datetime import datetime, timezone
from quotes import MessageContentError, parseQuote

MAX_CONTEXT_BYTES = 16 * 1024


def messageKey(row):
    if not row.get('shard'):
        raise ValueError('消息分片标识为空，停止而不猜测消息 ID')
    return f"{row['shard']}:{row['local_id']}"


def messageOrder(row):
    return int(row['sort_seq']), row['shard'], int(row['local_id'])


def recentEntries(database, chatId, normalize, pageSize, limit, before=None):
    """Newest matching entries, keyed by platform order and returned chronologically."""
    offset, found = 0, {}
    while True:
        page = database.get_messages(chatId, limit=pageSize, offset=offset)
        for row in page:
            key = messageOrder(row)
            if before is not None and key >= before: continue
            entry = normalize(row)
            if entry: found[key] = entry
        keys = sorted(found)[-limit:]
        # Finish a whole sort_seq tie so entries in another shard cannot be missed.
        if len(page) < pageSize or (len(keys) == limit and int(page[-1]['sort_seq']) < keys[0][0]): break
        offset += len(page)
    return {key: found[key] for key in keys}


def hasSender(row):
    """Whether the row names who said it. A pat card and some system cards name nobody; nobody is guessed for them,
    and they are passed over rather than stopping a whole page of a group (#70)."""
    return bool(row.get('sender_username'))


def normalizeMessage(row, chatId, selfId, people=None, *, includeSelf=False, conversationName=None):
    if row.get('sender_username') == selfId and not includeSelf: return None
    quote = parseQuote(row)
    if row['type'] != '文本' and quote is None: return None
    sender = row.get('sender_username')
    if not sender:
        raise ValueError(f'消息 {messageKey(row)} 的发送者未解析，停止处理而不猜测身份')
    text = quote[0] if quote else str(row['content'])
    if chatId.endswith('@chatroom') and text.startswith(sender + ':\n'):
        text = text[len(sender) + 2:]
    if not text.strip() and not quote: return None
    if len(text) > 2000:
        raise ValueError('消息超过当前模块 2000 字限制，请分开发送')
    identity = dict(channel='wechat', accountId=selfId, conversationType='group' if chatId.endswith('@chatroom') else 'private', conversationId=chatId, speakerId='wechat:' + sender)
    identity['platformMessageId'] = messageKey(row)
    if conversationName: identity['conversationName'] = conversationName
    if (people or {}).get(sender): identity['speakerName'] = people[sender]
    return dict(text=text, identity=identity, **({'reference': quote[1]} if quote else {}))


def messageNormalizer(database, chat, config):
    people = {**config.get('people', {})}
    def normalize(row, includeSelf=False):
        sender = row.get('sender_username')
        if sender and sender not in people:
            people[sender] = database.get_nickname(sender)
        return normalizeMessage(row, chat['id'], config['selfId'], people, includeSelf=includeSelf, conversationName=chat['name'])
    return normalize


def messageEntry(row, message):
    return dict(**message, id=messageKey(row), occurredAt=datetime.fromtimestamp(int(row['create_time']), timezone.utc).isoformat())


def displayMessage(row, normalize):
    """A bad historical card remains visible without breaking a later valid request."""
    try: message = normalize(row, includeSelf=True)
    except MessageContentError as error:
        message = normalize({**row, 'type': '文本', 'content': f'【消息未读取：{error}】'}, includeSelf=True)
    if message and not message['text']: message['text'] = '【引用消息】'
    return message
