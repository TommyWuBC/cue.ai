import assert from 'node:assert/strict';
import test from 'node:test';
import { compareHTML } from '../client/compare.js';

const DATA = {
  titles: { a: 'AirPods Pro 3', b: 'Soundcore Q20i' },
  rows: [{ label: 'Price', a: '$249', b: '$44.99' }, { label: 'Battery', a: '6h', b: 'not listed' }],
  verdict: 'The AirPods if you want the pairing, the Soundcore if you want the price.',
  pick: 'a',
  ecosystem: 'You picked up the iPhone last week, so these pair the moment you open the case.',
};

// createCompare's own behaviour needs a DOM; there is no jsdom here, so the
// panel is verified in the browser. What is testable is the markup it renders,
// which is where the escaping and the pick logic live.
test('product titles are page text, never markup', () => {
  const html = compareHTML({ ...DATA, titles: { a: '<img src=x onerror=alert(1)>', b: 'B' },
    rows: [{ label: '<b>x', a: '"><script>', b: "'" }] });
  assert.ok(!html.includes('<img'), 'a product title was rendered as markup');
  assert.ok(!html.includes('<script'), 'a row value was rendered as markup');
  assert.ok(html.includes('&lt;img'));
});

test('one side is marked as the pick, in the header and down its column', () => {
  const a = compareHTML(DATA);
  assert.match(a, /cc-card cc-win[\s\S]*?AirPods Pro 3/);
  assert.equal((a.match(/<td class="cc-col">/g) || []).length, DATA.rows.length);
  assert.ok(a.includes('Add the AirPods Pro 3'));
  // The badge is what states the pick; the tint must not be carrying it alone.
  assert.ok(a.includes('cc-badge'));

  const b = compareHTML({ ...DATA, pick: 'b' });
  assert.match(b, /cc-card cc-win[\s\S]*?Soundcore Q20i/);
  assert.ok(b.includes('Add the Soundcore Q20i'));
});

test('the ecosystem slot renders hidden, so the reveal is the only thing that shows it', () => {
  assert.match(compareHTML(DATA), /<div class="cc-eco" hidden><\/div>/);
});

test('prices come from the shop, and a missing one renders nothing', () => {
  assert.ok(compareHTML({ ...DATA, prices: { a: 249, b: 44.99 } }).includes('$249'));
  assert.ok(compareHTML({ ...DATA, prices: { a: 249, b: 44.99 } }).includes('$44.99'));
  assert.ok(!compareHTML(DATA).includes('$undefined'));
});

test('a comparison with nothing in it still renders a way out', () => {
  const html = compareHTML({});
  assert.ok(html.includes('cc-back'));
  assert.ok(!html.includes('undefined'));
});
