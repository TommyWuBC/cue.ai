import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extract, price } = require('../extension/extract.js');

globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
const visible = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 }) };

test('a live product page uses its own structured price and material', () => {
  const title = { closest: () => visible };
  const schema = { '@context': 'https://schema.org', '@type': 'Product', sku: '1293646002',
    name: 'Wool-Blend Coat', material: '50% wool', url: 'https://www2.hm.com/en_us/productpage.1293646002.html',
    offers: { price: '99.00', priceCurrency: 'USD' } };
  const doc = { querySelectorAll: selector => selector.startsWith('script') ? [{ textContent: JSON.stringify(schema) }] : [],
    querySelector: () => title };
  const result = extract(doc, schema.url);
  assert.equal(result.length, 1);
  assert.equal(result[0].product.price, 99);
  assert.equal(result[0].product.attrs.material, '50% wool');
  assert.equal(result[0].el, visible);
});

test('a listing with multiple structured products does not assign one to the whole page', () => {
  const products = [{ '@type': 'Product', name: 'First', url: 'https://store.example/first' },
    { '@type': 'Product', name: 'Second', url: 'https://store.example/second' }];
  const doc = { querySelectorAll: selector => selector.startsWith('script') ? [{ textContent: JSON.stringify(products) }] : [],
    querySelector: () => ({ closest: () => visible }) };
  assert.deepEqual(extract(doc, 'https://store.example/search'), []);
});

test('a homepage recommendation is not mistaken for its main product', () => {
  const schema = { '@type': 'Product', name: 'Recommended coat',
    url: 'https://store.example/coat', offers: { price: 89 } };
  const doc = { querySelectorAll: selector => selector.startsWith('script') ? [{ textContent: JSON.stringify(schema) }] : [],
    querySelector: () => ({ closest: () => visible }) };
  assert.deepEqual(extract(doc, 'https://store.example/'), []);
});

test('a product card with no shop-specific class is still numbered', () => {
  const card = {
    ...visible,
    textContent: 'Relaxed linen shirt',
    closest: () => null,
    querySelector: (sel) => sel.startsWith('h') ? { textContent: 'Relaxed linen shirt' } : null,
  };
  const link = {
    href: 'https://shop.example/items/linen-shirt',
    closest: (sel) => sel.includes('nav') ? null : card,
    getAttribute: () => null,
    querySelector: () => null,
    textContent: 'Relaxed linen shirt',
    getBoundingClientRect: visible.getBoundingClientRect,
  };
  card.querySelector = (sel) => sel.startsWith('h') ? { textContent: 'Relaxed linen shirt' } : null;
  const doc = {
    querySelectorAll: (selector) => {
      if (selector.startsWith('script')) return [];
      if (selector.includes('a[href]')) return [link];
      return [];
    },
    querySelector: () => null,
  };
  const result = extract(doc, 'https://shop.example/shop');
  assert.equal(result.length, 1);
  assert.equal(result[0].product.title, 'Relaxed linen shirt');
  assert.equal(result[0].el, card);
});

test('ambiguous prices are not presented as fact', () => {
  assert.equal(price('$120 $80'), null);
  assert.equal(price('$99.00$99.00'), 99);
});
