import ctypes
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from binding import WechatOffline
from sender import BuildStale, NativeRequest, NativeSender, currentBuild, encodeRequest, selectProfile, sendsStickers, verifyFile


PROFILES = Path(__file__).parent / 'engine/profiles.json'


class SenderTest(unittest.TestCase):
    def test_request_abi_and_utf8_boundaries(self):
        profile = json.loads(PROFILES.read_text(encoding='utf-8-sig'))[0]
        self.assertEqual(ctypes.sizeof(NativeRequest), 4464)
        request = encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, '你好')
        self.assertEqual(request.value, '你好'.encode())
        self.assertEqual(request.rva[0], 0x45d10)
        encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, 'a' * 4094)
        with self.assertRaises(ValueError):
            encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, 'a' * 4095)
        for invalid in ('a\0b', '鱼' * 1400):
            with self.assertRaises(ValueError):
                encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, invalid)
        with self.assertRaises(ValueError):
            encodeRequest(profile, 123, 'wxid_bot', 'not a wxid', 1, 'hello')

    def test_each_supported_build_encodes_its_own_native_addresses(self):
        profiles = json.loads(PROFILES.read_text(encoding='utf-8-sig'))
        self.assertEqual([profile['version'] for profile in profiles], ['4.1.15.13', '4.1.15.56', '4.2.0.11', '4.2.0.12', '4.2.0.13'])
        # The 4.2 profiles leave the native GIF slots unmapped.
        for profile, timestamp, imageSize, addresses in (
            (profiles[2], 0x6ae0a8d1, 0xc4dc000, (
                0x45d10, 0x47310, 0x311990, 0x47220, 0x384730, 0x71c600, 0x571fd20,
                0x3ec5540, 0, 0x9b5e0, 0, 0, 0,
                0x17cf210, 0x76a43bc, 0x76a4400, 0xbd0ce30, 0x90d4f88, 0)),
            (profiles[3], 0x6ae33707, 0xc4db000, (
                0x45d10, 0x47310, 0x311990, 0x47220, 0x384730, 0x71b380, 0x5721040,
                0x3ec6850, 0, 0x9b5e0, 0, 0, 0,
                0x17ce4c0, 0x76a53bc, 0x76a5400, 0xbd0ce30, 0x90d5f68, 0)),
            (profiles[4], 0x6ae83cfe, 0xc4de000, (
                0x45d10, 0x47310, 0x3141a0, 0x47220, 0x384e40, 0x71eb70, 0x5723550,
                0x3ecfcb0, 0, 0x9b5e0, 0, 0, 0,
                0x17db2d0, 0x76a750c, 0x76a7550, 0xbd0fdf0, 0x90d7fe8, 0)),
            (profiles[0], 0x6ab0a378, 0xc0ae000, (
                0x45d10, 0x47310, 0x2fb010, 0x47220, 0x36c740, 0x6f4d90, 0x54b02f0,
                0x3d9d990, 0x1bfb1c0, 0x9b5d0, 0xe7a8e0, 0x5309c0, 0x4e6360,
                0x178f100, 0x74ab89c, 0x74ab8e0, 0xb912690, 0x8dfe2f8, 0x90daff8)),
            (profiles[1], 0x6ad083c8, 0xc34f000, (
                0x45d10, 0x47310, 0x30f450, 0x47220, 0x3823d0, 0x709280, 0x55f0380,
                0x3e22d70, 0x1c12a00, 0x9b5e0, 0xea1fe0, 0x545d40, 0x4fb6e0,
                0x17a3c20, 0x754bcdc, 0x754bd20, 0xbb92fa0, 0x8fd1468, 0x92b2d08)),
        ):
            with self.subTest(version=profile['version']):
                request = encodeRequest(profile, 123, 'wxid_bot', 'family@chatroom', 1, '你好')
                self.assertEqual((request.timestamp, request.imageSize), (timestamp, imageSize))
                self.assertEqual(tuple(request.rva), addresses)

    def test_a_build_without_the_sticker_path_refuses_native_stickers_but_sends_text_and_images(self):
        profiles = json.loads(PROFILES.read_text(encoding='utf-8-sig'))
        self.assertEqual([sendsStickers(profile) for profile in profiles], [True, True, False, False, False])
        encodeRequest(profiles[2], 123, 'wxid_bot', 'family@chatroom', 1, '你好')
        encodeRequest(profiles[2], 123, 'wxid_bot', 'family@chatroom', 2, 'C:/a.png')
        with self.assertRaisesRegex(ValueError, '4.2.0.11 未适配原生表情包'):
            encodeRequest(profiles[2], 123, 'wxid_bot', 'family@chatroom', 3, 'C:/a.gif')
        encodeRequest(profiles[1], 123, 'wxid_bot', 'family@chatroom', 3, 'C:/a.gif')

    def test_profile_selection_matches_file_size_and_hash_instead_of_list_order(self):
        profiles = json.loads(PROFILES.read_text(encoding='utf-8-sig'))
        first, second = b'first build', b'other build'
        fixtures = [dict(profile, size=len(data), sha256=hashlib.sha256(data).hexdigest())
                    for profile, data in zip(profiles, (first, second))]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'Weixin.dll'
            for data, version in ((second, '4.1.15.56'), (first, '4.1.15.13')):
                with self.subTest(version=version):
                    path.write_bytes(data)
                    self.assertEqual(selectProfile(path, fixtures)['version'], version)
            for data in (b'wrong build', b'unknown size'):
                with self.subTest(data=data), self.assertRaisesRegex(ValueError, '不支持当前微信构建'):
                    path.write_bytes(data)
                    selectProfile(path, fixtures)

    def test_duplicate_fingerprints_are_rejected_as_ambiguous(self):
        profile = json.loads(PROFILES.read_text(encoding='utf-8-sig'))[0]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'Weixin.dll'
            path.write_bytes(b'build')
            fixture = dict(profile, size=5, sha256=hashlib.sha256(b'build').hexdigest())
            with self.assertRaisesRegex(ValueError, '多个适配配置'):
                selectProfile(path, [fixture, fixture])

    def test_unknown_core_build_is_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'Weixin.dll'
            path.write_bytes(b'unknown build')
            with self.assertRaises(ValueError):
                verifyFile(path, 201552944, '0' * 64)
            with self.assertRaises(ValueError):
                verifyFile(path, path.stat().st_size, '0' * 64)

    def test_a_missing_or_stale_build_asks_for_a_new_one_and_a_matching_one_is_used(self):
        source = hashlib.sha256((PROFILES.parent / 'bridge.cpp').read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(BuildStale, '还没有构建'):
                currentBuild(root)
            (root / 'current.json').write_text(json.dumps(dict(file='x.dll', sha256='0' * 64, sourceSha256='f' * 64)), encoding='utf-8')
            with self.assertRaisesRegex(BuildStale, '源码已变化'):
                currentBuild(root)
            (root / 'current.json').write_text(json.dumps(dict(file='x.dll', sha256='0' * 64, sourceSha256=source)), encoding='utf-8-sig')
            self.assertEqual(currentBuild(root)['file'], 'x.dll')

    def test_sender_initialization_releases_its_handle_when_the_process_goes_offline(self):
        profile = json.loads(PROFILES.read_text(encoding='utf-8-sig'))[0]
        process = SimpleNamespace(memory_maps=lambda: [SimpleNamespace(path='Weixin.dll')])
        api = Mock()
        api.OpenProcess.return_value = 123
        api.CloseHandle.return_value = True
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dll = root / 'bridge.dll'
            dll.write_bytes(b'bridge fixture')
            (root / 'current.json').write_text(json.dumps(dict(file=str(dll), sha256=hashlib.sha256(dll.read_bytes()).hexdigest(),
                sourceSha256=hashlib.sha256((PROFILES.parent / 'bridge.cpp').read_bytes()).hexdigest())), encoding='utf-8')
            with patch('psutil.Process', return_value=process), patch('sender.selectProfile', return_value=profile), patch('sender.c.WinDLL', return_value=api), patch.object(NativeSender, '_modules', side_effect=WechatOffline('微信退出')):
                with self.assertRaises(WechatOffline):
                    NativeSender(dict(processId=10, engineDir=str(root)), lambda: None)
            api.CloseHandle.assert_called_once_with(123)


if __name__ == '__main__':
    unittest.main()
