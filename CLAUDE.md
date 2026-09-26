# Cue — how it works

Read this before changing anything. It covers the parts that are non-obvious,
the decisions that are load-bearing, and the traps that have already cost us
hours. `ARCHITECTURE.md` is the interface contract; this is the reasoning.

**Keep this file current.** If you change how something works in a way another
teammate would be surprised by, update the relevant section in the same commit.

---

## The one-sentence version

You look at roughly the right area, Cue numbers the things near your gaze, you
say the number, and you talk to it about what you picked. Gaze never acts on
its own; voice always commits.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
cp .env.example .env          # paste XAI_API_KEY and ELEVENLABS_API_KEY
.venv/bin/uvicorn main:app --app-dir server --port 4173 --reload
```

Open **http://localhost:4173** in Chrome or Brave. Not the Claude preview pane
— it blocks camera and mic.

| URL flag | Effect |
|---|---|
| `?gaze=mouse` | mouse instead of eyes, no camera |
| `?gaze=sim` | mouse as truth + synthetic gaze noise through the real filter |
| `?sigma=242` | how noisy sim mode is (242 = our real measured error) |
| `?cal=0` | skip calibration |
| `?keepdata=1` | reuse the stored gaze model instead of wiping it |
| `?mc=0.1&beta=0.0005&dc=0.3` | override the filter, disables auto-tuning |

**`?gaze=sim&sigma=242` is the most useful one.** It reproduces what the real
camera actually does, without a camera. Develop against it.

## Watch what it is doing

```bash
tail -f /tmp/cue-server.log | grep -E '\[stt\]|\[turn\]|\[agent\]'
```

```
[stt] heard: "Cue, add the second one in medium."
[turn] "add the second one in medium." -> router   do=focus_nth,select_variant,add_to_cart
```

A dead mic, a misheard wake word, and a router miss all look identical from the
outside. These two lines tell them apart. `STT_LOG=0` silences the first.

---

## The accuracy problem, and why the UI looks the way it does

This is the single most important thing to understand about this codebase.

**Measured gaze error on a real face is 220–250px.** WebGazer's own published
figure is ~130px; we are worse, and it varies run to run. Amazon's product tiles
are 249px wide. Measured through our own pipeline at σ=242:

| | |
|---|---|
| Gaze alone picks the card you are looking at | **2 / 6** — chance |
| Intended card is among the four nearest | **6 / 6** |

So **gaze is a region signal, not a pointer**, and everything follows from that:

- `client/badges.js` stamps big numbers on the few products nearest your gaze.
  You say "two". This is the primary selection mechanism, not a fallback.
- Below the precision bar the focus outline goes dashed and semi-transparent.
  At 242px a confident outline is on the *wrong* card two times in three —
  showing certainty we do not have is worse than showing none.
- The reticle grows as confidence drops. Honest beats fake-precise.

**Do not "fix" this by making the outline bold again or removing the badges.**
The numbers are measured; they are in the git history if you want to re-check.

### Three things poison the gaze model — all now handled, don't undo them

`client/gaze.js`, in `start()`:

1. `saveDataAcrossSessions(false)` — WebGazer persists training data across
   sessions by default. Ours had accumulated garbage from every past run.
2. `clearData()` after `begin()` — it is async and only exists post-begin.
3. `removeMouseEventListeners()` — **the big one.** `begin()` installs
   capture-phase click and mousemove listeners that train the regression on the
   assumption you were looking wherever you clicked. Across all the `?gaze=mouse`
   and `?gaze=sim` runs, where the cursor had nothing to do with the eyes, that
   wrote thousands of false pairs. Removing it took measured error from a hard
   242px into the 150–220 band on the first clean run.

### It learns while you use it

`learnFromSelection()` in `client/gaze.js`. When you *say* "two", we know
exactly which item you meant, and that badge was only on screen because you were
already looking near it. That is a true training pair, free, several times a
minute — so every spoken selection feeds `recordScreenPosition`.

Gated: the named item must be within 420px of the current estimate, or naming
something while looking away would undo the calibration.

This matters most at a demo table where a different face sits down every few
minutes.

### Measuring, honestly

```js
await cue.experiment()     // the whole before/after, hands-free
await cue.measure()        // one reading: { error_px, raw_px, samples, learned_from }
```

`measure()` runs the five validation points **without retraining or changing
anything**, so before/after comparisons are real.

`experiment()` is the one to reach for. It measures, tells you to use Cue
normally, waits until it has learned from 8 spoken selections, measures again,
and prints the verdict. Both need the camera — they return null in
`?gaze=sim` / `?gaze=mouse`.

**If `error_px` is flat after a dozen selections, the self-learning is not
working and it is worth saying so** rather than assuming it helped.

### The filter

One Euro, not an EMA. `client/gaze.js` top of file.

The original median+EMA removed **0%** of the noise — its saccade escape hatch
(reset on any >90px jump) fired on nearly every frame because WebGazer's
frame-to-frame delta routinely exceeds any threshold small enough to catch a
real saccade. It defeated itself.

Constants are swept, not guessed, and there are two sets because one tuning
cannot serve both a good and a bad signal:

| signal | noise sd | jitter | settle |
|---|---|---|---|
| σ=70 tuning at σ=70 | 19px | 10px | 260ms |
| σ=70 tuning at σ=242 | 112px | 47px | — |
| σ=242 tuning at σ=242 | 56px | 16px | 333ms |

`tuningFor()` picks from the accuracy measured at calibration. **`dCutoff` must
stay well below the noise frequency** — if it drifts up, the speed estimate is
driven by the noise itself and `beta` re-opens the filter it was meant to close.

To re-sweep: open `?gaze=sim&sigma=<yours>`, `import { oneEuro } from '/client/gaze.js'`,
and bench stillness against settle time. The harness is ~40 lines; see git
history for the exact script.

---

## Voice

### Three ways in, one gate

Wake word ("Cue, …", 12s conversation window after), push-to-talk (hold space),
or `cue.say("...")` from the console. All land in `handleTranscript()` in
`client/voice.js` — **intent gating lives in exactly one place** so the paths
cannot drift.

### Bugs that are fixed and easy to reintroduce

- **Push-to-talk needs a tail, not a flag.** The final transcript arrives
  hundreds of ms *after* you release the key. Reading an instantaneous `ptt`
  boolean at that moment always saw false, so every held-space utterance was
  discarded. `pttUntil` arms a 2.5s window.
- **Barge-in must not swallow the command that caused it.** `stopSpeaking()`
  sets a self-hear guard; applying that guard to the interrupting utterance
  means interrupting Cue reliably loses what you said. See `barged` in
  `handleTranscript()`.
- **Cue must not interrupt itself.** The mic hears our own speakers. `isEcho()`
  compares the transcript against what we are currently saying. The old code
  treated any 3+ characters as barge-in, so Cue cut itself off one syllable into
  every sentence. Do not blanket-mute during speech instead — that kills
  barge-in entirely, which I tried and had to undo.

### STT is Grok, proxied

`server/stt.py` bridges the browser to `wss://api.x.ai/v1/stt`. It is a proxy so
the xAI key never reaches the page. Grok's `Finalize` control message is built
for push-to-talk — release the key, get the transcript immediately.

