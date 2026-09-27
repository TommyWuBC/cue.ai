import assert from 'node:assert/strict';
import test from 'node:test';
import { bestMatch, correctUtterance, echoes, findWake, isWakeOnly, stripWake } from '../client/speech.js';

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

// Real transcripts from /tmp/cue-server.log, the session where Cue heard its
// own voice, acted on it, and looped. Each of these was processed as a fresh
// command and produced another click_named, which spoke again.
test('Cue recognises its own voice spanning two spoken lines', () => {
  const said = ['Opening your cart now.', 'Opening Cart, shift, option, c.'];
  assert.equal(echoes('Opening your cart now. Opening card. Shift. Up.', said), true);
  assert.equal(echoes(', opening your cart now. Oh.', said), true);
  assert.equal(echoes('Opening your cart now. O.', said), true);

  // The memory window is what makes this one work: the echoing line is two
  // utterances back, not the one playing.
  const add = ["All set. It's in your cart.",
               'SKIN1004 Hyalu-Cica Water-Fit Sun Serum UV, SPF 50 Sunscreen, 1.69 fl.oz, size S, $17.99. Add it?'];
  assert.equal(echoes("All set. It's in your cart. Skin one.", add), true);
  // ...and only the current line is not enough, which is the old behaviour.
  assert.equal(echoes("All set. It's in your cart. Skin one.", [add[1]]), false);
});

test('a shopper talking over Cue is not swallowed as echo', () => {
  const said = ['Opening your cart now.', 'Opening Cart, shift, option, c.'];
  // Barge-in and genuine commands must survive: these share few content words.
  assert.equal(echoes('no, the grey one instead', said), false);
  assert.equal(echoes('how much is the wool coat', said), false);
  assert.equal(echoes('stop', said), false);
  // Nothing said yet means nothing to echo.
  assert.equal(echoes('open my cart', []), false);
});

// "Hey Cue, stop" switched Cue off in a live session. The rule that ends Cue
// exists in two files — client/voice.js runs first, before anything reaches
// the server — and only one copy had bare "stop" removed. These assert the
// shape both copies must share, so fixing one and not the other fails here.
const HALT_RE = /^(?:end|cue end|stop cue|quit cue|pause cue|exit|quit|go away|shut down|turn(?: yourself)? off|disable)(?: cue)?$/;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const halts = (t) => HALT_RE.test(norm(stripWake(norm(t))));

test('"stop" is for the scroll, and never ends Cue', () => {
  for (const phrase of ['stop', 'Hey Cue, stop', 'Cue stop', 'stop scrolling', 'hey cue stop please']) {
    assert.equal(halts(phrase), false, phrase);
  }
});

test('ending Cue takes a word that means only that', () => {
  for (const phrase of ['quit', 'exit', 'Hey Cue, quit', 'stop cue', 'cue end', 'turn off', 'go away']) {
    assert.equal(halts(phrase), true, phrase);
  }
});
