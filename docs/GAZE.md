# Gaze v2: how Cue sees where you look

This replaces the WebGazer pipeline. The short version of why: WebGazer's own
paper claims 4–5°, but independent as-deployed measurements put it at 6–11°,
and ours measured 220–350px. It also runs a heavy TF.js face mesh on the main
thread, re-fits a ridge model on raw eye-patch pixels, and gives no head-pose
handling, which is where most of the drift, lag and flicker came from.

## What the field does

- **Features from landmarks, not pixels.** MediaPipe Face Landmarker gives 478
  landmarks including iris centres, a head pose matrix and eye blendshapes, at
  ~10 ms a frame on the GPU. The 2026 capture-clock study reports FaceMesh
  features with kernel ridge regression at ~3–4° against WebGazer's ~6–7°.
  WebEyeTrack (ACM MM 2025) uses the same landmarks plus head pose and a
  9-sample personalisation step.
- **Report fixations, not raw samples.** Gaze is noisy by nature: the eye
  itself jitters (microsaccades), and webcam estimates add far more. Eye
  trackers smooth heavily while the eye is still, and let saccades through
  immediately (One Euro filter, velocity-threshold saccade detection).
- **Never make gaze the click.** Tobii's guidance and the Midas-touch
  literature: gaze plus an explicit signal (a key, a pinch, a word) is the most
  predictable interaction. Apple's visionOS does exactly this, with no cursor
  and a hover highlight on whatever you look at.
- **Calibrate with motion, check with fixations.** Smooth-pursuit calibration
  (follow a moving dot) collects far more data than tapping through points and
  was more accurate in the literature (0.84° vs 1.39° on an EyeLink). A short
  set of fixation points afterwards gives an honest accuracy number.

## Philosophy for Cue

1. **Gaze suggests, voice decides.** Looking never acts. It only answers
   "which one do you mean by *this*?" The voice commits, the passkey pays.
2. **Honest about precision.** The UI never shows more certainty than the
   tracker has. Confidence comes from the measured calibration error, face
   tracking quality and how far the head has moved since calibrating.
3. **Stable beats precise.** A highlight that sits still on roughly the right
   thing is usable; one that jitters on exactly the right thing is not. Focus
   changes only on a real fixation, with hysteresis between neighbours.
4. **Fast enough to feel attached to your eyes.** Target under 100 ms from
   camera frame to highlight: landmark inference on the GPU, one prediction per
   video frame (`requestVideoFrameCallback`), no Kalman stacking.
5. **It should get better while you use it.** Every selection the voice
   confirms is a free, correct training pair.
6. **No hands required, anywhere.** Calibration needs no key presses: you
   follow a dot and look at a few points. "Cue, recalibrate" redoes it.

## The pipeline

```
camera frame (rVFC, ~30 fps)
  -> Face Landmarker (478 landmarks, head pose matrix, blendshapes)   eyes.js
  -> features: iris position inside each eye in eye-local coordinates,
     eyelid aperture, eye-look blendshapes, head yaw/pitch/roll and
     position                                                  gaze-features.js
  -> blink / no-face rejection
  -> per-user regression, fitted at calibration (ridge on expanded
     features, or RBF kernel ridge; whichever cross-validates better)
                                                                gaze-model.js
  -> fixation filter: One Euro while fixating, snap on saccades  fixation.js
  -> gaze.js: dwell, focus, hysteresis, confidence, drift     (unchanged API)
```

**Features, not raw pixels.** Iris offsets are measured in each eye's own
frame (origin between the corners, x along the corners, scaled by eye width),
so rolling your head or leaning in does not change them. Vertical gaze is the
hard axis on webcams, so it gets three signals: iris offset, eyelid aperture
(the lids follow the eyes) and MediaPipe's own look-up/look-down blendshapes.
Head pose enters as its own features, so the model learns how head movement
shifts the mapping instead of breaking.

**Model.** Standardised features, then both a ridge regression over a
quadratic expansion and an RBF kernel ridge regression are fitted, each with
its regularisation picked by leave-one-target-out cross-validation. The one
with lower held-out error is kept. It is small linear algebra in plain JS:
a few hundred samples, a fit in milliseconds.

**Calibration.** About 20 seconds, no keys:
1. Nine fixation points, auto-advancing. The first 450 ms at each point are
   discarded (the eye is still travelling), blinks are dropped.
2. A smooth-pursuit sweep: follow the dot round the screen. Camera and eye lag
   the target, so several lags are tried and the best-fitting one is used.