**`keyterm` is one term per repeated query parameter, max 50 chars each.** A
comma-joined string is a single long term and xAI rejects the whole handshake
with HTTP 400. That cost an hour; the error body explains it, which is why the
proxy now surfaces the body instead of just `str(e)`.

Brave ships no working Web Speech API, so there is **no browser fallback there**
— Grok has to be up. The HUD chip shows which is live.

### TTS

ElevenLabs, `server/tts.py`. Notes:

- Text is normalised to spoken form server-side (`spoken()`), and the browser
  path is handed the same string, so "$79.99" is never read as digits by either.
- **128kbps, not 64.** 64 smears sibilants into static and was a real part of
  "the voice sounds robotic".
- Repeats come from `server/cache/` free. Before rehearsing:
  `TTS_PROVIDER=eleven .venv/bin/python server/prewarm.py`
- `ELEVEN_CHAR_BUDGET` hard-stops to the browser voice rather than failing.
- Browsers refuse audio before a user gesture and Brave is stricter than Chrome.
  The opening line is held and spoken on first interaction rather than lost.

---

## Models are served by us, not tfhub

WebGazer bundles no weights — it fetched ~6 MB from `tfhub.dev` on every cold
start. Saturated venue wifi would have meant no eye tracking at all, and a
third-party page's CSP will block it outright.

