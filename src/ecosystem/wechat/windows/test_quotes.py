import tempfile
import unittest
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from xml.sax.saxutils import escape

from adapter import MessageStore, incomingMessage, postHome, watch
from incoming import ImageUnavailable, IncomingImages, referenceRow, saveImage
from messages import normalizeMessage
from reading import readHistory


def quoteRow(kind='1', content='引用内容样例', title='继续讨论这个问题', **extra):
    xml = f'<msg><appmsg><title>{escape(title)}</title><type>57</type><refermsg><type>{kind}</type><svrid>9007199254740993</svrid><fromusr>bot</fromusr><displayname>她</displayname><content>{escape(content)}</content></refermsg></appmsg></msg>'
    return dict(local_id=218, shard='m.db', sort_seq=10, create_time=1700000000, sender_username='owner', type='文件/链接/卡片', content=xml, **extra)


class QuoteTest(unittest.TestCase):
    def test_old_host_cannot_silently_discard_reference_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'wechat.json'
            file.write_text(json.dumps(dict(protocol=4, origin='http://127.0.0.1:1', path='/dsh-world/wechat/ask', token='test')), encoding='utf-8')
            with patch('adapter.urlopen') as request:
                with self.assertRaisesRegex(RuntimeError, '引用'):
                    postHome(file, dict(text='新留言', reference=dict(type='text', text='旧留言')))
                request.assert_not_called()

    def test_real_text_quote_keeps_current_words_and_original_author_separate(self):
        message = normalizeMessage(quoteRow(), 'owner', 'bot')
        self.assertIsNotNone(message)
        self.assertEqual(message['text'], '继续讨论这个问题')
        self.assertEqual(message['identity']['speakerId'], 'wechat:owner')
        self.assertEqual(message['reference']['id'], '9007199254740993')
        self.assertEqual(message['reference']['speakerId'], 'wechat:bot')
        self.assertEqual(message['reference']['text'], '引用内容样例')
        self.assertNotIn('<appmsg', str(message))

    def test_private_image_and_sticker_quotes_reuse_media_reader_without_changing_speaker(self):
        for kind, expected in [('3', 'image'), ('47', 'sticker')]:
            with self.subTest(kind=kind):
                image = dict(file='a' * 64 + '.png', quality='original', firstFrame=True)
                database = SimpleNamespace(readReference=Mock(return_value=image))
                message = incomingMessage(database, dict(id='owner', name='伙伴'), quoteRow(kind, '<msg><private-media/></msg>'), dict(selfId='bot'))
                self.assertIsNotNone(message)
                self.assertEqual(message['reference']['type'], expected)
                self.assertEqual(message['reference']['image'], image)
                self.assertNotIn('未读取', message['reference']['text'])
                self.assertEqual(message['identity']['speakerId'], 'wechat:owner')
                database.readReference.assert_called_once()
                self.assertNotIn('private-media', str(message))
                database.readReference.side_effect = ImageUnavailable('原消息不在本机')
                missing = incomingMessage(database, dict(id='owner'), quoteRow(kind), dict(selfId='bot'))
                self.assertNotIn('image', missing['reference'])
                self.assertIn('原消息不在本机', missing['reference']['text'])
                database.readReference.side_effect = RuntimeError('账号绑定错误')
                with self.assertRaisesRegex(RuntimeError, '账号绑定错误'):
                    incomingMessage(database, dict(id='owner'), quoteRow(kind), dict(selfId='bot'))

    def test_group_quotes_still_require_a_real_mention_and_history_uses_same_parser(self):
        row = quoteRow()
        class Database:
            source = '<msgsource/>'
            def get_message_row(self, *args, **kwargs): return dict(source=self.source)
            def get_nickname(self, user): return user
            def get_messages(self, chatId, limit, offset=0): return [row][offset:offset+limit]
        database = Database()
        chat = dict(id='family@chatroom', name='家', trigger='mention')
        config = dict(selfId='bot', chats=[chat])
        self.assertIsNone(incomingMessage(database, chat, row, config))
        database.source = '<msgsource><atuserlist>bot</atuserlist></msgsource>'
        message = incomingMessage(database, chat, row, config)
        self.assertIsNotNone(message)
        self.assertEqual(message['reference']['text'], '引用内容样例')
        page = readHistory(database, config, dict(chatId=chat['id'], accountId='bot', limit=1))
        self.assertEqual(page['messages'][0]['reference'], message['reference'])

    def test_missing_and_nested_references_never_expose_raw_xml_or_lose_current_words(self):
        row = quoteRow('49', '<msg><appmsg><title>上一层留言</title><type>57</type></appmsg></msg>')
        nested = normalizeMessage(row, 'owner', 'bot')
        self.assertIsNotNone(nested)
        self.assertIn('上一层留言', nested['reference']['text'])
        missing = normalizeMessage({**row, 'content': '<msg><appmsg><title>新留言</title><type>57</type></appmsg></msg>'}, 'owner', 'bot')
        self.assertEqual(missing['text'], '新留言')
        self.assertIn('error', missing['reference'])
        self.assertNotIn('<appmsg', str(missing))
        empty = normalizeMessage(quoteRow(title=''), 'owner', 'bot')
        self.assertEqual(empty['text'], '')
        self.assertIn('reference', empty)
        invalid = normalizeMessage({**quoteRow(), 'content': quoteRow()['content'].replace('9007199254740993', '9' * 5000)}, 'owner', 'bot')
        self.assertIn('ID 无效', invalid['reference']['error'])

    def test_reference_lookup_is_scoped_exact_and_never_chooses_between_duplicate_ids(self):
        connection = sqlite3.connect(':memory:')
        self.addCleanup(connection.close)
        connection.execute('CREATE TABLE messages(local_id INTEGER, server_id INTEGER)')
        connection.execute('INSERT INTO messages VALUES (7,9007199254740993)')
        original = dict(local_id=7, shard='m.db', local_type=3, sender_username='bot', server_id=9007199254740993)
        database = SimpleNamespace(_shard_label=lambda _: 'm.db', get_message_row=Mock(return_value=original))
        chats = []
        def query(chatId, build):
            chats.append(chatId)
            return build([(connection, 'messages')])
        database._run_msg_query = query
        self.assertEqual(referenceRow(database, 'owner', '9007199254740993'), original)
        self.assertEqual(chats, ['owner'])
        database.get_message_row.assert_called_once_with('owner', 7, shard='m.db')
        reader = IncomingImages(database, dict(chats=[dict(id='owner')]), Mock())
        reader.read = Mock(return_value=dict(file='a' * 64 + '.png', quality='cached'))
        reader.readReference('owner', dict(id='9007199254740993', speakerId='wechat:bot', type='image'))
        reader.read.assert_called_once_with('owner', original)
        with self.assertRaisesRegex(ImageUnavailable, '原作者'):
            reader.readReference('owner', dict(id='9007199254740993', speakerId='wechat:other', type='image'))
        with self.assertRaisesRegex(ValueError, '已配置'):
            reader.readReference('other-chat', dict(id='9007199254740993', speakerId='wechat:bot', type='image'))
        with self.assertRaisesRegex(ImageUnavailable, '不在本机'):
            referenceRow(database, 'owner', '1')
        database.get_message_row.return_value = {**original, 'server_id': 1}
        with self.assertRaisesRegex(ImageUnavailable, '位置已变化'):
            referenceRow(database, 'owner', '9007199254740993')
        database.get_message_row.return_value = original
        connection.execute('INSERT INTO messages VALUES (8,9007199254740993)')
        with self.assertRaisesRegex(ImageUnavailable, '不唯一'):
            referenceRow(database, 'owner', '9007199254740993')

    def test_animated_media_keeps_only_the_first_frame_and_labels_it(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'input.gif'
            Image.new('RGB', (2, 2), 'red').save(file, save_all=True, append_images=[Image.new('RGB', (2, 2), 'blue')], duration=100, loop=0)
            result = saveImage(file, directory, 'bot', 'owner', 'original')
            self.assertIs(result['firstFrame'], True)
            with Image.open(next(Path(directory).rglob(result['file']))) as image:
                self.assertEqual(image.convert('RGB').getpixel((0, 0)), (255, 0, 0))

    def test_bad_quote_is_recorded_once_and_following_message_can_finish(self):
        broken = {**quoteRow(), 'content': '<msg><appmsg><type>57</type>'}
        normal = dict(broken, local_id=219, sort_seq=11, type='文本', content='后续普通消息')
        class Finished(Exception): pass
        calls = []
        class Database:
            def get_messages(self, chatId, limit, offset=0):
                # The buffer reads again while it waits; stop once the following message has been asked.
                if calls and store.cursor('owner') == 11: raise Finished()
                return [normal, broken][offset:offset+limit]
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite')
            try:
                store.baseline('owner', 0)
                with self.assertRaises(Finished):
                    watch(dict(chats=[dict(id='owner')], selfId='bot', moduleFile='unused'), Database(), store, None, lambda _, message: calls.append(message['text']), poll=lambda _: {})
                self.assertEqual(calls, ['后续普通消息'])
                self.assertEqual(store.cursor('owner'), 11)
                store.checkPending()
                self.assertEqual(store.db.execute('SELECT status FROM messages WHERE messageId=? LIMIT 1', ('m.db:218',)).fetchone()[0], 'rejected')
                self.assertEqual(store.db.execute('SELECT COUNT(*) FROM messageFaults').fetchone()[0], 1)
            finally: store.close()


if __name__ == '__main__':
    unittest.main()