3. Five validation points the model never trained on. Their error is the
   number shown to the shopper and the one that sets confidence.

## Attention, not a pointer

Even done well, a webcam is off by 100-200px, about half a product card. So
Cue does not treat gaze as a cursor. `client/attention.js` keeps an invisible
attention map instead: every estimate is a Gaussian blob with the measured
error as its spread, and each item's share is the probability that the true
gaze is inside its box (much more under the centre, some for neighbours,
nothing far away). Shares are integrated at three speeds: **fast** (~0.5 s,
what holds the eyes now), **recent** (~4 s) and **studied** (~45 s), plus plain
seconds per item for the visit.

What it is used for:

- **The highlight** follows attention, not the dot: an item takes it only when
  it holds at least half the current attention for ~0.4 s and beats the
  current one by 1.4x. Looking at empty space keeps the last highlight. There
  is no floating gaze dot (`?gazedebug=1` shows one).
- **"This"** is what held the eyes as the sentence began. A split between two
  items is left for the agent, which asks "the wool coat or the puffer?".
- **"These", "both", "compare them"** mean the two items the eyes have been
  going between; **"the one I was looking at"** means the most studied one.
- **Being torn** between two items for a few seconds brings a silent hint in
  the dock: "Deciding between A and B? Say “compare them”." Once per pair per
  minute, never while speaking.
- **The agent** gets `attention` in its context (titles and shares only), and
  the offline fallback uses it the same way, so this works with no API key.

## Speech and gaze together

People look at a thing, then refer to it. By the time the sentence ends, the
eyes have often moved on (to the dock, to the next item). So Cue pins what
you were looking at **when you started speaking**, using a short fixation
history, and holds it while the conversation continues. "Is this wool?"
means what you looked at as you said "this", not wherever your eyes wandered
while Cue was answering.

## UX rules

- No gaze cursor by default. The existing reticle widens as confidence
  falls; the focus outline follows fixations, not samples.
- Focus commits after a fixation of about 300 ms, and a neighbour must be
  clearly closer to take it over.
- Blinks and lost faces freeze the estimate rather than dropping it.
- `?gazedebug=1` shows the camera, the eye landmarks, fps, latency,
  the fixation state and the live accuracy, for diagnosing a bad session.

## Later (designed for, not built yet)

- **Continuous recalibration** from any confirmed selection and from clicks
  in mouse-assisted sessions, with a sliding window so it tracks drift.
- **Gaze-aware disambiguation:** "which one?" answered by looking, with Cue
  reading the two candidates you are looking between.
- **Reading and attention:** knowing you are reading reviews, pausing speech
  when you look away, resuming when you look back.
- **Dwell mode** as an opt-in for users who cannot speak reliably, with long
  dwell times and a visible progress ring (never the default).
- **Gaze scrolling** by looking at the page edge (already partly present).
- **Merchant analytics** from aggregated, consented attention data only.
- **Moving feature extraction into an offscreen document** for the
  extension, so page CSP cannot block the WASM runtime; only the regression
  runs in the page, which keeps it in the page's coordinate frame.

## How to try it

1. Run the server and open `http://localhost:4173/?gazedebug=1` in Chrome.
2. Allow the camera. Sit about an arm's length away, face lit from the front.
3. Say "Cue, ready" (or press space) and follow the dot: nine points, one
   sweep, five checks. About 20 seconds.
4. The debug panel shows the validated error in px, the model it picked, fps
   and latency. `await cue.gaze.measure()` re-measures any time without
   changing anything.

Test it with real faces before trusting any number: everything here has been
checked on a live browser with a camera stream of a still photo (the pipeline,
frame rate, feature stability) and on synthetic data (the model, the pursuit
lag, the fixation filter), but not yet on a person moving their eyes.

## Known limits

- **The extension on third-party sites needs one more step.** MediaPipe loads
  its WASM through a `<script>` it adds to the page, which runs in the page's
  world, not the content script's, and can be blocked by a store's CSP. The
  fix is the offscreen-document split above. The demo store is unaffected, and
  the extension currently runs in mouse mode.
- **Speed depends on the GPU.** Inference is ~5-10 ms on a laptop GPU; the CPU
  fallback works but is slower, so latency rises.
- **Vertical accuracy is always worse than horizontal** on a webcam: the eye
  moves less vertically and the lids hide the iris. The lid and blendshape
  features exist to claw some of that back.
- **Glasses, strong backlight and moving your head a lot** still hurt, as with
  every webcam tracker. Head pose is a model input, and the drift nudge still
  asks for a recalibration when the head moves too far.
