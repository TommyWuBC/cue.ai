# Cue design notes

Moved out of `CLAUDE.md` unchanged. Read the section for whatever you are touching.

## The accuracy problem, and why the UI looks the way it does

> **Gaze v2 replaced WebGazer** (see `docs/GAZE.md`). The numbers below were measured
> with WebGazer and still shape the UI until v2 is measured on real faces.

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
- Below the precision bar the focus brackets thin out and fade.
  At 242px a confident outline is on the *wrong* card two times in three —
  showing certainty we do not have is worse than showing none.
- **What it looks like** (`client/overlay.css`): each numbered badge is a small
  Cue mark, the number inside the mark's C with the dot in its opening; the
  focused badge's dot turns Cue blue. Candidates get four corner brackets set
  in the gutter outside the card, never a tinted box over the photo, and
  buttons get only their number. The reticle is the mark's dot. Warnings
  (uncertain gaze, drift, the calibration quality card) use the mark's
  charcoal and off-white, and the card's gauge is the C, filled by precision.
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

**This is already most of "make the agent persistent and personalised."** If a
session is asked to bolt on cross-visit memory or a shopper profile from
scratch, check `server/memory.py` first — it likely already exists and the
real work is extending it, not creating it.

### What "understanding" is built from, three separate signals

Do not read these as redundant — each covers a failure the others do not:

- **`server/memory.py`** — the shopper, across visits and across this tab's
  turns. Sizes, colours, price sensitivity, short notes, recent orders.
- **`client/product-memory.js`** — the last two products actually *discussed*,
  across page navigations, in `sessionStorage` (or the extension's isolated
  memory area — see below). Incidental gaze passing over a product does not
  overwrite it; only a named or focused-and-spoken-about product does. This is
  what makes "how's this different from the one before" work after a page
  change.
- **`client/intent.js`** — within one turn, what the shopper actually *said*
  versus where they happened to be looking. A product named in the sentence
  outranks gaze; size and colour are recorded only when spoken, because a
  card's default colour showing on screen is not a choice the shopper made.
  `matchCandidates()` returns every top-scoring product — a tie means the
  words were not specific enough, which is a real state Cue has to ask about,
  not silently resolve by picking one.

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
The microphone and speaker turn off — nobody nearby can dictate a card number
and nobody can overhear one read back. The shopper dwells on a gaze keypad
(`DwellActivator`, 1000ms default — long enough that a glance cannot approve
anything) to enter the fictional demo card shown on screen. Only a matching
fixture continues to the order review. Looking at Approve with passkey opens the
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

## Clicking and typing by voice

"Click / open / select / choose / go to X", "search for / find me X", "type X
(into the Y field) (and press enter)", "press enter" and "find X on this page"
are router rules, so they work without the model and in ~0ms. The router
declines anything deictic ("click it", "type that") and "find me the cheapest
…" — those need the model or the page catalog. Typed text is matched against
the original casing, so an email address survives.

