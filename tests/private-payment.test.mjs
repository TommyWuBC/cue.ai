import test from 'node:test';
import assert from 'node:assert/strict';
import { DwellActivator, DEMO_FIXTURE, validateDemoFields } from '../store/private-payment.js';

test('dwell activates once and requires a reliable look-away before same target repeats', () => {
  let t = 0, hits = [];
  const dwell = new DwellActivator({ dwellMs: 1000, now: () => t, onActivate: id => hits.push(id) });
  dwell.update('4', true);
  t = 999; assert.equal(dwell.update('4', true).activated, false);
  t = 1000; assert.equal(dwell.update('4', true).activated, true);
  t = 2500; assert.equal(dwell.update('4', true).activated, false);
  assert.deepEqual(hits, ['4']);
  dwell.update(null, true); // deliberate look-away rearms
  t = 2600; dwell.update('4', true);
  t = 3600; assert.equal(dwell.update('4', true).activated, true);
  assert.deepEqual(hits, ['4', '4']);
});

test('lost or unreliable tracking resets dwell progress but does not count as look-away', () => {
  let t = 0, hits = [];
  const dwell = new DwellActivator({ dwellMs: 1000, now: () => t, onActivate: id => hits.push(id) });
  dwell.update('next', true);
  t = 700; assert.ok(dwell.update('next', true).progress > 0.6);
  t = 750; assert.equal(dwell.update('next', false).progress, 0);
  t = 900; assert.equal(dwell.update('next', true).progress, 0);
  t = 1900; assert.equal(dwell.update('next', true).activated, true);
  t = 3000; dwell.update('next', false);
  t = 4200; assert.equal(dwell.update('next', true).activated, false);
  assert.deepEqual(hits, ['next']);
});

test('only the complete fictional fixture is accepted', () => {
  assert.equal(validateDemoFields(DEMO_FIXTURE), true);
  assert.equal(validateDemoFields({ ...DEMO_FIXTURE, expiry: '1229' }), false);
  assert.equal(validateDemoFields({ ...DEMO_FIXTURE, securityCode: '' }), false);
  assert.equal(validateDemoFields({ cardNumber: '', expiry: '', securityCode: '' }), false);
});

test('approval remains blocked until all three demo fields match', () => {
  const partial = { cardNumber: DEMO_FIXTURE.cardNumber, expiry: DEMO_FIXTURE.expiry, securityCode: '' };
  assert.equal(validateDemoFields(partial), false);
  assert.equal(validateDemoFields({ ...partial, securityCode: DEMO_FIXTURE.securityCode }), true);
});
