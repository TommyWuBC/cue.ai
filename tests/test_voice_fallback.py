import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import main
import stt
import tts


class FakeResponse:
    def __init__(self, status, content=b'', ctype='audio/mpeg'):
        self.status_code, self.content, self.text = status, content, content.decode('latin1')
        self.headers = {'content-type': ctype}


class TtsChainTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cache = Path(tmp.name)
        for patch in (mock.patch.object(tts, 'CACHE', cache), mock.patch.object(tts, 'LEDGER', cache / '_ledger.json'),
                      mock.patch.object(tts, 'PROVIDER', 'grok')):
            patch.start()
            self.addCleanup(patch.stop)
        self.calls = []

    def env(self, **keys):
        patch = mock.patch.dict('os.environ', keys, clear=False)
        patch.start()
        self.addCleanup(patch.stop)
        for k in ('XAI_API_KEY', 'ELEVENLABS_API_KEY'):
            if k not in keys:
                p = mock.patch.dict('os.environ', {k: ''})
                p.start(); self.addCleanup(p.stop)

    def post(self, responses):
        def fake(url, **kw):
            self.calls.append(url)
            r = responses['grok' if 'x.ai' in url else 'eleven']
            if isinstance(r, Exception):
                raise r
            return r
        patch = mock.patch.object(tts.httpx, 'post', side_effect=fake)
        patch.start()
        self.addCleanup(patch.stop)

    def test_grok_is_first(self):
        self.env(XAI_API_KEY='x', ELEVENLABS_API_KEY='e')
        self.post({'grok': FakeResponse(200, b'GROK'), 'eleven': FakeResponse(200, b'ELEVEN')})
        audio, source, _ = tts.synth('Hello there.')
        self.assertEqual((audio, source), (b'GROK', 'grok'))
        self.assertEqual(len(self.calls), 1)

    def test_eleven_when_grok_errors(self):
        self.env(XAI_API_KEY='x', ELEVENLABS_API_KEY='e')
        self.post({'grok': FakeResponse(500, b'boom', 'application/json'), 'eleven': FakeResponse(200, b'ELEVEN')})
        self.assertEqual(tts.synth('Hello there.')[:2], (b'ELEVEN', 'eleven'))

    def test_eleven_when_grok_unreachable_or_keyless(self):
        self.env(ELEVENLABS_API_KEY='e')
        self.post({'grok': ConnectionError(), 'eleven': FakeResponse(200, b'ELEVEN')})
        self.assertEqual(tts.synth('Hello there.')[:2], (b'ELEVEN', 'eleven'))
        self.assertFalse(any('x.ai' in c for c in self.calls))   # no key, never called

    def test_browser_when_both_fail(self):
        self.env(XAI_API_KEY='x', ELEVENLABS_API_KEY='e')
        self.post({'grok': ConnectionError(), 'eleven': FakeResponse(401, b'no', 'application/json')})
        audio, source, said = tts.synth('That is $79.99.')
        self.assertEqual((audio, source), (None, 'browser'))
        self.assertIn('79 dollars and 99 cents', said)

    def test_repeat_comes_from_cache(self):
        self.env(XAI_API_KEY='x')
        self.post({'grok': FakeResponse(200, b'GROK'), 'eleven': FakeResponse(500)})
        tts.synth('Added.')
        self.assertEqual(tts.synth('Added.')[:2], (b'GROK', 'cache'))
        self.assertEqual(len(self.calls), 1)

    def test_browser_provider_skips_the_network(self):
        self.env(XAI_API_KEY='x', ELEVENLABS_API_KEY='e')
        self.post({'grok': FakeResponse(200, b'GROK'), 'eleven': FakeResponse(200, b'ELEVEN')})
        with mock.patch.object(tts, 'PROVIDER', 'browser'):
            self.assertEqual(tts.synth('Hello.')[1], 'browser')
        self.assertEqual(self.calls, [])


