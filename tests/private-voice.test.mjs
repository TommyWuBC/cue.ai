import test from 'node:test';
import assert from 'node:assert/strict';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Import once with a minimal browser-ish environment. The private-mode paths
// intentionally do not require real media/browser services.
const media = deferred();
let micRequested = false;
let stopped = 0;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  mediaDevices: { getUserMedia: () => { micRequested = true; return media.promise; } },
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
globalThis.addEventListener = () => {};
let healthFetches = 0;
globalThis.fetch = async () => { healthFetches++; return { json: async () => ({ stt: { ready: true } }) }; };

const voice = await import('../client/voice.js?private-test=1');

test('entering private mode invalidates a microphone startup already in flight', async () => {
  const starting = voice.startListening();
  while (!micRequested) await Promise.resolve();
  await voice.enterPrivateMode();
  media.resolve({ getTracks: () => [{ stop: () => { stopped++; } }] });
  assert.equal(await starting, false);
  assert.ok(stopped >= 1);
  assert.equal(voice.isPrivateMode(), true);
  assert.equal(await voice.startListening(), false);
  assert.equal(healthFetches, 1, 'private mode must block a new health/STT startup entirely');
});

test('a TTS response that arrives after private mode starts is discarded', async () => {
  voice.exitPrivateMode();
  const response = deferred();
  let audioConstructed = 0;
  globalThis.Audio = class { constructor() { audioConstructed++; } };
  globalThis.fetch = () => response.promise;
  const speaking = voice.speak('late response');
  await Promise.resolve();
  await voice.enterPrivateMode();
  response.resolve({ headers: { get: () => 'audio/mpeg' }, blob: async () => new Blob(['x']) });
  await speaking;
  assert.equal(audioConstructed, 0);
  assert.equal(voice.isPrivateMode(), true);
});
