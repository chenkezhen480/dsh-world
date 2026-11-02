import json
import tempfile
import unittest
from pathlib import Path
from snapshot import NotSent
from outgoing import deliverMessages, mediaDigestMatches, prepareMessages, serverConfirmed, stillSticker


class OutgoingTest(unittest.TestCase):
    def test_a_local_outbox_row_is_not_a_server_confirmation(self):
        self.assertFalse(serverConfirmed(dict(server_id=0)))
        self.assertFalse(serverConfirmed({}))
        self.assertTrue(serverConfirmed(dict(server_id=5489465419718876343)))

    def test_media_receipt_uses_decoded_xml_when_raw_payload_is_compressed(self):
        digest = '2402bd4f44806c29a471639c1f3f584a'
        row = dict(content=f'<msg><emoji md5="{digest}" type="2"/></msg>')
        raw = dict(content=b'\x28\xb5\x2f\xfdcompressed-xml', packed_info=b'\x08\x02\x10\x01')
        self.assertTrue(mediaDigestMatches(row, digest, raw))
        self.assertFalse(mediaDigestMatches(row, '0' * 32, raw))
        self.assertTrue(mediaDigestMatches(dict(content=''), digest, dict(packed_info=bytes.fromhex(digest))))

    def test_partial_failure_keeps_order_and_never_retries(self):
        calls = []
        confirmed = []
        def send(message):
            calls.append(message)
            if message['type'] == 'sticker':
                raise RuntimeError('uncertain')
        items = [dict(type='text', text='一句'), dict(type='sticker', path='a.gif'), dict(type='text', text='下一句')]
        with self.assertRaisesRegex(RuntimeError, '第 2/3 条'):
            deliverMessages(items, send, confirmed.append)
        self.assertEqual(calls, items[:2])
        self.assertEqual(confirmed, [1])

    def test_a_job_that_never_started_may_be_tried_again_but_a_half_sent_one_may_not(self):
        items = [dict(type='text', text='一句'), dict(type='text', text='下一句')]
        calls = []
        def first(_message): calls.append(1); raise NotSent('busy')
        with self.assertRaises(NotSent): deliverMessages(items, first, lambda _count: None)
        self.assertEqual(calls, [1])
        def second(message):
            if message['text'] == '下一句': raise NotSent('busy')
        confirmed = []
        with self.assertRaisesRegex(RuntimeError, '第 2/2 条') as caught: deliverMessages(items, second, confirmed.append)
        self.assertNotIsInstance(caught.exception, NotSent)
        self.assertEqual(confirmed, [1])

    def test_a_sticker_id_is_resolved_only_through_the_worlds_own_library(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            world = Path(directory) / 'world'
            library = world / 'stickers'
            (library / 'files').mkdir(parents=True)
            Image.new('RGBA', (8, 8), (255, 0, 0, 255)).save(library / 'files' / 'st_aaaaaaaaaaaa.png')
            (library / 'index.json').write_text(json.dumps(dict(version=1, stickers=[
                dict(id='st_aaaaaaaaaaaa', name='x', tags=['x'], file='st_aaaaaaaaaaaa.png'),
                dict(id='st_escape000000', name='x', tags=['x'], file='../../outside.png')])), encoding='utf-8')
            config = dict(moduleFile=str(world / 'wechat.json'))
            stateDir = Path(directory) / 'state'
            prepared = prepareMessages([dict(type='sticker', stickerId='st_aaaaaaaaaaaa')], config, stateDir)
            self.assertEqual(prepared[0]['type'], 'sticker')
            self.assertTrue(Path(prepared[0]['path']).is_file())
            with self.assertRaisesRegex(ValueError, '不在表情库'):
                prepareMessages([dict(type='sticker', stickerId='st_missing00000')], config, stateDir)
            with self.assertRaisesRegex(ValueError, '越界'):
                prepareMessages([dict(type='sticker', stickerId='st_escape000000')], config, stateDir)
            (library / 'index.json').unlink()
            with self.assertRaisesRegex(ValueError, '没有可用的索引'):
                prepareMessages([dict(type='sticker', stickerId='st_aaaaaaaaaaaa')], config, stateDir)

    def test_all_messages_are_validated_before_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                prepareMessages([dict(type='text', text='ok'), dict(type='image', path='C:/outside.png')], {}, Path(directory))
            with self.assertRaises(ValueError):
                prepareMessages([dict(type='text', text='鱼' * 1400)], {}, Path(directory))

    def test_sticker_keeps_animation_and_creates_a_native_gif(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'reaction.webp'
            Image.new('RGB', (32,32), 'blue').save(source, format='WEBP', save_all=True, append_images=[Image.new('RGB', (32,32), 'red')], duration=100, loop=0)
            prepared = prepareMessages([dict(type='sticker', path=str(source))], dict(mediaRoots=[directory]), root)
            with Image.open(prepared[0]['path']) as output:
                self.assertEqual(output.format, 'GIF')
                self.assertEqual(output.n_frames, 2)

    def test_still_sticker_keeps_a_drawn_first_frame_and_skips_a_flat_one(self):
        from PIL import Image
        drawn = Image.new('RGBA', (8, 8), (0, 0, 255, 255)); drawn.putpixel((1, 1), (255, 255, 255, 255))
        last = Image.new('RGBA', (8, 8), (255, 0, 0, 255)); last.putpixel((2, 2), (0, 0, 0, 255))
        with tempfile.TemporaryDirectory() as directory:
            for name, first, corner in (('drawn', drawn, (0, 0, 255, 255)), ('flat', Image.new('RGBA', (8, 8), (255, 255, 255, 255)), (255, 0, 0, 255))):
                with self.subTest(first=name):
                    gif = Path(directory) / f'{name}.gif'
                    first.save(gif, format='GIF', save_all=True, append_images=[last], duration=100, loop=0)
                    with Image.open(stillSticker(gif)) as still:
                        self.assertEqual(still.convert('RGBA').getpixel((7, 7)), corner)


if __name__ == '__main__':
    unittest.main()
