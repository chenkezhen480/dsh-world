import unittest
import json
import hashlib
import tempfile
from pathlib import Path
from unittest.mock import patch
from reading import readHistory
from stickers import StickerUnavailable
from incoming import ImageUnavailable


def row(number):
    return dict(local_id=number, shard='m.db', sort_seq=number, create_time=1700000000+number,
                type='文本', sender_username='dad', content=f'群里第 {number} 句话')


class ReadingTest(unittest.TestCase):
    def setUp(self):
        self.rows = [row(i) for i in range(8, 0, -1)]
        self.calls = []
        owner = self
        class Database:
            def get_messages(self, chatId, limit, offset=0):
                owner.calls.append((chatId, limit, offset))
                return owner.rows[offset:offset+limit]
            def get_nickname(self, _): return '爸爸'
        self.database = Database()
        self.config = dict(selfId='bot', chats=[dict(id='family@chatroom', name='家人', trigger='mention')], pageSize=2)
        self.request = dict(id='request', accountId='bot', chatId='family@chatroom', limit=3)

    def test_group_without_mentions_is_paginated_stably_when_new_messages_arrive(self):
        first = readHistory(self.database, self.config, self.request)
        self.assertEqual([entry['id'] for entry in first['messages']], ['m.db:6', 'm.db:7', 'm.db:8'])
        self.assertEqual(first['messages'][0]['identity']['speakerId'], 'wechat:dad')
        self.rows.insert(0, row(9))
        second = readHistory(self.database, self.config, {**self.request, 'cursor': first['nextCursor']})
        self.assertEqual([entry['id'] for entry in second['messages']], ['m.db:3', 'm.db:4', 'm.db:5'])
        last = readHistory(self.database, self.config, {**self.request, 'cursor': second['nextCursor']})
        self.assertEqual([entry['id'] for entry in last['messages']], ['m.db:1', 'm.db:2'])
        self.assertNotIn('nextCursor', last)
        self.assertTrue(all(call[1] == 2 for call in self.calls))

    def test_equal_sequences_and_shards_are_neither_skipped_nor_duplicated(self):
        self.rows = [{**row(i), 'sort_seq': 10, 'shard': 'a.db' if i % 2 else 'b.db'} for i in range(8, 0, -1)]
        seen, cursor = [], None
        for _ in range(4):
            page = readHistory(self.database, self.config, {**self.request, **({'cursor': cursor} if cursor else {})})
            seen.extend(entry['id'] for entry in page['messages'])
            cursor = page.get('nextCursor')
            if not cursor: break
        self.assertEqual(len(seen), 8); self.assertEqual(len(set(seen)), 8)

    def test_wrong_binding_private_targets_bad_cursors_and_limits_do_not_read_the_database(self):
        first = readHistory(self.database, self.config, self.request)
        self.calls.clear()
        for patch in [dict(accountId='other'), dict(chatId='unselected@chatroom'), dict(chatId='private'), dict(limit=True), dict(limit=21), dict(cursor='bad'), dict(cursor='')]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                readHistory(self.database, self.config, {**self.request, **patch})
        self.config['chats'].append(dict(id='other@chatroom', name='其他'))
        with self.assertRaises(ValueError):
            readHistory(self.database, self.config, {**self.request, 'chatId': 'other@chatroom', 'cursor': first['nextCursor']})
        self.assertEqual(self.calls, [])

    def test_self_messages_are_visible_and_unread_media_is_explicit_without_raw_payload(self):
        self.rows = [{**row(3), 'sender_username': 'bot', 'content': '我刚刚说过'},
                     {**row(2), 'type': '图片', 'content': 'private-image-xml'},
                     {**row(1), 'type': '视频', 'content': 'private-video-xml'}]
        page = readHistory(self.database, self.config, self.request)
        self.assertEqual(len(page['messages']), 3)
        self.assertEqual(page['messages'][-1]['identity']['speakerId'], 'wechat:bot')
        self.assertIn('未读取', str(page)); self.assertNotIn('private-', str(page))

    def test_large_pages_return_a_cursor_instead_of_silently_losing_older_messages(self):
        self.rows = [{**row(i), 'content': '鱼' * 2000} for i in range(20, 0, -1)]
        seen, cursor = [], None
        for _ in range(20):
            page = readHistory(self.database, self.config, {**self.request, 'limit': 20, **({'cursor': cursor} if cursor else {})})
            self.assertLessEqual(len(json.dumps(page['messages'], ensure_ascii=False).encode('utf-8')), 16 * 1024)
            seen.extend(entry['id'] for entry in page['messages']); cursor = page.get('nextCursor')
            if not cursor: break
        self.assertEqual(len(seen), 20); self.assertEqual(len(set(seen)), 20)

    def test_system_events_and_lines_that_name_nobody_are_left_out_without_breaking_the_page(self):
        self.rows.insert(0, {**row(9), 'type': '系统消息', 'sender_username': '', 'content': '<sysmsg>成员变动</sysmsg>'})
        page = readHistory(self.database, self.config, self.request)
        self.assertNotIn('m.db:9', [entry['id'] for entry in page['messages']])
        # A pat card names nobody: nobody is guessed for it, and it no longer fails the whole page (#70).
        self.rows[0]['type'] = '文本'
        for card in ('文本', '链接'):
            with self.subTest(card=card):
                self.rows[0]['type'] = card
                page = readHistory(self.database, self.config, self.request)
                ids = [entry['id'] for entry in page['messages']]
                self.assertNotIn('m.db:9', ids)
                self.assertEqual(ids[-1], 'm.db:8', 'the lines around it are read as before')

    def test_reads_and_sends_share_one_poll_without_advancing_the_receive_cursor(self):
        from adapter import MessageStore, flushOutgoing
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite'); store.baseline('family@chatroom', 8)
            config = {**self.config, 'moduleFile': 'unused'}
            work = [dict(read=self.request, job=dict(id='a' * 64, accountId='bot', chatId='family@chatroom', messages=[dict(type='text', text='看过再说')])), {}]
            sent, receipts = [], []
            try:
                with patch('adapter.postHome') as post:
                    flushOutgoing(config, self.database, store, lambda chat, item: sent.append((chat['id'], item['text'])),
                                  poll=lambda _: work.pop(0), report=lambda _, value: receipts.append(value))
                    page = post.call_args.args[1]['readResult']
                    self.assertEqual(page['messages'][-1]['id'], 'm.db:8')
                self.assertEqual(sent, [('family@chatroom', '看过再说')])
                self.assertEqual(receipts[-1]['status'], 'sent'); self.assertEqual(store.cursor('family@chatroom'), 8)
                store.checkPending()
            finally: store.close()


