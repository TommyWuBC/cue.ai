import os, pathlib
from dotenv import load_dotenv
load_dotenv(pathlib.Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, Response, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import fallback, router, tts
from checkout import Checkout, CheckoutError

ROOT = pathlib.Path(__file__).parent.parent
app = FastAPI(title="Cue")
checkout = Checkout()


class Utterance(BaseModel):
    text: str
    context: dict = {}


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


@app.get("/api/merchant/orders")
def merchant_orders():
    return {"orders": checkout.orders()}


@app.post("/utterance")
def utterance(u: Utterance):
    fast = router.route(u.text)
    if fast:
        return fast
    if os.getenv("XAI_API_KEY"):
        try:
            import agent
            return agent.respond(u.text, u.context)
        except Exception as e:
            # Never let a dead key or saturated venue wifi kill the demo.
            print(f"[agent] {type(e).__name__}: {e} -> falling back to local answerer")
    return fallback.answer(u.text, u.context)


@app.get("/tts")
def speak(text: str):
    audio, source = tts.synth(text)
    if audio is None:
        return JSONResponse({"mode": "browser"})
    return Response(audio, media_type="audio/mpeg", headers={"x-aura-tts": source})


@app.get("/health")
def health():
    return {"ok": True, "tts": tts.budget_status(),
            "grok_key": bool(os.getenv("XAI_API_KEY")),
            "grok_model": os.getenv("GROK_MODEL", "grok-4")}


@app.get("/models")
def models():
    """Model ids drift. Hit this to see what your key can actually call."""
    import httpx
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
