import os, pathlib
from dotenv import load_dotenv
load_dotenv(pathlib.Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, Response, WebSocket, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import fallback, router, stt, tts
from checkout import Checkout, CheckoutError

ROOT = pathlib.Path(__file__).parent.parent
app = FastAPI(title="Cue")
checkout = Checkout()


# Injected into a third-party page, every call to us is cross-origin. This is
# a localhost dev server driven by its own extension, so the permissive policy
# is the correct one — it is not reachable from anywhere but this machine.
#
# NOTE: allow_credentials stays False. The passkey routes below are
# unauthenticated demo endpoints; if they ever gain a session cookie this must
# become an explicit origin allowlist, because a wildcard with credentials is
# exactly how a hostile page would drive someone else's checkout.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["x-cue-tts", "x-aura-tts"],
)


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

class CartItem(BaseModel):
    id: str
    size: str
    color: str


class PrepareCheckout(BaseModel):
    items: list[CartItem]
    customer_words: str


class PasskeyResponse(BaseModel):
    ceremony_id: str
    credential: dict


def checkout_call(fn, *args):
    try:
        return fn(*args)
    except CheckoutError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


@app.get("/api/checkout/status")
def checkout_status():
    return checkout.status()


@app.post("/api/checkout/prepare")
def checkout_prepare(body: PrepareCheckout):
    return checkout_call(checkout.prepare, [item.model_dump() for item in body.items], body.customer_words)


@app.post("/api/passkey/register/options")
def passkey_register_options():
    return checkout_call(checkout.registration_options)


@app.post("/api/passkey/register/verify")
def passkey_register_verify(body: PasskeyResponse):
    return checkout_call(checkout.register, body.ceremony_id, body.credential)


@app.post("/api/passkey/authenticate/options/{intent_id}")
def passkey_authenticate_options(intent_id: str):
    return checkout_call(checkout.authentication_options, intent_id)


@app.post("/api/checkout/approve")
def checkout_approve(body: PasskeyResponse):
    return checkout_call(checkout.approve, body.ceremony_id, body.credential)


@app.post("/api/checkout/cancel/{intent_id}")
def checkout_cancel(intent_id: str):
    return checkout_call(checkout.cancel, intent_id)


@app.get("/api/merchant/orders")
def merchant_orders():
    return {"orders": checkout.orders()}


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
# debugging a stale module is an hour you do not have.
@app.middleware("http")
async def caching(request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/vendor/models/"):
        # Model weights are content-addressed by their directory and never
        # change. Cache them hard — they are 3.4 MB and we want the second
        # load to be instant.
        resp.headers["cache-control"] = "public, max-age=604800, immutable"
    elif path.startswith("/vendor/"):
        # Previously exempt from cache headers entirely, which meant browsers
        # applied heuristic freshness and happily served a stale webgazer.js
        # after it had been patched. no-cache still allows a 304, so the 1.6 MB
        # is not re-sent — it just has to be revalidated.
        resp.headers["cache-control"] = "no-cache"
    else:
        resp.headers["cache-control"] = "no-store, must-revalidate"
    return resp


app.mount("/client", StaticFiles(directory=ROOT / "client"), name="client")
app.mount("/vendor", StaticFiles(directory=ROOT / "vendor"), name="vendor")
app.mount("/", StaticFiles(directory=ROOT / "store", html=True), name="store")
