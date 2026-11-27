import tempfile
import unittest
from pathlib import Path
from adapter import MessageStore, flushReading, watch, pollOutgoing
from presence import GroupPresence, seedPresence
from unittest.mock import patch


def row(seq, sender='dad'):
    return dict(sort_seq=seq, shard='m.db', local_id=seq, create_time=1700000000 + seq,
                sender_username=sender, type='文本', content='不得上传的正文')


class PresenceTest(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = root / 'state.sqlite'
        self.store = MessageStore(self.path)
        self.addCleanup(lambda: self.store.close())
        self.config = dict(selfId='bot', chats=[dict(id='family@chatroom', name='家人')], moduleFile='unused', pageSize=2)
        self.chat = self.config['chats'][0]

    def test_counts_are_durable_deduplicated_account_scoped_and_never_keep_message_bodies(self):
        p = GroupPresence(self.store.db)
        p.observe('bot', self.chat['id'], row(1), '爸爸')
        p.observe('bot', self.chat['id'], row(1), '爸爸')
        p.observe('bot', self.chat['id'], row(2, 'bot'), '鲸鲸')
        self.store.close(); self.store = MessageStore(self.path)
        p = GroupPresence(self.store.db)
        result = p.snapshot(self.config)
        self.assertEqual(result[0]['count'], 1)
        self.assertEqual(result[0]['lastSelf'], True)
        self.assertNotIn('不得上传的正文', str(result))
        self.assertEqual(p.snapshot({**self.config, 'selfId': 'other'}), [])
        self.assertEqual(p.snapshot({**self.config, 'chats': []}), [])
        p.observe('bot', self.chat['id'], {**row(3), 'type': '系统消息'}, '')
        self.assertEqual(p.snapshot(self.config), result)

    def test_seed_is_paginated_and_does_not_swallow_messages_after_the_receive_cursor(self):
        calls = []
        class Database:
            def get_messages(_, chat, limit, offset=0):
                calls.append((limit, offset)); return [row(i) for i in range(6, 0, -1)][offset:offset+limit]
            def get_nickname(_, sender): return '爸爸'
        self.store.baseline(self.chat['id'], 3)
        seedPresence(Database(), self.store, self.config, self.chat)
        p = GroupPresence(self.store.db)
        self.assertEqual(p.snapshot(self.config)[0]['count'], 0)
        p.observe('bot', self.chat['id'], row(4), '爸爸')
        self.assertEqual(p.snapshot(self.config)[0]['count'], 1)
        self.assertEqual(calls, [(2, 0), (2, 2), (2, 4)])

    def test_successful_latest_read_clears_without_counting_read_rows_again_and_failed_reads_preserve(self):
        p = GroupPresence(self.store.db)
        p.observe('bot', self.chat['id'], row(1), '爸爸')
        request = dict(id='a'*32, accountId='bot', chatId=self.chat['id'])
        result = dict(messages=[], readThrough=[3, 'm.db', 3], readRows=[row(3)])
        class Database:
            def get_messages(_, chat, limit, offset=0): return [row(3), row(2), row(1)][offset:offset+limit]
            def get_nickname(_, sender): return '爸爸'
        with patch('adapter.readHistory', return_value=result), patch('adapter.postHome', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError): flushReading(self.config, Database(), request, self.store)
        self.assertEqual(p.snapshot(self.config)[0]['count'], 1)
        with patch('adapter.readHistory', return_value=dict(result)), patch('adapter.postHome', return_value=dict(readAccepted=True)) as post:
            flushReading(self.config, Database(), request, self.store)
            self.assertNotIn('readThrough', post.call_args.args[1]['readResult'])
            self.assertNotIn('readRows', post.call_args.args[1]['readResult'])
        p.observe('bot', self.chat['id'], row(2), '爸爸')
        p.observe('bot', self.chat['id'], row(3), '爸爸')
        self.assertEqual(p.snapshot(self.config)[0]['count'], 0)
        p.observe('bot', self.chat['id'], row(4), '爸爸')
        p.markRead('bot', self.chat['id'], [3, 'm.db', 3])
        self.assertEqual(p.snapshot(self.config)[0]['count'], 1)

    def test_unmentioned_group_activity_never_asks_or_sends_and_poll_contains_only_metadata(self):
        class Database:
            def get_messages(_, chat, limit, offset=0): return [row(2), row(1)][offset:offset+limit]
            def get_nickname(_, sender): return '爸爸'
            def get_message_row(_, *args, **kwargs): return dict(source='<msgsource/>')
        self.store.baseline(self.chat['id'], 1, [row(1)])
        with patch('adapter.time.sleep', side_effect=StopIteration), patch('adapter.askHome') as ask:
            with self.assertRaises(StopIteration):
                watch(self.config, Database(), self.store, lambda *args: self.fail('must not send'),
                      ask=lambda *args: self.fail('must not ask'), poll=lambda _: {})
            ask.assert_not_called()
        with patch('adapter.postHome', return_value={}) as post:
            pollOutgoing(self.config)
            binding = post.call_args.args[1]['outbox']
        self.assertEqual(binding['presence']['groups'][0]['count'], 1)
        self.assertNotIn('不得上传的正文', str(binding))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM messages').fetchone()[0], 1, 'ordinary messages must not add per-message state')
        self.store.checkPending()

    def test_a_line_that_names_nobody_is_passed_over_and_the_group_keeps_being_read(self):
        # A pat card arrives with no sender; it used to stop the adapter on every poll (#70).
        pat = {**row(2, ''), 'type': '拍一拍', 'content': '「爸爸」拍了拍「鲸鲸」'}
        class Database:
            def get_messages(_, chat, limit, offset=0): return [row(3), pat, row(1)][offset:offset+limit]
            def get_nickname(_, sender): return '爸爸'
            def get_message_row(_, *args, **kwargs): return dict(source='<msgsource/>')
        self.store.baseline(self.chat['id'], 1, [row(1)])
        with patch('adapter.time.sleep', side_effect=StopIteration), patch('sys.stderr'):
            with self.assertRaises(StopIteration):
                watch(self.config, Database(), self.store, lambda *args: self.fail('must not send'),
                      ask=lambda *args: self.fail('must not ask'), poll=lambda _: {})
        self.assertEqual(self.store.cursor(self.chat['id']), 3, 'read past it')
        self.assertEqual(GroupPresence(self.store.db).snapshot(self.config)[0]['count'], 1, 'only the line with a speaker counts')
        self.store.checkPending()

    def test_many_groups_keep_all_counters_but_report_a_bounded_summary(self):
        chats = [dict(id=f'{i}@chatroom', name=str(i)) for i in range(20)]
        for i, chat in enumerate(chats): self.store.presence.observe('bot', chat['id'], row(i+1), '爸爸')
        config = {**self.config, 'chats': chats}
        self.assertEqual(len(self.store.presence.snapshot(config)), 8)
        self.assertEqual(self.store.presence.snapshot({**config, 'chats': chats[:1]})[0]['count'], 1)

    def test_ignored_read_does_not_clear_and_a_stale_boundary_only_clears_its_own_unread(self):
        p = self.store.presence
        for i in [1, 2]: p.observe('bot', self.chat['id'], row(i), '爸爸')
        request = dict(id='a'*32, accountId='bot', chatId=self.chat['id'])
        class Database:
            def get_messages(_, chat, limit, offset=0): return [row(2), row(1)][offset:offset+limit]
            def get_nickname(_, sender): return '爸爸'
        result = dict(messages=[], readThrough=[1, 'm.db', 1], readRows=[row(1)])
        with patch('adapter.readHistory', return_value={**result, 'readThrough': [2, 'm.db', 2]}), patch('adapter.postHome', return_value=dict(readAccepted=False)):
            flushReading(self.config, Database(), request, self.store)
        self.assertEqual(p.snapshot(self.config)[0]['count'], 2)
        with patch('adapter.readHistory', return_value=result), patch('adapter.postHome', return_value=dict(readAccepted=True)):
            flushReading(self.config, Database(), request, self.store)
        self.assertEqual(p.snapshot(self.config)[0]['count'], 1)

    def test_read_before_first_scan_still_seeds_the_last_speaker(self):
        self.store.presence.markRead('bot', self.chat['id'], [2, 'm.db', 2])
        self.store.baseline(self.chat['id'], 2)
        class Database:
            def get_messages(_, chat, limit, offset=0): return [row(2), row(1)][offset:offset+limit]
            def get_nickname(_, sender): return '爸爸'
        seedPresence(Database(), self.store, self.config, self.chat)
        self.assertEqual(self.store.presence.snapshot(self.config)[0]['lastSpeaker'], '爸爸')

    def test_same_sequence_late_shards_are_counted_once_across_restart_and_after_reading(self):
        p = self.store.presence
        first = {**row(10), 'shard': 'b.db', 'local_id': 1}
        late = {**row(10), 'shard': 'a.db', 'local_id': 2}
        p.observe('bot', self.chat['id'], first, '爸爸')
        self.store.close(); self.store = MessageStore(self.path); p = self.store.presence
        p.observe('bot', self.chat['id'], late, '爸爸')
        p.observe('bot', self.chat['id'], late, '爸爸')
        self.assertEqual(p.snapshot(self.config)[0]['count'], 2)
        p.markRead('bot', self.chat['id'], [10, 'b.db', 1], seenKeys=['b.db:1', 'a.db:2'])
        p.observe('bot', self.chat['id'], {**late, 'local_id': 3}, '爸爸')
        self.assertEqual(p.snapshot(self.config)[0]['count'], 1)
        p.markRead('bot', self.chat['id'], [10, 'b.db', 1], seenKeys=['b.db:1', 'a.db:2'])
        self.assertEqual(p.snapshot(self.config)[0]['count'], 1, 'an old acknowledgement must not consume a later arrival')
        p.markRead('bot', self.chat['id'], [10, 'b.db', 1], seenKeys=['b.db:1', 'a.db:2', 'a.db:3'])
        self.assertEqual(p.snapshot(self.config)[0]['count'], 0, 'a fresh read at the same boundary consumes the late arrival')

    def test_reading_never_marks_a_later_same_sequence_arrival_as_already_read(self):
        first = {**row(10), 'shard': 'b.db', 'local_id': 1}
        late = {**row(10), 'shard': 'a.db', 'local_id': 3}
        class Database:
            calls = 0
            def get_messages(db, chat, limit, offset=0):
                db.calls += 1
                return [first] if db.calls == 1 else [first, late][offset:offset+limit]
            def get_nickname(_, sender): return '爸爸'
        self.store.presence.observe('bot', self.chat['id'], first, '爸爸')
        request = dict(id='a'*32, accountId='bot', chatId=self.chat['id'])
        with patch('adapter.postHome', return_value=dict(readAccepted=True)):
            flushReading(self.config, Database(), request, self.store)
        self.store.presence.observe('bot', self.chat['id'], late, '爸爸')
        self.assertEqual(self.store.presence.snapshot(self.config)[0]['count'], 1)
