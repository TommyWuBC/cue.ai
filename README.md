# Cue — shop by looking and talking

Gaze targeting, conversational answers, and a local demo checkout with server
enforced limits and passkey approval. Demo orders do not charge a card.

## Run

    python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
    cp .env.example .env          # then paste your two keys in
    .venv/bin/uvicorn main:app --app-dir server --port 4173 --reload

Open **http://localhost:4173** in Chrome (not the Claude preview pane — it blocks
camera and mic). Use `localhost` exactly: the passkey origin is configured for it.

### Experimental live-page extension

Run `python3 tools/build-extension.py`, then load `dist/cue-extension` as an
unpacked extension in Chrome. Start the Cue server first. Open an H&M product
page or Amazon search page, click the Cue toolbar icon, and select **Start on
this page**. The panel checks that the backend is reachable before starting.
The adapter tags
products from visible page markup and Product JSON-LD, then loads the existing
gaze and voice client in that tab's viewport. Video stays on the device. Only
product details and speech requests go to the local server. The intended scope
is shopping questions, scrolling, and focus; checkout stays on Northfield.
Reload the tab to stop the injected client. The extension is an experimental
adapter: page layouts can change, and a full passkey browser test on a live
store has not been run. The build also writes a Chrome Web Store upload ZIP;
see [extension setup and deployment notes](docs/EXTENSION.md).

    ?gaze=mouse      drive with the mouse instead of the eyes (dev + demo fallback)
    ?gaze=sim        mouse as truth + synthetic gaze noise, through the real filter
    ?sigma=110       how noisy sim mode is, in px (default 70)
    ?cal=0           skip calibration

Calibration is thirteen points: look at each dot, then press SPACE, tap the dot,
or say “Cue, next”. Keep looking while the capture message is shown. Five more
points then measure accuracy without any input. If the camera cannot capture
your eyes, the current point shows a retry message. The accuracy figure is
printed to the console; over 150px prompts a retry, and over 220px uses numbered
items for voice selection. Say “Cue, recalibrate” to start again.

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
    client/avatar.js    Cue's animated face; reacts to bus events, never emits any
    store/index.html    the Northfield storefront shell; views in store/app/ (design notes: store/DESIGN.md)
    store/checkout.js   spoken order review + browser passkey ceremony
    server/checkout.py  server priced cart, limits, passkey verification, SQLite orders
    server/router.py    regex fast path; the demo's core commands never hit an LLM
    server/agent.py     Grok, one call, strict JSON out
    server/fallback.py  offline answerer over the product data (no key needed)
    server/tts.py       speech out: Grok, then ElevenLabs, then the browser voice (disk cache first)
    server/stt.py       speech in: Grok, then ElevenLabs Scribe, then the browser recogniser

Markup contract and event shapes: see `ARCHITECTURE.md`.

## Why it is built this way

**Gaze never selects; voice commits.** Gaze sets focus, speech confirms. This is
the accessibility story and it is also why a few cm of webgazer error is harmless.

**AI answers cannot purchase.** Grok can answer questions and suggest reversible
selection or scrolling. The server filters its action list; adding, clicking,
checkout and approval are only reached through explicit command routes and the
passkey step. Partial product data produces an honest "I can't see it" answer.

**Only tagged elements are targetable.** `data-aura-product` / `data-aura-action`
(the `data-cue-*` spelling is also accepted). Six big hit targets on a page
beats pixel-accurate tracking.

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

## Voice credits

Cue speaks with Grok, falls back to ElevenLabs, then to the browser voice.
Repeats are served from `server/cache/` and cost nothing. Before rehearsing:

    .venv/bin/python server/prewarm.py

That generates the fixed demo lines once, with whichever voice is first in the
chain. `XAI_TTS_CHAR_BUDGET` and `ELEVEN_CHAR_BUDGET` hard-stop each provider.
Check spend and which provider is live: `curl localhost:4173/health`.

## Comparing products

Ask about one product, then look at or name another and say “Cue, how is this
different from the last one?” Cue remembers the last distinct product you
discussed or selected, including across page changes in the same tab. Both Grok
and the offline answerer use that product. Memory stays in the tab, expires
after an hour, and contains product details only; incidental gaze changes do
not replace it.

## Demo checkout

Add an item, say “Cue, check out”, and listen to the item, total, and remaining
budget. Set up a passkey once, then say “Cue, yes” and approve in the browser's
passkey prompt. A nearby phone may be offered by the browser. The merchant view
is at `http://localhost:4173/merchant.html`. Orders and the monthly budget are
stored in `server/data/cue.sqlite3` (ignored by git). The server sets prices from
`store/products.json`; cart prices sent by the browser are never accepted.

Say “Cue, cancel” at any point during checkout, including the readback or the
passkey prompt. Cancellation revokes the server intent and its approval
challenges, stops speech, and keeps the bag. If an order was already committed,
Cue reports that instead of claiming it was cancelled. A failed cancellation
can be retried from the dialog.

Say “Cue, the second one” to focus a product, then “Cue, medium, in black”
to set options. “Cue, add the second one in medium, in black” combines those
steps. A size is required before adding; no size is silently chosen.

For page control, say “Cue, scroll down”, “Cue, scroll to top”, “Cue, go
back”, or “Cue, click this” while looking at a button. Scrolling or resizing
clears focus when its target leaves the viewport, so “add it” cannot reuse an
off-screen item.

## Signed agent requests

Every checkout approval now passes through Cue's server signer and a separate
merchant verification endpoint. The Ed25519 HTTP signature binds the request
method, merchant, path, query, content type, and body digest. The body includes
the stored order intent and the shopper's passkey assertion. The merchant
verifies both before recording an order; signing never replaces the passkey.

Requests expire after two minutes. Single-use nonces are stored in SQLite and
rejected on replay, including after server restarts. The merchant view shows
signature evidence and rejected-request counts. Existing orders without
signature evidence are labelled accordingly. The public key is available at
`/.well-known/cue-agent-keys.json`; the private key stays in the local database.

This implements a local agent-recognition profile based on
[Visa's TAP specification](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications)
and RFC 9421. The trust anchor is Cue's local key. Visa directory enrollment,
consumer recognition tokens, and payment containers are not configured.

This is a **single shopper, localhost demo**. It has no account enrollment or
merchant login and must not be deployed to the public internet as-is. It records
passkey-approved demo orders but does not charge a card. Stripe/Visa sandbox
payment remains to be built. See [the remaining work](docs/ROADMAP.md).
