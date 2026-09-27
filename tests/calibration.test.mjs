import assert from 'node:assert/strict';
import test from 'node:test';
import { bus } from '../client/bus.js';

// Globals the harness replaces, captured once so every teardown restores the
// real ones (a test can build several harnesses, and they tear down in order).
const GLOBAL_KEYS = ['innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener',
  'requestAnimationFrame', 'cancelAnimationFrame', 'document', 'navigator'];
const ORIGINAL = new Map(GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
const restoreGlobals = () => {
  for (const [key, d] of ORIGINAL) {
    if (d) Object.defineProperty(globalThis, key, d);
    else delete globalThis[key];
  }
};

// Exercise the real gaze v2 calibration (fixations, pursuit, validation) with a
// fake eye engine whose features follow the calibration dot. No webcam, GPU or
// network is needed; timings are shrunk so a whole calibration takes ~1s.
async function setup(t, { face = true, beginMode = 'ok' } = {}) {
  const events = new EventTarget();
  const overlays = [];
  class Element extends EventTarget {
    style = {}; dataset = {}; className = ''; textContent = ''; disabled = false;
    classes = new Set();
    classList = {
      add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c),
      toggle: (c, on) => (on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c),
      contains: (c) => this.classes.has(c),
    };
    children = new Map();
    setAttribute() {}
    focus() { document.activeElement = this; }
    querySelector(sel) { if (!this.children.has(sel)) this.children.set(sel, new Element()); return this.children.get(sel); }
    remove() { const i = overlays.indexOf(this); if (i >= 0) overlays.splice(i, 1); }
  }

  const control = { face, beginMode };
  const feat = (x, y) => {
    // A perfect, slightly noisy eye: features are a smooth function of the dot.
    const f = new Array(20).fill(0).map(() => (Math.random() - 0.5) * 0.002);
    f[0] = f[2] = x / 1000; f[1] = f[3] = y / 800; f[4] = f[5] = 0.3 - y / 4000;
    return f;
  };
  const engine = {
    running: false, listener: null, last: null, timer: null,
    async begin() {
      if (control.beginMode === 'fail') throw new Error('camera unavailable');
      this.running = true;
      this.timer = setInterval(() => this.emit(), 5);
    },
    emit() {
      const dot = overlays.at(-1)?.querySelector('.aura-cal-dot');
      const x = parseFloat(dot?.style.left) || 500, y = parseFloat(dot?.style.top) || 400;
      const s = control.face
        ? { ok: true, features: feat(x, y), head: { x: 0.5, y: 0.5, iod: 0.12 }, t: performance.now() }
        : { ok: false, reason: 'face', t: performance.now() };
      this.last = s;
      this.listener?.(s);
    },
    setListener(fn) { this.listener = fn; },
    latest() { return this.last; },
    isRunning() { return this.running; },
    showPreview() {}, stats() { return {}; },
    end() { clearInterval(this.timer); this.running = false; },
  };

  const globals = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener: (type, fn, o) => events.addEventListener(type, fn, typeof o === 'boolean' ? { capture: o } : o),
    removeEventListener: (type, fn, o) => events.removeEventListener(type, fn, typeof o === 'boolean' ? { capture: o } : o),
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 8),
    cancelAnimationFrame: (id) => clearTimeout(id),
    document: {
      activeElement: null,
      body: { appendChild: (el) => overlays.push(el) },
      createElement: () => new Element(),
      querySelectorAll: () => [],
    },
  };
  Object.assign(globalThis, globals);
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia() {} } }, configurable: true, writable: true });

  const off = [];
  const originalOn = bus.on.bind(bus);
  t.mock.method(bus, 'on', (type, fn) => { const stop = originalOn(type, fn); off.push(stop); return stop; });
  const said = [];
  off.push(originalOn('SAY', ({ text }) => said.push(text)));

  const gaze = await import('../client/gaze.js?test=' + Math.random());
  gaze.setEngine(engine);
  Object.assign(gaze.TIMING, { settle: 5, hold: 40, pursuit: 400, validateSettle: 5, lead: 5 });
  t.after(() => {
    engine.end();                         // first: a live timer keeps the process up
    try { gaze.stop(); } catch { /* globals may already be restored by an earlier harness */ }
    off.forEach((stop) => stop());
    restoreGlobals();
  });

  const press = () => {
    const e = new Event('keydown', { cancelable: true });
    Object.assign(e, { code: 'Space', key: ' ', repeat: false });
    events.dispatchEvent(e);
  };
  return { gaze, engine, overlays, press, said, control,
    hint: () => overlays.at(-1)?.querySelector('.aura-cal-hint').textContent ?? '' };
}