`tools/patch-webgazer.py` rewrites the three hardcoded URLs to read
`globalThis.CUE_MODELS`, falling back to the originals. Idempotent, keeps a
pristine copy at `vendor/webgazer.orig.js` (gitignored). Weights live in
`vendor/models/`. It also disables the iris model — WebGazer downloads 2.6 MB
of it and then calls `estimateFaces` with `predictIrises: false`. Download is
3.4 MB, all local.

**If you ever update `vendor/webgazer.js`, re-run the patch script.**
`python3 tools/patch-webgazer.py --check` tells you if it is applied.

Cache rule in `server/main.py`: `/vendor/models/**` is immutable for a week,
`/vendor/*.js` is `no-cache` (revalidate, still 304s), everything else is
`no-store`. `/vendor` used to be exempt entirely, so browsers heuristically
cached a stale `webgazer.js` — the first attempt at the model patch looked like
it had failed when it had actually worked.

---

## Who says what

The **page** announces outcomes only it can know: "Added.", the over-budget
refusal. The **router/agent** announces intent it is certain of.

The router must never say "Added." optimistically. It did, and a refused item
was announced as added one breath after the refusal.

## Nothing spends money on one utterance

`checkout` **stages** an order and reads it back — item, total, remaining
budget. A separate `confirm` completes it. Budget is enforced at add time, in
the page, not at checkout.

This is the Visa trust story, so do not collapse it into one step to save a
demo second.

## Questions are not commands

`server/router.py` bails to the LLM when an utterance opens with an
interrogative. Without that, "how is this different from **the second one**"
matched the ordinal rule and was silently executed as a selection — the user
asked something and got silence. `can/could/would you …` are deliberately
excluded; those are polite commands.

---

## Config and origins

`client/config.js` resolves the Cue server **absolutely**. Never build a URL
from `location.host` — injected into Amazon, `new WebSocket(location.host + "/stt")`
opens a socket to Amazon. Query-string config is honoured only when Cue is
served from its own origin, because a real store has its own params (`?k=` on
Amazon).

`server/main.py` has permissive CORS. That is correct for a localhost dev server
driven by its own extension; it is not reachable from anywhere but this machine.

## The markup contract

`data-cue-product` (JSON blob) and `data-cue-action` on the page; the legacy
`data-aura-*` spelling still works everywhere so in-flight branches do not break.
`client/resolver.js` is the only thing that reads them.

Three places in `client/aura.js` bypass the resolver with literal selectors:
`scope()`, `select_variant`, `add_to_cart`. **`add_to_cart` is safety-critical**
— a global `querySelector` there adds the first product on the page, i.e.
charges for the wrong item.

---

## Known gaps

- `client/resolver.js` cache key is scroll + viewport + element counts. It misses
  lazy-loaded images resizing cards and SPA route changes. No `MutationObserver`
  yet — fine on the tagged demo store, not fine on a real site.
- Action ids embed `Math.round(rect.top)`, so they change on scroll.
- `case "navigate"` in `aura.js` writes an **LLM-supplied URL straight to
  `location.href`** with no validation. Fix before this runs on arbitrary pages.
- Push-to-talk captures Space globally, guarding only `INPUT`/`TEXTAREA` — not
  `contenteditable`, not shadow DOM.
- The HUD has no Shadow DOM, so host-page CSS will leak into it.
- `window.cueStore` is provided only by the demo store, so checkout/confirm is
  dead on any other page.
- No extension yet. A content script runs in the page's own frame, so the
  warning in `ARCHITECTURE.md` about wrong coordinate frames applies to an
  extension *page*, not a content script.

## Things that are true and surprising

- `grok-4` does not exist on our key. Use `grok-4.20-0309-non-reasoning` — 0.50s
  vs 2.54s for `grok-4.7`, and shorter answers, which is what you want read
  aloud. `curl localhost:4173/models` lists what the key can actually call.
- Visa Direct and PAAI 404 pending product approval. A prior hackathon team
  burned hours on it and demoed mocks. Stripe test mode behind the existing
  interface is the plan.
- `curl localhost:4173/health` tells you what is actually live — keys, provider,
  characters spent.
