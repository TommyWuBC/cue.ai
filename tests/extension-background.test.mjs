import assert from 'node:assert/strict';
import test from 'node:test';

let onMessage, onRemoved;
const calls = [];
const memory = new Map();
let active = false;
let healthy = true;

globalThis.chrome = {
  runtime: {
    id: 'cue-test', getURL: path => `chrome-extension://cue-test/${path}`,
    onMessage: { addListener: listener => { onMessage = listener; } },
  },
  scripting: {
    executeScript: async options => {
      calls.push(['script', options]);
      return options.func && !options.args ? [{ result: active }] : [{ result: null }];
    },
    insertCSS: async options => { calls.push(['css', options]); },
  },
  tabs: { onRemoved: { addListener: listener => { onRemoved = listener; } } },
  storage: { session: {
    get: async key => ({ [key]: memory.get(key) }),
    set: async record => { for (const [key, value] of Object.entries(record)) memory.set(key, value); },
    remove: async key => { memory.delete(key); },
  } },
};
globalThis.fetch = async () => ({ ok: healthy, json: async () => ({ ok: healthy }) });

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

test('activation injects packaged models and code once', async () => {
  const result = await send({ type: 'cue:start', tab }, popup);
  assert.equal(result.ok, true);
  assert.equal(calls.filter(([kind]) => kind === 'css').length, 1);
  assert.deepEqual(calls.filter(([kind, options]) => kind === 'script' && options.files)
    .map(([, options]) => options.files), [
      ['vendor/webgazer.js'], ['extension/extract.js', 'extension/content.js'],
    ]);
  const config = calls.find(([kind, options]) => kind === 'script' && options.args);
  assert.equal(config[1].args[0], 'http://localhost:4173');
  assert.match(config[1].args[1].facemesh, /^chrome-extension:\/\/cue-test\/vendor\/models/);
  active = true;
  assert.equal((await send({ type: 'cue:start', tab }, popup)).ok, true);
  assert.equal(calls.filter(([kind]) => kind === 'css').length, 1);
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
