import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};

const { bus } = await import('../client/bus.js');
const voice = await import('../client/voice.js');

function hear(text) {
  const heard = [];
  const stop = bus.on('UTTERANCE', (e) => heard.push(e));
  bus.emit('STT', { text, final: true });
  stop();
  return heard.map((e) => e.text);
}

test('calibration voice commands skip the wake word and the echo filter', async () => {
  bus.emit('STATE', { calibrating: false });
  assert.deepEqual(hear('continue anyway'), []);
  assert.deepEqual(hear('Cue, next'), ['next']);

  bus.emit('STATE', { calibrating: true });
  assert.deepEqual(hear('continue anyway'), ['continue anyway']);
  assert.deepEqual(hear('Cue, next'), ['next']);
  assert.deepEqual(hear('try again'), ['try again']);
  assert.deepEqual(hear('is this wool'), []);

  globalThis.fetch = () => new Promise(() => {});
  const pending = voice.speak('Say try again, or say continue anyway.');
  await Promise.resolve();
  assert.equal(voice.getVoiceState().speaking, true);
  assert.deepEqual(hear('continue anyway'), ['continue anyway']);
  assert.equal(voice.getVoiceState().speaking, false);

  bus.emit('STATE', { calibrating: false });
  voice.stopSpeaking();
  pending.catch(() => {});
});
