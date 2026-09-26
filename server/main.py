import os, pathlib
from dotenv import load_dotenv
load_dotenv(pathlib.Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, Response, WebSocket, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import fallback, router, stt, tts

ROOT = pathlib.Path(__file__).parent.parent
app = FastAPI(title="Cue")


class Utterance(BaseModel):
    text: str
    context: dict = {}


def _trace(text: str, out: dict):
    """One line per turn: what came in, who handled it, what happens next.
    Paired with [stt] heard, this makes every failure legible from the terminal
    instead of requiring the browser console."""
    verbs = ",".join(a.get("verb", "?") for a in out.get("do", [])) or "-"
    say = (out.get("say") or "")[:60]
    print(f'[turn] "{text}" -> {out.get("source", "?"):8} do={verbs:28} say="{say}"', flush=True)
    return out


@app.post("/utterance")
def utterance(u: Utterance):
    fast = router.route(u.text)
    if fast:
        return _trace(u.text, fast)
    if os.getenv("XAI_API_KEY"):
        try:
            import agent
            return _trace(u.text, agent.respond(u.text, u.context))
        except Exception as e:
            # Never let a dead key or saturated venue wifi kill the demo.
            print(f"[agent] {type(e).__name__}: {e} -> falling back to local answerer", flush=True)
    return _trace(u.text, fallback.answer(u.text, u.context))


# ── Speech in ───────────────────────────────────────────────────────────────
@app.websocket("/stt")
async def stt_socket(ws: WebSocket):
    await stt.proxy(ws)


@app.post("/stt/file")
async def stt_file(file: UploadFile = File(...)):
    """Batch fallback for when the stream will not hold."""
    if not stt.available():
        return JSONResponse({"text": "", "error": "grok stt unavailable"}, status_code=503)
    return await stt.transcribe_file(await file.read(), file.filename or "clip.webm")


# ── Speech out ──────────────────────────────────────────────────────────────
@app.get("/tts")
def speak(text: str):
    audio, source, said = tts.synth(text)
    if audio is None:
        # Hand back the normalised text so the browser voice says the same words.
        return JSONResponse({"mode": "browser", "text": said})
    return Response(audio, media_type="audio/mpeg",
                    headers={"x-cue-tts": source, "x-aura-tts": source})


@app.get("/health")
def health():
    return {"ok": True, "tts": tts.budget_status(), "stt": stt.status(),
            "grok_key": bool(os.getenv("XAI_API_KEY")),
            "grok_model": os.getenv("GROK_MODEL", "grok-4")}


@app.get("/models")
def models():
    """Model ids drift. Hit this to see what your key can actually call."""
    import httpx
    if not os.getenv("XAI_API_KEY"):
        return JSONResponse({"error": "no XAI_API_KEY"}, status_code=400)
    r = httpx.get("https://api.x.ai/v1/models",
                  headers={"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"}, timeout=15)
    return r.json()


# Dev hygiene: browsers cache ES modules aggressively, and an hour spent
# debugging a stale module is an hour you do not have. Never cache app code.
@app.middleware("http")
async def no_store(request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith("/vendor"):
        resp.headers["cache-control"] = "no-store, must-revalidate"
    return resp


app.mount("/client", StaticFiles(directory=ROOT / "client"), name="client")
app.mount("/vendor", StaticFiles(directory=ROOT / "vendor"), name="vendor")
app.mount("/", StaticFiles(directory=ROOT / "store", html=True), name="store")
