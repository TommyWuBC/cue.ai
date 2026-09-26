// The bag: state, the rules for adding (size required, limits enforced at add
// time — see CLAUDE.md "Nothing spends money on one utterance"), and every
// surface that shows it: header count, bag bar, drawer, toast, order review.
import { setupCheckout } from "/checkout.js";
import { setupPrivatePayment } from "/private-payment.js";
import { photo, money, cents, byId } from "./data.js";
import { esc } from "./util.js";

const $ = id => document.getElementById(id);
const KEY = "northfield.bag";

let cart = [];
try { cart = (JSON.parse(sessionStorage.getItem(KEY)) ?? []).filter(i => byId(i.id)).map(i => ({ ...byId(i.id), ...i })); } catch {}
export let limits = { remaining: 25000, order: 20000, monthly: 25000, passkey: false };

const listeners = new Set();
export const onCartChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const items = () => cart;
export const total = () => cart.reduce((s, i) => s + cents(i), 0);
const plural = n => `${n} ${n === 1 ? "item" : "items"}`;

function save() {
  try { sessionStorage.setItem(KEY, JSON.stringify(cart.map(({ id, size, color, words }) => ({ id, size, color, words })))); } catch {}
}

export function add(p, size, color) {
  const say = text => window.cue?.bus.emit("SAY", { text });
  if (!size) { say(`Choose a size for ${p.title} first.`); return false; }
  if (total() + cents(p) > limits.order) {
    say(`That would take this order over your ${money(limits.order)} per-order limit.`); return false;
  }
  if (total() + cents(p) > limits.remaining) {
    say(`That would go over the ${money(limits.remaining)} left in your monthly budget.`); return false;
  }
  const item = { ...p, size, color, words: window.cue?.lastActionUtterance || "" };
  cart.push(item);
  changed(true);
  toast(item);
  say(`Added ${p.title}, ${color}, size ${size}.`);
  return true;
}

export function remove(index) { cart.splice(index, 1); changed(); }

function changed(bump = false) {
  save();
  render(bump);
  listeners.forEach(fn => fn(cart));
}

export function limitsHTML(thisOrder, heading) {
  const spent = limits.monthly - limits.remaining;
  const pct = v => `${Math.max(0, Math.min(100, (v / limits.monthly) * 100))}%`;
  return `
    <div class="limits-row"><span>${heading}</span><b class="tabular">${money(Math.max(0, limits.remaining - thisOrder))} left</b></div>
    <div class="meter" aria-hidden="true"><span class="spent" style="width:${pct(spent)}"></span><span class="this" style="left:${pct(spent)};width:${pct(thisOrder)}"></span></div>
    <div class="note">Monthly budget ${money(limits.monthly)}. Orders over ${money(limits.order)} are blocked.</div>`;
}

export function lineHTML(i, idx, { removable = true } = {}) {
  return `
    <div class="line">
      <a href="/product/${i.id}"><img src="${photo(i.id, i.color)}" alt=""></a>
      <div>
        <a class="line-title" href="/product/${i.id}">${esc(i.title)}</a>
        <p class="line-meta">${esc(i.color)}, ${i.size === "One size" ? "one size" : `size ${esc(i.size)}`}</p>
        ${removable ? `<button class="line-remove" type="button" data-remove="${idx}">Remove</button>` : ""}
      </div>
      <span class="line-price tabular">${money(i.unit_price_cents ?? cents(i))}</span>
    </div>`;
}

function render(bump = false) {
  const n = cart.length, t = total();
  const count = $("count");
  count.textContent = n;
  count.classList.toggle("on", n > 0);
  if (bump) { count.classList.remove("bump"); void count.offsetWidth; count.classList.add("bump"); }
  $("bag-open").setAttribute("aria-label", `Bag, ${plural(n)}`);

  $("bag-bar").classList.toggle("on", n > 0 && !document.body.matches("[data-view=bag]"));
  $("bag-items").textContent = plural(n);
  $("bag-total").textContent = money(t);
  $("bag-thumbs").innerHTML = cart.slice(-3).reverse().map(i => `<img src="${photo(i.id, i.color)}" alt="">`).join("");

  $("bag-lines").innerHTML = n ? cart.map((i, idx) => lineHTML(i, idx)).join("")
    : `<div class="drawer-empty"><p>Your bag is empty.</p><a class="btn btn-secondary" href="/shop/new" data-close>Shop new in</a></div>`;
  $("bag-foot").hidden = !n;
  $("bag-subtotal").textContent = money(t);
  $("bag-limits").innerHTML = limitsHTML(t, "Budget after this bag");
}

