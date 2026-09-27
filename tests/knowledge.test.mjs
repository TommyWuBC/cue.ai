import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalProductUrl, cardLinks, createKnowledge } from '../client/knowledge.js';
import { safeProductUrl } from '../client/details.js';

const PAGE = 'https://www.amazon.com/s?k=headphones';
const anchor = (href, text = '') => ({ getAttribute: (k) => (k === 'href' ? href : k === 'aria-label' ? text : null), textContent: text });
const card = (...links) => ({ querySelectorAll: () => links });
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('sponsored redirect and plain link are the same product page', () => {
  const sponsored = '/sspa/click?ie=UTF8&spc=abc&url=%2FSonitum-Headphones%2Fdp%2FB0ABCDEFGH%2Fref%3Dsr_1_1_sspa%3Fth%3D1';
  assert.equal(canonicalProductUrl(sponsored, PAGE), 'https://www.amazon.com/dp/B0ABCDEFGH');
  assert.equal(canonicalProductUrl('/Some-Name/dp/B0ABCDEFGH/ref=x?psc=1', PAGE), 'https://www.amazon.com/dp/B0ABCDEFGH');
  assert.equal(safeProductUrl(sponsored, PAGE), 'https://www.amazon.com/dp/B0ABCDEFGH');
});

test('cross-origin, cart and checkout links are refused', () => {
  assert.equal(canonicalProductUrl('https://sponsored-ads.amazon.com/clk/?x=1', PAGE), null);
  assert.equal(canonicalProductUrl('/gp/cart/view.html', PAGE), null);
  assert.equal(canonicalProductUrl('/sspa/click?url=%2Fgp%2Fbuy%2Fspc%2Fhandlers', PAGE), null);
});

test('card links are sorted by what they are for, with a reviews fallback', () => {
  const links = cardLinks(card(
    anchor('/Soundcore/dp/B0Q20I0001/ref=x', 'Soundcore Q20i'),
    anchor('/Soundcore/product-reviews/B0Q20I0001', '4.5 out of 5 stars'),
  ), PAGE, 'https://www.amazon.com/dp/B0Q20I0001');
  assert.equal(links.product, 'https://www.amazon.com/dp/B0Q20I0001');
  assert.match(links.reviews, /product-reviews/);
  const bare = cardLinks(card(anchor('/x/dp/B0Q20I0001', 'Soundcore Q20i')), PAGE, 'https://www.amazon.com/dp/B0Q20I0001');
  assert.equal(bare.reviews, 'https://www.amazon.com/dp/B0Q20I0001#customerReviews');
});

test('what was seen survives a page load, and facts attach to it', () => {
  const s = store();
  let here = PAGE;
  const k = createKnowledge({ storage: s, page: () => here });
  const el = card(anchor('/Soundcore/dp/B0Q20I0001/ref=x', 'Soundcore Q20i'));
  k.observe([{ product: { id: 'B0Q20I0001', title: 'Soundcore Q20i Headphones', price: 45, url: '/Soundcore/dp/B0Q20I0001' }, el }]);
  k.setFacts('https://www.amazon.com/dp/B0Q20I0001', { title: 'Soundcore Q20i', rating: '4.5 from 3217 reviews', highlights: ['40h battery'] });
  k.flush();
  here = 'https://www.amazon.com/s?k=speakers';
  const next = createKnowledge({ storage: s, page: () => here });
  const [item] = next.brief();
  assert.equal(item.title, 'Soundcore Q20i Headphones');
  assert.equal(item.here, false);
  assert.equal(item.read, true);
  assert.ok(item.links.includes('reviews'));
  assert.equal(next.linkFor(next.get('B0Q20I0001'), 'reviews'), 'https://www.amazon.com/dp/B0Q20I0001#customerReviews');
});
