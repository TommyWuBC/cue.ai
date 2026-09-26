# Cue — shop with your eyes and your voice

Track 1 of the build: **gaze targeting + conversational AI**. Payments, passkey and
the merchant console come later — see the plan.

## Run

    python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
    cp .env.example .env          # then paste your two keys in
    .venv/bin/uvicorn main:app --app-dir server --port 4173 --reload

Open **http://localhost:4173** in Chrome (not the Claude preview pane — it blocks
camera and mic).

    ?gaze=mouse      drive with the mouse instead of the eyes (dev + demo fallback)
    ?gaze=sim        mouse as truth + synthetic gaze noise, through the real filter
    ?sigma=110       how noisy sim mode is, in px (default 70)
    ?cal=0           skip calibration

Calibration is nine points (look, press SPACE), then five more where you just
look while Cue measures its own accuracy. About 45 seconds. The accuracy figure
is printed to the console — under ~90px is good, over ~170px and Cue says so.

## Keys

Two, both optional — everything degrades instead of dying.

| Key | Used for | Without it |
|---|---|---|
| `XAI_API_KEY` | Grok reasoning **and** Grok speech-to-text | browser recogniser + offline answerer |
| `ELEVENLABS_API_KEY` | spoken responses | browser voice |

Check what is actually live: `curl localhost:4173/health`

## Testing without a mic

    cue.say("is this wool")
    cue.say("the third one")
    cue.say("add the second one in medium")
    cue.say("check out")
    cue.say("yes")

Same code path as speech — only the wake word and STT are bypassed.

## How the pieces fit

    client/bus.js       one event bus, everything crosses it
    client/gaze.js      webgazer -> outlier gate -> One Euro -> dwell -> FOCUS
    client/mic.js       mic -> 16kHz PCM -> /stt websocket -> Grok
    client/resolver.js  gaze point -> nearest tagged element
    client/voice.js     wake word, push-to-talk, barge-in, echo rejection, TTS playback
    client/aura.js      orchestration: utterance -> server -> speech + page actions
    server/router.py    regex fast path; the demo's core commands never hit an LLM
    server/stt.py       websocket proxy to Grok STT (the key never reaches the page)
    server/agent.py     Grok, one call, strict JSON out
    server/fallback.py  offline answerer over the product data (no key needed)
    server/tts.py       ElevenLabs with spoken-form normalisation, disk cache, budget

Markup contract and event shapes: see `ARCHITECTURE.md`.

## Why it is built this way

**Gaze never selects; voice commits.** Gaze sets focus, speech confirms. This is
the accessibility story and it is also why a few cm of webgazer error is harmless.

**Only tagged elements are targetable.** `data-cue-product` / `data-cue-action`
(the old `data-aura-*` spelling still works). Six big hit targets on a page beats
pixel-accurate tracking.

**Everything in one coordinate frame.** Camera, mic, calibration and overlay all
run in the store page. Running webgazer from a separate extension page would put
its regression output in the wrong frame.

**Nothing spends money on one utterance.** Checkout only *stages* an order and
reads it back; a separate "yes" completes it. The budget is enforced at add time,
not at checkout.

**The demo degrades instead of dying.** No xAI key falls back to `fallback.py` and
the browser recogniser. No ElevenLabs credits falls back to the browser voice. No
camera falls back to `?gaze=mouse`. No mic falls back to `cue.say()`.

## Gaze tuning

The filter was swept against `?gaze=sim` over 6 noise seeds. At sigma=70:

| | before | after |
|---|---|---|
| output noise sd | 70 px | **19 px** |
| frame-to-frame jitter | 87 px | **10 px** |
| worst single jump | 303 px | **46 px** |
| 400px saccade settles in | — | **260 ms** |

Constants live at the top of `client/gaze.js`. To re-sweep, open `?gaze=sim` and
import `oneEuro` from the module — the harness is three dozen lines.

`dCutoff` must stay well BELOW the noise frequency. If it drifts up, the speed
estimate gets driven by the noise itself and `beta` re-opens the filter that was
meant to close.

## ElevenLabs credits

Repeats are served from `server/cache/` and cost nothing. Before rehearsing:

    TTS_PROVIDER=eleven .venv/bin/python server/prewarm.py

That generates the fixed demo lines once. `ELEVEN_CHAR_BUDGET` hard-stops to the
browser voice when exhausted. Check spend: `curl localhost:4173/health`.

## Not done yet

Cart/checkout are local state only. No passkey, no Stripe, no signed agent
requests, no merchant console, no H&M. Those are the Visa track.
