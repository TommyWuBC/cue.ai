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

**Measured gaze error on a real face is 220–350px**, varying run to run
(observed: 242, then 150–220, then >220, then 341). WebGazer's own published
figure is ~130px; we are worse, and it varies run to run. Amazon's product tiles
are 249px wide. Measured through our own pipeline at σ=242:

| | |
|---|---|
| Gaze alone picks the card you are looking at | **2 / 6** — chance |
| Intended card is among the four nearest | **6 / 6** |

So **gaze is a region signal, not a pointer**, and everything follows from that:

- `client/badges.js` stamps big numbers on products near your gaze. You say
  "two". This is the primary selection mechanism, not a fallback.
- **How many get numbered scales with the measured error** (`setPrecision()`).
  At ~150px the nearest four is a precise, quiet affordance. Past ~240px gaze
  barely narrows anything, so *everything on screen* gets a number and the
  voice does all the work. Busier, but it cannot miss — verified 6/6 reachable
  at 341px, where numbering only four would sometimes omit the wanted item.
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

### Head movement

`client/gaze.js`, the "Head pose" section. Webgazer fits its regression at ONE
head position; move and the mapping is simply wrong. This is the largest source
of drift after calibration and filtering cannot fix it, because the error is
systematic rather than noise.

We read the face mesh (`webgazer.getTracker().getPositions()`), take the
midpoint of the eye corners as head position and interocular distance as a
depth proxy, and baseline it at calibration. Then three things:

1. **Confidence falls** as the head moves away from the calibration pose. A
   tight sample cloud from a moved head is *confidently wrong*, and dispersion
   alone cannot see that. Losing the face entirely drops confidence to 0.
2. **The drift nudge names the cause** — "you've moved since we calibrated",
   "you've leaned in", "I can't see your face" — instead of something generic.
   See `driftReason()`.
3. **A linear correction is subtracted**, with the gain *learned* from spoken
   selections rather than guessed. Each selection contributes (head offset,
   resulting error); `fitHeadGain()` least-squares it per axis.

The compensation is deliberately timid: nothing is applied until there are 8+
samples spread over real head movement, and the gain is clamped. A wrong
compensation is worse than none. Inspect with `cue.head()`.

**The fit must use `state.uncomp`, the estimate before compensation.** Fitting
against an already-compensated error feeds the correction into its own input
and lets it run away.

### Calibration can be advanced by voice

"Cue, next" advances a calibration dot, as well as space. Someone who cannot
use a trackpad cannot press space either, and calibration is the very first
screen they meet. This is why `voice.startListening()` runs **before**
`gaze.calibrate()` in boot — move it back after and the feature silently dies.
`aura.js` declines to forward utterances to the server while calibrating, so
the calibration's own listener is the only consumer.

While a calibration screen is up, "next" and the accuracy modal's "continue
anyway" / "try again" are accepted **without the wake word**. Push-to-talk is
off for that whole screen, and the prompts quote the phrases they want back,
so the echo filter used to swallow them. `calibrationCommand()` in
`client/voice.js` sits in front of both gates, and it cancels the prompt
before the verdict is spoken. Do not route those phrases through the normal
wake-word path.

### Tracking quality, and dropping focus

`checkQuality()` runs on the dwell loop. Bad tracking is not always noisy — a
frozen feed or a face out of frame gives a rock-steady, completely wrong
estimate that dispersion cannot detect. So it checks sample freshness and
plausibility directly, and after `LOW_CONFIDENCE_MS` of that it **drops focus**
and raises `GAZE_QUALITY`, which shows the panel with a Recalibrate button.
Pointing confidently at the wrong thing is worse than pointing at nothing.

### Stray trackpad input

- **The pointer goes stale after 3s.** In mouse and sim modes a brushed
  trackpad would otherwise leave the cursor steering Cue for the rest of the
  demo. After `POINTER_IDLE_MS` of stillness the estimate freezes where it is
  — frozen, not cleared, so what you already selected stays selected — and
  resumes the instant the pointer genuinely moves.
- **Real clicks on money actions are blocked in gaze mode.** In gaze mode the
  user is not holding the trackpad, so a trusted click on add-to-cart or
  checkout is far more likely to be a palm than an intent. Cue's own clicks are
  synthetic (`isTrusted === false`) and pass straight through. Sizes and other
  harmless actions are not blocked.

### Voice-set focus is sticky

Saying "two" and then talking about it must not let gaze take the focus back.
The lock used to expire on a 3.5s timer, so `"two"` → two questions → `"add it"`
added whatever the eyes had drifted onto — effectively random at 242px. Every
utterance now calls `gaze.holdFocus()`. Gaze regains control once the
conversation stops.

