import time
import unittest
import threading
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from gaze_companion import EyeTraxRuntime, FeatureSample, GazeCompanion, SessionTokens


class FakeModel:
    def __init__(self):
        self.trained = None

    def train(self, features, targets):
        self.trained = (features, targets)


class FakeEstimator:
    def __init__(self):
        self.model = FakeModel()

    def train(self, features, targets):
        self.model.train(features, targets)


class FakeNumpy:
    @staticmethod
    def array(value):
        return value


class FakeRuntime:
    def __init__(self):
        self.calibrated = False
        self._thread = None
        self.stopped = False
        self.started_thread = None

    def start(self, viewport):
        self.started_thread = threading.get_ident()
        return {'calibrated': self.calibrated, 'viewport': list(viewport), 'accuracy': None}

    def latest(self):
        return FeatureSample(0, time.monotonic(), None, False, None)

    def add_calibration_sample(self, _x, _y):
        return True, 'captured', 1

    def train(self):
        self.calibrated = True
        return 40

    def reset(self, _viewport=None):
        self.calibrated = False

    def set_accuracy(self, _value):
        pass

    def stop(self, *, clear=False):
        self.stopped = True
        if clear:
            self.calibrated = False


class GazeCompanionTests(unittest.TestCase):
    def test_session_tokens_are_short_lived_and_single_use(self):
        tokens = SessionTokens(ttl_seconds=1)
        token = tokens.issue()
        self.assertTrue(tokens.consume(token))
        self.assertFalse(tokens.consume(token))
        self.assertFalse(tokens.consume('not-a-token'))

    def test_calibration_uses_each_recent_camera_frame_once(self):
        runtime = EyeTraxRuntime()
        runtime._np = FakeNumpy()
        runtime._estimator = FakeEstimator()
        runtime._create_model = lambda *_args, **_kwargs: FakeModel()
        for sequence in range(1, 41):
            runtime._latest = FeatureSample(
                sequence, time.monotonic(), [sequence, sequence + 1], False, None)
            accepted, reason, count = runtime.add_calibration_sample(100, 200)
            self.assertTrue(accepted, reason)
            self.assertEqual(count, sequence)
        accepted, reason, _ = runtime.add_calibration_sample(100, 200)
        self.assertFalse(accepted)
        self.assertEqual(reason, 'duplicate')
        self.assertEqual(runtime.train(), 40)
        self.assertTrue(runtime.calibrated)
        self.assertEqual(len(runtime._estimator.model.trained[0]), 40)

    def test_stale_or_missing_face_samples_are_rejected(self):
        runtime = EyeTraxRuntime()
        runtime._latest = FeatureSample(1, time.monotonic() - 1, [1], False, None)
        self.assertEqual(runtime.add_calibration_sample(0, 0)[1], 'stale')
        runtime._latest = FeatureSample(2, time.monotonic(), None, False, None)
        self.assertEqual(runtime.add_calibration_sample(0, 0)[1], 'no_face')

    def test_authenticated_websocket_calibrates_and_shuts_down(self):
        runtime = FakeRuntime()
        companion = GazeCompanion(runtime)
        app = FastAPI()

        @app.websocket('/gaze')
        async def gaze(ws: WebSocket):
            await companion.websocket(ws)

        token = companion.issue_token()
        with TestClient(app).websocket_connect('/gaze?token=' + token) as ws:
            ws.send_json({'type': 'hello', 'width': 1200, 'height': 800})
            self.assertEqual(ws.receive_json()['state'], 'loading')
            self.assertEqual(ws.receive_json()['type'], 'ready')
            ws.send_json({'type': 'capture', 'id': 3, 'x': 100, 'y': 200})
            reply = ws.receive_json()
            while reply.get('type') == 'quality':
                reply = ws.receive_json()
            self.assertEqual(reply, {'type': 'captured', 'id': 3, 'ok': True,
                                     'reason': 'captured', 'value': 1})
            ws.send_json({'type': 'train', 'id': 4})
            reply = ws.receive_json()
            while reply.get('type') == 'quality':
                reply = ws.receive_json()
            self.assertEqual(reply['samples'], 40)
            ws.send_json({'type': 'shutdown', 'id': 5})
            reply = ws.receive_json()
            while reply.get('type') == 'quality':
                reply = ws.receive_json()
            self.assertTrue(reply['ok'])
        self.assertTrue(runtime.stopped)

    def test_macos_camera_opens_on_websocket_main_thread(self):
        runtime = FakeRuntime()
        companion = GazeCompanion(runtime)
        app = FastAPI()
        event_loop_thread = None

        @app.websocket('/gaze')
        async def gaze(ws: WebSocket):
            nonlocal event_loop_thread
            event_loop_thread = threading.get_ident()
            await companion.websocket(ws)

        with patch('gaze_companion.sys', SimpleNamespace(platform='darwin')):
            with TestClient(app).websocket_connect('/gaze?token=' + companion.issue_token()) as ws:
                ws.send_json({'type': 'hello', 'width': 1200, 'height': 800})
                self.assertEqual(ws.receive_json()['state'], 'loading')
                self.assertEqual(ws.receive_json()['type'], 'ready')
                ws.send_json({'type': 'shutdown', 'id': 1})
                while ws.receive_json().get('type') != 'shutdown':
                    pass

        self.assertEqual(runtime.started_thread, event_loop_thread)


if __name__ == '__main__':
    unittest.main()
