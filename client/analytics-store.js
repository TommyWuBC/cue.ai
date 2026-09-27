// Shopping activity stays in the browser profile. The extension uses
// chrome.storage.local; the standalone demo store uses its own localStorage.
export const ANALYTICS_KEY = "cue.analytics.events.v2";
export const ANALYTICS_FIELDS = ["timestamp", "event_id", "kind", "site", "query",
  "product_id", "product_title", "size", "color", "price_cents", "order_id", "order_total_cents"];
const KINDS = new Set(["search", "cart_add", "add_request", "purchase"]);
const clean = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cents = value => Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
const dayStamp = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
  String(date.getDate()).padStart(2, "0")].join("-");

export function normalizeActivity(raw, { site = null, allowPurchase = false } = {}) {
  if (!raw || typeof raw !== "object" || !KINDS.has(raw.kind) ||
      (raw.kind === "purchase" && !allowPurchase)) throw new Error("Invalid shopping activity.");
  const event_id = clean(raw.event_id, 120);
  if (event_id.length < 8 || event_id.length > 120) throw new Error("Invalid activity ID.");
  const query = clean(raw.query, 120);
  const product_title = clean(raw.product_title, 200);
  if (raw.kind === "search" ? !query : !product_title) throw new Error("Missing activity details.");
  const timestamp = Number.isNaN(Date.parse(raw.timestamp)) ? new Date().toISOString()
    : new Date(raw.timestamp).toISOString();
  return { timestamp, event_id, kind: raw.kind, site: clean(site ?? raw.site, 120), query,
    product_id: clean(raw.product_id, 120), product_title, size: clean(raw.size, 60),
    color: clean(raw.color, 60), price_cents: cents(raw.price_cents),
    order_id: raw.kind === "purchase" ? clean(raw.order_id, 120) : "",
    order_total_cents: raw.kind === "purchase" ? cents(raw.order_total_cents) : null };
}

export function addActivity(events, raw, options = {}) {
  const event = normalizeActivity(raw, options);
  if (events.some(row => row.event_id === event.event_id)) return { events, recorded: false };
  return { events: [...events, event], recorded: true };
}

export function summarizeActivity(events, now = new Date()) {
  const rows = Array.isArray(events) ? events.filter(row => KINDS.has(row?.kind)) : [];
  const count = kind => rows.filter(row => row.kind === kind);
  const searches = count("search"), adds = count("cart_add"), requests = count("add_request"), purchases = count("purchase");
  const ranked = (list, field, limit) => {
    const groups = new Map();
    for (const row of list) {
      const label = clean(row[field]);
      if (!label) continue;
      const key = label.toLocaleLowerCase();
      const prior = groups.get(key);
      groups.set(key, { label: prior?.label || label, count: (prior?.count || 0) + 1 });
    }
    return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  };
  const top_searches = ranked(searches, "query", 6);
  const top_added = ranked(adds, "product_title", 5);
  const top_purchased = ranked(purchases, "product_title", 5);
  const orders = new Map();
  for (const row of purchases) if (row.order_id) {
    const prior = orders.get(row.order_id);
    orders.set(row.order_id, {
      total: row.order_total_cents ?? prior?.total ?? null,
      itemSum: (prior?.itemSum || 0) + (row.price_cents || 0),
    });
  }
  const daily = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - 6 + index);
    const day = dayStamp(date);
    return { date: day,
      searches: searches.filter(row => dayStamp(new Date(row.timestamp)) === day).length,
      adds: adds.filter(row => dayStamp(new Date(row.timestamp)) === day).length };
  });
  const recent = [...rows].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 12).map(row => ({ kind: row.kind,
      label: row.kind === "search" ? row.query : row.product_title,
      site: row.site, at: row.timestamp, price_cents: row.price_cents || 0 }));
  const insight = top_searches[0]?.count >= 2
    ? { title: "A recurring interest", body: `You searched for ${top_searches[0].label} ${top_searches[0].count} times. Cue can use that theme when you ask for ideas.` }
    : top_added.length ? { title: "From interest to intent", body: `${top_added[0].label} is the item you added most often while using Cue.` }
    : { title: "Your patterns will appear here", body: "Search and shop with Cue to see the interests you return to." };
  return { totals: { searches: searches.length, confirmed_adds: adds.length,
    add_requests: requests.length, orders: orders.size, items_purchased: purchases.length,
    demo_spend_cents: [...orders.values()].reduce((sum, row) => sum + (row.total ?? row.itemSum), 0) },
  top_searches, top_added, top_purchased, daily, recent, insight, local: true };
}

export function activityCSV(events) {
  const cell = value => {
    let text = value == null ? "" : String(value);
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [ANALYTICS_FIELDS.join(","), ...(events || []).map(row =>
    ANALYTICS_FIELDS.map(field => cell(row[field])).join(","))].join("\r\n") + "\r\n";
}

export function localAnalyticsRequest(kind, event, storage = localStorage) {
  const events = JSON.parse(storage.getItem(ANALYTICS_KEY) || "[]");
  if (!Array.isArray(events)) throw new Error("The local shopping journal is invalid.");
  if (kind === "event") {
    const result = addActivity(events, event, { allowPurchase: true });
    if (result.recorded) storage.setItem(ANALYTICS_KEY, JSON.stringify(result.events));
    return { recorded: result.recorded };
  }
  if (kind === "summary") return summarizeActivity(events);
  if (kind === "export") return activityCSV(events);
  throw new Error("Unknown analytics request.");
}
