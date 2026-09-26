import test from 'node:test';
import assert from 'node:assert/strict';
import { productMemory } from '../client/product-memory.js';

test('comparison follows discussed products through reloads, repeated questions, and changing focus', () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const first = { id: 'coat', title: 'Wool coat', price: 100, attrs: { material: 'Wool' } };
  const second = { id: 'shirt', title: 'Cotton shirt', price: 50 };
  let memory = productMemory({ storage });
  assert.equal(memory.remember(first), null);
  first.attrs.material = 'Changed DOM data';
  memory = productMemory({ storage });
  assert.equal(memory.remember(second).attrs.material, 'Wool');
  assert.equal(memory.remember(second).id, 'coat');
  assert.equal(memory.remember(null).id, 'coat');
  const previous = memory.remember(second);
  previous.title = 'Mutated by caller';
  assert.equal(memory.remember(second).title, 'Wool coat');
  assert.equal(memory.remember(first).id, 'shirt');
});

test('memory expires and works when browser storage is blocked', () => {
  let now = 1000;
  const memory = productMemory({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } }, now: () => now });
  memory.remember({ id: 'one' });
  assert.equal(memory.remember({ id: 'two' }).id, 'one');
  now += 3600001;
  assert.equal(memory.remember({ id: 'three' }), null);
});