class SttTranslationTests(unittest.TestCase):
    def test_audio_becomes_input_chunk(self):
        out = json.loads(stt._eleven_up({'bytes': b'\x01\x02'}))
        self.assertEqual(out['message_type'], 'input_audio_chunk')
        self.assertEqual(out['audio_base_64'], 'AQI=')
        self.assertFalse(out['commit'])
        self.assertEqual(out['sample_rate'], 16000)

    def test_finalize_becomes_commit(self):
        out = json.loads(stt._eleven_up({'text': json.dumps({'type': 'Finalize'})}))
        self.assertTrue(out['commit'])
        self.assertIsNone(stt._eleven_up({'text': '{"type":"audio.done"}'}))

    def test_transcripts_become_grok_events(self):
        partial = stt._eleven_down(json.dumps({'message_type': 'partial_transcript', 'text': 'is this'}))
        self.assertEqual(partial, {'type': 'transcript.partial', 'text': 'is this', 'is_final': False, 'speech_final': False})
        final = stt._eleven_down(json.dumps({'message_type': 'committed_transcript', 'text': 'is this wool'}))
        self.assertTrue(final['is_final'] and final['speech_final'])
        self.assertIsNone(stt._eleven_down(json.dumps({'message_type': 'committed_transcript', 'text': ''})))
        self.assertIsNone(stt._eleven_down(json.dumps({'message_type': 'quota_exceeded', 'error': 'x'})))

    def test_keyterms_respect_the_20_character_cap(self):
        with mock.patch.dict('os.environ', {'STT_KEYTERMS': 'Cue,merino,' + 'x' * 25}):
            url = stt._eleven_url()
        self.assertIn('keyterms=Cue', url)
        self.assertNotIn('x' * 25, url)

    def test_order_and_cooldown(self):
        with mock.patch.dict('os.environ', {'STT_PROVIDER': 'grok', 'XAI_API_KEY': 'x', 'ELEVENLABS_API_KEY': 'e'}):
            self.assertEqual(stt.status()['provider'], 'grok')
            with mock.patch.object(stt, '_grok_down_until', float('inf')):
                self.assertEqual(stt.status()['provider'], 'eleven')
        with mock.patch.dict('os.environ', {'STT_PROVIDER': 'grok', 'XAI_API_KEY': '', 'ELEVENLABS_API_KEY': ''}):
            self.assertEqual(stt.status(), {**stt.status(), 'provider': 'browser', 'ready': False})


class FakeUpstream:
    def __init__(self, messages):
        self.messages, self.sent, self.closed = list(messages), [], False

    async def send(self, m):
        self.sent.append(m)

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.sleep(0.2)
        if not self.messages:
            await asyncio.sleep(3600)
        return self.messages.pop(0)


class SttProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_nothing_available_says_so(self):
        with mock.patch.dict('os.environ', {'XAI_API_KEY': '', 'ELEVENLABS_API_KEY': ''}):
            with self.client.websocket_connect('/stt') as ws:
                self.assertEqual(ws.receive_json()['type'], 'cue.unavailable')

    def test_falls_back_to_eleven_and_translates(self):
        up = FakeUpstream([json.dumps({'message_type': 'committed_transcript', 'text': 'add it in medium'})])

        async def no_grok():
            return None

        async def eleven():
            return up
        with mock.patch.dict('os.environ', {'XAI_API_KEY': 'x', 'ELEVENLABS_API_KEY': 'e'}), \
             mock.patch.object(stt, '_open_grok', no_grok), mock.patch.object(stt, '_open_eleven', eleven):
            with self.client.websocket_connect('/stt') as ws:
                self.assertEqual(ws.receive_json(), {'type': 'cue.ready', 'provider': 'eleven'})
                ws.send_bytes(b'\x00\x00')
                ws.send_text(json.dumps({'type': 'Finalize'}))
                heard = ws.receive_json()
        self.assertEqual(heard['text'], 'add it in medium')
        self.assertTrue(heard['is_final'] and heard['speech_final'])
        kinds = [json.loads(m)['commit'] for m in up.sent]
        self.assertEqual(kinds, [False, True])


if __name__ == '__main__':
    unittest.main()