test('a camera that fails falls back to the mouse, and a retry gets the camera', async (t) => {
  const h = await setup(t, { beginMode: 'fail' });
  assert.equal(await h.gaze.start(), 'mouse');
  assert.equal(h.gaze.getState().gazeError, 'the face tracker could not start the camera');
  h.control.beginMode = 'ok';
  assert.equal(await h.gaze.start(), 'webgazer');
  assert.equal(h.gaze.getState().gazeError, null);
});

test('one gesture starts a hands-free calibration that fits and validates a model', async (t) => {
  const h = await setup(t);
  await h.gaze.start();
  const first = h.gaze.calibrate({ allowRetry: false });
  const second = h.gaze.calibrate({ allowRetry: false });
  assert.equal(first, second, 'a second request shares the running calibration');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.overlays.length, 1);
  assert.match(h.hint(), /say “Cue, ready”/);
  h.press();                                   // the only input needed
  const acc = await first;
  assert.ok(acc && acc.after_px < 40, `validated error ${acc?.after_px}px`);
  assert.ok(acc.trained_on > 50 && ['ridge', 'krr'].includes(acc.model));
  assert.equal(h.overlays.length, 0, 'the calibration screen is gone');
  assert.equal(h.gaze.getState().calibrated, true);
  assert.ok(h.said.some((s) => s.includes('Calibration done')));

  // Space is released back to push-to-talk once calibration has finished.
  const before = h.said.length;
  h.press();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.overlays.length, 0);
  assert.equal(h.said.length, before);
});

test('voice starts calibration too, for people who cannot press a key', async (t) => {
  const h = await setup(t);
  await h.gaze.start();
  const done = h.gaze.calibrate({ allowRetry: false });
  await new Promise((r) => setTimeout(r, 20));
  bus.emit('UTTERANCE', { text: 'ready', final: true });
  assert.ok((await done)?.after_px < 40);
});

test('no visible face ends without accuracy, and says how to recover', async (t) => {
  const h = await setup(t, { face: false });
  await h.gaze.start();
  const done = h.gaze.calibrate({ allowRetry: false });
  await new Promise((r) => setTimeout(r, 20));
  h.press();
  assert.equal(await done, null);
  assert.equal(h.gaze.getState().calibrated, false);
  assert.equal(h.gaze.getAccuracy(), null);
  assert.ok(h.said.some((s) => s.includes("couldn't measure")));
  assert.ok(!h.said.some((s) => s.includes('Calibration done')));
});

test('stopping gaze cancels a running calibration', async (t) => {
  const h = await setup(t);
  await h.gaze.start();
  const done = h.gaze.calibrate({ allowRetry: false });
  await new Promise((r) => setTimeout(r, 20));
  h.gaze.stop();
  assert.equal(await done, false);
  assert.equal(h.overlays.length, 0);
});

test('a fitted model survives a page change without calibrating again', async (t) => {
  const h = await setup(t);
  await h.gaze.start();
  const done = h.gaze.calibrate({ allowRetry: false });
  await new Promise((r) => setTimeout(r, 20));
  h.press();
  await done;
  const snapshot = JSON.parse(JSON.stringify(h.gaze.exportCalibration()));
  assert.equal(snapshot.version, 2);
  assert.ok(JSON.stringify(snapshot).length < 400_000, 'small enough for session storage');

  const next = await setup(t);
  assert.equal(await next.gaze.start({ resume: snapshot }), 'webgazer');
  assert.equal(next.gaze.getState().calibrated, true);
  assert.equal(next.gaze.getAccuracy().after_px, snapshot.accuracy.after_px);

  const other = await setup(t);
  await other.gaze.start({ resume: { ...snapshot, viewport: { width: 1, height: 1 } } });
  assert.equal(other.gaze.getState().calibrated, false, 'a different window size is not reused');
});
