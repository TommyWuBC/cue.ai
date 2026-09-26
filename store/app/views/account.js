// Account: the demo shopper's orders, spending limits, passkeys, addresses.
// Everything that comes from the server is written with textContent or esc().
import { crumbs } from "../ui.js";
import { photo, money } from "../data.js";
import { esc } from "../util.js";

const TABS = { orders: "Orders", limits: "Spending limits", passkeys: "Passkeys", addresses: "Addresses" };

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error();
  return r.json();
}

const dateOf = iso => new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

async function orders(el) {
  const { orders } = await getJSON("/api/merchant/orders");
  if (!orders.length) {
    el.innerHTML = `<div class="acct-empty"><h2>No orders yet</h2><p>Orders you approve with your passkey will appear here, with what you said when you placed them.</p><a class="btn btn-primary" href="/shop/new">Shop new in</a></div>`;
    return;
  }
  el.innerHTML = orders.map(o => {
    const words = String(o.customer_words || "").split("|").map(s => s.trim())
      .filter(s => s && !/^checkout button pressed$/i.test(s));
    return `
    <article class="acct-order">
      <header>
        <div><h2>Order ${esc(o.id.slice(0, 8).toUpperCase())}</h2><p>${esc(dateOf(o.created_at))}</p></div>
        <b class="tabular">${money(o.total_cents)}</b>
      </header>
      <ul class="acct-lines">${o.items.map(i => `
        <li><a href="/product/${esc(i.id)}"><img src="${photo(i.id, i.color)}" alt=""></a>
          <div><a href="/product/${esc(i.id)}">${esc(i.title)}</a><p>${esc(i.color)}, ${i.size === "One size" ? "one size" : `size ${esc(i.size)}`}</p></div>
          <span class="tabular">${money(i.unit_price_cents)}</span></li>`).join("")}</ul>
      ${words.length ? `<div class="acct-words"><p>What you said</p>${words.map(w => `<q>${esc(w)}</q>`).join("")}</div>` : ""}
      <footer><span class="acct-pill ok">Approved with passkey</span><span class="acct-pill">Demo order, no charge</span></footer>
    </article>`;
  }).join("");
}

async function limits(el) {
  const s = await getJSON("/api/checkout/status");
  const spent = s.monthly_limit_cents - s.remaining_cents;
  const pct = v => `${Math.max(0, Math.min(100, (v / s.monthly_limit_cents) * 100))}%`;
  el.innerHTML = `
    <div class="acct-limit">
      <div class="acct-limit-figure"><span>Left this month</span><b class="tabular">${money(s.remaining_cents)}</b><small>of ${money(s.monthly_limit_cents)}</small></div>
      <div class="meter" aria-hidden="true"><span class="spent" style="width:${pct(spent)}"></span></div>
      <p class="acct-muted">${money(spent)} spent since the first of the month.</p>
    </div>
    <dl class="acct-dl">
      <div><dt>Monthly budget</dt><dd class="tabular">${money(s.monthly_limit_cents)}</dd></div>
      <div><dt>Per-order limit</dt><dd class="tabular">${money(s.order_limit_cents)}</dd></div>
    </dl>
    <div class="acct-note">
      <h2>How limits work</h2>
      <p>Cue will not add an item that would take your bag over either limit. Before any order, it reads back every item, the total and what would remain of your budget, and nothing is recorded until you approve with your passkey.</p>
      <p>The limits are enforced by the store's server, which rechecks them at the moment of approval. They can't be changed from this page.</p>
    </div>`;
}

async function passkeys(el) {
  const s = await getJSON("/api/checkout/status");
  el.innerHTML = `
    <div class="acct-passkey ${s.passkey_registered ? "on" : ""}">
      <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 12V8a4 4 0 0 1 4-4h4M28 4h4a4 4 0 0 1 4 4v4M36 28v4a4 4 0 0 1-4 4h-4M12 36H8a4 4 0 0 1-4-4v-4"/>
        <path d="M14 14v3M26 14v3M20 14v8h-2M15 27c3 2.4 7 2.4 10 0"/></svg>
      <div>
        <h2>${s.passkey_registered ? "Passkey set up" : "No passkey yet"}</h2>
        <p>${s.passkey_registered
          ? "Orders are approved with Face ID, a fingerprint or your device PIN. Your passkey stays on your device; the store only keeps a public key."
          : "You'll be asked to create one the first time you check out. It lets you approve orders with Face ID, a fingerprint or your device PIN instead of a password."}</p>
      </div>
    </div>`;
}

function addresses(el) {
  el.innerHTML = `
    <div class="acct-address">
      <p class="acct-muted">Default delivery address</p>
      <address>Alex Rivera<br>850 Marietta Street NW, Apt 4B<br>Atlanta, GA 30318<br>United States</address>
    </div>`;
}

const LOADERS = { orders, limits, passkeys, addresses };

export default function account({ params }) {
  const tab = TABS[params.tab] ? params.tab : "orders";
  document.getElementById("view").innerHTML = `
    <div class="pg acct">
      ${crumbs([["Home", "/"], ["Account", "/account"], [TABS[tab]]])}
      <div class="acct-head"><h1 class="pg-title">Hello, Alex</h1><p class="pg-lede">Alex Rivera, member since March 2025</p></div>
      <div class="acct-layout">
        <nav class="acct-nav" aria-label="Account">${Object.entries(TABS).map(([k, t]) =>
          `<a href="/account/${k}" ${k === tab ? 'aria-current="page"' : ""}>${t}</a>`).join("")}</nav>
        <section class="acct-panel" id="acct-panel" aria-live="polite"><p class="acct-muted">Loading…</p></section>
      </div>
    </div>`;
  const el = document.getElementById("acct-panel");
  Promise.resolve(LOADERS[tab](el)).catch(() => {
    el.innerHTML = `<p class="acct-error">We couldn't reach the store server. Check that it is running, then reload this page.</p>`;
  });
  return { title: TABS[tab], name: "account" };
}
