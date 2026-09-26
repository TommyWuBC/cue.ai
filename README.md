# Cue — shop with your eyes and your voice

Gaze targeting, conversational answers, and a local demo checkout with server
enforced limits and passkey approval. Demo orders do not charge a card.

## Run

    cd cue
    python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
    cp .env.example .env          # optional: add XAI_API_KEY
    .venv/bin/uvicorn main:app --app-dir server --port 4173 --reload

Open **http://localhost:4173** in Chrome (not the Claude preview pane — it blocks
camera and mic). Use `localhost` exactly: the passkey origin is configured for it.

    ?gaze=mouse    drive with the mouse instead of the eyes (dev + demo fallback)
    ?cal=0         skip calibration

Calibration: look at each dot and say “Cue, next”, or press SPACE. Nine points,
~30 seconds. If tracking becomes unstable or stops, Cue clears the current focus
and shows a recalibration prompt. Say “Cue, recalibrate” to start again.

## Testing without a mic

    cue.say("is this wool")
    cue.say("the third one")
    cue.say("add it")

Same code path as speech — the wake word and STT are the only thing bypassed.

## How the pieces fit

    client/bus.js       one event bus, everything crosses it
    client/gaze.js      WebGazer -> median filter -> adaptive EMA -> dwell -> FOCUS
    client/resolver.js  gaze point -> nearest tagged element
    client/voice.js     Web Speech STT, wake word, barge-in, tiered TTS playback
    client/aura.js      orchestration: utterance -> server -> speech + page actions
    store/checkout.js   spoken order review + browser passkey ceremony
    server/checkout.py  server priced cart, limits, passkey verification, SQLite orders
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
falls back to `?gaze=mouse`. No mic falls back to `cue.say()`.

## ElevenLabs credits

Default is `TTS_PROVIDER=browser` — development costs nothing. Before rehearsing:

    TTS_PROVIDER=eleven .venv/bin/python server/prewarm.py

That generates the fixed demo lines once into `server/cache/`. From then on they
replay from disk for free, however many times you run the demo. Dynamic lines are
cached by hash, `eleven_flash_v2_5` is half the credits of v2, and
`ELEVEN_CHAR_BUDGET` hard-stops to the browser voice when exhausted.
Check spend: `curl localhost:4173/health`.

## Demo checkout

Add an item, say “Cue, check out”, and listen to the item, total, and remaining
budget. Set up a passkey once, then say “Cue, yes” and approve in the browser's
passkey prompt. A nearby phone may be offered by the browser. The merchant view
is at `http://localhost:4173/merchant.html`. Orders and the monthly budget are
stored in `server/data/cue.sqlite3` (ignored by git). The server sets prices from
`store/products.json`; cart prices sent by the browser are never accepted.

Say “Cue, the second one” to focus a product, then “Cue, medium, in black”
to set options. “Cue, add the second one in medium, in black” combines those
steps. A size is required before adding; no size is silently chosen.

For page control, say “Cue, scroll down”, “Cue, scroll to top”, “Cue, go
back”, or “Cue, click this” while looking at a button. Scrolling or resizing
clears focus when its target leaves the viewport, so “add it” cannot reuse an
off-screen item.

This is a **single shopper, localhost demo**. It has no account enrollment or
merchant login and must not be deployed to the public internet as-is. It records
passkey-approved demo orders but does not charge a card. Stripe/Visa sandbox
payment and Visa Trusted Agent Protocol signing are still to be built.