class ImageReadingTest(unittest.TestCase):
    def setUp(self):
        owner = self
        self.reads = []
        self.raw = dict(local_id=7, local_type=3, sort_seq=7, create_time=1700000007, sender_username='dad')
        class Database:
            def get_messages(self, chatId, limit, offset=0):
                return [dict(local_id=7, shard='m.db', sort_seq=7, create_time=1700000007, type='图片', sender_username='dad', content='<xml/>')]
            def get_nickname(self, _): return '爸爸'
            def get_message_row(self, chatId, localId, local_type=None, shard=None):
                owner.reads.append((chatId, localId, local_type, shard))
                return owner.raw if localId == 7 and shard == 'm.db' else None
            def readImage(self, chatId, row):
                if owner.unavailable: raise ImageUnavailable('图片尚未下载到这台电脑')
                return dict(file='a' * 64 + '.png', quality='cached')
        self.unavailable = False
        self.database = Database()
        self.config = dict(selfId='bot', chats=[dict(id='family@chatroom', name='家人')], pageSize=2)
        self.request = dict(id='request', accountId='bot', chatId='family@chatroom', limit=1, imageId='m.db:7')

    def test_history_tells_the_model_how_to_look_at_a_picture(self):
        result = readHistory(self.database, self.config, {k: v for k, v in self.request.items() if k != 'imageId'})
        self.assertIn('wechat_image', result['messages'][0]['text'])
        self.assertNotIn('image', result['messages'][0])

    def test_one_picture_is_read_by_the_id_history_gave(self):
        result = readHistory(self.database, self.config, self.request)
        [entry] = result['messages']
        self.assertEqual((entry['id'], entry['image']['quality'], entry['identity']['speakerId']), ('m.db:7', 'cached', 'wechat:dad'))
        self.assertEqual(self.reads, [('family@chatroom', 7, 3, 'm.db')])
        self.assertNotIn('readThrough', result, 'looking at a picture does not clear the group unread count')

    def test_only_a_picture_in_a_configured_group_can_be_read(self):
        for bad in ('', 'm.db', 'm.db:x', 'm.db:8', ':7', 'm.db:7' + 'x' * 300):
            with self.subTest(imageId=bad), self.assertRaises(ValueError):
                readHistory(self.database, self.config, {**self.request, 'imageId': bad})
        self.raw = {**self.raw, 'local_type': 1}
        with self.assertRaisesRegex(ValueError, '不是本群里的图片'):
            readHistory(self.database, self.config, self.request)
        with self.assertRaises(ValueError):
            readHistory(self.database, self.config, {**self.request, 'chatId': 'other@chatroom'})

    def test_a_picture_that_is_not_on_this_computer_says_so(self):
        self.unavailable = True
        with self.assertRaisesRegex(ValueError, '尚未下载'):
            readHistory(self.database, self.config, self.request)


