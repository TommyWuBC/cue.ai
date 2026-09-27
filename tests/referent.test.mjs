import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReferent, gazePick, answerWhich, whichQuestion, talksAboutItem } from '../client/referent.js';

const COAT = { id: 'coat', title: 'Wool Coat' };
const PUFFER = { id: 'puffer', title: 'Puffer Jacket' };
const DENIM = { id: 'denim', title: 'Denim Jacket' };
const TILE = { id: 'tile', title: 'Recommended Scarf' };
const products = [COAT, PUFFER, DENIM, TILE];

// attention.snapshot() + at_speech, as gaze.getAttention() returns it.
const eyes = (rows, key = 'at_speech') => ({ [key]: rows.map(([id, share]) => ({ id, share, kind: 'product' })) });

test('gaze off: resolution is exactly the voice-only behaviour', () => {
  assert.equal(resolveReferent({ text: 'add it to my bag', discussed: COAT, products }).item, COAT);
  assert.equal(resolveReferent({ text: 'add it to my bag', pageItem: COAT, products }).item, COAT);
  assert.equal(resolveReferent({ text: 'add this to my bag', products }).item, null);
  assert.deepEqual(resolveReferent({ text: 'add the jacket', hits: [PUFFER, DENIM], products }).ask, [PUFFER, DENIM]);
});

test('a glance at a recommendation tile never takes "add it" off the page product', () => {
  const r = resolveReferent({ text: 'add it to my bag', pageItem: COAT, products, attention: eyes([['tile', 0.9]]) });
  assert.equal(r.item, COAT);
  assert.equal(r.how, 'page');
});

test('the conversation beats the eyes for "it"', () => {
  const r = resolveReferent({ text: 'is it warm', discussed: COAT, products, attention: eyes([['denim', 0.95]]) });
  assert.equal(r.item, COAT);
  assert.equal(r.how, 'conversation');
});

test('"this" on a results page with nothing discussed uses a clear gaze leader', () => {
  const r = resolveReferent({ text: 'how much is this', products, attention: eyes([['puffer', 0.8], ['coat', 0.1]]) });
  assert.equal(r.item, PUFFER);
  assert.equal(r.how, 'gaze');
});

test('"this" with the eyes split asks by name instead of guessing', () => {
  const r = resolveReferent({ text: 'add this', products, attention: eyes([['puffer', 0.45], ['coat', 0.4]]) });
  assert.equal(r.item, null);
  assert.deepEqual(r.ask.map((p) => p.id), ['puffer', 'coat']);
});

test('"this" needs a strong look to override the conversation, a weak one does not', () => {
  const strong = resolveReferent({ text: 'what about this one', discussed: COAT, products, attention: eyes([['denim', 0.85]]) });
  assert.equal(strong.item, DENIM);
  const weak = resolveReferent({ text: 'what about this one', discussed: COAT, products, attention: eyes([['denim', 0.52], ['coat', 0.4]]) });
  assert.equal(weak.item, COAT);
});

test('gaze breaks a tie between items the words both name', () => {
  const r = resolveReferent({ text: 'add the jacket', hits: [PUFFER, DENIM], products,
    attention: eyes([['denim', 0.7], ['puffer', 0.2]]) });
  assert.equal(r.item, DENIM);
  assert.equal(r.how, 'named+gaze');
  // Eyes on neither of the named items: ask, and do not pick the gazed coat.
  const off = resolveReferent({ text: 'add the jacket', hits: [PUFFER, DENIM], products, attention: eyes([['coat', 0.9]]) });
  assert.equal(off.item, null);
  assert.equal(off.ask.length, 2);
});

test('the likelier item is asked about first', () => {
  const r = resolveReferent({ text: 'add the jacket', hits: [PUFFER, DENIM], products,
    attention: eyes([['denim', 0.5], ['puffer', 0.4]]) });
  assert.deepEqual(r.ask.map((p) => p.id), ['denim', 'puffer']);
});

test('navigation never picks an item up from the eyes', () => {
  for (const text of ['scroll down', 'search for boots', 'go back', 'yes', 'no thanks']) {
    assert.equal(resolveReferent({ text, products, attention: eyes([['coat', 1]]) }).item, null, text);
  }
  assert.equal(talksAboutItem('add it'), true);
  assert.equal(talksAboutItem('scroll down'), false);
});

test('"the one I was looking at" is what this visit studied', () => {
  const r = resolveReferent({ text: 'add the one I was looking at', discussed: COAT, products,
    attention: { studied: [{ id: 'puffer', share: 0.6 }], at_speech: [{ id: 'coat', share: 1 }] } });
  assert.equal(r.item, PUFFER);
});

test('a trickle of attention is not a pick', () => {
  assert.equal(gazePick({ now: [{ id: 'coat', share: 0.2, kind: 'product' }] }).id, null);
  // Controls do not count as products.
  assert.equal(gazePick({ at_speech: [{ id: 'btn', share: 0.9, kind: 'action' }] }).id, null);
});

