import { crumbs, row } from "../ui.js";
import { items, total, lineHTML, limitsHTML, onCartChange } from "../cart.js";
import { related, money, byId, PRODUCTS, hasTag } from "../data.js";

function render() {
  const cart = items(), t = total();
  const seed = cart.length ? byId(cart[cart.length - 1].id) : null;
  const inBag = new Set(cart.map(i => i.id));
  const recs = (seed ? related(seed, 8) : PRODUCTS.filter(p => hasTag(p, "bestseller")))
    .filter(p => !inBag.has(p.id)).slice(0, 4);
  document.getElementById("view").innerHTML = `
    <div class="pg bagpage">
      ${crumbs([["Home", "/"], ["Bag"]])}
      <h1 class="pg-title">Your bag</h1>
      ${cart.length ? `
      <div class="bagpage-layout">
        <div class="bagpage-lines">${cart.map((i, idx) => lineHTML(i, idx)).join("")}</div>
        <aside class="bagpage-summary">
          <h2>Order summary</h2>
          <dl>
            <div><dt>Subtotal</dt><dd class="tabular">${money(t)}</dd></div>
            <div><dt>Shipping</dt><dd>Free</dd></div>
            <div class="bagpage-total"><dt>Total</dt><dd class="tabular">${money(t)}</dd></div>
          </dl>
          <div class="limits">${limitsHTML(t, "Budget after this order")}</div>
          <button class="btn btn-primary bagpage-go" type="button" onclick="checkout()">Check out</button>
          <p class="bagpage-note">Cue reads the order back before you approve it with your passkey. This is a demo store; no card is charged.</p>
        </aside>
      </div>` : `
      <div class="bagpage-empty">
        <p>Your bag is empty.</p>
        <div><a class="btn btn-primary" href="/shop/new">Shop new in</a><a class="btn btn-secondary" href="/shop/bestsellers">Bestsellers</a></div>
      </div>`}
    </div>
    <section class="pg bagpage-recs">
      <div class="pg-head"><h2>You may also like</h2></div>
      ${row(recs)}
    </section>`;
}

export default function bag() {
  render();
  const off = onCartChange(render);
  return { title: "Bag", name: "bag", cleanup: off };
}
