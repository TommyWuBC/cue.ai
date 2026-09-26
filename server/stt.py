"""Speech to text, proxied: Grok first, ElevenLabs second, the browser last.

The browser streams 16 kHz PCM16 to us over a websocket; we relay it to an
upstream recogniser and relay transcripts back. It is a proxy rather than a
direct connection because no API key may ever reach the page.

The page only ever speaks one dialect — Grok's: binary PCM plus a `Finalize`
text frame up, `transcript.created` / `transcript.partial` / `transcript.done`
down. When Grok is unavailable we open ElevenLabs Scribe instead and translate
both directions here, so client/mic.js does not care which one answered. When
neither is available we send `cue.unavailable` and the page falls back to the
browser's own recogniser.

Grok's `Finalize` control message is built for push-to-talk — release the key,
get the final transcript immediately instead of waiting out the endpointing
silence. On ElevenLabs the same frame becomes a manual commit.
"""
import asyncio, base64, json, os, time, urllib.parse

import websockets
from fastapi import WebSocket, WebSocketDisconnect

XAI_WS = "wss://api.x.ai/v1/stt"
ELEVEN_WS = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"

# Print every final transcript to the terminal. On by default: during a build
# this is the difference between "the mic is dead" and "it heard you fine and
# the router ignored it". Set STT_LOG=0 to silence.
LOG_TRANSCRIPTS = os.getenv("STT_LOG", "1") != "0"

# If Grok opens and then dies within seconds (quota, bad key scope), the page
# reconnects immediately. Skip Grok for a while so that reconnect lands on
# ElevenLabs instead of failing the same way forever.
GROK_COOLDOWN_S = 60
_grok_down_until = 0.0

KEYS = {"grok": "XAI_API_KEY", "eleven": "ELEVENLABS_API_KEY"}


def chain() -> list[str]:
    first = os.getenv("STT_PROVIDER", "grok")
    return {"grok": ["grok", "eleven"], "eleven": ["eleven"]}.get(first, [])


def _usable(name: str) -> bool:
    if not os.getenv(KEYS[name]):
        return False
    return not (name == "grok" and time.monotonic() < _grok_down_until)


def available() -> bool:
    return any(_usable(n) for n in chain())


def status() -> dict:
    live = [n for n in chain() if _usable(n)]
    return {
        "provider": live[0] if live else "browser",
        "chain": chain() + ["browser"],
        "model": os.getenv("STT_MODEL", "grok-voice-transcribe-2.0"),
        "ready": bool(live),
    }


KEYTERM_MAX_CHARS = 50
KEYTERM_MAX_COUNT = 100


def _keyterms() -> list[str]:
    """One term per `keyterm` parameter, repeated. NOT a comma-joined string —
    xAI rejects the whole handshake with HTTP 400 if any single term is over
    50 characters, and a joined list counts as one very long term."""
    raw = os.getenv("STT_KEYTERMS", "")
    terms = [t.strip() for t in raw.split(",")]
    return [t for t in terms if t and len(t) <= KEYTERM_MAX_CHARS][:KEYTERM_MAX_COUNT]


def _upstream_url() -> str:
    q: list[tuple[str, str]] = [
        ("model", os.getenv("STT_MODEL", "grok-voice-transcribe-2.0")),
        ("encoding", "pcm"),
        ("sample_rate", "16000"),
        ("interim_results", "true"),
        ("endpointing", os.getenv("STT_ENDPOINTING", "380")),
        # The venue is loud. A low VAD threshold keeps quiet speech alive; the
        # wake word and push-to-talk are what actually gate intent.
        ("vad_threshold", "0.25"),
    ]
    lang = os.getenv("STT_LANGUAGE", "").strip()
    if lang:
        q.append(("language", lang))
    # Biasing toward the words on this page is the cheapest accuracy win
    # available — "Cue" and "merino" are exactly what a generic model fumbles.
    q.extend(("keyterm", t) for t in _keyterms())
    return f"{XAI_WS}?{urllib.parse.urlencode(q)}"