test('answering "which one?" by name, ordinal or a look', () => {
  const opts = [PUFFER, DENIM];
  const match = (t, list) => list.filter((p) => t.toLowerCase().includes(p.title.split(' ')[0].toLowerCase()));
  assert.equal(answerWhich('the denim one', opts, null, match), DENIM);
  assert.equal(answerWhich('the first one', opts), PUFFER);
  assert.equal(answerWhich('the other one', opts), DENIM);
  assert.equal(answerWhich('this one', opts, eyes([['denim', 0.8], ['puffer', 0.1]])), DENIM);
  assert.equal(answerWhich('never mind', opts), null);
  assert.equal(whichQuestion(opts), 'The Puffer Jacket or the Denim Jacket?');
});

test('"this" on a product page is the page product, unless scrolled away and clearly looking elsewhere', () => {
  const look = eyes([['tile', 0.9]]);
  assert.equal(resolveReferent({ text: 'add this', pageItem: COAT, pageVisible: true, products, attention: look }).item, COAT);
  assert.equal(resolveReferent({ text: 'add this', pageItem: COAT, pageVisible: false, products, attention: look }).item, TILE);
  assert.equal(resolveReferent({ text: 'add this', pageItem: COAT, pageVisible: false, products,
    attention: eyes([['tile', 0.55], ['denim', 0.4]]) }).item, COAT);
  // "it" stays with the page product wherever the eyes are.
  assert.equal(resolveReferent({ text: 'add it', pageItem: COAT, pageVisible: false, products, attention: look }).item, COAT);
});

test('"compare these two" is the pair the eyes went between, not a single "this"', () => {
  const att = { recent: [{ id: 'coat', share: 0.45, kind: 'product' }, { id: 'denim', share: 0.4, kind: 'product' },
    { id: 'puffer', share: 0.15, kind: 'product' }], at_speech: [{ id: 'denim', share: 0.9, kind: 'product' }] };
  const r = resolveReferent({ text: 'compare these two', products, attention: att });
  assert.deepEqual(r.pair.map((p) => p.id), ['coat', 'denim']);
  assert.equal(r.item, null);
  // Named items beat the eyes: "compare the puffer and the denim" is the agent's.
  assert.equal(resolveReferent({ text: 'compare these two', products, attention: { recent: [{ id: 'coat', share: 1 }] } }).pair, undefined);
});

test('"the one I was looking at" finds an item that has scrolled out of view', () => {
  // products here is the whole page, not only what is on screen.
  const r = resolveReferent({ text: 'how much was the one I was looking at', products,
    attention: { studied: [{ id: 'tile', share: 0.7 }, { id: 'coat', share: 0.3 }] } });
  assert.equal(r.item, TILE);
});

test('a steady look outweighs one noisy onset frame; a fresh glance against it asks', () => {
  const steady = { recent: [{ id: 'puffer', share: 0.8, kind: 'product' }, { id: 'coat', share: 0.2, kind: 'product' }],
    at_speech: [{ id: 'puffer', share: 0.55, kind: 'product' }, { id: 'coat', share: 0.45, kind: 'product' }] };
  assert.equal(resolveReferent({ text: 'how much is this', products, attention: steady }).item, PUFFER);
  const glance = { recent: [{ id: 'puffer', share: 0.9, kind: 'product' }],
    at_speech: [{ id: 'denim', share: 0.9, kind: 'product' }] };
  const r = resolveReferent({ text: 'how much is this', products, attention: glance });
  assert.equal(r.item, null);
  assert.equal(r.ask.length, 2);
});

test('"this page" is not pointing, and choosing across the page is left to the agent', () => {
  const look = eyes([['puffer', 0.5], ['coat', 0.45]]);
  for (const text of ['which is the cheapest jacket on this page?', 'what is the warmest coat here',
    'show me the best rated one', 'which of the jackets is lightest']) {
    const r = resolveReferent({ text, products, attention: look });
    assert.equal(r.item, null, text);
    assert.equal(r.ask, null, text);
  }
  // Pointing still works with a superlative in the sentence.
  assert.equal(resolveReferent({ text: 'is this the warmest one', products,
    attention: eyes([['coat', 0.9]]) }).item, COAT);
  // "Which of these" is the pair the eyes went between.
  const pair = resolveReferent({ text: 'which of these is warmer', products,
    attention: { recent: [{ id: 'coat', share: 0.5 }, { id: 'puffer', share: 0.45 }] } });
  assert.deepEqual(pair.pair.map((p) => p.id), ['coat', 'puffer']);
});

test('"the cheapest one here" is the page, even with the eyes on one card', () => {
  for (const text of ['which is the cheapest one here?', "what's the warmest one on here", 'which one is best here']) {
    const r = resolveReferent({ text, products, attention: eyes([['coat', 0.95]]) });
    assert.equal(r.item, null, text);
    assert.equal(r.ask, null, text);
  }
  // With a conversation, "which size is it in" is still about the discussed item.
  assert.equal(resolveReferent({ text: 'is it the warmest', discussed: DENIM, products }).item, DENIM);
});
