import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetHTML } from '../client/budget.js';

test('spend and cart add up correctly, and staying under budget says so', () => {
  const html = budgetHTML({ spent: 593.56, limit: 1000, cart: 44.99 });
  assert.ok(html.includes('$638.55'), 'projected total missing');
  assert.ok(html.includes('$593.56'));
  assert.ok(html.includes('$44.99'));
  assert.ok(html.includes('still under your $1000.00 budget') || html.includes('$1000.00 budget'));
  assert.ok(!html.includes('Over budget'));
});

test('going over budget is stated plainly, not hidden', () => {
  const html = budgetHTML({ spent: 950, limit: 1000, cart: 100 });
  assert.ok(html.includes('Over budget'));
  assert.ok(html.includes("that's over your $1000.00 budget"));
});

test('no cart in progress omits the cart slice and legend row', () => {
  const html = budgetHTML({ spent: 593.56, limit: 1000, cart: 0 });
  assert.ok(!html.includes('bg-dot-cart'));
  assert.ok(html.includes("You've spent"));
});
