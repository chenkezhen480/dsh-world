import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from types import SimpleNamespace
from adapter import MessageStore, run, watchConnected
from binding import WechatOffline
from sender import NativeSender


class PollComplete(Exception):
    pass


class ReconnectTest(unittest.TestCase):
    def test_offline_then_new_process_resumes_cursor_without_replaying_messages(self):
        old = dict(local_id=1, shard='m.db', sort_seq=10, type='文本', sender_username='wxid_owner', content='旧消息')
        new = {**old, 'local_id': 2, 'sort_seq': 11, 'content': '重开后刚到的消息'}
        oldDatabase = Mock(); oldDatabase.get_messages.side_effect = WechatOffline('微信退出')
        newDatabase = Mock(); newDatabase.get_messages.side_effect = lambda _chat,limit,offset=0: [new,old][offset:offset+limit]
        oldSend, newSend = Mock(), Mock()
        oldSend.processId, newSend.processId = 10, 20
        oldSend.probe.return_value = dict(version='4.1.15.13', stage=1, status=0)
        newSend.probe.return_value = dict(version='4.1.15.56', stage=1, status=0)
        connector = Mock(side_effect=[WechatOffline('尚未登录'), (oldDatabase,oldSend), (newDatabase,newSend)])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root/'state.sqlite')
            store.baseline('private',10,[old])
            # The loop ends at its first sleep, so the message must not wait in the buffer.
            config = dict(chats=[dict(id='private')], selfId='wxid_bot', moduleFile=str(root/'wechat.json'), pollSeconds=0.5, bufferSeconds=0)
            jobs = []
            def enqueue(*_):
                jobs.append(dict(id='a'*64, accountId='wxid_bot', chatId='private', messages=[dict(type='text',text='听到了')]))
                return dict(text='留在家里')
            ask = Mock(side_effect=enqueue)
            report, sleep, status = Mock(), Mock(), Mock()
            try:
                with patch('builtins.print') as logs, patch('adapter.time.sleep',side_effect=PollComplete), self.assertRaises(PollComplete):
                    watchConnected(config,root,store,connector,ask=ask,report=report,poll=lambda _: dict(job=jobs.pop(0) if jobs else None),sleep=sleep,status=status)
                self.assertEqual([call.args[1] for call in status.call_args_list],['offline','offline'], 'the console is told while waiting for the account')
                self.assertEqual(connector.call_count,3)
                self.assertEqual(sleep.call_count,2)
                self.assertEqual(sum('指定微信账号已离线' in str(call.args) for call in logs.call_args_list),2)
                self.assertTrue(any('4.1.15.13' in str(call.args) for call in logs.call_args_list))
                self.assertTrue(any('4.1.15.56' in str(call.args) for call in logs.call_args_list))
                oldSend.probe.assert_called_once_with()
                newSend.probe.assert_called_once_with()
                ask.assert_called_once()
                self.assertEqual(ask.call_args.args[1]['text'],new['content'])
                newSend.assert_called_once()
                oldSend.assert_not_called()
                oldSend.close.assert_called_once()
                newSend.close.assert_called_once()
                self.assertEqual(store.cursor('private'),11)
                store.checkPending()
                self.assertTrue(store.seen('private','m.db:1'))
                report.assert_called_once()
            finally: store.close()

    def test_pending_input_does_not_prevent_connecting_but_unrelated_connection_errors_still_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite')
            store.baseline('private',10)
            store.begin('private','m.db:11',11)
            database, send, sleep = Mock(), Mock(), Mock()
            send.probe.return_value = dict(version='4.1.15.13')
            connector = Mock(return_value=(database, send))
            config = dict(selfId='bot', moduleFile='unused', chats=[dict(id='private', name='伙伴')])
            try:
                with patch('adapter.time.sleep'), patch('sys.stderr'), self.assertRaises(PollComplete):
                    watchConnected(config,root,store,connector,poll=Mock(side_effect=[{}, PollComplete()]),sleep=sleep)
                connector.assert_called_once(); send.close.assert_called_once(); sleep.assert_not_called()
                database.get_messages.assert_not_called()
                with self.assertRaisesRegex(RuntimeError,'尚未确认'): store.checkPending()
                store.acknowledge('private','m.db:11')
                connector.reset_mock()
                connector.side_effect=RuntimeError('账号不唯一')
                with self.assertRaisesRegex(RuntimeError,'账号不唯一'):
                    watchConnected({},root,store,connector,poll=lambda _: {},sleep=sleep)
                connector.assert_called_once();sleep.assert_not_called()
            finally:store.close()

    def test_native_process_handle_is_closed_once(self):
        sender=object.__new__(NativeSender)
        sender.api=Mock();sender.api.CloseHandle.return_value=True;sender.handle=123
        sender.close();sender.close()
        sender.api.CloseHandle.assert_called_once_with(123)
        self.assertIsNone(sender.handle)

    def test_unsupported_build_is_rejected_before_claiming_jobs_or_advancing_cursor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root / 'state.sqlite')
            store.baseline('private', 10)
            config = dict(selfId='wxid_bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='private')])
            job = dict(id='a' * 64, accountId='wxid_bot', chatId='private', messages=[dict(type='text', text='queued')])
            database, send, ask, report = Mock(), Mock(), Mock(), Mock()
            database.get_messages.return_value = []
            send.probe.side_effect = send.side_effect = ValueError('不支持当前微信构建')
            poll = Mock(return_value=job)
            try:
                with self.assertRaisesRegex((ValueError, RuntimeError), '不支持当前微信构建'):
                    watchConnected(config, root, store, lambda *_: (database, send), ask=ask, report=report, poll=poll)
                poll.assert_not_called(); ask.assert_not_called(); send.assert_not_called()
                send.close.assert_called_once_with()
                self.assertEqual(store.cursor('private'), 10)
                self.assertIsNone(store.reply(job['id']))
                store.checkPending()
            finally: store.close()

    def test_reconnect_checks_the_new_build_before_claiming_another_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root / 'state.sqlite')
            store.baseline('private', 10)
            config = dict(selfId='wxid_bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='private')])
            job = dict(id='a' * 64, accountId='wxid_bot', chatId='private', messages=[dict(type='text', text='queued')])
            oldDatabase, newDatabase, oldSend, newSend = Mock(), Mock(), Mock(), Mock()
            oldDatabase.get_messages.side_effect = WechatOffline('微信升级重启')
            newDatabase.get_messages.return_value = []
            oldSend.probe.return_value = dict(version='4.1.15.13', stage=1, status=0)
            newSend.probe.side_effect = newSend.side_effect = ValueError('不支持当前微信构建')
            connector = Mock(side_effect=[(oldDatabase, oldSend), (newDatabase, newSend)])
            poll, ask = Mock(side_effect=[{}, dict(job=job)]), Mock()
            try:
                with self.assertRaisesRegex((ValueError, RuntimeError), '不支持当前微信构建'):
                    watchConnected(config, root, store, connector, ask=ask, report=Mock(), poll=poll, sleep=Mock(), status=Mock())
                self.assertEqual(poll.call_count, 1)
                oldSend.probe.assert_called_once_with(); newSend.probe.assert_called_once_with()
                oldSend.close.assert_called_once_with(); newSend.close.assert_called_once_with()
                ask.assert_not_called(); newSend.assert_not_called()
                self.assertEqual(store.cursor('private'), 10)
                self.assertIsNone(store.reply(job['id']))
                store.checkPending()
            finally: store.close()

    def test_manual_send_checks_readiness_before_marking_a_message_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = dict(selfId='wxid_bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='private')])
            database, send = Mock(), Mock()
            database.get_messages.return_value = []
            send.probe.side_effect = send.side_effect = ValueError('不支持当前微信构建')
            args = SimpleNamespace(command='send', allow_send=True, chat='private', text='queued')
            with patch('native.connect', return_value=(database, send)), self.assertRaisesRegex(ValueError, '不支持当前微信构建'):
                run(args, config, root)
            send.assert_not_called()
            send.close.assert_called_once_with()
            store = MessageStore(root / 'state.sqlite')
            try:
                self.assertIsNone(store.cursor('private'))
                store.checkPending()
            finally: store.close()

    def test_probe_reports_selected_build_and_only_submits_the_no_message_operation(self):
        from native import connect
        class Database:
            def __init__(self, **kwargs): self.account=kwargs['account']; self.wxid='wxid_bot'
        process = SimpleNamespace(pid=10, create_time=lambda: 100)
        nativeSender = SimpleNamespace(profile=dict(version='4.1.15.56'), send=Mock(return_value=dict(stage=1, status=0)), close=Mock())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = dict(account='bot', selfId='wxid_bot', dbDir=directory, moduleFile=str(root / 'wechat.json'), chats=[dict(id='private')])
            with patch('wechatauto.db.WeChatDB', Database), patch('native.findAccountProcess', return_value=process), patch('psutil.Process', return_value=process), patch('native.checkAccountProcess'), patch('sender.NativeSender', return_value=nativeSender):
                _, send = connect(config, root)
                try:
                    ready = send.probe()
                    self.assertEqual(ready.get('version'), '4.1.15.56')
                    nativeSender.send.assert_called_once_with('private', 0)
                finally: send.close()

    def test_process_loss_during_send_remains_uncertain_without_a_second_connection(self):
        row=dict(local_id=2,shard='m.db',sort_seq=11,type='文本',sender_username='wxid_owner',content='在吗')
        database=Mock();database.get_messages.side_effect=lambda _chat,limit,offset=0:[row][offset:offset+limit]
        send=Mock(side_effect=WechatOffline('发送期间微信退出'));send.processId=10
        send.probe.return_value=dict(version='4.1.15.13', stage=1, status=0)
        connector=Mock(return_value=(database,send))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite');store.baseline('private',10)
            config=dict(chats=[dict(id='private')],selfId='wxid_bot',moduleFile=str(root/'wechat.json'))
            jobs=[]
            def enqueue(*_):
                jobs.append(dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='答复')]))
                return dict(text='留在家里')
            ask=Mock(side_effect=enqueue)
            report,sleep=Mock(),Mock()
            try:
                with self.assertRaisesRegex(RuntimeError,'发送未确认'):
                    watchConnected(config,root,store,connector,ask=ask,report=report,poll=lambda _:dict(job=jobs.pop(0) if jobs else None),sleep=sleep)
                connector.assert_called_once();send.assert_called_once();ask.assert_called_once();sleep.assert_not_called()
                send.close.assert_called_once()
                with self.assertRaisesRegex(RuntimeError,'尚未确认'):store.checkPending()
                self.assertEqual(report.call_args.args[1]['status'],'uncertain')
            finally:store.close()

    def test_raw_message_read_rechecks_process_on_io_failure_without_swallowing_online_errors(self):
        from native import connect
        class Database:
            def __init__(self, **kwargs): self.account=kwargs['account'];self.wxid='wxid_bot'
            def _open_unlocked(self, _rel):return None
            def get_message_row(self, *_args, **_kwargs):return self._open_unlocked('message/message_0.db')
        process=SimpleNamespace(pid=10,create_time=lambda:100)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            config=dict(account='bot',selfId='wxid_bot',dbDir=directory,moduleFile=str(root/'wechat.json'))
            for offline in [False,True]:
                with self.subTest(offline=offline), patch('wechatauto.db.WeChatDB',Database), patch('native.findAccountProcess',return_value=process), patch('psutil.Process',return_value=process), patch('native.checkAccountProcess') as check, patch('native.checkedSnapshot',side_effect=FileNotFoundError('WAL disappeared')):
                    if offline:check.side_effect=[None,None,WechatOffline('微信退出')]
                    database,send=connect(config,root)
                    try:
                        with self.assertRaises(WechatOffline if offline else FileNotFoundError):
                            database.get_message_row('group',1)
                    finally:send.close()


if __name__ == '__main__':unittest.main()
