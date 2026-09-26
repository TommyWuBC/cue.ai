# Gaze tracking research and experiment plan

Research date: September 26, 2026. Experiment branch: `experiment/gaze-tracking`,
created from browser-extension commit `4ddaf22`. EyeTrax is now implemented as
the default experimental engine, but it has not yet been benchmarked on a person.
The findings below distinguish source inspection from measured performance;
there are no new human accuracy results.

## Experiment implementation

- `server/gaze_companion.py` owns the webcam and EyeTrax estimator. Frames and
  landmark features remain in that local process; an authenticated WebSocket
  sends viewport coordinates, sample age, face presence and blink status.
- `client/eyetrax.js` implements the browser protocol. The extension requests a
  one-use session credential from its background worker before connecting.
- Cue's existing calibration overlay labels current EyeTrax features directly
  in CSS viewport coordinates. It fits screen correction on five points and
  reports error on five different held-out points.
- The model remains in memory across normal document navigation. A changed
  viewport invalidates it. “Cue, exit” shuts down the camera and clears it.
- EyeTrax has one responsive One Euro filter and a 250 ms target dwell. The
  extension package no longer contains WebGazer, TensorFlow.js or their model
  weights. WebGazer remains available on the local demo with `?gaze=webgazer`
  for comparison.
- The reviewed EyeTrax commit and MediaPipe 0.10 runtime are pinned in
  `server/requirements-gaze.txt`. The estimator was initialized successfully on
  the development Mac. The automated shell does not have macOS camera permission,
  so the webcam smoke test stopped with a permission error and closed cleanly.
  Camera-to-target accuracy still requires a user trial after granting Terminal
  or Cursor camera access.

## Previous Cue technology

`client/gaze.js` configures WebGazer with its TFFacemesh tracker and ridge
regression. Face tracking finds the eyes; a calibrated regression maps eye-image
features to screen coordinates. Cue then applies screen correction, head
compensation, outlier rejection, One Euro smoothing, and DOM target selection.
WebGazer's Kalman filter is also enabled.

