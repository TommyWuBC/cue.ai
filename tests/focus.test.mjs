import assert from 'node:assert/strict';
import test from 'node:test';
import { setFocus, refreshFocus, getFocus } from '../client/gaze.js';

const rect = (top, bottom) => ({ left: 10, right: 210, top, bottom, width: 200, height: bottom - top });

test('scrolling updates a visible focus and clears one that leaves the viewport', () => {
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  let current = rect(100, 300);
  const element = { isConnected: true, getBoundingClientRect: () => current };
  setFocus({ kind: 'product', id: 'j1', el: element, rect: current }, 0);
  current = rect(60, 260);
  refreshFocus();
  assert.equal(getFocus().rect.top, 60);
  current = rect(-300, -100);
  refreshFocus();
  assert.equal(getFocus(), null);
});

test('a removed action cannot remain the voice target', () => {
  const element = { isConnected: false, getBoundingClientRect: () => rect(100, 300) };
  setFocus({ kind: 'action', id: 'old', el: element, rect: rect(100, 300) }, 0);
  refreshFocus();
  assert.equal(getFocus(), null);
});
