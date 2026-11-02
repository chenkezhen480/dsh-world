import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from native import connect
from sender import STICKER_CALLS


class ConfirmationTest(unittest.TestCase):
    def deliver(self, text, row, *, serverId=123, baseline=(), item=None, profile=None):
        class Database:
            def __init__(self, **_):
                self.account, self.wxid, self.reads = 'bot-account', 'wxid_bot', 0

            def _message_dbs(self): return ['m.db']
            def _db_path(self, _): return 'unused.db'
            def _wal_path(self, _): return None

            def get_messages(self, _chat, limit, offset=0):
                self.reads += 1
                return list(baseline) if self.reads == 1 else [row]

            def get_message_row(self, _chat, _id, *, shard):
                return dict(server_id=serverId)

        process = SimpleNamespace(pid=123, create_time=lambda: 1)
        transport = Mock(profile=profile or dict(version='4.1.15.56', addresses={name: 1 for name in STICKER_CALLS}))
        modules = {
            'wechatauto.db': SimpleNamespace(WeChatDB=Database),
            'wechatauto.param': SimpleNamespace(WxParam=SimpleNamespace(ENABLE_FILE_LOGGER=False)),
            'incoming': SimpleNamespace(IncomingImages=lambda *_: SimpleNamespace(read=None, readSticker=None, readReference=None)),
        }
        config = dict(dbDir='unused', account='bot-account', selfId='wxid_bot')
        with patch.dict(sys.modules, modules), patch('native.findAccountProcess', return_value=process), \
                patch('native.checkAccountProcess'), patch('psutil.Process', return_value=process), \
                patch('native.fileStamp', return_value=(1, 1)), \
                patch('native.time.monotonic', side_effect=[0, 1, 2, 3, 4, 25]), \
                patch('native.time.sleep'), patch('sender.NativeSender', return_value=transport):
            _, send = connect(config, Path('unused'))
            try:
                send(dict(id='private'), item or dict(type='text', text=text))
            finally:
                send.close()
                if item is None: transport.send.assert_called_once_with('private', 1, text)
                transport.close.assert_called_once_with()
        return transport

    def test_a_build_that_cannot_send_stickers_sends_a_gif_as_its_still_frame(self):
        from PIL import Image
        from outgoing import stillSticker
        with tempfile.TemporaryDirectory() as directory:
            gif = Path(directory) / 'sticker.gif'
            blank, smile = Image.new('RGBA', (8, 8), (0, 0, 0, 0)), Image.new('RGBA', (8, 8), (255, 0, 0, 255))
            for x in range(4): smile.putpixel((x, x), (255, 255, 0, 255))
            blank.save(gif, format='GIF', save_all=True, append_images=[smile], duration=100, loop=0)
            still = stillSticker(gif)
            with Image.open(still) as image:
                self.assertEqual(image.format, 'PNG')
                self.assertEqual(image.convert('RGBA').getpixel((7, 0)), (255, 0, 0, 255), 'a blank first frame gives way to the last')
            digest = hashlib.md5(Path(still).read_bytes()).hexdigest()
            row = dict(shard='m.db', local_id=2, sender_username='wxid_bot', type='图片', content=f'<img md5="{digest}"/>')
            transport = self.deliver('', row, item=dict(type='sticker', path=str(gif)), profile=dict(version='4.2.0.11', addresses={}))
            transport.send.assert_called_once_with('private', 2, still)

    def test_text_receipt_matches_the_database_readers_trimmed_view(self):
        for text in ('原文', '原文 ', ' 原文\n', '\n第一行\n\n第二行\t'):
            with self.subTest(text=repr(text)):
                row = dict(shard='m.db', local_id=2, sender_username='wxid_bot', type='文本', content=text.strip())
                try:
                    self.deliver(text, row)
                except RuntimeError as error:
                    self.fail(f'已有服务器确认的正文仅首尾空白不同，不应判为发送不明：{error}')

    def test_text_confirmation_still_requires_new_own_server_confirmed_matching_message(self):
        row = dict(shard='m.db', local_id=2, sender_username='wxid_bot', type='文本', content='第一行\n第二行')
        cases = [
            dict(row={**row, 'content': '第一行 第二行'}),
            dict(row={**row, 'sender_username': 'someone_else'}),
            dict(row={**row, 'type': '图片'}),
            dict(row=row, serverId=0),
            dict(row=row, baseline=[row]),
        ]
        for case in cases:
            with self.subTest(case=case), self.assertRaisesRegex(RuntimeError, '尚未确认'):
                self.deliver('第一行\n第二行 ', **case)


if __name__ == '__main__':
    unittest.main()
