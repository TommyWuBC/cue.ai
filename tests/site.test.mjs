import assert from 'node:assert/strict';
import test from 'node:test';
import { sameOrigin, readPage, learnSite, matchPage } from '../client/site.js';

function doc(title, headings, links) {
  const nodes = links.map(([name, href]) => ({ textContent: name, href, getAttribute: () => href }));
  return {
    querySelector: (sel) => sel === 'title' ? { textContent: title } : headings[0] ? { textContent: headings[0] } : null,
    querySelectorAll: (sel) => sel.startsWith('h1') ? headings.map((h) => ({ textContent: h })) : nodes,
  };
}

test('only links this page already shows, on the same site, are remembered', () => {
  const page = 'https://shop.example/en/women';
  assert.equal(sameOrigin('https://other.example/sale', page), null);
  const here = readPage(doc('Shop', ['Women'], [
    ['Dresses', '/en/dresses'],
    ['Search', '/en/search'],
    ['Sale', 'https://other.example/sale'],
  ]), page);
  assert.deepEqual(here.links.map((l) => l.name), ['Dresses']);
  assert.equal(here.links[0].url, 'https://shop.example/en/dresses');
});

test('a named page is only opened when the site linked to it', async () => {
  const page = 'https://shop.example/';
  const site = await learnSite(doc('Shop', ['Home'], [['Knitwear', '/knitwear']]), page,
    async () => '<title>Knitwear</title><h1>Knitwear</h1>');
  assert.equal(matchPage('knitwear', site).url, 'https://shop.example/knitwear');
  assert.equal(matchPage('https://evil.example', site), null);
});
