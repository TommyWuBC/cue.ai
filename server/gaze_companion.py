"""Local EyeTrax gaze companion used by the browser extension.

Camera frames and landmark features stay in this process.  The websocket emits
only viewport coordinates and small quality/timing fields.  EyeTrax is imported
lazily so the rest of Cue can still run when the optional native dependencies
have not been installed.
"""
from __future__ import annotations

import asyncio
import importlib.util
import secrets
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect


@dataclass
class FeatureSample:
    sequence: int
    captured_at: float
    features: Any | None
    blink: bool
    prediction: tuple[float, float] | None


class SessionTokens:
    """Short-lived, one-use websocket credentials issued to the extension."""

    def __init__(self, ttl_seconds: float = 60.0):
        self.ttl_seconds = ttl_seconds
        self._tokens: dict[str, float] = {}
        self._lock = threading.Lock()

    def issue(self) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._prune()
            self._tokens[token] = time.monotonic() + self.ttl_seconds
        return token

    def consume(self, token: str | None) -> bool:
        if not token:
            return False
        with self._lock:
            self._prune()
            expires = self._tokens.pop(token, 0)
        return expires >= time.monotonic()

    def _prune(self) -> None:
        now = time.monotonic()
        for token, expires in list(self._tokens.items()):
            if expires < now:
                self._tokens.pop(token, None)


class EyeTraxRuntime:
    """Owns the webcam, estimator, model and calibration samples."""

    def __init__(self, camera_index: int = 0):
        self.camera_index = camera_index
        self._cv2 = None
        self._np = None
        self._create_model = None
        self._estimator = None
        self._capture = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._data_lock = threading.Lock()
        self._estimator_lock = threading.Lock()
        self._latest = FeatureSample(0, 0.0, None, False, None)
        self._features: list[Any] = []
        self._targets: list[list[float]] = []
        self._used_sequences: set[int] = set()
        self.viewport: tuple[int, int] | None = None
        self.calibrated = False
        self.accuracy: dict[str, Any] | None = None

    def _load(self) -> None:
        if self._estimator is not None:
            return
        try:
            import cv2
            import numpy as np
            from eyetrax.gaze import GazeEstimator
            from eyetrax.models import create_model
        except Exception as exc:
            raise RuntimeError(
                "EyeTrax is not installed. Install server/requirements-gaze.txt "
                "with Python 3.11, then restart Cue."
            ) from exc
        self._cv2, self._np, self._create_model = cv2, np, create_model
        self._estimator = GazeEstimator(model_name="ridge", model_kwargs={"alpha": 1.0})

    def start(self, viewport: tuple[int, int]) -> dict[str, Any]:
        self._load()
        if min(viewport) <= 0 or max(viewport) > 16_384:
            raise ValueError("Invalid browser viewport")
        if self.viewport and self.viewport != viewport:
            self.reset(viewport)
        else:
            self.viewport = viewport
        if self._thread and self._thread.is_alive():
            return self.status()

        capture = self._cv2.VideoCapture(self.camera_index)
        if not capture.isOpened() and self.camera_index == 0:
            capture.release()
            capture = self._cv2.VideoCapture(1)
        if not capture.isOpened():
            capture.release()
            if sys.platform == "darwin":
                raise RuntimeError(
                    "EyeTrax could not open a webcam. In System Settings > Privacy & "
                    "Security > Camera, allow the app that launched Cue (Terminal or Cursor)."
                )
            raise RuntimeError("EyeTrax could not open a webcam; check operating-system camera permission")
        capture.set(self._cv2.CAP_PROP_FRAME_WIDTH, 1280)
        capture.set(self._cv2.CAP_PROP_FRAME_HEIGHT, 720)
        capture.set(self._cv2.CAP_PROP_FPS, 30)
        self._capture = capture
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="cue-eyetrax", daemon=True)
        self._thread.start()
        return self.status()

    def _run(self) -> None:
        sequence = self._latest.sequence
        while not self._stop.is_set():
            ok, frame = self._capture.read()
            if not ok:
                time.sleep(0.02)
                continue
            captured_at = time.monotonic()
            try:
                with self._estimator_lock:
                    features, blink = self._estimator.extract_features(frame)
                    prediction = None
                    if features is not None and not blink and self.calibrated:
                        value = self._estimator.predict(self._np.array([features]))[0]
                        prediction = (float(value[0]), float(value[1]))
                sequence += 1
                sample = FeatureSample(sequence, captured_at, features, bool(blink), prediction)
            except Exception:
                sequence += 1
                sample = FeatureSample(sequence, captured_at, None, False, None)
            with self._data_lock:
                self._latest = sample

    def latest(self) -> FeatureSample:
        with self._data_lock:
            sample = self._latest
            features = None if sample.features is None else sample.features.copy()
            return FeatureSample(sample.sequence, sample.captured_at, features,
                                 sample.blink, sample.prediction)

    def add_calibration_sample(self, x: float, y: float) -> tuple[bool, str, int]:
        sample = self.latest()
        age = time.monotonic() - sample.captured_at
        if sample.features is None:
            return False, "no_face", sample.sequence
        if sample.blink:
            return False, "blink", sample.sequence
        if age > 0.35:
            return False, "stale", sample.sequence
        with self._data_lock:
            if sample.sequence in self._used_sequences:
                return False, "duplicate", sample.sequence
            self._used_sequences.add(sample.sequence)
            self._features.append(sample.features)
            self._targets.append([float(x), float(y)])
            count = len(self._features)
        return True, "captured", count

    def train(self) -> int:
        with self._data_lock:
            features = list(self._features)
            targets = list(self._targets)
        if len(features) < 40:
            raise RuntimeError("Not enough valid calibration frames")
        with self._estimator_lock:
            self._estimator.train(self._np.array(features), self._np.array(targets))
            self.calibrated = True
        return len(features)

    def reset(self, viewport: tuple[int, int] | None = None) -> None:
        with self._data_lock:
            self._features.clear()
            self._targets.clear()
            self._used_sequences.clear()
            self.accuracy = None
            if viewport:
                self.viewport = viewport
        self.calibrated = False
        if self._estimator is not None:
            with self._estimator_lock:
                self._estimator.model = self._create_model("ridge", alpha=1.0)

    def set_accuracy(self, value: dict[str, Any] | None) -> None:
        with self._data_lock:
            self.accuracy = value

    def status(self) -> dict[str, Any]:
        return {
            "calibrated": self.calibrated,
            "viewport": list(self.viewport) if self.viewport else None,
            "accuracy": self.accuracy,
        }

    def stop(self, *, clear: bool = False) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        self._thread = None
        if self._capture is not None:
            self._capture.release()
            self._capture = None
        if clear:
            self.reset()


