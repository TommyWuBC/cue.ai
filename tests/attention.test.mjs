import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttention, massInRect } from '../client/attention.js';

const card = (id, left, top, w = 300, h = 400) =>
  ({ id, kind: 'product', label: id, product: { id, title: `Item ${id}` },
     rect: { left, top, right: left + w, bottom: top + h, width: w, height: h } });
const cards = [card('a', 0, 0), card('b', 320, 0), card('c', 640, 0), card('d', 960, 0)];

function rng(seed = 3) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }

test('the item under the gaze gets most of the blob, neighbours get some, the far side none', () => {
  const on = massInRect(470, 200, 120, cards[1].rect);
  const next = massInRect(470, 200, 120, cards[2].rect);
  const far = massInRect(470, 200, 120, cards[3].rect);
  assert.ok(on > 0.6 && next > 0.05 && next < on && far < 0.001, `${on} ${next} ${far}`);
  const tiled = [card('x', -2000, -2000, 4000, 4000)];
  assert.ok(Math.abs(massInRect(0, 0, 150, tiled[0].rect) - 1) < 1e-6);
});

test('steady looking elects a leader; noisy looking near a boundary does not flip it', () => {
  const r = rng(1), a = createAttention();
  let t = 0;
  for (let i = 0; i < 45; i++) a.update(470 + gauss(r) * 60, 200 + gauss(r) * 60, 140, t += 33, cards);
  const lead = a.leader({ minShare: 0.5 });
  assert.equal(lead?.target.id, 'b');

  // Now hover right on the b/c boundary with 120px of noise for a second.
  const leaders = [];
  for (let i = 0; i < 30; i++) {
    a.update(630 + gauss(r) * 120, 200 + gauss(r) * 60, 140, t += 33, cards);
    leaders.push(a.leader({ minShare: 0.5 })?.target.id ?? null);
  }
  const flips = leaders.slice(1).filter((id, i) => id && leaders[i] && id !== leaders[i]).length;
  assert.ok(flips <= 2, `leader flipped ${flips} times at a boundary`);
});

test('a clear move to another item does win', () => {
  const r = rng(2), a = createAttention();
  let t = 0;
  for (let i = 0; i < 30; i++) a.update(150 + gauss(r) * 40, 200, 120, t += 33, cards);
  for (let i = 0; i < 30; i++) a.update(1110 + gauss(r) * 40, 200, 120, t += 33, cards);
  assert.equal(a.leader()?.target.id, 'd');
});

test('what held the eyes when speech began is recalled after they moved on', () => {
  const a = createAttention();
  let t = 0;
  for (let i = 0; i < 30; i++) a.update(470, 200, 120, t += 33, cards);
  const spoke = t;
  for (let i = 0; i < 30; i++) a.update(1110, 200, 120, t += 33, cards);
  assert.equal(a.at(spoke)[0].id, 'b');
  assert.equal(a.leader()?.target.id, 'd');
});

test('going back and forth between two items is noticed; staring at one is not', () => {
  const a = createAttention();
  let t = 0;
  for (let i = 0; i < 120; i++) a.update(Math.floor(i / 15) % 2 ? 470 : 150, 200, 100, t += 33, cards);
  const pair = a.torn();
  assert.deepEqual(pair?.map((x) => x.id).sort(), ['a', 'b']);

  const b = createAttention();
  t = 0;
  for (let i = 0; i < 120; i++) b.update(150, 200, 100, t += 33, cards);
  assert.equal(b.torn(), null);
});

test('the snapshot for the agent is titles and shares, and remembers the session', () => {
  const a = createAttention();
  let t = 0;
  for (let i = 0; i < 60; i++) a.update(150, 200, 100, t += 33, cards);
  for (let i = 0; i < 20; i++) a.update(790, 200, 100, t += 33, cards);
  const s = a.snapshot();
  assert.equal(s.now[0].title, 'Item c');
  assert.equal(s.studied[0].title, 'Item a', 'the long view remembers what was studied');
  assert.equal(s.session[0].id, 'a');
  assert.ok(s.now.every((x) => x.share > 0 && x.share <= 1));
  assert.ok(!JSON.stringify(s).includes('rect'), 'no geometry leaks out');
});
