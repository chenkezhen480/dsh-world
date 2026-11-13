import io
import json
import tempfile
import unittest
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError
from unittest.mock import patch
from adapter import HomeBusy, postHome


class TransportTest(unittest.TestCase):
    def brokenBody(self, error):
        class Body(io.BytesIO):
            def read(self, *_): raise error
        return Body()

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.file = Path(directory.name) / 'wechat.json'
        self.connection = dict(origin='http://127.0.0.1:1234', path='/dsh-world/worlds/default/wechat/ask', token='old', protocol=4, references=True)
        self.file.write_text(json.dumps(self.connection), encoding='utf-8')

    def unavailable(self, code=503, detail='receipt not recorded; retry receipt only'):
        return HTTPError('http://127.0.0.1:1234', code, 'Unavailable', {}, io.BytesIO(json.dumps(dict(error=detail)).encode()))

    def test_safe_requests_retry_transient_http_errors_with_the_same_body(self):
        for key in ('receipt', 'outbox', 'status', 'readResult'):
            with self.subTest(key=key), patch('adapter.urlopen', side_effect=[self.unavailable(502), self.unavailable(503), self.unavailable(504), io.BytesIO(b'{"accepted":true}')]) as request, patch('adapter.time.sleep') as sleep:
                self.assertTrue(postHome(self.file, {key: {}})['accepted'])
                self.assertEqual(request.call_count, 4)
                self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2, 4])
                self.assertEqual([json.loads(call.args[0].data) for call in request.call_args_list], [{key: {}}] * 4)

    def test_retry_rereads_the_current_host_address_and_token(self):
        def restart(_delay):
            self.file.write_text(json.dumps({**self.connection, 'origin': 'http://127.0.0.1:5678', 'token': 'new'}), encoding='utf-8')
        with patch('adapter.urlopen', side_effect=[URLError(ConnectionRefusedError()), io.BytesIO(b'{"accepted":true}')]) as request, patch('adapter.time.sleep', side_effect=restart):
            postHome(self.file, dict(outbox={}))
        self.assertEqual([call.args[0].full_url for call in request.call_args_list], ['http://127.0.0.1:1234/dsh-world/worlds/default/wechat/ask', 'http://127.0.0.1:5678/dsh-world/worlds/default/wechat/ask'])
        self.assertEqual([call.args[0].get_header('X-dsh-world-token') for call in request.call_args_list], ['old', 'new'])

    def test_generation_and_mixed_requests_never_retry_and_keep_the_error_body(self):
        for message in (dict(text='不要再生成一次'), dict(receipt={}, text='混合请求')):
            with self.subTest(message=message), patch('adapter.urlopen', side_effect=self.unavailable(detail='home request failed; delivery must be checked before retrying')) as request, patch('adapter.time.sleep') as sleep:
                with self.assertRaisesRegex(RuntimeError, '503.*delivery must be checked'):
                    postHome(self.file, message)
                self.assertEqual(request.call_count, 1)
                sleep.assert_not_called()

    def test_a_busy_home_is_its_own_failure_and_is_not_retried_inside_the_request(self):
        with patch('adapter.urlopen', side_effect=self.unavailable(409, 'home busy; message not taken in, ask again later')) as request, patch('adapter.time.sleep') as sleep:
            with self.assertRaisesRegex(HomeBusy, '409.*not taken in'):
                postHome(self.file, dict(text='她在忙'))
            self.assertEqual(request.call_count, 1)
            sleep.assert_not_called()

    def test_connection_failures_have_five_attempts_and_no_final_sleep(self):
        for error in (URLError(ConnectionRefusedError('refused')), TimeoutError('timeout'), ConnectionResetError('reset')):
            with self.subTest(error=error), patch('adapter.urlopen', side_effect=error) as request, patch('adapter.time.sleep') as sleep:
                with self.assertRaisesRegex(RuntimeError, str(error)):
                    postHome(self.file, dict(outbox={}))
                self.assertEqual(request.call_count, 5)
                self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2, 4, 8])

    def test_generation_connection_failure_is_never_retried(self):
        with patch('adapter.urlopen', side_effect=URLError('response lost')) as request, patch('adapter.time.sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'response lost'):
                postHome(self.file, dict(text='可能已经生成'))
        self.assertEqual(request.call_count, 1)
        sleep.assert_not_called()

    def test_control_requests_do_not_hold_the_sender_for_a_model_response_timeout(self):
        for message, timeout in ((dict(outbox={}), 5), (dict(text='等本轮回复'), 190)):
            with self.subTest(message=message), patch('adapter.urlopen', return_value=io.BytesIO(b'{"accepted":true}')) as request:
                postHome(self.file, message)
                self.assertEqual(request.call_args.kwargs['timeout'], timeout)

    def test_truncated_success_and_error_bodies_retry_only_safe_requests(self):
        for generating in (False, True):
            for status in (200, 503):
                body = self.brokenBody(IncompleteRead(b'{"accepted":', 5) if status == 200 else ConnectionResetError('body connection reset'))
                response = body if status == 200 else HTTPError('http://127.0.0.1:1234', status, 'Unavailable', {}, body)
                with self.subTest(generating=generating, status=status), patch('adapter.urlopen', side_effect=[response, io.BytesIO(b'{"accepted":true}')]) as request, patch('adapter.time.sleep') as sleep:
                    if generating:
                        with self.assertRaises(RuntimeError): postHome(self.file, dict(text='可能已生成'))
                        self.assertEqual(request.call_count, 1)
                        sleep.assert_not_called()
                    else:
                        self.assertTrue(postHome(self.file, dict(outbox={}))['accepted'])
                        self.assertEqual(request.call_count, 2)
                        sleep.assert_called_once_with(1)

    def test_permanent_http_errors_and_unaccepted_responses_never_retry(self):
        for response, detail in ((self.unavailable(400, 'bad receipt'), '400.*bad receipt'), (io.BytesIO(b'{"accepted":false}'), '没有确认请求')):
            with self.subTest(detail=detail), patch('adapter.urlopen', side_effect=[response]) as request, patch('adapter.time.sleep') as sleep:
                with self.assertRaisesRegex(RuntimeError, detail):
                    postHome(self.file, dict(receipt={}))
                self.assertEqual(request.call_count, 1)
                sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