GIF = b'GIF89a' + b'x' * 30


class StickerSavingTest(unittest.TestCase):
    def setUp(self):
        owner = self
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.raw = dict(local_id=5, local_type=47, content=b'<msg/>', sender_username='dad')
        class Database:
            def get_message_row(self, chatId, localId, local_type=None, shard=None):
                return owner.raw if localId == 5 and shard == 'm.db' else None
        self.database = Database()
        self.config = dict(selfId='bot', moduleFile=str(Path(self.directory.name) / 'wechat.json'),
                           chats=[dict(id='family@chatroom', name='家人'), dict(id='mom', name='妈妈')])
        self.request = dict(id='r', accountId='bot', chatId='mom', limit=1, stickerId='m.db:5')

    def save(self, request=None, data=GIF):
        with patch('reading.fetchSticker', return_value=data):
            return readHistory(self.database, self.config, request or self.request)

    def test_a_sticker_from_a_private_or_group_chat_is_staged_with_its_md5(self):
        for chat in ('mom', 'family@chatroom'):
            result = self.save({**self.request, 'chatId': chat})
            sticker = result['sticker']
            self.assertEqual((sticker['md5'], sticker['mediaType'], sticker['bytes']), (hashlib.md5(GIF).hexdigest(), 'image/gif', len(GIF)))
            staged = Path(self.directory.name) / 'stickers' / 'incoming' / sticker['file']
            self.assertEqual(staged.read_bytes(), GIF)

    def test_only_a_sticker_message_in_a_configured_chat_can_be_saved(self):
        for bad in ('', 'm.db', 'm.db:x', 'm.db:6', ':5'):
            with self.subTest(stickerId=bad), self.assertRaises(ValueError):
                self.save({**self.request, 'stickerId': bad})
        with self.assertRaises(ValueError): self.save({**self.request, 'chatId': 'stranger'})
        with self.assertRaises(ValueError): self.save({**self.request, 'accountId': 'other'})
        self.raw = {**self.raw, 'local_type': 1}
        with self.assertRaisesRegex(ValueError, '不是聊天里的表情包'): self.save()

    def test_a_download_that_fails_or_is_not_a_picture_is_refused(self):
        with patch('reading.fetchSticker', side_effect=StickerUnavailable('下载内容与消息中的 md5 不符，已丢弃')):
            with self.assertRaisesRegex(ValueError, 'md5'): readHistory(self.database, self.config, self.request)
        with self.assertRaisesRegex(ValueError, 'GIF、PNG'): self.save(data=b'<html>not a picture</html>')
        self.config['fetchStickers'] = False
        with self.assertRaisesRegex(ValueError, 'fetchStickers'): self.save()


if __name__ == '__main__': unittest.main()
