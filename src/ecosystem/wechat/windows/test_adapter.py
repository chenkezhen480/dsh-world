import contextlib
import io
import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from adapter import syncSettings, MessageStore, baselineChat, flushReceipts, messageKey, newMessages, normalizeMessage, validateConfig, watch
from sender import selectProfile


class AdapterTest(unittest.TestCase):
    def test_unknown_core_build_exits_with_the_supervisors_non_retryable_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            core = root / '4.2.0.52' / 'Weixin.dll'
            core.parent.mkdir()
            core.write_bytes(b'unknown build')
            moduleFile = root / 'wechat.json'
            moduleFile.write_text('{"references":true}', encoding='utf-8')
            config = root / 'config.json'
            config.write_text(json.dumps(dict(account='wxid_bot_abcd', selfId='wxid_bot', dbDir=str(root),
                                              moduleFile=str(moduleFile), chats=[dict(id='family@chatroom', name='家庭群', trigger='mention')])), encoding='utf-8')
            argv = ['adapter.py', 'watch', '--config', str(config), '--allow-send']
            error = io.StringIO()
            with patch.object(sys, 'argv', argv), patch('native.connect', side_effect=lambda *_: selectProfile(core, [])), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as exit:
                runpy.run_module('adapter', run_name='__main__')
            self.assertEqual(exit.exception.code, 4, error.getvalue())
            self.assertIn('不支持当前微信构建', error.getvalue())

    def test_receipts_survive_restart_and_only_retry_writeback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.sqlite'
            store = MessageStore(path)
            store.beginReply('a' * 64, 3)
            store.confirmReply('a' * 64, 1)
            store.close()
            store = MessageStore(path)
            try:
                receipts = []
                def failedPost(_file, receipt):
                    raise RuntimeError('offline')
                with self.assertRaisesRegex(RuntimeError, 'offline'):
                    flushReceipts('module', store, failedPost)
                flushReceipts('module', store, lambda _file, receipt: receipts.append(receipt))
                self.assertEqual(receipts, [dict(id='a' * 64, confirmed=1, status='uncertain')])
                self.assertEqual(store.pendingReceipts(), [])
                store.confirmReply('a' * 64, 3)
                flushReceipts('module', store, lambda _file, receipt: receipts.append(receipt))
                self.assertEqual(receipts[-1], dict(id='a' * 64, confirmed=3, status='sent'))
            finally:
                store.close()

    def test_ids_are_real_senders_and_self_echoes_are_ignored(self):
        row = dict(local_id=9, shard='message_1.db', sort_seq=20, type='文本', sender_username='wxid_mom', content='wxid_mom:\n你好')
        message = normalizeMessage(row, 'family@chatroom', 'wxid_bot')
        self.assertEqual(message['identity']['speakerId'], 'wechat:wxid_mom')
        self.assertEqual(message['text'], '你好')
        self.assertIsNone(normalizeMessage({**row, 'sender_username': 'wxid_bot'}, 'family@chatroom', 'wxid_bot'))
        with self.assertRaises(ValueError):
            normalizeMessage({**row, 'sender_username': ''}, 'family@chatroom', 'wxid_bot')
        with self.assertRaises(ValueError):
            messageKey({**row, 'shard': ''})

    def test_pagination_keeps_messages_with_equal_sequence_across_pages(self):
        class Database:
            def get_messages(self, user, limit, offset=0):
                return rows[offset:offset+limit]
        rows = [dict(local_id=n, shard='m.db', sort_seq=12 if n >= 3 else 10) for n in range(6, 0, -1)]
        result = newMessages(Database(), 'group', 11, 2)
        self.assertEqual(len(result), 4)
        self.assertEqual([r['local_id'] for r in result], [3, 4, 5, 6])

    def test_uncertain_delivery_is_not_silently_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            store.baseline('group', 10)
            store.begin('group', 'shard:11', 11)
            with self.assertRaises(RuntimeError):
                store.checkPending()
            store.finish('group', 'shard:11', 11)
            store.checkPending()
            self.assertTrue(store.seen('group', 'shard:11'))
            self.assertEqual(store.cursor('group'), 11)
            store.close()

    def test_config_requires_an_explicit_account_and_unique_targets_but_pid_is_optional(self):
        config = dict(account='wxid_bot_abcd', selfId='wxid_bot', processId=123, dbDir='D:/data', moduleFile='D:/wechat.json', chats=[dict(id='family@chatroom', name='家庭群', trigger='mention')])
        validateConfig(config)
        validateConfig({key:value for key,value in config.items() if key!='processId'})
        with self.assertRaises(ValueError):
            validateConfig({**config, 'account': ''})
        with self.assertRaises(ValueError):
            validateConfig({**config, 'chats': config['chats'] * 2})
        validateConfig({**config, 'chats': [dict(id='group1@chatroom', name='家', trigger='mention'), dict(id='group2@chatroom', name='家', trigger='mention')]})

    def test_startup_does_not_skip_a_message_arriving_during_baseline(self):
        old = dict(local_id=1, shard='m.db', sort_seq=10, type='文本', sender_username='wxid_mom', content='旧消息')
        new = dict(local_id=2, shard='m.db', sort_seq=11, type='文本', sender_username='wxid_mom', content='刚到的消息')
        class Database:
            def get_messages(self, user, limit, offset=0):
                return [old] if limit == 1 else [new, old][offset:offset+limit]
        calls = []
        def ask(_file, message):
            calls.append(message['text'])
            raise RuntimeError('stop after observing the new message')
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            with self.assertRaises(RuntimeError):
                watch(dict(chats=[dict(id='group')], selfId='wxid_bot', moduleFile='unused'), Database(), store, lambda *_: None, ask, poll=lambda _: {})
            self.assertEqual(calls, ['刚到的消息'])
            store.close()

    def test_manual_send_baseline_does_not_replay_history_or_consume_new_tied_messages(self):
        rows = [dict(local_id=2, shard='m.db', sort_seq=10), dict(local_id=1, shard='m.db', sort_seq=9)]
        class Database:
            def get_messages(self, user, limit, offset=0):
                return rows[offset:offset+limit]
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            baselineChat(Database(), store, 'group', 2)
            self.assertEqual(store.cursor('group'), 10)
            self.assertTrue(store.seen('group', 'm.db:2'))
            rows.insert(0, dict(local_id=3, shard='m.db', sort_seq=10))
            baselineChat(Database(), store, 'group', 2)
            unseen = [row for row in newMessages(Database(), 'group', store.cursor('group'), 2)
                      if not store.seen('group', f"m.db:{row['local_id']}")]
            self.assertEqual([row['local_id'] for row in unseen], [3])
            store.close()


if __name__ == '__main__':
    unittest.main()


class SettingsSyncTests(unittest.TestCase):
    def test_syncSettings_accepts_only_in_range_numbers(self):
        config = {}
        syncSettings(config, {'contextMessages': 12, 'bufferSeconds': 1.5})
        self.assertEqual((config['contextMessages'], config['bufferSeconds']), (12, 1.5))
        syncSettings(config, {'contextMessages': 0, 'bufferSeconds': 99})
        syncSettings(config, {'contextMessages': True, 'bufferSeconds': '3'})
        syncSettings(config, None)
        self.assertEqual((config['contextMessages'], config['bufferSeconds']), (12, 1.5))


class NeedsHumanTests(unittest.TestCase):
    def test_pending_message_asks_for_a_person_and_stays_a_runtime_error(self):
        from adapter import NeedsHuman, EXIT_NEEDS_HUMAN
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            try:
                store.beginBatch('owner', [dict(local_id=1, shard='m.db', sort_seq=11, type='文本')])
                with self.assertRaises(NeedsHuman) as caught: store.checkPending()
                self.assertIsInstance(caught.exception, RuntimeError)
                self.assertEqual(EXIT_NEEDS_HUMAN, 2)
            finally: store.close()
