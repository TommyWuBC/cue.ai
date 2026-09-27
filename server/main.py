import json
import os, pathlib
from dotenv import load_dotenv
load_dotenv(pathlib.Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, Response, Request, WebSocket, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import fallback, memory, router, stt, tts
from checkout import Checkout, CheckoutError
from trust import TrustError, MERCHANT_PATH, MAX_BODY
import httpx

ROOT = pathlib.Path(__file__).parent.parent
app = FastAPI(title="Cue")
checkout = Checkout()
shopper = memory.ShopperMemory()


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


def _trace(text: str, out: dict, ctx: dict | None = None):
    """One line per turn: what came in, what page it was on, who handled it, and
    what happens next. `ask` is staged, not performed, and leaving it out of the
    log made a correct readback look like Cue had done nothing at all."""
    verbs = ",".join(a.get("verb", "?") for a in out.get("do", [])) or "-"
    staged = ",".join(a.get("verb", "?") for a in (out.get("ask") or []))
    page = (ctx or {}).get("page") if isinstance((ctx or {}).get("page"), dict) else {}
    where = f'{page.get("kind", "?")}:{str(page.get("title") or "")[:36]}'
    print(f'[turn] "{text[:70]}" [{where}] -> {out.get("source", "?"):8} '
          f'do={verbs:24}{" ask=" + staged if staged else ""} say="{(out.get("say") or "")[:60]}"', flush=True)
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


class MerchantApproval(PasskeyResponse):
    intent: dict


def checkout_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except (CheckoutError, TrustError) as exc:
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
async def checkout_approve(body: PasskeyResponse):
    # Agent and merchant share a process in this demo. An ASGI HTTP hop keeps
    # the same signed bytes/headers and verification route used by an external
    # agent, without a loopback socket or trusting an incoming Host as a URL.
    intent = checkout_call(checkout.intent_for_ceremony, body.ceremony_id)
    signed = checkout_call(checkout.agent_trust.sign, {**body.model_dump(), "intent": intent})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        response = await client.send(signed)
    return JSONResponse(response.json(), status_code=response.status_code)


@app.post(MERCHANT_PATH)
async def merchant_approve(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BODY:
            raise HTTPException(413, "The approval request is too large.")
    proof = checkout_call(checkout.agent_trust.verify, request.method, str(request.url),
                          request.headers, bytes(raw))
    try:
        body = MerchantApproval.model_validate_json(raw)
    except ValueError as exc:
        raise HTTPException(400, "Invalid signed approval payload.") from exc
    return checkout_call(checkout.approve, body.ceremony_id, body.credential,
                         expected_intent=body.intent, agent_proof=proof)


@app.get("/.well-known/cue-agent-keys.json")
def agent_public_keys():
    return checkout.agent_trust.public_keys()


@app.get("/api/merchant/trust")
def merchant_trust():
    return checkout.agent_trust.status()


@app.post("/api/checkout/cancel/{intent_id}")
def checkout_cancel(intent_id: str):
    return checkout_call(checkout.cancel, intent_id)


@app.get("/api/merchant/orders")
def merchant_orders():
    return {"orders": checkout.orders()}


@app.post("/utterance")
def utterance(u: Utterance):
    session = (u.context or {}).get("session") if isinstance(u.context, dict) else None
    ctx = u.context if isinstance(u.context, dict) else {}
    details = ctx.get("product_details") if isinstance(ctx.get("product_details"), list) else []
    known = ctx.get("known") if isinstance(ctx.get("known"), list) else []
    convo = ctx.get("convo") if isinstance(ctx.get("convo"), list) else []
    # The page speaks lines the server never sees (router actions, refusals like
    # "I don't see an add button"). They come back in convo, and without them the
    # log shows a turn that looks fine and a shopper who heard something else.
    spoken = [t.get("content", "") for t in convo if isinstance(t, dict) and t.get("role") == "assistant"]
    if spoken:
        print(f'[said] "{spoken[-1][:120]}"', flush=True)
    if ctx.get("url"):
        print(f"[ctx] build={str(ctx.get('client_build') or 'OLD (no build stamp)')[:40]} "
              f"details={len(details)} known={len(known)} convo={len(ctx.get('convo') or [])} "
              f"stats={json.dumps(ctx.get('details_stats'))[:260]} "
              f"{[str((d or {}).get('title', ''))[:30] for d in details[:3]]}", flush=True)
    fast = router.route(u.text)
    if fast:
        shopper.note(session, u.text, fast)
        return _trace(u.text, fast, ctx)
    if os.getenv("ANTHROPIC_API_KEY"):
        try:
            import agent
            out = agent.respond(u.text, u.context, shopper.prompt_block(session))
            shopper.note(session, u.text, out)
            return _trace(u.text, out, ctx)
        except Exception as e:
            # Never let a dead key or saturated venue wifi kill the demo.
            print(f"[agent] {type(e).__name__}: {e} -> falling back to local answerer", flush=True)
    out = fallback.answer(u.text, u.context)
    shopper.note(session, u.text, out)
    return _trace(u.text, out, ctx)


# ── Speech in ───────────────────────────────────────────────────────────────
@app.websocket("/stt")
async def stt_socket(ws: WebSocket):
    await stt.proxy(ws)


@app.post("/stt/file")
async def stt_file(file: UploadFile = File(...)):
    """Batch fallback for when the stream will not hold."""
    if not stt.available():
        return JSONResponse({"text": "", "error": "no speech-to-text provider available"}, status_code=503)
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
            "agent_key": bool(os.getenv("ANTHROPIC_API_KEY")),
            "agent_model": os.getenv("CUE_MODEL", "claude-haiku-4-5-20251001"),
            "stt_key": bool(os.getenv("XAI_API_KEY"))}


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
