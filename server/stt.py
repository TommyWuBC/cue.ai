"""Speech to text via Grok, proxied.

The browser streams 16 kHz PCM16 to us over a websocket; we relay it to
wss://api.x.ai/v1/stt and relay transcript events back. It is a proxy rather
than a direct connection for one reason: the xAI key must never reach the page.

Grok's streaming API has a `Finalize` control message built for push-to-talk,
which is exactly the interaction Cue needs — release the key, get the final
transcript immediately instead of waiting out the endpointing silence.
"""
import asyncio, json, os, urllib.parse

import websockets
from fastapi import WebSocket, WebSocketDisconnect

XAI_WS = "wss://api.x.ai/v1/stt"


def available() -> bool:
    return os.getenv("STT_PROVIDER", "grok") == "grok" and bool(os.getenv("XAI_API_KEY"))


def status() -> dict:
    return {
        "provider": os.getenv("STT_PROVIDER", "grok") if available() else "browser",
        "model": os.getenv("STT_MODEL", "grok-voice-transcribe-2.0"),
        "ready": available(),
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


async def proxy(ws: WebSocket):
    """Bridge one browser socket to one xAI socket for the life of the page."""
    await ws.accept()

    if not available():
        await ws.send_json({"type": "cue.unavailable", "reason": "no XAI_API_KEY"})
        await ws.close()
        return

    headers = {"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"}
    try:
        upstream = await websockets.connect(
            _upstream_url(), additional_headers=headers,
            max_size=None, ping_interval=20, ping_timeout=20,
        )
    except Exception as e:
        # xAI rejects a bad handshake with a JSON body that says exactly what is
        # wrong. Surfacing only str(e) hides it and turns a one-line fix into a
        # debugging session, so dig the body out.
        detail = str(e)[:200]
        body = getattr(getattr(e, "response", None), "body", None)
        if body:
            detail = body.decode("utf-8", "replace")[:300]
        print(f"[stt] upstream connect failed: {type(e).__name__}: {detail}", flush=True)
        await ws.send_json({"type": "cue.unavailable", "reason": detail})
        await ws.close()
        return

    print("[stt] grok stream open", flush=True)

    async def to_xai():
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if (b := msg.get("bytes")) is not None:
                    await upstream.send(b)
                elif (t := msg.get("text")) is not None:
                    await upstream.send(t)          # Finalize / audio.done
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            with_suppress = getattr(upstream, "close", None)
            if with_suppress:
                await upstream.close()

    async def to_browser():
        try:
            async for raw in upstream:
                if isinstance(raw, bytes):
                    continue
                await ws.send_text(raw)
        except Exception as e:
            print(f"[stt] upstream closed: {type(e).__name__}: {e}", flush=True)

    a = asyncio.create_task(to_xai())
    b = asyncio.create_task(to_browser())
    done, pending = await asyncio.wait({a, b}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    try:
        await upstream.close()
    except Exception:
        pass
    try:
        await ws.close()
    except Exception:
        pass
    print("[stt] grok stream closed", flush=True)


async def transcribe_file(data: bytes, filename: str = "clip.webm") -> dict:
    """Batch fallback. Used by the record-then-send path when the socket dies."""
    import httpx
    form = {
        "model": (None, os.getenv("STT_MODEL", "grok-voice-transcribe-2.0")),
        "format": (None, "true"),
        "file": (filename, data, "application/octet-stream"),
    }
    lang = os.getenv("STT_LANGUAGE", "").strip()
    if lang:
        form["language"] = (None, lang)
    terms = os.getenv("STT_KEYTERMS", "").strip()
    if terms:
        form["keyterm"] = (None, terms)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            "https://api.x.ai/v1/stt",
            headers={"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"},
            files=form,
        )
    if r.status_code != 200:
        return {"text": "", "error": f"{r.status_code}: {r.text[:200]}"}
    return r.json()