def _eleven_url() -> str:
    q: list[tuple[str, str]] = [
        ("model_id", os.getenv("ELEVEN_STT_MODEL", "scribe_v2_realtime")),
        ("audio_format", "pcm_16000"),
        # VAD ends an utterance on silence, like Grok's endpointing, so the
        # wake word path works; push-to-talk release still sends a commit.
        ("commit_strategy", "vad"),
        ("vad_silence_threshold_secs", os.getenv("ELEVEN_STT_SILENCE", "0.45")),
    ]
    lang = os.getenv("STT_LANGUAGE", "").strip()
    if lang:
        q.append(("language_code", lang))
    # Same bias list as Grok, but ElevenLabs caps each term at 20 characters
    # and rejects the whole session if any is longer.
    q.extend(("keyterms", t) for t in _keyterms() if len(t) <= 20)
    return f"{ELEVEN_WS}?{urllib.parse.urlencode(q)}"


def _handshake_detail(e: Exception) -> str:
    # A rejected handshake carries a body that says exactly what is wrong.
    # Surfacing only str(e) hides it and turns a one-line fix into a session.
    detail = str(e)[:200]
    body = getattr(getattr(e, "response", None), "body", None)
    if body:
        detail = body.decode("utf-8", "replace")[:300]
    return detail


async def _open_grok():
    try:
        return await websockets.connect(
            _upstream_url(), additional_headers={"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"},
            max_size=None, ping_interval=20, ping_timeout=20,
        )
    except Exception as e:
        print(f"[stt] grok connect failed: {type(e).__name__}: {_handshake_detail(e)}", flush=True)
        return None


async def _open_eleven():
    try:
        up = await websockets.connect(
            _eleven_url(), additional_headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
            max_size=None, ping_interval=20, ping_timeout=20,
        )
    except Exception as e:
        print(f"[stt] eleven connect failed: {type(e).__name__}: {_handshake_detail(e)}", flush=True)
        return None
    # ElevenLabs accepts the socket even with a bad key or bad parameters and
    # reports the problem as its first message. Only session_started is a yes.
    try:
        first = json.loads(await asyncio.wait_for(up.recv(), 8))
    except Exception as e:
        first = {"message_type": "no_session", "error": type(e).__name__}
    if first.get("message_type") != "session_started":
        print(f"[stt] eleven refused: {first.get('message_type')}: {str(first.get('error', ''))[:200]}", flush=True)
        await up.close()
        return None
    return up


def _log_heard(text: str, provider: str):
    if LOG_TRANSCRIPTS and text:
        print(f'[stt] heard ({provider}): "{text}"', flush=True)


# ── ElevenLabs <-> Grok dialect ─────────────────────────────────────────────
def _eleven_up(msg: dict):
    """A browser frame, as ElevenLabs wants it. None = drop it."""
    if (b := msg.get("bytes")) is not None:
        return json.dumps({"message_type": "input_audio_chunk", "audio_base_64": base64.b64encode(b).decode(),
                           "commit": False, "sample_rate": 16000})
    try:
        if json.loads(msg.get("text") or "{}").get("type") == "Finalize":
            return json.dumps({"message_type": "input_audio_chunk", "audio_base_64": "",
                               "commit": True, "sample_rate": 16000})
    except json.JSONDecodeError:
        pass
    return None


def _eleven_down(raw: str):
    """An ElevenLabs message, in the Grok events client/mic.js understands."""
    try:
        m = json.loads(raw)
    except json.JSONDecodeError:
        return None
    kind, text = m.get("message_type"), (m.get("text") or "").strip()
    if kind == "partial_transcript" and text:
        return {"type": "transcript.partial", "text": text, "is_final": False, "speech_final": False}
    if kind == "committed_transcript" and text:
        _log_heard(text, "eleven")
        return {"type": "transcript.partial", "text": text, "is_final": True, "speech_final": True}
    if m.get("error") or kind not in ("partial_transcript", "committed_transcript", "session_started",
                                     "committed_transcript_with_timestamps"):
        print(f"[stt] eleven {kind}: {str(m.get('error', ''))[:200]}", flush=True)
    return None


