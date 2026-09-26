import assert from 'node:assert/strict';
import test from 'node:test';
import { matchProduct, matchCandidates, matchOptions, missingChoices, optionPrompt } from '../client/intent.js';

const coat = { id: 'j1', title: 'Oversized Wool-Blend Coat', variants: ['XS', 'S', 'M', 'L'], colors: [{ name: 'Black' }, { name: 'Camel' }] };
const jeans = { id: 'j2', title: 'Straight Jeans', variants: ['S', 'M', 'L'], colors: [{ name: 'Indigo' }, { name: 'Black' }] };

test('a spoken title beats a different item, and a shared word is not a choice', () => {
  assert.equal(matchProduct('add the wool coat in medium', [coat, jeans]).id, 'j1');
  assert.equal(matchProduct('the straight jeans', [coat, jeans]).id, 'j2');
  assert.equal(matchProduct('add it', [coat, jeans]), null);
  const twins = [{ id: 'a', title: 'Wool coat' }, { id: 'b', title: 'Wool coat black' }];
  assert.equal(matchCandidates('the wool', twins).length, 2);
  assert.equal(matchProduct('black', [coat, jeans]), null);
});

test('size and color are taken from the words, and both are required before an add', () => {
  assert.deepEqual(matchOptions('medium, in camel', coat), { size: 'M', color: 'Camel' });
  assert.deepEqual(matchOptions('large', coat), { size: 'L', color: null });
  assert.deepEqual(missingChoices(coat, {}), { size: true, color: true });
  assert.deepEqual(missingChoices(coat, { size: 'M', color: 'Camel' }), { size: false, color: false });
  assert.deepEqual(missingChoices({ variants: ['One size'], colors: [{ name: 'Black' }] }, {}), { size: false, color: false });
  assert.match(optionPrompt(coat.title, { size: true, color: true }, coat), /size and color/);
});