The product a turn was about is `discussed`. A product named in the sentence
(`client/intent.js`) replaces it. Looking somewhere else does not, except
"this one" or "the one I'm looking at". Size and color are recorded only
when spoken — the card's default color is not a choice — and an add asks for
whichever of them is still missing before the readback. "Search for wool coats" uses whatever search field is on the page. If the
shop only shows a search icon, Cue opens that control, then types. A few
same-origin pages already linked from the current page are read so Cue can
open a section by name. Product numbers come from visible cards, not from
one shop's class names. Buttons and icons near the gaze are numbered too, and
saying that number opens them. Add-to-bag and checkout stay spoken on purpose.
Edge scrolling follows whichever box is actually scrolling under the gaze.
Many shops do not scroll the window. Learning extra pages happens in the
background and does not delay calibration. Edge scroll sits
between the original hold and the looser one: 330ms to start, 150px from the
edge, and about 180ms of slack once it is moving.

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

**The outlier gate needs its `SACCADE_STUCK` escape.** Requiring three
consecutive samples to agree within 150px is fine at σ=70, but at σ=242
consecutive samples differ by ~340px on average, so that agreement essentially
never happens and a genuine large gaze shift is rejected forever — the estimate
sits frozen at the old location. After 6 consecutive rejections the gate
re-acquires at the median of what it rejected. Large shifts land in ~290ms.

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

### Every voice path falls back: Grok, then ElevenLabs, then the browser

We are in xAI's track, so Grok is always first. `server/tts.py` tries Grok
TTS, then ElevenLabs, then hands the page spoken text for the browser voice.
`server/stt.py` tries Grok, then ElevenLabs Scribe, then sends
`cue.unavailable` and the page starts the browser recogniser.

- **The page speaks one STT dialect, Grok's.** When the server falls back to
  ElevenLabs it translates both ways in `stt.py` (`_eleven_up`/`_eleven_down`):
  PCM becomes `input_audio_chunk`, `Finalize` becomes a commit, committed
  transcripts become a final `transcript.partial`. `client/mic.js` never needs
  to know which provider answered.
- **The server always sends a verdict first**: `cue.ready` with the provider,
  or `cue.unavailable`. `mic.start()` waits for it and returns false on
  unavailable, which is what makes `voice.js` start the browser recogniser.
  Before this, an unavailable verdict after the socket opened left Cue deaf.
- **ElevenLabs accepts the socket even with a bad key** and reports it as the
  first message. Only `session_started` counts as success.
- **If Grok's stream dies within 8s of opening, Grok is skipped for 60s**, so
  the page's automatic reconnect lands on ElevenLabs instead of looping.
- `curl localhost:4173/health` shows each chain and which provider is live.
- Testing against a server on another port: the client always calls
  `localhost:4173` unless you add `?server=http://localhost:<port>`.

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

Grok first, then ElevenLabs, then the browser voice, in `server/tts.py`. Notes:

- Text is normalised to spoken form server-side (`spoken()`), and the browser
  path is handed the same string, so "$79.99" is never read as digits by either.
- **128kbps, not 64.** 64 smears sibilants into static and was a real part of
  "the voice sounds robotic".
- Repeats come from `server/cache/` free. Before rehearsing:
  `.venv/bin/python server/prewarm.py` (same chain as live speech).
- `XAI_TTS_CHAR_BUDGET` and `ELEVEN_CHAR_BUDGET` hard-stop each provider and
  fall through to the next rather than failing.
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

## The agent is the brain

`server/router.py` is a latency shortcut, not the understanding. It handles an exact handful: yes, no, checkout, a bare number, "what's two", "Cue, end", recalibrate, and passkey setup. Those last two stay there because the page refuses them when they come from the model. Every other phrase goes to `server/agent.py`.

The model sees the last ten turns of this browser tab, plus a shopper profile that survives visits. Both live in the same SQLite file as orders (`server/memory.py`, shopper id `local`, session id from the tab). The profile records sizes, colours, price sensitivity, and short notes from what the shopper actually said, and recent purchases are read from the orders table. There is no account login.

## Who says what

The **page** announces outcomes only it can know: "Added.", the over-budget
refusal. The **router/agent** announces intent it is certain of.

The router must never say "Added." optimistically. It did, and a refused item
was announced as added one breath after the refusal.

## Checkout: two paths, one set of words

There are two checkout implementations and they are both live.

- **`store/checkout.js` + `server/checkout.py`** is the real one: server-side
  repricing, per-order and monthly caps rechecked *inside the SQLite write
  transaction*, a WebAuthn challenge bound to a pending intent, and the
  customer's own words stored on the order. `store/merchant.html` reads
  `/api/merchant/orders`.
