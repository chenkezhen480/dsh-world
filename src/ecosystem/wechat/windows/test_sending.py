import tempfile
import unittest
import threading
import io
from urllib.error import HTTPError
from unittest.mock import Mock, patch
from pathlib import Path
from adapter import MessageStore, flushOutgoing, watch


class SendingTest(unittest.TestCase):
    def test_pending_incoming_holds_only_its_own_chat_while_other_chats_and_outgoing_keep_running(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root / 'state.sqlite')
            store.baseline('family@chatroom', 10); store.baseline('private', 20)
            store.begin('family@chatroom', 'm.db:11', 11)
            config = dict(selfId='bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='family@chatroom', name='家人', trigger='all'), dict(id='private', name='伙伴')])
            job = dict(id='b' * 64, accountId='bot', chatId='private', messages=[dict(type='text', text='独立消息')])
            poll = Mock(side_effect=[dict(job=job), {}, {}, {}, {}, StopIteration('done')])
            rows = {'family@chatroom': [dict(local_id=12, shard='m.db', sort_seq=12, type='文本', sender_username='aunt', content='群里新消息')],
                    'private': [dict(local_id=21, shard='m.db', sort_seq=21, type='文本', sender_username='owner', content='私聊还在')]}
            database = Mock(); database.get_messages.side_effect = lambda chat, limit, offset=0: rows[chat][offset:offset + limit]
            asked, send = [], Mock()
            try:
                with patch('adapter.time.sleep'), patch('sys.stderr') as stderr, self.assertRaises(StopIteration):
                    watch(config, database, store, send, ask=lambda _file, message: asked.append(message['text']) or dict(text=''), report=lambda *_: None, poll=poll)
                send.assert_called_once_with(config['chats'][1], dict(type='text', text='独立消息'))
                self.assertEqual(asked, ['私聊还在'], 'a group waiting to be checked no longer stops private chats')
                self.assertEqual(store.cursor('family@chatroom'), 10, 'the held group is not read past its unconfirmed message')
                self.assertEqual(store.pendingChats(), {'family@chatroom': 'm.db:11'})
                self.assertEqual(''.join(call.args[0] for call in stderr.write.call_args_list).count('仅此聊天'), 1, 'said once, not every poll')
            finally: store.close()

    def test_uncertain_claim_only_reports_its_receipt_and_does_not_block_the_next_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root / 'state.sqlite')
            store.baseline('private', 10); store.beginReply('a' * 64, 1, 'private', 10)
            config = dict(selfId='bot', moduleFile=str(root / 'wechat.json'), chats=[dict(id='private', name='伙伴')])
            first = dict(id='a' * 64, accountId='bot', chatId='private', messages=[dict(type='text', text='结果不明，不能再发')])
            second = {**first, 'id': 'b' * 64, 'messages': [dict(type='text', text='另一条独立任务')]}
            work = [dict(job=first), dict(job=second), {}]
            send, report = Mock(), Mock()
            try:
                flushOutgoing(config, None, store, send, poll=lambda _: work.pop(0), report=report)
                send.assert_called_once_with(config['chats'][0], second['messages'][0])
                self.assertEqual(store.reply(first['id'])['status'], 'uncertain')
                self.assertEqual(store.reply(second['id'])['status'], 'sent')
                with self.assertRaisesRegex(RuntimeError, 'outgoing:'): store.checkPending()
            finally: store.close()

    def test_failed_generation_is_not_repeated_while_its_queued_reply_can_still_send(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root / 'state.sqlite'); store.baseline('private', 10)
            file = root / 'wechat.json'
            file.write_text('{"origin":"http://127.0.0.1:1234","path":"/dsh-world/wechat/ask","token":"secret"}', encoding='utf-8')
            config = dict(selfId='bot', moduleFile=str(file), chats=[dict(id='private', name='伙伴')], pollSeconds=0.001)
            row = dict(local_id=11, shard='m.db', sort_seq=11, type='文本', sender_username='owner', content='在吗')
            database = Mock(); database.get_messages.side_effect = lambda _chat, limit, offset=0: [row][offset:offset + limit]
            job = dict(id='a' * 64, accountId='bot', chatId='private', messages=[dict(type='text', text='已经生成的回复')])
            sent, polls = [], [0]
            def poll(_config):
                polls[0] += 1
                if polls[0] > 4 and sent: raise StopIteration('done')
                return dict(job=job) if store.seen('private', 'm.db:11') and not sent else {}
            error = HTTPError('http://127.0.0.1:1234', 503, 'Unavailable', {}, io.BytesIO(b'{"error":"delivery must be checked"}'))
            try:
                with patch('adapter.urlopen', side_effect=error) as request, patch('sys.stderr'), self.assertRaises(StopIteration):
                    watch(config, database, store, lambda _chat, item: sent.append(item), report=lambda *_: None, poll=poll)
                self.assertEqual(request.call_count, 1)
                self.assertEqual(sent, job['messages'])
                self.assertEqual(store.cursor('private'), 10)
                with self.assertRaisesRegex(RuntimeError, 'm.db:11'): store.checkPending()
            finally: store.close()

    def test_model_wait_does_not_block_native_delivery_or_require_the_turn_to_end(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite');store.baseline('private',10)
            row=dict(local_id=2,shard='m.db',sort_seq=11,type='文本',sender_username='owner',content='来聊天')
            class Database:
                def get_messages(self,_chat,limit,offset=0):return [row][offset:offset+limit]
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')],pollSeconds=0.01)
            jobs=[];sent=[];delivered=threading.Event()
            def ask(*_):
                jobs.append(dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='边聊边发')]))
                if not delivered.wait(1):raise RuntimeError('model waited for delivery, but native sender was blocked')
                return dict(text='现在整轮才结束')
            def send(_chat,item):sent.append(item['text']);delivered.set()
            def poll(_):
                if store.cursor('private')==11:raise StopIteration('本轮验证完成')
                return dict(job=jobs.pop(0) if jobs else None)
            try:
                with self.assertRaises(StopIteration):
                    watch(config,Database(),store,send,ask=ask,report=lambda *_:None,poll=poll)
                self.assertEqual(sent,['边聊边发']);store.checkPending()
            finally:store.close()

    def test_confirmed_send_only_reposts_receipt_after_host_network_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite');store.baseline('private',10)
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')])
            job=dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='只发一次')])
            sent=[]
            def offline(*_):raise RuntimeError('回执网络失败')
            try:
                with self.assertRaisesRegex(RuntimeError,'回执网络失败'):
                    flushOutgoing(config,None,store,lambda _chat,item:sent.append(item),poll=lambda _:dict(job=job),report=offline)
                store.checkPending()
                jobs=[job,None];receipts=[]
                flushOutgoing(config,None,store,lambda *_:sent.append('重复'),poll=lambda _:dict(job=jobs.pop(0)),report=lambda _file,r:receipts.append(r))
                self.assertEqual(len(sent),1)
                self.assertEqual(receipts[-1],dict(id='a'*64,confirmed=1,status='sent'))
            finally:store.close()

    def test_proactive_and_reactive_jobs_share_ordered_delivery_without_model_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root / 'state.sqlite')
            config = dict(selfId='wxid_bot', moduleFile=str(root/'wechat.json'), chats=[dict(id='private',name='伙伴'),dict(id='family@chatroom',name='家人',trigger='mention')])
            store.baseline('private',10); store.baseline('family@chatroom',20)
            jobs = [dict(id='a'*64, accountId='wxid_bot', chatId='private', messages=[dict(type='text',text='主动一句'),dict(type='text',text='再一句')]),
                    dict(id='b'*64, accountId='wxid_bot', chatId='family@chatroom', messages=[dict(type='text',text='群里一句')])]
            sent, receipts = [], []
            def poll(_config): return dict(job=jobs.pop(0) if jobs else None)
            try:
                flushOutgoing(config, None, store, lambda chat,item: sent.append((chat['id'],item['text'])), poll=poll, report=lambda _file,receipt: receipts.append(receipt))
                self.assertEqual(sent,[('private','主动一句'),('private','再一句'),('family@chatroom','群里一句')])
                self.assertEqual([(r['confirmed'],r['status']) for r in receipts],[(2,'sent'),(1,'sent')])
                store.checkPending()
            finally: store.close()

    def test_uncertain_delivery_is_never_replayed_after_restart_and_keeps_manual_barrier(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root/'state.sqlite'); store.baseline('private',10)
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')])
            job=dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='一'),dict(type='text',text='二')])
            sent,receipts=[],[]
            def send(_chat,item):
                sent.append(item['text'])
                if len(sent)==2:raise RuntimeError('断开，结果不明')
            try:
                with self.assertRaisesRegex(RuntimeError,'第 2/2 条'):
                    flushOutgoing(config,None,store,send,poll=lambda _config:dict(job=job),report=lambda _file,r:receipts.append(r))
                self.assertEqual(receipts[-1],dict(id='a'*64,confirmed=1,status='uncertain'))
                store.close();store=MessageStore(root/'state.sqlite')
                jobs = [job, None]
                flushOutgoing(config,None,store,send,poll=lambda _config:dict(job=jobs.pop(0)),report=lambda *_:None)
                with self.assertRaisesRegex(RuntimeError,'尚未确认'): store.checkPending()
                self.assertEqual(sent,['一','二'])
            finally:store.close()

    def test_received_claim_with_an_existing_receipt_only_reposts_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite')
            store.beginReply('a'*64,1);store.confirmReply('a'*64,1)
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')])
            job=dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='已经发过')])
            jobs=[job,None]; sent,receipts=[],[]
            try:
                flushOutgoing(config,None,store,lambda *_:sent.append(True),poll=lambda _config:dict(job=jobs.pop(0)),report=lambda _file,r:receipts.append(r))
                self.assertEqual(sent,[])
                self.assertEqual(receipts[-1]['status'],'sent')
            finally:store.close()

    def test_job_cannot_override_bound_account_or_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite')
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')])
            job=dict(id='a'*64,accountId='wxid_other',chatId='private',messages=[dict(type='text',text='不要发送')])
            sent=[]
            try:
                with self.assertRaises(ValueError):flushOutgoing(config,None,store,lambda *_:sent.append(True),poll=lambda _config:dict(job=job))
                job={**job,'accountId':'wxid_bot','chatId':'unselected'}
                with self.assertRaises(ValueError):flushOutgoing(config,None,store,lambda *_:sent.append(True),poll=lambda _config:dict(job=job))
                self.assertEqual(sent,[])
            finally:store.close()


if __name__=='__main__':unittest.main()
