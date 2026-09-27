import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsCommand, dashboardHTML } from '../client/analytics.js';
import { ANALYTICS_KEY, activityCSV, localAnalyticsRequest, summarizeActivity } from '../client/analytics-store.js';

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
  }, { hasExport: true });
  assert.match(html, /What you look for/);
  assert.match(html, /Added to bag/);
  assert.match(html, /Checked out/);
  assert.match(html, /\$129\.00/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Download CSV/);
  assert.match(html, /Stored in your browser/);
});

test('browser journal survives reload, counts repeated searches and records only approved purchases', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value) };
  const record = event => localAnalyticsRequest('event', event, storage);
  assert.deepEqual(record({ event_id: 'search-001', kind: 'search', query: 'wool coat', site: 'amazon.com' }),
    { recorded: true });
  assert.deepEqual(record({ event_id: 'search-001', kind: 'search', query: 'wool coat' }),
    { recorded: false });
  record({ event_id: 'search-002', kind: 'search', query: 'Wool Coat' });
  record({ event_id: 'add-req-001', kind: 'add_request', product_title: 'Coat' });
  record({ event_id: 'cart-add-001', kind: 'cart_add', product_title: 'Coat' });
  record({ event_id: 'purchase:order-1:0', kind: 'purchase', product_title: 'Coat',
    price_cents: 12900, order_id: 'order-1', order_total_cents: 12900 });
  const summary = localAnalyticsRequest('summary', null, storage);
  assert.deepEqual(summary.totals, { searches: 2, confirmed_adds: 1,
    add_requests: 1, orders: 1, items_purchased: 1, demo_spend_cents: 12900 });
  assert.equal(summary.top_searches[0].count, 2);
  assert.equal(summary.top_purchased[0].label, 'Coat');
  assert.equal(JSON.parse(values.get(ANALYTICS_KEY)).length, 5);
  assert.match(localAnalyticsRequest('export', null, storage), /purchase:order-1:0/);
});

test('CSV escapes formulas and the summary does not turn add requests into confirmed adds', () => {
  const events = [{ event_id: 'request-01', kind: 'add_request',
    timestamp: '2026-09-27T12:00:00Z', product_title: '=HYPERLINK("bad")' }];
  assert.equal(summarizeActivity(events).totals.confirmed_adds, 0);
  assert.match(activityCSV(events), /"'=HYPERLINK\(""bad""\)"/);
});
