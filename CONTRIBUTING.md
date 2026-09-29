# Contributing to Cue

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt pytest
cp .env.example .env    # every key is optional; Cue degrades without them
.venv/bin/uvicorn main:app --app-dir server --port 4173 --reload
```

Python 3.10 or newer is required (CI runs 3.12). Open http://localhost:4173 in
Chrome and use `?gaze=mouse` if you have no camera, or `cue.say("...")` in the
console if you have no mic.

## Tests

```bash
.venv/bin/python -m pytest tests          # server
npm test                                  # client and extension (node:test)
npm install && npm run test:browser       # real-browser extension test, needs Chrome
```

CI runs the first two on every push and pull request.

## Ground rules

- **The model may shop; only the user may commit.** Never let model output reach
  `confirm`, `approve_checkout` or `setup_passkey`. See
  [Design principles](./README.md#design-principles).
- **The server prices the cart.** Prices sent by the browser are never accepted.
- **No secrets.** `.env` is ignored; only `.env.example` is committed.
- Match the surrounding code. Read the section of [docs/DESIGN.md](./docs/DESIGN.md)
  for whatever you are touching first.
- Update [README.md](./README.md) or [ARCHITECTURE.md](./ARCHITECTURE.md) when
  user-facing behavior, config or event shapes change.
