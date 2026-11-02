import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import adapter
from adapter import MessageStore


def text(local_id, content, sender='owner', **extra):
    return dict(local_id=local_id, shard='m.db', sort_seq=local_id, create_time=100 + local_id, type='文本', sender_username=sender, content=content, **extra)


class Clock:
    """Messages appear at given times; `sleep` moves time on."""
    def __init__(self, timeline):
        self.now, self.timeline = 0.0, timeline
    def time(self): return self.now
    def sleep(self, seconds): self.now += seconds
    def rows(self, _chat, limit, offset=0):
        arrived = [row for at, row in self.timeline if at <= self.now]
        return list(reversed(arrived))[offset:offset + limit]


class BufferTest(unittest.TestCase):
    def buffer(self, timeline, chat='owner', config=None):
        clock = Clock(timeline)
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            try:
                rows = adapter.bufferMessages(config or {}, SimpleNamespace(get_messages=clock.rows), store, dict(id=chat), timeline[0][1], clock=clock.time, sleep=clock.sleep)
            finally: store.close()
        return [row['local_id'] for row in rows], clock.now

    def test_each_new_message_from_the_sender_restarts_the_wait(self):
        ids, waited = self.buffer([(0, text(1, '在吗')), (2, text(2, '我跟你说')), (4.5, text(3, '今天好累'))])
        self.assertEqual(ids, [1, 2, 3])
        self.assertAlmostEqual(waited, 7.5, delta=0.2, msg='quiet for 3s after the last one')

    def test_a_pause_longer_than_the_buffer_starts_the_next_request(self):
        ids, waited = self.buffer([(0, text(1, '在吗')), (3.5, text(2, '晚点再说'))])
        self.assertEqual(ids, [1]); self.assertAlmostEqual(waited, 3, delta=0.2)

    def test_someone_else_speaking_ends_the_wait_at_once(self):
        ids, waited = self.buffer([(0, text(1, '大家好', 'aunt')), (0.5, text(2, '你好', 'uncle'))], chat='family@chatroom')
        self.assertEqual(ids, [1]); self.assertLess(waited, 1)

    def test_the_wait_is_capped_and_the_merged_text_fits_the_home_limit(self):
        chatter = [(index * 2.0, text(index + 1, f'第{index}句')) for index in range(30)]
        ids, waited = self.buffer(chatter)
        self.assertLessEqual(waited, adapter.MAX_BUFFER_SECONDS + 0.2)
        self.assertLessEqual(len(ids), adapter.MAX_BATCH_ROWS)
        ids, _ = self.buffer([(0, text(1, '一' * 1500)), (1, text(2, '二' * 600))])
        self.assertEqual(ids, [1], 'a line that would push the request past 2000 characters waits for the next one')

    def test_a_group_line_without_a_call_joins_the_one_that_called_her_and_keeps_its_identity(self):
        first = text(1, 'aunt:\n@小鱼 晚上吃什么', 'aunt')
        rows = [first, text(2, 'aunt:\n要不吃火锅', 'aunt')]
        database = SimpleNamespace(get_nickname=lambda _wxid: '阿姨')
        message = dict(text='@小鱼 晚上吃什么', identity=dict(conversationType='group', platformMessageId='m.db:1', mentionIds=['wechat:bot']))
        adapter.mergeFollowing(database, dict(id='family@chatroom', name='家人'), dict(selfId='bot'), message, rows[1:])
        self.assertEqual(message['text'], '@小鱼 晚上吃什么\n要不吃火锅')
        self.assertEqual(message['identity']['platformMessageId'], 'm.db:1')
        self.assertEqual(message['identity']['mentionIds'], ['wechat:bot'])

    def test_private_messages_typed_in_a_burst_are_one_request(self):
        timeline = [(0, text(1, '在吗')), (1, text(2, '我想问你')), (2, text(3, '周末去哪'))]
        clock, asked = Clock(timeline), []
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite'); store.baseline('owner', 0)
            clock.now = 2
            config = dict(selfId='bot', moduleFile=str(Path(directory) / 'wechat.json'), chats=[dict(id='owner', name='伙伴')])
            def poll(_config):
                if store.cursor('owner') == 3: raise StopIteration('done')
                return {}
            try:
                with patch('adapter.time.monotonic', clock.time), patch('adapter.time.sleep', clock.sleep), self.assertRaises(StopIteration):
                    adapter.watch(config, SimpleNamespace(get_messages=clock.rows), store, lambda *_: None, ask=lambda _file, message: asked.append(message) or dict(text='ok'), report=lambda *_: None, poll=poll)
                self.assertEqual([message['text'] for message in asked], ['在吗\n我想问你\n周末去哪'])
                self.assertEqual(asked[0]['identity']['platformMessageId'], 'm.db:3')
                store.checkPending()
            finally: store.close()


if __name__ == '__main__':
    unittest.main()