// ── Drawer and toast ────────────────────────────────────────────────────────
const bag = $("bag");
export const openBag = () => { render(); bag.showModal(); };
$("bag-open").addEventListener("click", openBag);
bag.addEventListener("click", e => {
  if (e.target === bag || e.target.closest("[data-close]") || e.target.closest("a[href]")) bag.close();
  const r = e.target.closest("[data-remove]");
  if (r) remove(Number(r.dataset.remove));
});
$("bag-checkout").addEventListener("click", () => { bag.close(); window.checkout(); });
document.addEventListener("click", e => {
  const r = e.target.closest("#view [data-remove]");
  if (r) remove(Number(r.dataset.remove));
});

let toastTimer;
export function toast(item, heading = "Added to bag") {
  const t = $("toast");
  t.innerHTML = `
    ${item.id ? `<img src="${photo(item.id, item.color)}" alt="">` : `<span class="toast-seal" aria-hidden="true"></span>`}
    <div>
      <p class="toast-head"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>${heading}</p>
      <p>${esc(item.title)}</p>
      <p class="muted">${item.size ? `${esc(item.color)}, ${item.size === "One size" ? "one size" : `size ${esc(item.size)}`}` : esc(item.color ?? "")}</p>
      ${item.size ? `<button class="btn btn-secondary" type="button">View bag</button>` : ""}
    </div>`;
  t.querySelector("button")?.addEventListener("click", () => { t.classList.remove("on"); openBag(); });
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 3600);
}

// ── Checkout ────────────────────────────────────────────────────────────────
function review(lines, totalCents) {
  $("review-lines").innerHTML = lines.map(i => `
    <li><img src="${photo(i.id, i.color)}" alt="">
      <div><p class="line-title">${esc(i.title)}</p><p class="line-meta">${esc(i.color)}, ${i.size === "One size" ? "one size" : `size ${esc(i.size)}`}</p></div>
      <span class="line-price tabular">${money(i.unit_price_cents ?? cents(i))}</span></li>`).join("");
  $("review-total").textContent = money(totalCents);
  $("review-limits").innerHTML = limitsHTML(totalCents, "Budget after this order");
}

const flow = setupCheckout({
  getCart: () => cart,
  clearCart: () => {
    const placed = cart.length;
    cart = []; changed();
    if (placed) toast({ id: "", title: "Demo order recorded. No charge occurred.", color: "" }, "Demo order confirmed");
  },
  onStatus: s => {
    limits = { remaining: s.remaining_cents, order: s.order_limit_cents,
      monthly: s.monthly_limit_cents ?? limits.monthly, passkey: s.passkey_registered };
    window.cueBudget = { remaining: limits.remaining, order: limits.order };
    changed();
  },
  onPrepared: pending => review(pending.items, pending.total_cents),
});
const privatePayment = setupPrivatePayment({
  onApproved: () => {
    if (cart.length) review(cart, total());
    return flow.prepare();
  },
});

window.checkout = () => {
  if (bag.open) bag.close();
  if (!cart.length) { window.cue?.bus.emit("SAY", { text: "Your cart is empty." }); return; }
  return privatePayment.start({ total: total() });
};
// aura.js calls cueCheckout.prepare() directly for "check out"; route it
// through the same path so the bag drawer closes and the review fills first.
window.cueCheckout = { ...flow, prepare: window.checkout, privatePayment };
window.CART = () => cart;

// Voice needs a way OUT of the bag, not just in. Gaze picks the wrong item
// often enough at our measured error that an undo is not a nicety.
window.cueBag = {
  items: () => cart.map((i, idx) => ({ idx, title: i.title, size: i.size, color: i.color, price: i.price })),
  remove,
  clear() { while (cart.length) remove(cart.length - 1); },
  open: openBag,
};

// The approval panel mirrors checkout.js's status line: waiting, or a problem.
const approval = $("approval"), message = approval.querySelector(".checkout-message");
new MutationObserver(() => {
  const text = message.textContent;
  approval.classList.toggle("waiting", /waiting|create a passkey|checking|reading back/i.test(text));
  approval.classList.toggle("error", !!text && !/waiting|create|checking|reading|say|set up|passkey ready/i.test(text));
}).observe(message, { childList: true, characterData: true, subtree: true });

document.addEventListener("routechange", () => render());
render();