On the page, `click_named` tries, in order: a size or colour of the product in
scope ("select medium" is the M button, not a button called Medium; on a
product page with nothing focused, the page's product is the scope), an option
in a native `<select>`, then `findControl()`. That searches the on-screen
controls, then `clickables()` — the whole document including checkboxes,
radios and labels — then the same two lists by sound (`bestMatch`). Off-screen
targets are scrolled into view first. `controls()` is still viewport-only
because badges and the agent context are built from it.

`fill` with no field named types into a field the shopper focused, then the
search box. Focus Cue left behind from its own last typing does not count, or
"type desk top" after filling the newsletter box lands in the newsletter box.
`submit` presses enter on the field Cue last typed into. Both announce after
the dispatch loop, so "type X and press enter" is one line, and a reply from
the model replaces it.

## Misheard speech is corrected against the page

`client/speech.js`, three layers, each conservative:

1. **Bias the recogniser.** `stt.py` always sends `Cue` and `Hey Cue` as
   keyterms on top of `STT_KEYTERMS`. Keyterms are fixed when the socket
   opens, so page-specific words cannot be added per page.
2. **Correct on the client, only where the page makes sense of it.**
   `findWake()` accepts "q", "queue", "kew" etc. as the first word, a
   sound-alike ("cute", "cool") only when a command follows it, and never a
   word that is itself a command ("go" keys the same as "Cue"; "go to
   checkout" is not "Cue, to checkout"). `correctVerb()` fixes the first word
   ("clique" → click, "serch for" → search for) only if the rest then matches a
   control or field on this page. Names match by a coarse phonetic key plus
   edit distance, and a near tie between two names returns nothing rather than
   a guess ("bak" could be Bag or Back).
3. **Tell the model.** The prompt says `said` is a noisy transcript to read
   against `controls`, `fields` and products; when the client corrected it,
   `heard` carries the raw text. The server logs `[stt] corrected "…" -> "…"`.

---

## Cue on any site: the browser extension

`extension/` (manifest v3) is what makes "any website" real rather than a
claim. It is a genuinely separate delivery mechanism from the demo store —
build it with `python3 tools/build-extension.py`.

- **`extension/extract.js`** reads product evidence already on the live page:
  schema.org/JSON-LD `Product` blocks first (most real retailers ship these,
  clean and structured), falling back to DOM heuristics. No network fetches,
  no hidden-page crawling — it only ever reads what is already rendered.
  `isProduct()`/`normalize()` pull title, price, currency and material out of
  a JSON-LD node; a search page with many products' JSON-LD present does not
  get them all tagged onto one container (`canonical()` checks the node's own
  URL against the page's).
- **`extension/content.js`** runs `extract.js` on a `MutationObserver` +
  scroll-debounced loop, writing `data-cueProduct` onto matched elements —
  the exact same attribute the demo store's own markup uses, so
  `client/resolver.js` needs no adapter-awareness at all. It calls
  `resolver.js`'s `invalidate()` after every pass, because the resolver's
  cache cannot see a live SPA updating a card in place.
- **`extension/background.js`** keeps one session per tab in
  `chrome.storage.session`, keyed by tab id and checked against the tab's
  origin. A shopper approves a store once from the toolbar icon; later visits
  to *that store* start Cue automatically, show the splash, then calibrate.
  Moving to another page on the *same* store restores the already-trained
  gaze model and skips both the splash and the calibration dots
  (`resuming`/`calibration` passed through `client/config.js`'s
  `injectedCfg`). "Cue, end" or "Cue, exit" stops the camera and pauses that
  tab until the icon is clicked again.
- **Content scripts share the page's Web Storage with the page itself** — so
  `client/product-memory.js` cannot use `sessionStorage` there without a real
  site being able to read Cue's own memory of what was discussed.
  `content.js` instead proxies reads/writes through
  `chrome.runtime.sendMessage({type: 'cue:memory:read'|'cue:memory:write'})`
  into the extension's own isolated storage, and hands that to
  `productMemory()` as a custom `storage` object with the same
  `getItem`/`setItem` shape `sessionStorage` has.
- **Checkout still redirects to the demo store.** The extension shows Cue on
  the live page for browsing, discussing and adding to a bag; the actual
  passkey/order flow is `server/checkout.py`'s, which only that origin serves.

## Signed agent requests (RFC 9421 / Ed25519)

`server/trust.py`. Real HTTP message signing per RFC 9421, not a demo
placeholder: `HTTPMessageSigner`/`HTTPMessageVerifier` from
`http_message_signatures`, an Ed25519 keypair, and a signature over
`@method @authority @path @query content-type content-digest` plus a
`content-digest` body hash. Verification runs before passkey approval in the
merchant checkout path.

**Read its own docstring before describing this to anyone**, because it
draws an exact boundary the project must not overstate: *"This demo pins
Cue's own Ed25519 public key. It does not claim Visa enrollment, Visa
consumer identity, or a Visa payment container."* It authenticates that a
request genuinely came from Cue's signing key unmodified — a real, useful
property — but it is not a claim of Visa's Trusted Agent Protocol enrollment.
Signing keys stay server-side; the merchant verifies the whole HTTP request
before a passkey prompt is ever shown.

This is the piece the guardian-approval pitch (above) would need to extend or
duplicate, aimed at a different recipient — see that section for what is
missing to get there.

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

### `node --check file.js` does not parse it the way the browser does

There is no `"type": "module"` in `package.json`, so `node --check` reads a
`.js` file as a **script**, and a script is sloppier than a module. `aura.js`
shipped a stray `);` closing `async function beginTurn` — valid as a script,
a `SyntaxError` in the browser. Nothing imports `aura.js` in the tests, so it
was never parsed as a module, and the whole dispatch layer silently failed to
load on every page for several commits while the avatar and gaze, which are
separate module graphs, kept running and made it look alive.

To actually check a browser module, force module parsing:

```bash
cp client/aura.js /tmp/check.mjs && node --check /tmp/check.mjs
```

A file that no test imports is a file nothing has ever parsed. If you add one
to `client/`, either import it from a test or check it this way.

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

## Cue's face reacts to what it says

Cue's face is the Cue mark on a charcoal tile. The two Cs hold still; the dot
is the eye. It looks where the shopper looks (kept clear of the strokes by
`confine()`), blinks by flattening, and droops and dims after 30s of nothing.

`client/avatar.js` picks its reaction from the text of each `SAY`: a hop and
sparkles for "Added…", "Order approved", "Removed the…"; a tilt and a raised
eye for anything ending in "?" (so every staged "…Add it?"); a shake and a
smaller, lower eye for "couldn't", "isn't", "cancel…"; a nod for "Okay". The
patterns are `HAPPY`, `CONCERN` and `ACK` at the top of the file. **Rewording
a reply can change or drop its reaction**, so check them when you change what
Cue says.

Everything else comes from real signals: gaze, clicks, `STATE` (`ptt`,
`awake`), `STT`/`UTTERANCE` partials (the eye turns blue and sends rings),
in-flight requests (the eye scans), and `voice.getVoiceState().speaking` (the
eye pulses with the reply's letters). The dock mirrors the avatar through
`data-cue-state`. Try any reaction from the console:
`cueAvatar.react("celebrate" | "concerned" | "ask" | "thinking" | "boop" | "perk" | "sleep")`.

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

- `client/resolver.js` cache key is scroll + viewport + element counts, and by
  itself misses lazy-loaded images resizing cards or an SPA route change that
  keeps the element count stable. Both places that inject Cue currently paper
  over this by calling `invalidate()` themselves — the demo store's router on
  every route change, `extension/content.js` after every `MutationObserver`
  pass on a live page — so this is closed for both surfaces Cue actually runs
  on today, not fixed at the source. A third way of injecting `resolver.js`
  that forgets to call `invalidate()` will hit it again.
- Action ids embed `Math.round(rect.top)`, so they change on scroll.
- Push-to-talk captures Space globally, guarding only `INPUT`/`TEXTAREA` — not
  `contenteditable`, not shadow DOM.
- The HUD has no Shadow DOM, so host-page CSS will leak into it.
- `window.cueStore` and `window.cueCheckout` are both demo-store globals, so on
  a real site `stageCheckout()` reaches neither. That fallback used to say
  "There's no cart on this page", which a live session heard while sitting on
  Amazon's own cart with seven items in it. It now finds the shop's own money
  control and goes through the same readback-and-second-yes confirmation that
  `click_named` uses, so "proceed to checkout" works on a real site. The demo
  store's two branches are checked first and are unchanged.

## The toolbar icon opens a panel, and why

`extension/popup.html` is the whole click. `4ddaf22` had replaced it with a
bare `chrome.action.onClicked` that started Cue in one gesture, and the failure
branches reported themselves only through `setBadgeText`. **An extension cannot
pin its own icon** — there is no API, Chrome and Brave reserve that for the
user — so on an unpinned icon that badge is invisible and every refusal looks
identical to a broken extension. It is one of those refusals that sent a
session hunting a bug that did not exist.

The panel says, in words, which of them happened: server unreachable, not a
shopping page, already running. `supported()` also rejects the demo store
itself (`origin === SERVER.origin`) because Cue is already built into that
page — clicking the icon on `localhost:4173` is *supposed* to do nothing.

**The store grant has to be the first `await` in the panel's click handler.**
`chrome.permissions.request()` is only allowed while the click is still the
current gesture, and awaiting anything first — a `tabs.query`, a health check —
loses it. `check()` resolves the tab up front so the handler does not have to.
Lose that grant and hands-free startup on later visits goes with it.

Setting `default_popup` means `chrome.action.onClicked` **never fires**. Both
paths cannot exist; `background.js` keeps only `startFromPanel()`, which also
clears the "Cue, end" pause.


## Things that are true and surprising

- `grok-4` does not exist on our key. Use `grok-4.20-0309-non-reasoning`: 0.50s vs
  2.54s for `grok-4.7`, and shorter answers, which is what you want read aloud.
  `curl localhost:4173/models` lists what the key can call.
- Visa Direct and PAAI 404 pending product approval. A prior hackathon team burned
  hours on it and demoed mocks. Stripe test mode behind the existing interface is the plan.
- `curl localhost:4173/health` shows what is live: keys, provider, characters spent.
- A dead mic, a misheard wake word, and a router miss look identical from outside;
  the `[stt]` and `[turn]` log lines tell them apart. `STT_LOG=0` silences `[stt]`.

## Session knowledge and conversation (client/knowledge.js)
Every product Cue sees is kept for the visit with its card links (product, reviews,
brand) and compact facts read from its page, in extension session storage, so a
search that replaces the page does not erase what was discussed. Ad-redirect links
(`/sspa/click?url=...`) are unwrapped to `/dp/ASIN` before the background reader
sees them; before that 114 of 115 were rejected as "not product-looking". The
client also keeps the full conversation, including lines only the page speaks, and
sends it as `context.convo`; `agent._convo` prefers it over the server's history.
`open_link{target, part}` opens a known item's page or reviews (same origin, never
cart/checkout).

## Numbering removed (2026-09-26)
Badges numbered the few products nearest the gaze point, and the shopper picked one
by saying its number. In live use the numbers drifted as the eyes moved, they were
spoken back in long "Which one? 5 is the Sponsored ad..." lines, and the agent
confused a badge number with a position in a list. Selection is now by name, which
is what people said anyway. `client/badges.js`, `focus_number`/`describe_number` and
the router's ordinal fast path are gone; `focus_nth` remains as the agent's own
ordinal over products in reading order.

## The page the shopper is on (context.page)
The agent used to get only `page_text` on question-shaped utterances, so on a product
page it answered from `looking_at` — a 250px guess that often landed on an ad — and
said it could not see the page. `pageBrief()` now always sends kind (product /
results / page), title, url, and on a single-product page that product's own facts.
`agent._page` type-checks and caps it; it stays untrusted evidence.