class GazeCompanion:
    def __init__(self, runtime: EyeTraxRuntime | None = None):
        self.runtime = runtime or EyeTraxRuntime()
        self.tokens = SessionTokens()
        self._generation = 0
        self._generation_lock = asyncio.Lock()

    def issue_token(self) -> str:
        return self.tokens.issue()

    def health(self) -> dict[str, Any]:
        installed = all(importlib.util.find_spec(name) is not None
                        for name in ("eyetrax", "cv2", "mediapipe", "numpy", "sklearn"))
        return {
            "engine": "eyetrax", "installed": installed,
            "camera_running": bool(self.runtime._thread and self.runtime._thread.is_alive()),
            "calibrated": self.runtime.calibrated,
        }

    async def websocket(self, ws: WebSocket, *, allow_without_token: bool = False) -> None:
        token = ws.query_params.get("token")
        if not allow_without_token and not self.tokens.consume(token):
            await ws.close(code=1008, reason="Invalid or expired gaze session")
            return
        await ws.accept()
        async with self._generation_lock:
            self._generation += 1
            generation = self._generation
        producer: asyncio.Task | None = None
        explicit_shutdown = False
        try:
            first = await asyncio.wait_for(ws.receive_json(), timeout=8)
            if first.get("type") != "hello":
                raise ValueError("Expected hello")
            viewport = (int(first.get("width", 0)), int(first.get("height", 0)))
            await ws.send_json({"type": "status", "state": "loading"})
            status = await asyncio.to_thread(self.runtime.start, viewport)
            await ws.send_json({"type": "ready", **status})
            producer = asyncio.create_task(self._produce(ws, generation))

            while True:
                message = await ws.receive_json()
                kind = message.get("type")
                request_id = message.get("id")
                if kind == "capture":
                    ok, reason, value = self.runtime.add_calibration_sample(
                        float(message.get("x", 0)), float(message.get("y", 0)))
                    await ws.send_json({"type": "captured", "id": request_id,
                                        "ok": ok, "reason": reason, "value": value})
                elif kind == "train":
                    try:
                        count = await asyncio.to_thread(self.runtime.train)
                        await ws.send_json({"type": "trained", "id": request_id,
                                            "ok": True, "samples": count})
                    except Exception as exc:
                        await ws.send_json({"type": "trained", "id": request_id,
                                            "ok": False, "error": str(exc)})
                elif kind == "reset":
                    self.runtime.reset(viewport)
                    await ws.send_json({"type": "reset", "id": request_id, "ok": True})
                elif kind == "accuracy":
                    self.runtime.set_accuracy(message.get("value"))
                elif kind == "shutdown":
                    explicit_shutdown = True
                    await ws.send_json({"type": "shutdown", "id": request_id, "ok": True})
                    break
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        except Exception as exc:
            try:
                await ws.send_json({"type": "error", "message": str(exc)})
            except Exception:
                pass
        finally:
            if producer:
                producer.cancel()
            if explicit_shutdown:
                await asyncio.to_thread(self.runtime.stop, clear=True)
            else:
                asyncio.create_task(self._stop_after_navigation_grace(generation))
            try:
                await ws.close()
            except Exception:
                pass

    async def _produce(self, ws: WebSocket, generation: int) -> None:
        last_sequence = -1
        last_quality_at = 0.0
        while generation == self._generation:
            sample = self.runtime.latest()
            now = time.monotonic()
            if sample.sequence != last_sequence:
                last_sequence = sample.sequence
                age_ms = (now - sample.captured_at) * 1000
                if sample.prediction is not None and age_ms <= 350:
                    await ws.send_json({
                        "type": "gaze", "x": sample.prediction[0], "y": sample.prediction[1],
                        "sequence": sample.sequence,
                        "age_ms": round(age_ms, 1),
                    })
                elif now - last_quality_at >= 0.25:
                    last_quality_at = now
                    await ws.send_json({
                        "type": "quality", "face": sample.features is not None,
                        "blink": sample.blink, "sequence": sample.sequence,
                    })
            await asyncio.sleep(0.01)

    async def _stop_after_navigation_grace(self, generation: int) -> None:
        await asyncio.sleep(4)
        if generation == self._generation:
            await asyncio.to_thread(self.runtime.stop, clear=False)


companion = GazeCompanion()