- **`stageCheckout()` in `client/aura.js`** is the fallback for any page
  without that flow — it stages, reads back and waits for `confirm`.

`checkout` picks whichever exists. The subtlety worth knowing:

**The router maps a bare "yes" to `approve_checkout`, not `confirm`**, because
its anchored checkout rules are tried first. Only the page knows whether the
passkey dialog is actually open, so `aura.js` reconciles: `approve_checkout`
falls back to `confirm` when no dialog is up, and `confirm` drives the dialog
when one is. Change one side and you must change the other, or "yes" silently
does nothing in one of the two worlds.

**`cancel` is never refused.** `prepare()` holds its `busy` flag for the whole
spoken readback, and the original `cancel()` early-returned on `busy` — so
while Cue read your order aloud you could not say no. On a payment
confirmation that is the one moment cancel must work. It now stops the speech,
clears the intent and closes the dialog regardless, and `prepare()` checks a
`cancelled` flag after its await so it cannot re-arm a dismissed dialog.

**The dialog is modal to Cue too.** While it is open, only
approve/cancel/setup_passkey/confirm/cancel/recalibrate get through.
Recalibrate is on that list deliberately: losing tracking mid-dialog would
otherwise trap you in it.

## Cue may shop. Only the human may commit.

This is the centre of the project, so be careful changing it.

The agent **is** allowed to buy — `add_to_cart` and `checkout` are both things
it can propose. What it can never do is commit. `checkout` only stages an order
and reads it back; it charges nothing. The charge needs the shopper's own
spoken yes and their passkey.

`confirm`, `approve_checkout` and `setup_passkey` are enforced human-only in
**two independent places**, because one of them being wrong should not be
enough: `sanitize()` in `server/agent.py` drops them from any model response,
and the dispatch loop in `client/aura.js` refuses them when `source === "grok"`.
The second one is the one that survives a jailbreak, because it is the page and
not the prompt.

The agent can also **stage** a sequence with `ask`, which is how it buys
politely: it says exactly what it is about to do, and the shopper's yes performs
it. `ask` is a list and must contain everything the sentence promised — say "in
medium" and stage the size too, or the yes lands on a page with no size chosen
and silently does nothing.

`sanitize()` has a net for a model that narrates without acting: a sentence
claiming an add with nothing proposed is converted into an `ask`. Telling
someone who cannot see the screen "adding it to your bag" while doing nothing
leaves them believing they bought something they did not — the worst failure
this system has.

## There has to be a way back out

A system whose premise is that gaze is imprecise will put the wrong thing in
the bag. `remove(index)` existed in `store/app/cart.js` but nothing could
reach it, so a wrong item was permanent — the single worst gap for a judge
trying it cold.

`window.cueBag` exposes items/remove/clear/open, and the verbs are
`remove_item` (by name, by number, or the last one), `read_bag` and
`open_bag`. Removal is confirmed the same way an add is, because removing the
wrong thing is its own mistake.

"What's in my bag" sits above the question guard for the same reason
"what can I click" does: a question by grammar, a command by intent. STT drops
apostrophes constantly, so the patterns accept "whats" as well as "what's".

## Every add is confirmed too

The bag is where a wrong item first gets in, and at 300px of gaze error that
is a live possibility on every add — so an add is read back and waits, exactly
like a charge.

`perform("add_to_cart")` stages rather than acts unless it is passed
`{ confirmed: true }`. One place, so the spoken command, the compound command
and the agent are all held to the same bar. `describeAdd()` builds the line —
item, colour, size, price — because for some users it is the only description
of the purchase they will get. No size chosen means it asks for the size
instead of guessing.

A staged sequence from the agent passes `confirmed: true` when it runs, since
the whole sequence was already read back; otherwise a yes would ask again.

## Nothing charges on one utterance

`checkout` opens private payment mode first (`store/private-payment.js`).
The microphone and speaker turn off. The shopper dwells on a gaze keypad to
enter the fictional demo card shown on screen. Only a matching fixture
continues to the order review. Looking at Approve with passkey opens the
Mac passkey prompt, which on this laptop is Touch ID. Nothing is charged.
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

