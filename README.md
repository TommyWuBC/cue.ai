# Aura — shop with your eyes and your voice

Track 1 of the build: **gaze targeting + conversational AI**. Payments, passkey and
the merchant console come later — see the plan.

## Run

    cd aura
    python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
    cp .env.example .env          # optional: add XAI_API_KEY
    .venv/bin/uvicorn main:app --app-dir server --port 4173 --reload

Open **http://localhost:4173** in Chrome (not the Claude preview pane — it blocks
camera and mic).

    ?gaze=mouse    drive with the mouse instead of the eyes (dev + demo fallback)
    ?cal=0         skip calibration

Calibration: look at each dot, press SPACE. Nine points, ~30 seconds.

## Testing without a mic

    aura.say("is this wool")
    aura.say("the third one")
    aura.say("add it")

Same code path as speech — the wake word and STT are the only thing bypassed.

## How the pieces fit

    client/bus.js       one event bus, everything crosses it
    client/gaze.js      WebGazer -> median filter -> adaptive EMA -> dwell -> FOCUS
    client/resolver.js  gaze point -> nearest tagged element
    client/voice.js     Web Speech STT, wake word, barge-in, tiered TTS playback
    client/aura.js      orchestration: utterance -> server -> speech + page actions
    server/router.py    regex fast path; the demo's core commands never hit an LLM
    server/agent.py     Grok, one call, strict JSON out
    server/fallback.py  offline answerer over the product data (no key needed)
    server/tts.py       ElevenLabs with disk cache + hard character budget

Markup contract and event shapes: see `ARCHITECTURE.md`.

## Why it is built this way

**Gaze never selects; voice commits.** Gaze sets focus, speech confirms. This is
the accessibility story and it is also why ~5cm of WebGazer error does not matter.

**Only tagged elements are targetable.** `data-aura-product` / `data-aura-action`.
Six big hit targets on a page beats pixel-accurate tracking.

**Everything in one coordinate frame.** Camera, mic, calibration and overlay all
run in the store page. Running WebGazer from a separate extension page would put
its regression output in the wrong frame.

**The demo degrades instead of dying.** No xAI key or dead wifi falls back to
`fallback.py`. No ElevenLabs credits falls back to the browser voice. No camera
falls back to `?gaze=mouse`. No mic falls back to `aura.say()`.

## ElevenLabs credits

Default is `TTS_PROVIDER=browser` — development costs nothing. Before rehearsing:

    TTS_PROVIDER=eleven .venv/bin/python server/prewarm.py

That generates the fixed demo lines once into `server/cache/`. From then on they
replay from disk for free, however many times you run the demo. Dynamic lines are
cached by hash, `eleven_flash_v2_5` is half the credits of v2, and
`ELEVEN_CHAR_BUDGET` hard-stops to the browser voice when exhausted.
Check spend: `curl localhost:4173/health`.

## Not done yet

Cart/checkout are local state only. No passkey, no Stripe, no signed agent
requests, no merchant console, no H&M. Those are the Visa track.
