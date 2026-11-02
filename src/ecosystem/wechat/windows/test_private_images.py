import unittest
import tempfile
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import json
import adapter
from adapter import incomingMessage, MessageStore
from incoming import ImageUnavailable


class PrivateImageTest(unittest.TestCase):
    def test_private_picture_is_a_media_request_with_no_fake_user_text(self):
        row = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='图片', sender_username='owner', content='image metadata')
        database = SimpleNamespace(readImage=Mock(return_value=dict(file='a' * 64 + '.png', quality='cached')))
        config = dict(selfId='bot', people={})
        message = incomingMessage(database, dict(id='owner', name='伙伴'), row, config)
        self.assertIsNotNone(message)
        self.assertEqual(message['text'], '')
        self.assertEqual(message['media'][0]['id'], 'm.db:1')
        self.assertEqual(message['media'][0]['image']['quality'], 'cached')
        self.assertEqual(message['identity']['conversationType'], 'private')

    def test_missing_private_picture_is_explicit_and_does_not_swallow_sender_errors(self):
        row = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='图片', sender_username='owner', content='image metadata')
        database = SimpleNamespace(readImage=Mock(side_effect=ImageUnavailable('尚未下载')))
        message = incomingMessage(database, dict(id='owner', name='伙伴'), row, dict(selfId='bot'))
        self.assertIsNotNone(message)
        self.assertIn('尚未下载', message['media'][0]['text'])
        self.assertNotIn('image', message['media'][0])
        database.readImage.side_effect = RuntimeError('账号绑定错误')
        with self.assertRaisesRegex(RuntimeError, '账号绑定错误'):
            incomingMessage(database, dict(id='owner', name='伙伴'), row, dict(selfId='bot'))

    def test_buffer_merges_following_same_sender_messages_restarting_the_wait_and_stops_at_two_images(self):
        first = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='图片', sender_username='owner', content='image')
        caption = dict(first, local_id=2, sort_seq=12, type='文本', content='请看图')
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            store.baseline('owner', 10)
            database = SimpleNamespace(get_messages=lambda _chat, limit, offset=0: ([caption, first] if clock[0] >= 1 else [first])[offset:offset + limit])
            try:
                rows = adapter.bufferMessages(dict(pollSeconds=1), database, store, dict(id='owner'), first, clock=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
                self.assertEqual([row['local_id'] for row in rows], [1, 2])
                self.assertAlmostEqual(clock[0], 4, delta=0.2, msg='the caption at 1s starts another 3s wait')
                self.assertEqual(store.cursor('owner'), 10, 'buffering does not advance durable cursor')
                second = dict(first, local_id=2, sort_seq=12)
                third = dict(first, local_id=3, sort_seq=13)
                database.get_messages = lambda _chat, limit, offset=0: [third, second, first][offset:offset + limit]
                rows = adapter.bufferMessages({}, database, store, dict(id='owner'), first)
                self.assertEqual([row['local_id'] for row in rows], [1, 2])
                database.get_messages = lambda _chat, limit, offset=0: [dict(caption, sender_username='other'), first][offset:offset + limit]
                self.assertEqual(adapter.bufferMessages({}, database, store, dict(id='owner'), first), [first])
            finally:
                store.close()

    def test_buffer_expires_without_consuming_a_later_caption(self):
        first = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='图片', sender_username='owner', content='image')
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            database = SimpleNamespace(get_messages=lambda _chat, limit, offset=0: [first][offset:offset + limit])
            try:
                rows = adapter.bufferMessages(dict(pollSeconds=2), database, store, dict(id='owner'), first, clock=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
                self.assertEqual(rows, [first])
                self.assertEqual(clock[0], 3)
            finally:
                store.close()

    def test_expired_buffer_does_not_read_late_text_after_a_delayed_wakeup(self):
        first = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='图片', sender_username='owner', content='image')
        caption = dict(first, local_id=2, sort_seq=12, type='文本', content='窗口结束后到达')
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            database = SimpleNamespace(get_messages=lambda _chat, limit, offset=0: ([caption, first] if clock[0] >= 4 else [first])[offset:offset + limit])
            try:
                rows = adapter.bufferMessages(dict(pollSeconds=1), database, store, dict(id='owner'), first, clock=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds + 4))
                self.assertEqual(rows, [first], 'late text must stay for the next request even after a slow wakeup')
            finally:
                store.close()

    def test_buffer_polling_is_independent_of_normal_poll_interval(self):
        first = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='图片', sender_username='owner', content='image')
        caption = dict(first, local_id=2, sort_seq=12, type='文本', content='窗口内的说明')
        for pollSeconds, captionAt in [(3, 1), (2, 2.9)]:
            with self.subTest(pollSeconds=pollSeconds, captionAt=captionAt), tempfile.TemporaryDirectory() as directory:
                clock = [0.0]
                store = MessageStore(Path(directory) / 'state.sqlite')
                database = SimpleNamespace(get_messages=lambda _chat, limit, offset=0: ([caption, first] if clock[0] >= captionAt else [first])[offset:offset + limit])
                try:
                    rows = adapter.bufferMessages(dict(pollSeconds=pollSeconds), database, store, dict(id='owner'), first, clock=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
                    self.assertEqual([row['local_id'] for row in rows], [1, 2])
                    self.assertLessEqual(clock[0], captionAt + 3 + 0.2)
                finally:
                    store.close()

    def test_batch_pending_is_atomic_and_survives_until_the_whole_batch_finishes(self):
        rows = [dict(local_id=1, shard='m.db', sort_seq=11), dict(local_id=2, shard='m.db', sort_seq=12)]
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'state.sqlite'
            store = MessageStore(file)
            store.baseline('owner', 10)
            try:
                store.beginBatch('owner', rows)
                with self.assertRaises(RuntimeError): store.checkPending()
                store.close(); store = MessageStore(file)
                with self.assertRaises(RuntimeError): store.checkPending()
                store.finishBatch('owner', rows)
                store.checkPending()
                self.assertEqual(store.cursor('owner'), 12)
                self.assertTrue(all(store.seen('owner', 'm.db:' + str(row['local_id'])) for row in rows))
                with self.assertRaises(sqlite3.IntegrityError):
                    store.beginBatch('owner', [dict(local_id=3, shard='m.db', sort_seq=13), rows[0]])
                self.assertFalse(store.seen('owner', 'm.db:3'), 'an incomplete batch insert must roll back')
            finally:
                store.close()

    def test_text_arriving_after_image_processing_starts_runs_in_the_next_turn(self):
        first = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='图片', sender_username='owner', content='image')
        later = dict(first, local_id=2, sort_seq=12, type='文本', content='后来的说明')
        rows, requests = [first], []
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite'); store.baseline('owner', 10)
            database = SimpleNamespace(get_messages=lambda _chat, limit, offset=0: list(reversed(rows))[offset:offset + limit], readImage=lambda *_: dict(file='a' * 64 + '.png', quality='cached'))
            config = dict(selfId='bot', moduleFile=str(Path(directory) / 'wechat.json'), chats=[dict(id='owner', name='伙伴')], pollSeconds=0.01)
            def ask(_file, message):
                requests.append(message)
                if len(requests) == 1: rows.append(later)
                return dict(text='ok')
            def poll(_config):
                if store.cursor('owner') == 12: raise StopIteration('done')
                return {}
            try:
                with self.assertRaises(StopIteration): adapter.watch(config, database, store, lambda *_: None, ask=ask, report=lambda *_: None, poll=poll)
                self.assertEqual(len(requests), 2)
                self.assertEqual(requests[0]['text'], '')
                self.assertEqual(requests[1]['text'], '后来的说明')
                self.assertNotIn('media', requests[1])
                store.checkPending()
            finally:
                store.close()

    def test_two_images_and_caption_are_one_request_and_preserve_every_source_id(self):
        first = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='图片', sender_username='owner', content='image')
        rows = [first, dict(first, local_id=2, sort_seq=12), dict(first, local_id=3, sort_seq=13, type='文本', content='一起看这两张')]
        requests = []
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite'); store.baseline('owner', 10)
            database = SimpleNamespace(get_messages=lambda _chat, limit, offset=0: list(reversed(rows))[offset:offset + limit], readImage=lambda *_: dict(file='a' * 64 + '.png', quality='cached'))
            config = dict(selfId='bot', moduleFile=str(Path(directory) / 'wechat.json'), chats=[dict(id='owner', name='伙伴')], pollSeconds=0.01)
            def ask(_file, message):
                requests.append(message)
                observer = sqlite3.connect((Path(directory) / 'state.sqlite').resolve().as_uri() + '?mode=ro', uri=True)
                try:
                    self.assertEqual(observer.execute("SELECT COUNT(*) FROM messages WHERE status='pending'").fetchone()[0], 3)
                finally:
                    observer.close()
                return dict(text='ok')
            def poll(_config):
                if store.cursor('owner') == 13: raise StopIteration('done')
                return {}
            try:
                with self.assertRaises(StopIteration): adapter.watch(config, database, store, lambda *_: None, ask=ask, report=lambda *_: None, poll=poll)
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0]['text'], '一起看这两张')
                self.assertEqual(requests[0]['identity']['platformMessageId'], 'm.db:3')
                self.assertEqual([item['id'] for item in requests[0]['media']], ['m.db:1', 'm.db:2'])
                self.assertTrue(all(store.seen('owner', 'm.db:' + str(row['local_id'])) for row in rows))
                store.checkPending()
            finally:
                store.close()

    def test_old_host_protocol_rejects_private_media_before_http_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'wechat.json'
            file.write_text(json.dumps(dict(protocol=2)), encoding='utf-8')
            with patch('adapter.urlopen') as openRequest:
                with self.assertRaisesRegex(RuntimeError, '新版宿主协议'):
                    adapter.postHome(str(file), dict(media=[dict(id='image')]))
                openRequest.assert_not_called()


if __name__ == '__main__':
    unittest.main()