## Tests

    .venv/bin/python -m pytest tests -q     # router, checkout, api
    node --test tests/*.mjs                 # resolver targeting

`node --test tests/` (with a bare directory) fails on Node 22 with
MODULE_NOT_FOUND — it resolves the path as a module. Use the glob.

`client/resolver.js` and `client/badges.js` are imported by the node runner,
which has no DOM — that is why their top-level `addEventListener` calls are
guarded and why `key()` reads viewport globals off `globalThis` with
fallbacks. Keep new top-level DOM access out of those two files, or guard it.

## #aura-root is in the TOP LAYER

`avatar.js` promotes it with `root.popover = "manual"; root.showPopover()`.
Anything inside `#aura-root` therefore paints above everything on the page,
**z-index is ignored**. That is why the calibration screen appeared covered in
stray dots: the numbered badges live in that root and floated over it.

`overlay.css` therefore hides the whole root during calibration
(`body:has(.aura-cal) #aura-root { visibility: hidden }`) rather than listing
pieces — the dock covered the lower-left training point and the number badges
floated over the dots. The badges are hidden behind a modal dialog too.

**Nothing Cue draws or says may run during calibration.** The drift watch and
the badge loop both have to check `gaze.getState().calibrating`, or Cue
interrupts its own calibration to announce that tracking has drifted.

## The demo store is one document on purpose

`store/index.html` is a single-page app: home, listings, product pages,
search, bag, account, journal, help, stores. Views live in `store/app/views/`
and swap into `#view`; `store/app/router.js` gives each one a real URL with
`history.pushState`.

**Never turn a store link into a full page load.** Every load restarts
WebGazer, which wipes and re-runs calibration. That is why internal `<a>`
clicks are intercepted, and why dev flags (`?gaze=mouse&cal=0` etc.) are
carried from view to view.

- **Refreshing a deep link works** because `store/404.html` is a symlink to
  `index.html`; Starlette's `StaticFiles(html=True)` serves it for unknown
  paths (status 404, full page). Do not replace it with a copy.
- **Every route change calls `invalidate()` from `client/resolver.js`**, and so
  does every image load. The resolver's cache key cannot see a view swap, so
  without it gaze and "the second one" point at elements from the old view.
- **Product scope is `[data-aura-product]`**: cards and the product page's
  `.pdp` section. `store/app/ui.js` owns size, color and add-to-bag for both,
  and `store/app/cart.js` enforces size and limits at add time.
- **Catalog:** 33 products in `store/products.json`. Photos are
  `store/assets/products/<id>-<color>.jpg`; after adding any, regenerate the
  `PHOTOS` map in `store/catalog.js` (it lists which colors have a photo).
  `o8` is priced over the $200 per-order limit on purpose, to demo a refusal.

## Two things that will silently break the overlay

**Class names are `aura-*`, not `cue-*`.** `client/overlay.css` and
`client/avatar.js` both key off them — the avatar seats itself by querying
`#aura-root .aura-hud`. Rename them and the overlay renders completely
unstyled with no avatar, and nothing throws. Only `cue-badge(s)` and
`cue-modal*` use a cue- prefix, and those have their own styles appended at
the bottom of overlay.css.

**`frame()` reschedules itself at the end.** One throw inside it kills the
render loop permanently — no reticle, no badges, no outline tracking, and no
error after the first. If the overlay looks frozen, check that
`ui.reticle.style.transform` is being written; empty means the loop is dead.
Everything it touches (`render`, `ui.*`, `badges`) must exist before boot.

## Known gaps

- `client/resolver.js` cache key is scroll + viewport + element counts. It misses
  lazy-loaded images resizing cards and SPA route changes (the demo store
  calls `invalidate()` for both; a real site has no such hook). No `MutationObserver`
  yet — fine on the tagged demo store, not fine on a real site.
- Action ids embed `Math.round(rect.top)`, so they change on scroll.
- `case "navigate"` in `aura.js` writes an **LLM-supplied URL straight to
  `location.href`** with no validation. Fix before this runs on arbitrary pages.
- Push-to-talk captures Space globally, guarding only `INPUT`/`TEXTAREA` — not
  `contenteditable`, not shadow DOM.
- The HUD has no Shadow DOM, so host-page CSS will leak into it.
- `window.cueStore` is provided only by the demo store, so checkout/confirm is
  dead on any other page.
- `extension/` is the Chrome adapter. The shopper approves a store once from
  the toolbar icon. Later visits to that store start Cue on their own, show
  the logo, then calibrate. Moving to another page on the same store restores
  the gaze model and skips the logo and the dots. "Cue, end" or "Cue, exit"
  stops the camera and pauses that tab until the icon is clicked again.
  Build it with `python3 tools/build-extension.py`. Checkout remains on the
  demo store.

## Things that are true and surprising

- `grok-4` does not exist on our key. Use `grok-4.20-0309-non-reasoning` — 0.50s
  vs 2.54s for `grok-4.7`, and shorter answers, which is what you want read
  aloud. `curl localhost:4173/models` lists what the key can actually call.
- Visa Direct and PAAI 404 pending product approval. A prior hackathon team
  burned hours on it and demoed mocks. Stripe test mode behind the existing
  interface is the plan.
- `curl localhost:4173/health` tells you what is actually live — keys, provider,
  characters spent.