async def proxy(ws: WebSocket):
    """Bridge one browser socket to one upstream socket for the life of the page."""
    global _grok_down_until
    await ws.accept()

    name, upstream = None, None
    for candidate in chain():
        if not _usable(candidate):
            continue
        upstream = await (_open_grok() if candidate == "grok" else _open_eleven())
        if upstream:
            name = candidate
            break
    if not upstream:
        reason = "no speech-to-text provider available (" + ", ".join(
            f"{n}: {'key set' if os.getenv(KEYS[n]) else 'no key'}" for n in chain()) + ")"
        await ws.send_json({"type": "cue.unavailable", "reason": reason})
        await ws.close()
        return

    print(f"[stt] {name} stream open", flush=True)
    opened = time.monotonic()
    # One explicit verdict for the page, whichever upstream answered. mic.js
    # waits for this (or cue.unavailable) before it reports the mic as live.
    await ws.send_json({"type": "cue.ready", "provider": name})

    async def to_upstream():
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if name == "grok":
                    if (b := msg.get("bytes")) is not None:
                        await upstream.send(b)
                    elif (t := msg.get("text")) is not None:
                        await upstream.send(t)          # Finalize / audio.done
                elif (out := _eleven_up(msg)) is not None:
                    await upstream.send(out)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            await upstream.close()

    async def to_browser():
        try:
            async for raw in upstream:
                if isinstance(raw, bytes):
                    continue
                if name == "eleven":
                    if (out := _eleven_down(raw)) is not None:
                        await ws.send_json(out)
                    continue
                # Echo finals to the terminal. Without this you cannot tell a
                # dead mic from a mis-heard wake word from a router miss, which
                # are three very different problems with the same symptom.
                try:
                    m = json.loads(raw)
                    if m.get("is_final") and m.get("speech_final"):
                        _log_heard(m.get("text", ""), "grok")
                except (json.JSONDecodeError, TypeError):
                    pass
                await ws.send_text(raw)
        except Exception as e:
            print(f"[stt] {name} upstream closed: {type(e).__name__}: {e}", flush=True)

    a = asyncio.create_task(to_upstream())
    b = asyncio.create_task(to_browser())
    done, pending = await asyncio.wait({a, b}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    if name == "grok" and b in done and time.monotonic() - opened < 8:
        _grok_down_until = time.monotonic() + GROK_COOLDOWN_S
        print(f"[stt] grok dropped after {time.monotonic() - opened:.1f}s; using the next provider for {GROK_COOLDOWN_S}s", flush=True)
    for close in (upstream.close, ws.close):
        try:
            await close()
        except Exception:
            pass
    print(f"[stt] {name} stream closed", flush=True)


async def transcribe_file(data: bytes, filename: str = "clip.webm") -> dict:
    """Batch fallback for the record-then-send path. Grok, then ElevenLabs."""
    import httpx
    lang = os.getenv("STT_LANGUAGE", "").strip()
    errors = []
    for name in chain():
        if not _usable(name):
            continue
        if name == "grok":
            form = {"model": (None, os.getenv("STT_MODEL", "grok-voice-transcribe-2.0")),
                    "format": (None, "true"), "file": (filename, data, "application/octet-stream")}
            if lang:
                form["language"] = (None, lang)
            terms = os.getenv("STT_KEYTERMS", "").strip()
            if terms:
                form["keyterm"] = (None, terms)
            url, headers = "https://api.x.ai/v1/stt", {"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"}
        else:
            form = {"model_id": (None, os.getenv("ELEVEN_STT_BATCH_MODEL", "scribe_v2")),
                    "file": (filename, data, "application/octet-stream")}
            if lang:
                form["language_code"] = (None, lang)
            url, headers = "https://api.elevenlabs.io/v1/speech-to-text", {"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(url, headers=headers, files=form)
        except Exception as e:
            errors.append(f"{name}: {type(e).__name__}")
            continue
        if r.status_code == 200:
            out = r.json()
            _log_heard(out.get("text", ""), name)
            return {**out, "provider": name}
        errors.append(f"{name} {r.status_code}: {r.text[:120]}")
    return {"text": "", "error": "; ".join(errors) or "no speech-to-text provider available"}
