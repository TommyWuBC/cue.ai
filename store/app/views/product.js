import { byId, photo, altPhoto, money, cents, blurb, badgeFor, related, reviewsFor, ratingSpread, fitOf,
  CATEGORIES, DEPARTMENTS, PRODUCTS } from "../data.js";
import { productJSON, colorPicker, sizePicker, stars, row, crumbs, esc } from "../ui.js";
import notfound from "./notfound.js";

const SEEN = "northfield.seen";

function deliveryDate() {
  const d = new Date();
  let added = 0;
  while (added < 4) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) added++; }
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// Phrases Cue actually understands, built from this product's own details.
function askCue(p) {
  const fibre = (p.attrs.material.match(/wool|cashmere|cotton|linen|leather|silk|merino|mohair|nylon|polyester/i) ?? ["wool"])[0].toLowerCase();
  const size = p.variants.includes("M") ? "medium" : null;
  return [
    `Is this ${fibre}?`,
    p.variants.length > 1 ? "Does it run small?" : "How big is it?",
    size ? `Add it in ${size}${p.colors.length > 1 ? `, in ${p.colors[1].name.toLowerCase()}` : ""}` : "Add it to my bag",
  ];
}

export default function product({ params }) {
  const p = byId(params.id);
  if (!p) return notfound();
  const first = p.colors[0].name;
  const reviews = reviewsFor(p), spread = ratingSpread(p), fit = fitOf(p);
  const maxCount = Math.max(...spread.map(s => s.count));
  const deptLink = p.department === "accessories" ? "/shop/accessories" : `/shop/${p.department}`;
  const badge = badgeFor(p);

  let seen = [];
  try { seen = JSON.parse(sessionStorage.getItem(SEEN)) ?? []; } catch {}
  const recent = seen.filter(id => id !== p.id && byId(id)).slice(0, 4).map(byId);
  try { sessionStorage.setItem(SEEN, JSON.stringify([p.id, ...seen.filter(id => id !== p.id)].slice(0, 12))); } catch {}

  document.getElementById("view").innerHTML = `
  <div class="pdp-wrap">
    ${crumbs([["Home", "/"], [DEPARTMENTS[p.department], deptLink],
      ...(p.department !== "accessories" ? [[CATEGORIES[p.category], `${deptLink}?category=${p.category}`]] : []), [p.title]])}
    <section class="pdp" data-id="${p.id}" data-aura-product='${productJSON(p)}'>
      <div class="gallery">
        <figure class="g-main">${badge ? `<span class="tag">${badge}</span>` : ""}<img data-photo src="${photo(p.id, first)}" alt="${esc(p.title)} in ${esc(first)}"></figure>
        ${altPhoto(p.id) ? `<figure class="g-alt"><img src="${altPhoto(p.id)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></figure>` : ""}
        <figure class="g-detail"><img data-photo src="${photo(p.id, first)}" alt="" loading="lazy"></figure>
      </div>
      <div class="buy">
        <div class="buy-inner">
          <h1>${esc(p.title)}</h1>
          <div class="buy-price"><span class="tabular">${money(cents(p))}</span>
            <a class="rating" href="#reviews">${stars(p.attrs.rating)}<span>${p.attrs.rating.toFixed(1)} · ${p.attrs.reviews.toLocaleString()} reviews</span></a></div>
          <p class="buy-blurb">${esc(blurb(p))}</p>
          ${colorPicker(p)}
          ${sizePicker(p, { guide: p.variants.length > 1 })}
          <button class="btn btn-primary add add-lg" type="button" data-aura-action="add_to_cart"
                  data-aura-label="Add ${esc(p.title)} to bag" data-id="${p.id}">Add to bag</button>
          ${p.price * 100 > 20000 ? `<p class="limit-note">This is over the $200 per-order limit set for Cue, so Cue will not add it for you.</p>` : ""}
          <ul class="assurances">
            <li>Free delivery by ${deliveryDate()}</li>
            <li>Free returns within 30 days</li>
            <li>Free repairs for as long as you own it</li>
          </ul>
          <div class="ask-cue">
            <p><span class="cue-dot" aria-hidden="true"></span>Hands busy? Hold space or say “Cue” and ask:</p>
            <ul>${askCue(p).map(q => `<li>“${esc(q)}”</li>`).join("")}</ul>
          </div>
          <div class="accordions">
            <details open><summary>Description</summary>
              <p>${esc(blurb(p))} ${esc(p.attrs.fit)}.</p>
              ${p.attrs.warmth ? `<p>Warmth: ${esc(p.attrs.warmth)}.</p>` : ""}</details>
            <details><summary>Materials and care</summary>
              <dl class="specs"><dt>Material</dt><dd>${esc(p.attrs.material)}</dd><dt>Care</dt><dd>${esc(p.attrs.care)}</dd>
              <dt>Origin</dt><dd>${esc(p.attrs.origin)}</dd></dl></details>
            <details><summary>Fit and sizing</summary>
              <dl class="specs"><dt>Fit</dt><dd>${esc(p.attrs.fit)}</dd><dt>Sizing</dt><dd>${esc(p.attrs.sizing)}</dd></dl>
              ${p.variants.length > 1 ? `<button class="link-btn" type="button" data-size-guide>Open the size guide</button>` : ""}</details>
            <details><summary>Shipping and returns</summary>
              <p>Free standard delivery on orders over $150, otherwise $8. Returns are free within 30 days, in store or by post. <a href="/help/returns">Returns policy</a></p></details>
          </div>
        </div>
      </div>
    </section>

    <section class="reviews" id="reviews">
      <div class="reviews-summary">
        <h2>Reviews</h2>
        <p class="big-rating"><span class="tabular">${p.attrs.rating.toFixed(1)}</span>${stars(p.attrs.rating)}</p>
        <p class="muted">Based on ${p.attrs.reviews.toLocaleString()} reviews</p>
        <ul class="spread">${spread.map(s => `
          <li><span>${s.stars} star</span><span class="bar"><i style="width:${(s.count / maxCount) * 100}%"></i></span><span class="tabular">${s.count}</span></li>`).join("")}</ul>
        ${p.variants.length > 1 ? `
        <div class="fitmeter"><p>How it fits</p>
          <div class="fit-track"><i style="left:${fit === "small" ? 18 : fit === "large" ? 82 : 50}%"></i></div>
          <div class="fit-labels"><span>Runs small</span><span>True to size</span><span>Runs large</span></div></div>` : ""}
      </div>
      <ol class="review-list">${reviews.map(r => `
        <li class="review">
          <div class="review-top">${stars(r.stars)}<span class="muted">${r.date}</span></div>
          <h3>${esc(r.title)}</h3>
          <p>${esc(r.body)}</p>
          <p class="review-by">${esc(r.name)}, ${esc(r.place)}${p.variants.length > 1 ? `. Bought size ${esc(r.size)}` : ""}. <span class="verified">Verified buyer</span></p>
        </li>`).join("")}</ol>
    </section>

    <section class="page-section">
      <div class="section-head"><h2>You may also like</h2><a class="more" href="/shop/${p.category}">More ${esc(CATEGORIES[p.category].toLowerCase())}</a></div>
      ${row(related(p))}
    </section>
    ${recent.length >= 2 ? `<section class="page-section"><div class="section-head"><h2>Recently viewed</h2></div>${row(recent)}</section>` : ""}
  </div>`;

  return { title: p.title, name: "product" };
}