[WebGazer's official description](https://webgazer.cs.brown.edu/) explains its
browser-local operation and calibration through interaction. Its site now warns
that future updates are not guaranteed. This is a webcam estimator, not a
dedicated infrared eye tracker.

### Problems found in our code

- **Multiple sources of delay:** Kalman filtering, conservative One Euro
  settings (default minimum cutoff 0.20 Hz), an outlier gate that waits for
  repeated large jumps, and a 380 ms target dwell. Cursor smoothing and target
  selection are distinct; these values should not simply be added together as
  an end-to-end latency measurement. Their individual effects need profiling.
- **Head compensation fitting bug (fixed on this branch):** `fitHeadGain()` reused `fit1d()`, whose
  slope is clamped to `[0.5, 3.5]` for screen-coordinate correction. A head gain
  may need a negative sign or a magnitude of hundreds of pixels per inter-eye
  distance. The subsequent clamp to +/-900 cannot recover the discarded slope.
- **Optimistic correction score (fixed on this branch):** the calibration finish path fitted affine
  correction on validation observations and computes corrected error on those
  same observations. That score is not an independent test of the correction.
- **Unreliable online labels:** `learnFromSelection()` treats a selected
  product's center as the fixation position. Naming a product does not establish
  that the user is looking at its center at that instant. The distance guard
  reduces extreme cases but cannot establish ground truth.
- **Potential duplicate inference:** calibration calls `getCurrentPrediction()`
  while tracking is active. Profile this before attributing delay to it.

Existing unit and browser tests check behavior and integration. They do not
establish eye-tracking accuracy on a person. Historical accuracy numbers in code
comments are not a benchmark of this branch.

## What the hackathon projects actually used

| Project | Verified implementation | Relevance to Cue |
| --- | --- | --- |
| Artemis, DubHacks 2025 | EyeTrax, Python, MediaPipe, ridge regression, Kalman filtering; Electron communicates with a Python process through JSON-RPC. | A useful native-companion reference. Its attention-monitoring use case does not prove small-button pointing accuracy. |
| Iris, Cal Hacks 12.0 | EyeTrax-derived Python estimator, MediaPipe refined face landmarks, head-relative feature normalization, ridge by default, WebSocket bridge to a Chrome extension. | Closest architectural reference for Cue; calibrated landmarks differ from WebGazer's eye-image features. |

Artemis's Devpost lists a GROW–The Advocate prize and reports 40–80 px mean error.
That is a creator-reported result, not a transferable guarantee for our users.
Its checked-in service uses nine-point calibration and a Kalman filter; its loop
also sleeps 50 ms after processing, so a camera request of 30 FPS is not proof of
30 predictions per second. Sources: [submission](https://devpost.com/software/artemis-kxd36i)
and [tracking service](https://github.com/tgondil/artemis/blob/main/flowsync/python/eyetrax_service.py).

The Cal Hacks Iris submission lists the Crater Play-Do prize. Its source centers
and rotates landmarks into a head-relative frame, scales by inter-eye distance,
and appends head angles before regression. The submission's latency claim is
not a comparative benchmark. Sources: [submission](https://devpost.com/software/iris-ojrmnv),
[feature extraction](https://github.com/tgondil/iris/blob/main/src/vision_module/gaze.py),
and [default ridge model](https://github.com/tgondil/iris/blob/main/src/vision_module/models/ridge.py).

There is also a different [Iris at Hack the Valley X](https://devpost.com/software/iris-fz4rad),
using MediaPipe/OpenCV and offline speech. These projects should not be conflated.

## Candidate approaches

| Approach | Benefit to investigate | Cost or limitation |
| --- | --- | --- |
| Correct and simplify current WebGazer pipeline | Fastest controlled baseline; isolates our own filtering and calibration defects. | Cannot assume tuning overcomes webcam model limitations. |
| EyeTrax local companion | Direct experiment with the approach used by Artemis/Iris; camera process can outlive page navigation. | Requires a local Python/native application in addition to the extension. Better accuracy remains unproven on our hardware. |
| Browser-native landmark regression | Keeps extension-only distribution; head-relative eye/iris features and calibrated screen mapping. | Must implement and validate the regression, calibration, lifecycle and packaging ourselves. |
| Dedicated infrared eye tracker | Strong option for users needing dependable assistive pointing. | Extra hardware, supported-device SDK, operating-system and licensing constraints. |
| Deep gaze-direction model such as L2CS-Net | Useful later research comparison using learned appearance features. | Outputs gaze direction, not turnkey screen coordinates; additional mapping and runtime work needed. |

[EyeTrax](https://github.com/ck-zhang/eyetrax) is MIT-licensed and provides
calibration, filtering, regression options and model persistence. Use a pinned
version and preserve required notices when integrating it. A local companion
can keep camera frames on the user's machine and transmit coordinates only.

MediaPipe alone does **not** provide the point on a monitor the user is looking
at; its [iris documentation explicitly states this](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/iris.md).
A browser approach still needs supervised screen calibration. Google's
[Face Landmarker web guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)
also notes that inference blocks the UI thread and recommends workers. Bundle
the runtime and model locally and test extension CSP and resource loading.

Dedicated systems commonly use near-infrared illumination and pupil/corneal
reflection geometry; see [Tobii's explanation](https://www.tobii.com/resource-center/learn-articles/how-do-eye-trackers-work).
For accessibility, evaluate a supported assistive device such as
[PCEye](https://www.tobiidynavox.com/pages/pceye), rather than assuming a gaming
tracker has equivalent integration or licensing. Hardware performance also
requires testing under the intended conditions.

[L2CS-Net's repository](https://github.com/Ahmednull/L2CS-Net) is a research
reference for gaze-direction estimation. Do not assume a larger neural model
will automatically improve Cue's calibrated screen targeting.

## Recommended experiment order

1. Build a shared evaluator before replacing the engine. Record raw and filtered
   predictions separately, with timestamps. Keep the existing engine selectable
   as a baseline. Freeze online learning during evaluation.
2. Correct the head-gain fitting and separate calibration fitting from independent
   evaluation. Compare WebGazer with one smoothing layer against today's stack;
   vary target dwell separately from cursor filtering.
3. Compare EyeTrax through a local companion using the same evaluator. This is the
   shortest route to testing the hackathon approach, not a decision to require a
   desktop installation in the final product.
4. If EyeTrax's features improve actual targeting, prototype a browser-native
   landmark regressor for extension-only use. Retain the native adapter as an
   optional route for supported hardware trackers.

For a companion, bind to loopback, authenticate each extension session, restrict
origins, reject stale samples, and send coordinates/quality metadata rather than
camera frames. Define coordinate conversion explicitly: physical display pixels,
browser position, zoom and viewport CSS pixels are different frames. Pause on
face loss, hidden tabs and voice exit. A lost camera must not silently become a
mouse-based "successful" gaze test.

### Evaluation protocol

- Fit on calibration targets, then evaluate on a fresh randomized target sequence,
  including locations not used for fitting. Never train on the evaluation run.
- Measure median and 90th-percentile fixation error in CSS pixels and as a fraction
  of viewport size, fixation jitter, valid-sample rate, FPS and software frame age.
  Software frame age is not the same as full eye-to-display latency.
- Measure correct product targeting and target-switch time on representative
  Amazon layouts. Separate signal settling from deliberate selection dwell.
- Compare engines within the same person/device/session, balance experiment order,
  and repeat with multiple people, glasses, lighting conditions and modest head
  movement. Record camera resolution and viewport geometry alongside results.
- Proposed goals, **not achieved results**: at least 40% lower p90 error than the
  same-person baseline and at least 90% correct product targeting on the chosen
  test layouts. Report failures and variation, not just the best run.

Automated tests can verify regression math, stale-frame handling, coordinate
mapping, teardown and extension navigation. Only real fixation trials can tell
us whether the new tracker is actually more accurate. Product snapping may make
selection easier but must not be reported as improved raw gaze estimation.

All variants retain voice authorization for shopping actions. Gaze alone must
never authorize payment.
