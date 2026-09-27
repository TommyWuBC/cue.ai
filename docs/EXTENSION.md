# Cue Chrome extension

This branch packages Cue's existing gaze and voice client as a Manifest V3
extension. The shopper uses the toolbar icon once to approve a store. Cue then
starts automatically whenever that store opens. Video stays in the local EyeTrax
companion and is never sent to the shopping page or a remote service.
Product details, the page URL, and speech requests go to the configured Cue
backend.

## Run locally

1. Install the gaze runtime with `uv pip install --python .venv/bin/python -r server/requirements-gaze.txt`.
2. Start the Cue backend: `.venv/bin/uvicorn main:app --app-dir server --port 4173`.
3. Run `python3 tools/build-extension.py` from the repo root.
4. Open `chrome://extensions` in Chrome, enable **Developer mode**, select
   **Load unpacked**, and choose `dist/cue-extension`.
5. Open a normal HTTPS shopping page and select the Cue toolbar icon once. Allow
   Cue to run on that store when Chrome asks. Cue starts immediately and will
   start automatically on later visits to the same store. Its icon badge changes
   to **ON** when startup succeeds or **!** if it fails; hover to read the error.
6. Cue shows its logo for about two seconds, fading in and out. Grant microphone
   permission in Chrome and camera permission to the app running the backend
   (Terminal, VS Code, or Cursor) when macOS asks,
   then follow the calibration dots
   with Space, a click, or “Cue, next.” Calibration closes over the same
   shopping page; it does not open a new tab or change the page URL. Cue keeps
   the calibration for this tab as you open other pages on the same store.

Say **“Cue, exit”** at any time, including during calibration, to stop the
camera and microphone and remove Cue from the page. Automatic startup remains
paused for that tab as the shopper navigates. Select the Cue toolbar icon to
resume; the store approval remains in place.

After rebuilding an already loaded extension, click **Reload** on Cue's card in
`chrome://extensions`, then reload the shopping tab. An already approved store
starts Cue automatically. If the dock says **mouse**, camera tracking did not start. Saying
“Cue, recalibrate” retries the camera and announces why it cannot start if the
retry fails.

The local Northfield demo store is where passkey checkout and merchant
verification currently run. The extension supports product questions,
comparisons, gaze focus, and page controls on live sites; it does not map live
merchant products into a Northfield order.

The build writes an unpacked directory for local testing and
`dist/cue-extension-0.1.0.zip` for upload. Both are ignored by Git. The ZIP has
the manifest at its root and bundles the Cue client, icons, and privacy details
page. EyeTrax and MediaPipe run in the separately installed local companion.

## Backend address

The default backend is `http://localhost:4173`. To build against a different
origin, run `python3 tools/build-extension.py --server-url https://cue.example`.
The build sets the extension's single backend host permission and runtime
configuration together. Non-local HTTP addresses are refused.

A remotely hosted Cue backend cannot operate the shopper's webcam. A public
release needs a signed desktop/native-messaging companion installed on the
shopper's computer. The current server
is a single shopper demo with no account authentication or merchant login, and
its passkey relying party is configured for `localhost`. Host the backend only
after adding those controls and configuring its WebAuthn origin. Until then,
use the localhost build and keep checkout on the demo store.

## What to validate on each target store

- The local companion has operating-system camera access and Chrome has microphone access.
- Calibration advances with Space and gaze focus follows the intended product.
- Cue reads only product details actually visible or present in Product JSON-LD.
- The store page allows the extension to connect to its permitted local backend.
- Speech questions and browser controls work, including after an in-page
  navigation. Full-page navigation reconnects to the in-memory EyeTrax model
  without the splash or dots.
  A changed viewport or unavailable model requires calibration again.

For local checks, run `node --test tests/extension-background.test.mjs
tests/extension.test.mjs tests/product-memory.test.mjs` and
`python3 -m unittest tests/test_extension_build.py`. The build test verifies
the upload ZIP, required assets, manifest permissions, and icons.

For a browser check, run `npm ci`, install Chrome for Testing or Chromium, then
set `CUE_CHROME_PATH` to that browser executable and run
`node --test tests/extension-browser.test.mjs`. The test launches the unpacked
extension on a local shopping fixture and checks the overlay, avatar, product
tagging, and the EyeTrax websocket lifecycle. It grants the fixture origin
to its temporary unpacked manifest because an automated tab does not receive
Chrome's toolbar-click `activeTab` grant.

## Chrome Web Store handoff

The ZIP is an upload candidate, not a published extension. The publisher must
complete the listing, screenshots, privacy fields, distribution choices, and
review submission in the Chrome Developer Dashboard. Cue handles page content
and speech, so the publisher must host an accurate privacy policy URL and keep
it consistent with the in-extension privacy details. The privacy statement
should name the actual backend host and whichever speech/AI providers are
enabled for the deployment.

Chrome's [publishing guide](https://developer.chrome.com/docs/webstore/publish/)
describes ZIP upload and review. Its [privacy fields guide](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
explains the required data and permission disclosures. Manifest V3 requires
[all executable code to be packaged](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).
