import assert from 'node:assert/strict';
import test from 'node:test';
import { bestMatch, correctUtterance, findWake, isWakeOnly, stripWake } from '../client/speech.js';

test('a misheard wake word counts at the start of a sentence', () => {
  assert.equal(findWake('q do xyz').rest, 'do xyz');
  assert.equal(findWake('Q, open the bag').rest, 'open the bag');
  assert.equal(findWake('Hey queue, find me desk tops').rest, 'find me desk tops');
  assert.equal(findWake('Kew. Find me desk tops.').rest, 'Find me desk tops.');
  assert.ok(isWakeOnly('cue'));
  assert.ok(isWakeOnly('Hey Q.'));
});

test('a sound-alike wakes Cue only when a command follows it', () => {
  assert.equal(findWake('cute click the cart').rest, 'click the cart');
  assert.equal(findWake('cute dress please'), null);
  assert.equal(findWake('what a cute q'), null);
  assert.equal(findWake('cool thanks'), null);
  assert.equal(findWake('I love the q20i'), null);
  assert.equal(findWake('key lime pie'), null);
});

test('a command word is never taken for the wake word', () => {
  assert.equal(findWake('go to checkout'), null);
  assert.equal(stripWake('go to checkout'), 'go to checkout');
  assert.equal(stripWake('go back'), 'go back');
});

test('names match by sound, and a near tie is refused rather than guessed', () => {
  assert.equal(bestMatch('the card', ['Cart', 'Account & Lists', 'Returns & Orders']).name, 'Cart');
  assert.equal(bestMatch('account and lists', ['Account & Lists', 'Cart']).name, 'Account & Lists');
  assert.equal(bestMatch('bak', ['Bag', 'Back']), null);
  assert.equal(bestMatch('oven mitts', ['Cart', 'Sign in']), null);
});

test('a misheard verb is corrected only when the page makes the rest make sense', () => {
  const page = { controls: ['Cart', 'Account & Lists'], fields: ['Search Amazon'] };
  assert.deepEqual(correctUtterance('clique the cart', page), { text: 'click the cart', changed: true });
  assert.deepEqual(correctUtterance('q clique the cart', page), { text: 'click the cart', changed: true });
  assert.equal(correctUtterance('serch for desk tops', page).text, 'search for desk tops');
  assert.equal(correctUtterance('scrawl down', page).text, 'scroll down');
  assert.equal(correctUtterance('clique the oven mitts', page).changed, false);
  assert.equal(correctUtterance('oven mitts', page).changed, false);
});
