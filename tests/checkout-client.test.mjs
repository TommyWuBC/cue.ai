import test from 'node:test';
import assert from 'node:assert/strict';
import { setupCheckout } from '../store/checkout.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const quote = { intent_id: 'intent-1', total_cents: 1000, remaining_after_cents: 24000,
  items: [{ title: 'Coat', size: 'M', color: 'Black', unit_price_cents: 1000 }] };

function setup(t, handler = () => undefined) {
  class Element extends EventTarget {
    open = false; disabled = false; textContent = '';
    nodes = new Map();
    querySelector(key) { if (!this.nodes.has(key)) this.nodes.set(key, new Element()); return this.nodes.get(key); }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const dialog = new Element(), calls = [], spoken = [];
  let cleared = false;
  const globals = {
    document: { getElementById: () => dialog },
    window: { cue: { bus: { emit: (type, p) => spoken.push(p.text) },
      voice: { speak: async text => spoken.push(text), stopSpeaking() {} } } },
    navigator: { credentials: {} },
    fetch: async path => {
      calls.push(path);
      const override = await handler(path);
      if (override) return override;
      const data = path.endsWith('/status') ? { passkey_registered: true } :
        path.endsWith('/prepare') ? quote :
        path.includes('/authenticate/options/') ? { ceremony_id: 'auth', options: { challenge: 'YQ' } } :
        { status: 'cancelled' };
      return { ok: true, json: async () => data };
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => before ? Object.defineProperty(globalThis, key, before) : delete globalThis[key]);
  }
  const flow = setupCheckout({ getCart: () => [{ id: 'j1', size: 'M', color: 'Black' }],
    clearCart: () => { cleared = true; }, onStatus() {} });
  return { flow, calls, spoken, dialog, cleared: () => cleared };
}

test('cancel during cart preparation revokes the late intent without a readback', async t => {
  const reply = deferred();
  const h = setup(t, path => path.endsWith('/prepare') ? reply.promise : undefined);
  const preparing = h.flow.prepare();
  await h.flow.cancel();
  reply.resolve({ ok: true, json: async () => quote });
  await preparing;
  assert.equal(h.calls.filter(p => p.includes('/cancel/')).length, 1);
  assert.equal(h.dialog.open, false);
  assert.equal(h.cleared(), false);
  assert.ok(!h.spoken.some(s => s.includes('Total')));
});

test('cancel aborts passkey UI and a late credential never reaches approval', async t => {
  const h = setup(t);
  const started = deferred(), credential = deferred();
  let signal;
  navigator.credentials.get = options => { signal = options.signal; started.resolve(); return credential.promise; };
  await h.flow.prepare();
  const approving = h.flow.approve();
  await started.promise;
  await h.flow.cancel();
  assert.equal(signal.aborted, true);
  credential.resolve({ toJSON: () => ({ rawId: 'YQ' }) });
  await approving;
  assert.ok(!h.calls.includes('/api/checkout/approve'));
  assert.equal(h.cleared(), false);
});

test('failed cancellation stays unapproved and can be retried', async t => {
  let fail = true;
  const h = setup(t, path => path.includes('/cancel/') && fail
    ? { ok: false, json: async () => ({ detail: 'Server unavailable' }) } : undefined);
  await h.flow.prepare();
  assert.equal(await h.flow.cancel(), false);
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.querySelector('.checkout-approve').disabled, true);
  assert.ok(h.spoken.some(s => s.includes("couldn't confirm cancellation")));
  fail = false;
  assert.equal(await h.flow.cancel(), true);
  assert.equal(h.dialog.open, false);
});

test('private mode prepares server-checked order without spoken readback', async t => {
  const h = setup(t);
  window.cue.voice.isPrivateMode = () => true;
  await h.flow.prepare();
  assert.ok(h.calls.includes('/api/checkout/prepare'));
  assert.ok(!h.spoken.some(s => s.includes('Total $10.00')));
  assert.equal(h.dialog.querySelector('.checkout-approve').disabled, false);
});
