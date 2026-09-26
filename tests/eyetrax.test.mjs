import assert from 'node:assert/strict';
import test from 'node:test';

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = FakeSocket.OPEN;
  sent = [];

  constructor(url) {
    super();
    this.url = String(url);
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === 'hello') this.reply({ type: 'ready', calibrated: false });
    if (message.type === 'capture') this.reply({ type: 'captured', id: message.id, ok: true });
    if (message.type === 'train') this.reply({ type: 'trained', id: message.id, ok: true, samples: 120 });
  }

  reply(value) {
    queueMicrotask(() => {
      const event = new Event('message');
      Object.defineProperty(event, 'data', { value: JSON.stringify(value) });
      this.dispatchEvent(event);
    });
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

globalThis.WebSocket = FakeSocket;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;

const { EyeTraxClient } = await import('../client/eyetrax.js');

test('EyeTrax client authenticates, calibrates, and forwards fresh gaze samples', async () => {
  const points = [];
  const client = new EyeTraxClient();
  const ready = await client.connect({ token: 'secret', onGaze: point => points.push(point) });
  assert.equal(ready.calibrated, false);
  const socket = FakeSocket.instances.at(-1);
  assert.equal(new URL(socket.url).searchParams.get('token'), 'secret');
  assert.deepEqual(socket.sent[0], { type: 'hello', width: 1200, height: 800 });

  assert.equal((await client.capture(100, 200)).ok, true);
  assert.equal((await client.train()).samples, 120);
  socket.reply({ type: 'gaze', x: 315, y: 240, age_ms: 18, sequence: 9 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(points[0].x, 315);
  assert.deepEqual(client.getCurrentPrediction(), { x: 315, y: 240, ageMs: 18, sequence: 9 });

  client.close(true);
  assert.equal(socket.sent.at(-1).type, 'shutdown');
});
