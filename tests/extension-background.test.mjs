import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

let onActionClicked, onActivated, onMessage, onRemoved, onUpdated;
const calls = [];
const actionState = new Map();
const memory = new Map();
const localData = new Map();
const allowedOrigins = new Set();
let active = false;
let healthy = true;
const fetchCalls = [];

globalThis.chrome = {
  action: {
    onClicked: { addListener: listener => { onActionClicked = listener; } },
    setBadgeBackgroundColor: async options => { calls.push(['badge-color', options]); },
    setBadgeText: async options => {
      calls.push(['badge-text', options]);
      actionState.set(options.tabId, options.text);
    },
    setTitle: async options => { calls.push(['title', options]); },
  },
  runtime: {
    id: 'cue-test', getURL: path => `chrome-extension://cue-test/${path}`,
    onMessage: { addListener: listener => { onMessage = listener; } },
  },
  permissions: {
    contains: async ({ origins }) => origins.every(origin => allowedOrigins.has(origin)),
    request: async ({ origins }) => {
      origins.forEach(origin => allowedOrigins.add(origin));
      calls.push(['permission', origins]);
      return true;
    },
  },
  scripting: {
    executeScript: async options => {
      calls.push(['script', options]);
      return options.func && !options.args ? [{ result: active }] : [{ result: null }];
    },
    insertCSS: async options => { calls.push(['css', options]); },
  },
  tabs: {
    get: async id => ({ id, url: 'https://store.example/product' }),
    onActivated: { addListener: listener => { onActivated = listener; } },
    onRemoved: { addListener: listener => { onRemoved = listener; } },
    onUpdated: { addListener: listener => { onUpdated = listener; } },
  },
  storage: { local: {
    get: async key => ({ [key]: localData.get(key) }),
    set: async record => { for (const [key, value] of Object.entries(record)) localData.set(key, value); },
  }, session: {
    get: async key => ({ [key]: memory.get(key) }),
    set: async record => { for (const [key, value] of Object.entries(record)) memory.set(key, value); },
    remove: async key => {
      for (const item of Array.isArray(key) ? key : [key]) memory.delete(item);
    },
  } },
};
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), options });
  return { ok: healthy, json: async () => ({ ok: healthy }) };
};

await import('../extension/background.js');

const popup = { id: 'cue-test', url: 'chrome-extension://cue-test/extension/popup.html' };
const content = { id: 'cue-test', url: 'https://store.example/product', tab: { id: 7 } };
const tab = { id: 7, url: 'https://store.example/product' };
function send(message, sender) {
  return new Promise(resolve => {
    if (onMessage(message, sender, resolve) !== true) resolve(null);
  });
}

test('activation requires a shopping tab and a reachable Cue server', async () => {
  assert.equal((await send({ type: 'cue:start', tab: { id: 7, url: 'chrome://settings' } }, popup)).ok, false);
  assert.equal((await send({ type: 'cue:start', tab: { id: 7, url: 'http://localhost:4173/' } }, popup)).ok, false);
  healthy = false;
  assert.match((await send({ type: 'cue:start', tab }, popup)).error, /cannot reach/);
  assert.equal(calls.filter(([kind]) => kind === 'css').length, 0);
  healthy = true;
});

// Asserts the wiring rule, not one snapshot of GAZE_MODE. The old version
// hard-coded 'mouse' and a null model list, so simply switching gaze on failed
// a test whose real subject — that nothing extra is ever injected, and models
// travel only when the camera is in use — was still perfectly satisfied.
test('the injected config matches whichever gaze mode is configured, and nothing else is injected', async () => {
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  const mode = source.match(/const GAZE_MODE = '([a-z]+)'/)[1];

  const result = await send({ type: 'cue:start', tab }, popup);
  assert.equal(result.ok, true);
  assert.equal(calls.filter(([kind]) => kind === 'css').length, 1);
  assert.deepEqual(calls.find(([kind]) => kind === 'css')[1].files,
    ['client/overlay.css', 'client/analytics.css', 'client/compare.css']);
  // The demo store's own MediaPipe engine loads as a module (client/eyes.js),
  // nothing to inject for it — but a real site in 'webgazer' mode gets
  // vendor/webgazer.js first, since the extension now runs WebGazer there
  // (see boot()'s engine swap and background.js's own comment for why).
  const fileInjections = calls.filter(([kind, options]) => kind === 'script' && options.files)
    .map(([, options]) => options.files);
  assert.deepEqual(fileInjections, mode === 'webgazer'
    ? [['vendor/webgazer.js'], ['extension/extract.js', 'extension/content.js']]
    : [['extension/extract.js', 'extension/content.js']]);
  const config = calls.find(([kind, options]) => kind === 'script' && options.args);
  assert.equal(config[1].args[0], 'http://localhost:4173');
  assert.equal(config[1].args[4], mode);
  // Model URLs are passed only when the camera is actually going to run.
  if (mode === 'webgazer') assert.ok(config[1].args[1] && typeof config[1].args[1] === 'object');
  else assert.equal(config[1].args[1], null);
  assert.equal(config[1].args[2], 'chrome-extension://cue-test/extension/assets/cue-splash.jpg');
  active = true;
  assert.equal((await send({ type: 'cue:start', tab }, popup)).ok, true);
  assert.equal(calls.filter(([kind]) => kind === 'css').length, 1);
});

