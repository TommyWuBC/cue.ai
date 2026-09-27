import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSearch, amazonSearchUrl, toNumber, describeFilters } from '../client/search.js';

test('spoken and written prices become numbers', () => {
  assert.equal(toNumber('a hundred'), 100);
  assert.equal(toNumber('two hundred fifty'), 250);
  assert.equal(toNumber('two fifty'), 250);
  assert.equal(toNumber('fifty'), 50);
  assert.equal(toNumber('$1,200'), 1200);
  assert.equal(toNumber('forty nine'), 49);
  assert.equal(toNumber('banana'), null);
});

test('the price limit is taken out of the search words', () => {
  const p = parseSearch('wireless headphones under a hundred dollars');
  assert.equal(p.q, 'wireless headphones');
  assert.equal(p.max, 100);
  assert.equal(p.min, null);
  assert.equal(parseSearch('running shoes under $80').max, 80);
  assert.equal(parseSearch('laptop over 500 dollars').min, 500);
  const r = parseSearch('desk lamp between twenty and forty dollars');
  assert.deepEqual([r.q, r.min, r.max], ['desk lamp', 20, 40]);
});

test('stars, prime and sort are recognised', () => {
  const p = parseSearch('four stars and up prime headphones cheapest first under 60');
  assert.equal(p.q, 'headphones');
  assert.equal(p.stars, 4); assert.equal(p.prime, true);
  assert.equal(p.sort, 'price-asc'); assert.equal(p.max, 60);
  assert.equal(describeFilters(p), 'under 60 dollars, 4 stars and up, Prime, cheapest first');
});

test('a plain search is untouched', () => {
  const p = parseSearch('wool coat');
  assert.deepEqual([p.q, p.min, p.max, p.sort, p.prime, p.stars], ['wool coat', null, null, null, false, null]);
});

test('Amazon gets a filtered results URL, other shops do not', () => {
  const url = new URL(amazonSearchUrl(parseSearch('wireless headphones under a hundred dollars'), 'https://www.amazon.com/dp/B0'));
  assert.equal(url.pathname, '/s');
  assert.equal(url.searchParams.get('k'), 'wireless headphones');
  assert.equal(url.searchParams.get('high-price'), '100');
  assert.equal(amazonSearchUrl(parseSearch('coat under 50'), 'https://shop.example/'), null);
});
