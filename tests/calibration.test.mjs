import assert from 'node:assert/strict';
import test from 'node:test';
import { bus } from '../client/bus.js';

// Exercise the real calibration event handlers and timers with controllable
// camera results. No webcam or network is required in CI.
async function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const events = new EventTarget();
  const overlays = [];
  class Element extends EventTarget {
    style = {};
    className = '';
    textContent = '';
    classList = { add() {}, remove() {} };
    children = new Map();
    setAttribute() {}
    focus() { document.activeElement = this; }
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, new Element());
      return this.children.get(selector);
    }
    remove() { const i = overlays.indexOf(this); if (i >= 0) overlays.splice(i, 1); }
  }
  const data = [];
  let captureMode = 'ok', predictions = true;
  const regression = { getData: () => data };
  const wg = {
    begin: async () => wg,
    clearData: async () => { data.length = 0; },
    getRegression: () => [regression],
    recordScreenPosition(x, y) {
      if (captureMode === 'throw') throw new Error('camera frame unavailable');
      if (captureMode === 'missing') return; // WebGazer silently drops missing eye features.
      data.push({ screenPos: [x, y] });
      if (data.length > 20) data.shift(); // Exercise its bounded training buffer too.
    },
    getTracker: () => ({ getPositions: () => Array.from({ length: 468 }, (_,i) => [i, 100, 0]) }),
    getCurrentPrediction: async () => {
      if (!predictions) return null;
      const dot = overlays.at(-1).querySelector('.aura-cal-dot');
      return { x: parseFloat(dot.style.left), y: parseFloat(dot.style.top) };
    },
  };
  for (const name of ['setRegression', 'setTracker', 'setGazeListener', 'saveDataAcrossSessions',
    'removeMouseEventListeners', 'showVideoPreview', 'showPredictionPoints', 'showFaceOverlay',
    'showFaceFeedbackBox', 'applyKalmanFilter']) wg[name] = () => wg;
  const globals = {
    window: { webgazer: wg }, innerWidth: 1000, innerHeight: 800,
    addEventListener: (type, fn, options) => events.addEventListener(type, fn,
      typeof options === 'boolean' ? { capture: options } : options),
    removeEventListener: (type, fn, options) => events.removeEventListener(type, fn,
      typeof options === 'boolean' ? { capture: options } : options),
    document: {
      activeElement: null,
      body: { appendChild: el => overlays.push(el) },
      createElement: tag => tag === 'canvas' ? { getContext: () => ({}) } : new Element(),
      querySelectorAll: () => [],
    },
  };
  const previous = new Map(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.assign(globalThis, globals);
  const off = [];
  const originalOn = bus.on.bind(bus);
  t.mock.method(bus, 'on', (type, fn) => { const stop = originalOn(type, fn); off.push(stop); return stop; });
  t.after(() => {
    off.forEach(stop => stop());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const gaze = await import('../client/gaze.js?test=' + Math.random());
  await gaze.start();
  const advance = async ms => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const press = (properties = { code: 'Space', key: ' ' }) => {
    const e = new Event('keydown', { cancelable: true });
    Object.assign(e, properties);
    events.dispatchEvent(e);
  };
  const finish = async () => {
    for (let i = 0; i < 13; i++) { press(); await advance(800); }
    for (let i = 0; i < 200; i++) await advance(1000);
  };
  return { gaze, overlays, advance, press, finish,
    hint: () => overlays.at(-1).querySelector('.aura-cal-hint').textContent,
    capture: mode => { captureMode = mode; },
    predictions: enabled => { predictions = enabled; },
  };
}

test('duplicate calibration shares one screen; Space advances the visible dot and is released after completion', async t => {
  const h = await setup(t);
  const first = h.gaze.calibrate({ allowRetry: false });
  const second = h.gaze.calibrate();
  assert.equal(first, second);
  await h.advance(0);
  assert.equal(h.overlays.length, 1);
  assert.equal(document.activeElement, h.overlays[0]);
  h.press();
  assert.match(h.hint(), /capturing point 1/);
  h.press({ code: 'Space', repeat: true });
  await h.advance(800);
  assert.match(h.hint(), /2 \/ 13/);
  await h.finish();
  assert.equal((await first).after_px, 0);
  assert.equal(h.overlays.length, 0);
  let received = false;
  addEventListener('keydown', () => { received = true; });
  h.press();
  assert.equal(received, true);
});

test('failed or empty camera samples show a retry message, then Space and voice can recover', async t => {
  const h = await setup(t);
  const done = h.gaze.calibrate({ allowRetry: false });
  await h.advance(0);
  for (const failure of ['throw', 'missing']) {
    h.capture(failure);
    h.press();
    await h.advance(800);
    assert.match(h.hint(), /Couldn't capture your eyes/);
  }
  h.capture('ok');
  // Accessibility keyboards can send key without the physical code.
  h.press({ key: ' ' });
  await h.advance(800);
  assert.match(h.hint(), /2 \/ 13/);
  bus.emit('UTTERANCE', { text: 'next', final: true });
  await h.advance(800);
  assert.match(h.hint(), /3 \/ 13/);
  h.overlays[0].querySelector('.aura-cal-dot').dispatchEvent(new Event('click'));
  await h.advance(800);
  assert.match(h.hint(), /4 \/ 13/);
  await h.finish();
  assert.equal((await done).after_px, 0);
});

test('failed validation never reuses old accuracy or announces successful calibration', async t => {
  const h = await setup(t);
  let done = h.gaze.calibrate({ allowRetry: false });
  await h.advance(0);
  await h.finish();
  assert.equal((await done).after_px, 0);
  h.predictions(false);
  const messages = [];
  bus.on('SAY', ({ text }) => messages.push(text));
  done = h.gaze.calibrate({ allowRetry: false });
  await h.advance(0);
  await h.finish();
  assert.equal(await done, null);
  assert.equal(h.gaze.getState().calibrated, false);
  assert.equal(h.gaze.isPrecise(), false);
  assert.equal(h.gaze.getAccuracy(), null);
  assert.ok(messages.some(text => text.includes("couldn't measure")));
  assert.ok(!messages.some(text => text.includes('Calibration done')));
});
