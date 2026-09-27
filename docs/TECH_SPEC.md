# Cue — Technical Specification

What Cue is built from, and why each piece was chosen over the obvious
alternative. This is a snapshot for judges and new contributors, not a design
rationale document — see `docs/DESIGN.md` for the reasoning behind individual
mechanisms (gaze filtering, the markup contract, the trust rail).

## System shape

Three surfaces, one server:

```
Chrome extension (real sites)  ─┐
Demo store (Northfield)        ─┼─► FastAPI server (localhost:4173) ─► Claude, Grok, ElevenLabs
Comparison / analytics panels  ─┘
```

Everything the shopper's voice reaches passes through one endpoint,
`POST /utterance`, so there is one place that decides what an utterance is
allowed to do, not one per surface.

## Client (browser)

| Piece | Choice | Why |
|---|---|---|
| Extension | Chrome MV3, service-worker background | The only way to inject into a real third-party page (Amazon) with a persistent process; MV2 is deprecated. |
| Language | Vanilla ES modules, no framework | The whole client is event-driven DOM manipulation over someone else's page. React's diffing model fights a page you don't own; a bus + direct DOM calls is less code and has no build step to get stale. |
| Gaze tracking | WebGazer.js (bundles TensorFlow.js) | The only mature browser-side gaze library with no server round-trip — video never leaves the device. Currently switched off (`GAZE_MODE = 'mouse'` in `extension/background.js`) while voice is tuned; selection is by name, not by looking. |
| Gaze filtering | One Euro Filter, hand-implemented | Standard for cursor/gaze smoothing (used in accessibility research) — low-latency at speed, aggressive smoothing when still. Swept against 6 synthetic noise seeds; cut jitter from 87px to 10px. |
| Speech in | AudioWorklet → 16kHz PCM16 → WebSocket → Grok streaming STT | `SpeechRecognition` (Web Speech API) needs near-silence, has no clean push-to-talk finalization, and Chrome kills the session every ~60s — unusable on a demo floor. AudioWorklet runs off the main thread, so gaze rendering doesn't glitch speech capture. |
| Speech out | Grok TTS → ElevenLabs → browser `speechSynthesis` | A three-tier fallback chain: the demo must not go silent because one paid API is out of budget or down. Disk-cached (`server/cache/`) so repeated demo lines cost nothing after the first run. |
| DOM targeting | Accessibility-tree walk (`role`, `aria-label`, tag semantics) + a small tagged-markup contract for the demo store | Works on a page nobody tagged for Cue — which is the whole point of a real-site extension — because every real site already exposes this for screen readers. |
| State | A single event bus (`client/bus.js`), no store library | Every subsystem (gaze, voice, avatar, overlay) reacts to the same typed events. Swapping in Redux/Zustand would add a dependency to solve a problem four files don't have. |

## Server (Python)

| Piece | Choice | Why |
|---|---|---|
| Framework | FastAPI + Uvicorn | Async-native (needed for the STT websocket proxy and concurrent product-page fetches), automatic request validation via Pydantic, no boilerplate for a single-file API surface. |
| Reasoning model | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`), via `anthropic` SDK | Fast enough for a live voice turn, materially more capable than the Grok non-reasoning model this replaced, and instruction-following is what a JSON-only, narrow-action-space contract needs most. Model is overridable via `CUE_MODEL`. |
| Deterministic fast path | Hand-written regex router (`server/router.py`) | Exact commands — "yes", "stop", "add number three" — must not wait on a model round-trip, and must not be something a model could get creative with. This is also where the trust boundary lives: `approve_checkout` only ever originates here. |
| Speech-to-text | Grok streaming STT (kept after the reasoning swap) | Grok's STT is fast and cheap; there was no reason to replace what wasn't broken when only the reasoning layer needed replacing. |
| Text-to-speech | Grok → ElevenLabs → browser (same fallback chain as the client) | Server owns provider selection and the spend ledger, so the client never needs API keys. |
| Storage | SQLite (`server/data/cue.sqlite3`) | One shopper, one process, localhost. No reason to run Postgres for a hackathon demo's order history and passkey credentials. |
| Passkeys | WebAuthn (`webauthn` PyPI package), platform authenticator | The actual standard for "prove it's you" without a password; every modern OS ships an authenticator. |
| Request signing | Ed25519 HTTP Message Signatures (RFC 9421) | Implements the shape of Visa's Trusted Agent Protocol locally: every checkout approval is a signed, non-replayable, time-boxed request the merchant independently verifies — the same trust primitive Visa's TAP spec asks for, without needing Visa directory enrollment to demonstrate it. |

## The trust boundary (why this design exists at all)

This is the part worth reading closely, because it's the answer to "how do
you know the AI won't just buy things":

1. **The model proposes; it cannot commit.** `sanitize()` in `server/agent.py`
   strips `confirm`, `approve_checkout`, and `setup_passkey` from every model
   response before it reaches the client — those verbs are not merely
   discouraged, they are absent from what the model is physically able to
   return.
2. **The client checks the source, not the wording.** Even if a verb slipped
   through, `client/aura.js` refuses commit verbs from any `source` other than
   `"router"` — the deterministic regex path that only fires on the shopper's
   own words. This is keyed on *not being the model*, not on a model name, so
   swapping models (as this project did, Grok → Claude) can't silently
   reopen it.
3. **Money is staged, read back, and waits.** A control that actually charges
   (`Buy now`, `Place your order`) is never pressed on proposal. It's staged as
   a `pendingConfirm`, its real page-printed amount is read back aloud, and
   only a second, separate spoken "yes" — captured by the router, not
   inferred by the model — presses it.
4. **Every approval is signed and cannot be replayed.** The Ed25519 signature
   binds method, path, query, content-type and a body digest; requests expire
   after two minutes and nonces are rejected on reuse, including across
   server restarts (SQLite-backed).

The result: on 2026-09-27, this pipeline placed a real order on Amazon by
voice, end to end, with no code path that could have skipped the spoken yes.

## Testing

| Suite | Tool | What it covers |
|---|---|---|
| `tests/*.py` | `pytest` | Router regex fast paths, `sanitize()`'s verb allowlist, checkout/passkey logic, live conversation quality (calls the real Claude API, skipped without a key) |
| `tests/*.mjs` | Node's built-in test runner | Product extraction, the knowledge store, the comparison panel's markup, speech correction, extension background script |
| `client/aura.js` | **No automated test** | The orchestration layer has no DOM harness (no jsdom in this repo) — verified by reading server logs from live sessions and manual browser checks. This is a known gap, tracked in `future.md`. |

One deliberate trap worth naming: `node --check some-file.js` parses a `.js`
file as a loose script, not a module, and will pass code that the browser
rejects. Every syntax check in this project runs against a copy renamed to
`.mjs` to force real module parsing — this caught a bug that silently broke
the entire client for several commits.

## What is not built

- No production auth or multi-tenant story — this is a single-shopper,
  localhost demo per `README.md`.
- No real payment rail — demo orders are recorded, never charged; a real
  Stripe/Visa sandbox integration is scoped in `docs/ROADMAP.md`.
- No neural voice-speaker identification — the near-field voice gate (if
  built) is a loudness heuristic, not biometric recognition.
