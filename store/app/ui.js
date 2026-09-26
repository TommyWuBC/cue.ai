// Shared building blocks and the one handler for size, color and add-to-bag.
// Mouse clicks, keyboard, and Cue's synthetic clicks all land in the same place.
import { photo, altPhoto, money, cents, byId, blurb, badgeFor } from "./data.js";
import { add } from "./cart.js";
import { esc } from "./util.js";
export { esc };

export const productJSON = p => esc(JSON.stringify(p));
export const sizeLabel = v => v === "One size" ? "One size" : v;

export function stars(rating, label = true) {
  return `<span class="stars" ${label ? `role="img" aria-label="Rated ${rating} out of 5"` : 'aria-hidden="true"'}><i></i><i style="width:${(rating / 5) * 100}%"></i></span>`;
}

export function colorPicker(p, selected = p.colors[0].name) {
  return `
    <div class="option">
      <div class="option-head"><span>Color <b class="color-name">${esc(selected)}</b></span></div>
      <div class="colors">${p.colors.map(c => `
        <button type="button" data-aura-action="select_color" data-aura-value="${esc(c.name)}"
                data-aura-label="Color ${esc(c.name)}" aria-label="${esc(c.name)}"
                aria-pressed="${c.name === selected}" style="--tone:${esc(c.tone)}"></button>`).join("")}</div>
    </div>`;
}

export function sizePicker(p, { guide = false } = {}) {
  if (p.variants.length === 1) {
    return `<div class="option"><div class="option-head"><span>Size <b>${esc(sizeLabel(p.variants[0]))}</b></span></div>
      <div class="variants" hidden><button type="button" data-aura-action="select_variant" data-aura-value="${esc(p.variants[0])}"
        data-aura-label="${esc(p.variants[0])}" aria-pressed="true">${esc(p.variants[0])}</button></div></div>`;
  }
  const fit = /true to size/i.test(p.attrs.sizing) ? "" : p.attrs.sizing;
  return `
    <div class="option">
      <div class="option-head"><span>Size <b class="size-name"></b></span>
        ${guide ? `<button type="button" class="link-btn" data-size-guide>Size guide</button>` : ""}</div>
      <div class="variants" style="--n:${p.variants.length}">${p.variants.map(v => `
        <button type="button" data-aura-action="select_variant" data-aura-value="${esc(v)}"
                data-aura-label="Size ${esc(v)}" aria-pressed="false">${esc(v)}</button>`).join("")}</div>
      ${fit ? `<p class="fit">${esc(fit)}</p>` : ""}
    </div>`;
}

export function card(p, { eager = false } = {}) {
  const first = p.colors[0].name, badge = badgeFor(p);
  return `
  <article class="card" data-id="${p.id}" data-aura-product='${productJSON(p)}'>
    <a class="media" href="/product/${p.id}" tabindex="-1" aria-hidden="true">
      ${badge ? `<span class="tag">${badge}</span>` : ""}
      <img class="main" data-photo src="${photo(p.id, first)}" alt="" ${eager ? "" : 'loading="lazy"'}>
      ${altPhoto(p.id) ? `<img class="alt" src="${altPhoto(p.id)}" alt="" loading="lazy" onload="this.classList.add('ready')" onerror="this.remove()">` : ""}
    </a>
    <div class="info">
      <div class="title-row"><a class="title" href="/product/${p.id}">${esc(p.title)}</a><span class="price tabular">${money(cents(p))}</span></div>
      <p class="blurb">${esc(blurb(p))}</p>
      <a class="rating" href="/product/${p.id}#reviews">${stars(p.attrs.rating)}<span>${p.attrs.rating.toFixed(1)} (${p.attrs.reviews.toLocaleString()})</span></a>
      ${colorPicker(p)}
      ${sizePicker(p)}
      <button class="btn btn-primary add" type="button" data-aura-action="add_to_cart"
              data-aura-label="Add ${esc(p.title)} to bag" data-id="${p.id}">Add to bag</button>
    </div>
  </article>`;
}

export const row = (products, opts) => `<div class="grid grid-4">${products.map(p => card(p, opts)).join("")}</div>`;

export function crumbs(parts) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.map(([label, to], i) =>
    to && i < parts.length - 1 ? `<a href="${to}">${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`)
    .join('<span class="sep">/</span>')}</nav>`;
}

// ── Product interactions ────────────────────────────────────────────────────
document.addEventListener("click", e => {
  const scope = e.target.closest("[data-aura-product]");
  if (!scope) return;
  const p = byId(scope.dataset.id);
  if (!p) return;

  const v = e.target.closest('[data-aura-action="select_variant"]');
  if (v) {
    scope.querySelectorAll(".variants button").forEach(b => b.setAttribute("aria-pressed", String(b === v)));
    scope.querySelectorAll(".size-name").forEach(el => el.textContent = v.dataset.auraValue);
    scope.classList.remove("needs-size");
  }

  const c = e.target.closest('[data-aura-action="select_color"]');
  if (c && c.getAttribute("aria-pressed") !== "true") {
    const name = c.dataset.auraValue;
    scope.querySelectorAll(".colors button").forEach(b => b.setAttribute("aria-pressed", String(b === c)));
    scope.querySelectorAll(".color-name").forEach(el => el.textContent = name);
    swapPhotos(scope, photo(p.id, name));
    scope.dispatchEvent(new CustomEvent("colorchange", { detail: name }));
  }

  const a = e.target.closest('[data-aura-action="add_to_cart"]');
  if (a) {
    const size = scope.querySelector('.variants [aria-pressed="true"]')?.dataset.auraValue;
    const color = scope.querySelector('.colors [aria-pressed="true"]')?.dataset.auraValue;
    if (!size) { scope.classList.remove("needs-size"); void scope.offsetWidth; scope.classList.add("needs-size"); }
    if (add(p, size, color)) {
      a.classList.add("done"); a.textContent = "Added";
      setTimeout(() => { a.classList.remove("done"); a.textContent = "Add to bag"; }, 1400);
    }
  }
});

function swapPhotos(scope, next) {
  for (const img of scope.querySelectorAll("img[data-photo]")) {
    if (img.getAttribute("src") === next) continue;
    img.classList.add("swap");
    const pre = new Image();
    pre.onload = pre.onerror = () => { img.src = next; requestAnimationFrame(() => img.classList.remove("swap")); };
    pre.src = next;
  }
}