test('shopping activity stays in extension storage and takes the site from the sender', async () => {
  const callsBefore = fetchCalls.length;
  const result = await send({ type: 'cue:analytics:event', event: {
    event_id: 'search-123', kind: 'search', query: 'wool coat', site: 'spoofed.example',
  } }, content);
  assert.equal(result.ok, true);
  const summary = await send({ type: 'cue:analytics:summary' }, content);
  assert.equal(summary.ok, true);
  assert.equal(summary.data.totals.searches, 1);
  assert.equal(summary.data.recent[0].site, 'store.example');
  assert.equal(fetchCalls.length, callsBefore, 'analytics must not call the server');
  assert.equal((await send({ type: 'cue:analytics:summary' },
    { ...content, id: 'another-extension' })), null);
  assert.equal((await send({ type: 'cue:analytics:event', event: {
    event_id: 'bad-12345', kind: 'purchase', product_title: 'fake',
  } }, content)).ok, false);
  const demo = { id: 'cue-test', url: 'http://localhost:4173/', tab: { id: 9 } };
  assert.equal((await send({ type: 'cue:analytics:event', event: {
    event_id: 'purchase:order-1:0', kind: 'purchase', product_title: 'Wool Coat',
    order_id: 'order-1', order_total_cents: 12900,
  } }, demo)).ok, true);
  const shared = await send({ type: 'cue:analytics:summary' }, content);
  assert.equal(shared.data.totals.orders, 1);
  assert.match((await send({ type: 'cue:analytics:export' }, demo)).data, /purchase:order-1:0/);
});

test('toolbar action starts Cue directly and reports status on its badge', async () => {
  active = false;
  const cssBefore = calls.filter(([kind]) => kind === 'css').length;
  await onActionClicked(tab);
  assert.equal(calls.filter(([kind]) => kind === 'css').length, cssBefore + 1);
  assert.equal(actionState.get(tab.id), 'ON');
  assert.ok(allowedOrigins.has('https://store.example/*'));
  const titles = calls.filter(([kind]) => kind === 'title').map(([, options]) => options);
  assert.equal(titles.at(-1).title, 'Cue is active on this page');

  healthy = false;
  await onActionClicked({ id: 8, url: 'https://store.example/another-product' });
  assert.equal(actionState.get(8), '!');
  assert.match(calls.filter(([kind]) => kind === 'title').at(-1)[1].title, /cannot reach/);
  healthy = true;
});

test('approved stores start automatically and voice exit pauses the tab', async () => {
  active = false;
  const cssBefore = calls.filter(([kind]) => kind === 'css').length;
  await onUpdated(tab.id, { status: 'complete' }, tab);
  assert.equal(calls.filter(([kind]) => kind === 'css').length, cssBefore + 1);

  assert.deepEqual(await send({ type: 'cue:exit' }, content), { ok: true });
  assert.equal(actionState.get(tab.id), 'OFF');
  active = false;
  const pausedCss = calls.filter(([kind]) => kind === 'css').length;
  await onActivated({ tabId: tab.id });
  assert.equal(calls.filter(([kind]) => kind === 'css').length, pausedCss);

  await onActionClicked(tab);
  assert.equal(actionState.get(tab.id), 'ON');
  assert.equal(calls.filter(([kind]) => kind === 'css').length, pausedCss + 1);
});

test('same-store navigation resumes the tab session and exit discards it', async () => {
  onRemoved(tab.id);
  await new Promise(resolve => setImmediate(resolve));
  active = false;
  await onActionClicked(tab);
  const initial = calls.filter(([kind, options]) => kind === 'script' && options.args).at(-1)[1];
  assert.equal(initial.args[3], null);

  const snapshot = { version: 1, samples: [{ type: 'click' }] };
  assert.deepEqual(await send({ type: 'cue:calibration:write', value: snapshot }, content), { ok: true });
  await onUpdated(tab.id, { status: 'complete' },
    { id: tab.id, url: 'https://store.example/dp/jacket' });
  const resumed = calls.filter(([kind, options]) => kind === 'script' && options.args).at(-1)[1];
  assert.equal(resumed.args[3].started, true);
  assert.deepEqual(resumed.args[3].calibration, snapshot);

  assert.deepEqual(await send({ type: 'cue:calibration:clear' }, content), { ok: true });
  await onUpdated(tab.id, { status: 'complete' }, tab);
  const cleared = calls.filter(([kind, options]) => kind === 'script' && options.args).at(-1)[1];
  assert.equal(cleared.args[3].started, true);
  assert.equal(cleared.args[3].calibration, null);

  assert.deepEqual(await send({ type: 'cue:exit' }, content), { ok: true });
  assert.equal(memory.has('cue.session.7'), false);
  assert.deepEqual(await send({ type: 'cue:calibration:write', value: snapshot }, content), { ok: false });
  assert.equal(memory.has('cue.session.7'), false);
});

test('product memory stays in extension storage for its tab', async () => {
  assert.equal(await send({ type: 'cue:memory:read' }, popup), null);
  assert.equal((await send({ type: 'cue:memory:read' }, content)).value, null);
  assert.deepEqual(await send({ type: 'cue:memory:write', value: '{"id":"coat"}' }, content), { ok: true });
  assert.equal((await send({ type: 'cue:memory:read' }, content)).value, '{"id":"coat"}');
  assert.equal(await send({ type: 'cue:memory:write', value: 'x'.repeat(10001) }, content), null);
  onRemoved(7);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await send({ type: 'cue:memory:read' }, content)).value, null);
});
