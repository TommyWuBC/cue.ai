import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsCommand, dashboardHTML } from '../client/analytics.js';

test('analytics opens for natural commands and any close phrase closes only while open', () => {
  assert.equal(analyticsCommand('Cue, show me my analytics', false), 'open');
  assert.equal(analyticsCommand('What do my analytics say?', false), 'open');
  assert.equal(analyticsCommand('Please close this table', true), 'close');
  assert.equal(analyticsCommand('Close my analytics', true), 'close');
  assert.equal(analyticsCommand('Close the cart', false), null);
  assert.equal(analyticsCommand('I need an analyst', false), null);
});

test('dashboard shows searches, confirmed adds and purchases without interpreting labels as HTML', () => {
  const html = dashboardHTML({
    totals: { searches: 2, confirmed_adds: 1, orders: 1, demo_spend_cents: 12900 },
    top_searches: [{ label: '<img src=x onerror=alert(1)>', count: 2 }],
    top_added: [{ label: 'Wool coat', count: 1 }],
    top_purchased: [{ label: 'Wool coat', count: 1 }],
    daily: [{ date: '2026-09-27', searches: 2, adds: 1 }],
    recent: [{ kind: 'purchase', label: 'Wool coat', at: '2026-09-27T12:00:00Z' }],
    insight: { title: 'A recurring interest', body: 'Wool coats caught your eye.' },
  }, { exportUrl: '/api/analytics/export' });
  assert.match(html, /What you look for/);
  assert.match(html, /Added to bag/);
  assert.match(html, /Checked out/);
  assert.match(html, /\$129\.00/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});
