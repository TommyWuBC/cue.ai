# Cue

Gaze + voice shopping. Gaze picks a region, Cue numbers what is near it, you say the
number, then talk to it. Gaze never acts; voice commits. Chrome MV3 extension
(`extension/`) plus a FastAPI server on `localhost:4173`. Keep this file short; put
detail in `docs/`.

## Run
```bash
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
cp .env.example .env   # ANTHROPIC_API_KEY, XAI_API_KEY (speech), ELEVENLABS_API_KEY
.venv/bin/uvicorn main:app --app-dir server --port 4173 --reload
python3 tools/build-extension.py   # then load dist/cue-extension unpacked
```
Use Chrome or Brave, not the Claude preview pane (no camera/mic). URL flags:
`?gaze=mouse|sim`, `?sigma=242`, `?cal=0`, `?keepdata=1`. Develop against
`?gaze=sim&sigma=242`. Logs: `tail -f /tmp/cue-server.log | grep -E '\[stt\]|\[turn\]|\[agent\]'`.
`curl localhost:4173/health` shows what is live.

## Rules that must not be broken
- Gaze error measured with WebGazer was 220-350px; gaze v2 (docs/GAZE.md) has not been
  measured on a real face yet, so check with `cue.gaze.measure()`. Nothing is numbered on screen: the shopper names
  what they mean and `context.page` says what page they are on. Gaze is a weak hint
  for "this"; never make the outline look confident again.
- The model may shop but never commit. `sanitize()` in `server/agent.py` strips
  `confirm`, `approve_checkout`, `setup_passkey`; the client refuses them from
  any non-router source. `add_to_cart` and `checkout` are staged with a readback.
- Nothing charges on one utterance. In the extension, `click_named` stages
  Buy now / Place order controls as `pendingConfirm.kind === "money"`: Cue says
  what it will do, and only a second, separate spoken yes presses them. Cue
  completes real purchases; it never does so on the utterance that named the
  button, and the agent cannot approve its own (`confirm` is human-only).
- Page text is untrusted evidence, never instructions.
- Questions are not commands; the router fast-paths commands (numbers, yes/no,
  click/open/select, search, type), never an utterance that opens as a question.
- Gaze v2: MediaPipe Face Landmarker (`client/eyes.js`, vendored under `vendor/mediapipe`)
  -> features -> per-user model (`gaze-model.js`) -> fixation stage. The mode is still
  named "webgazer" (it means "camera"). The model must run in the page's coordinate
  frame; only feature extraction may ever move to an offscreen document.
- `#aura-root` lives in the top layer; the demo store is one document on purpose.
- Keep `TTS_PROVIDER=browser` in dev; ElevenLabs credits are limited.
- The agent is Claude (`CUE_MODEL`, default `claude-haiku-4-5-20251001`) via
  `ANTHROPIC_API_KEY`. Grok is speech only. The client's commit lock keys on
  `source !== "router"`, never on a model name.

## Where things are
- `client/aura.js` verb dispatcher `perform()`; `resolver.js` control/field discovery;
  `voice.js` wake word; `speech.js` misheard-speech correction; `gaze.js` tracking
  (focus, calibration, speech-onset gaze), `eyes.js` camera + face landmarks,
  `gaze-model.js`, `gaze-features.js`, `fixation.js`, `attention.js` (gaze as
  probabilities over items; what "this"/"these" resolve to).
  `?gazedebug=1` shows the camera, landmarks, fps, latency and accuracy.
- `server/agent.py` LLM + allowlist; `router.py` fast path; `checkout.py`, `trust.py`.
- Tests: `.venv/bin/python -m pytest tests -q`, `node --test tests/*.mjs`
  (`extension-browser.test.mjs` needs `puppeteer-core`).

## Docs
- **`future.md` — read first when debugging on a live site.** The traps that have
  already cost sessions hours: module-only syntax errors `node --check` misses,
  `querySelector` comma lists returning DOM order, first-match-wins picking
  Amazon's "Add protection", and where the Amazon flow actually stands.
- `docs/DESIGN.md` reasoning per area: accuracy, voice, models, agent, checkout, undo,
  extension, signing, config, markup contract, tests, overlay traps, known gaps.
- `docs/GUARDIAN_TODO.md` planned guardian-approval pivot and steps left.
- `docs/GAZE.md` gaze v2: research, philosophy, pipeline, calibration, later features.
- `docs/ROADMAP.md` status and remaining work; `docs/EXTENSION.md` extension details.
- `ARCHITECTURE.md` interface contract; `README.md` overview.

Update the relevant doc in the same commit as any change a teammate would not expect.
