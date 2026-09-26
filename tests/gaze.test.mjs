import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, scan } from '../client/resolver.js';

const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

test('a nested action wins while the rest of its card remains a product', () => {
  const product = { kind: 'product', id: 'j1', rect: rect(0, 0, 300, 400) };
  const action = { kind: 'action', id: 'add:j1', rect: rect(100, 320, 200, 370) };
  assert.equal(resolve(150, 340, [product, action]).target, action);
  assert.equal(resolve(205, 350, [product, action]).target, action); // forgiving edge
  assert.equal(resolve(150, 100, [product, action]).target, product);
});

test('actions on separate cards have distinct focus identities', () => {
  const make = (id, left) => {
    const card = { dataset: { auraProduct: JSON.stringify({ id, title: id }) }, getBoundingClientRect: () => rect(left, 0, left + 300, 400) };
    const button = { dataset: { auraAction: 'add_to_cart', auraLabel: 'Add' }, textContent: 'Add', getBoundingClientRect: () => rect(left + 100, 320, left + 200, 370), closest: () => card };
    return { card, button };
  };
  const first = make('j1', 0), second = make('j2', 320);
  globalThis.innerHeight = 800;
  globalThis.document = { querySelectorAll: selector => selector === '[data-aura-product]' ? [first.card, second.card] : [first.button, second.button] };
  const actions = scan().filter(t => t.kind === 'action');
  assert.notEqual(actions[0].id, actions[1].id);
});
