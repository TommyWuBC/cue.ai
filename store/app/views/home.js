import { PRODUCTS, hasTag } from "../data.js";
import { row } from "../ui.js";

const pick = (tag, n, skip = []) => PRODUCTS.filter(p => hasTag(p, tag) && !skip.includes(p.id)).slice(0, n);

export default function home() {
  const fresh = pick("new", 4);
  const best = pick("bestseller", 4, fresh.map(p => p.id));
  document.getElementById("view").innerHTML = `
  <section class="home-hero">
    <img src="/assets/editorial/home-hero.jpg" alt="" fetchpriority="high">
    <div class="home-hero-copy">
      <p class="season">Autumn and winter 2026</p>
      <h1>Coats worth keeping</h1>
      <p>Wool, cashmere and waxed cotton, cut to layer and made to be repaired.</p>
      <div class="home-hero-ctas">
        <a class="btn btn-light" href="/shop/women">Shop women</a>
        <a class="btn btn-ghost-light" href="/shop/men">Shop men</a>
      </div>
    </div>
  </section>

  <section class="page-section">
    <div class="tiles">
      ${[["Women", "/shop/women", "home-women", "Coats, knits, dresses"],
         ["Men", "/shop/men", "home-men", "Overcoats and field jackets"],
         ["Knitwear", "/shop/knitwear", "home-knit", "Cashmere, merino, lambswool"],
         ["Accessories", "/shop/accessories", "home-accessories", "Scarves, bags, gloves"]]
        .map(([t, to, img, sub]) => `
        <a class="tile" href="${to}">
          <span class="tile-img"><img src="/assets/editorial/${img}.jpg" alt="" loading="lazy"></span>
          <span class="tile-label">${t}</span><span class="tile-sub">${sub}</span>
        </a>`).join("")}
    </div>
  </section>

  <section class="page-section">
    <div class="section-head"><h2>New this week</h2><a class="more" href="/shop/new">View all new in</a></div>
    ${row(fresh)}
  </section>

  <section class="page-section feature">
    <a class="feature-img" href="/journal/the-long-coat"><img src="/assets/editorial/journal-long-coat.jpg" alt="" loading="lazy"></a>
    <div class="feature-copy">
      <p class="kicker">From the journal</p>
      <h2>The long coat, four ways</h2>
      <p>Over tailoring on a Monday, over a hoodie on a Saturday. How one coat does the work of three, and what to look for in the cloth.</p>
      <a class="btn btn-secondary" href="/journal/the-long-coat">Read the story</a>
    </div>
  </section>

  <section class="page-section">
    <div class="section-head"><h2>Bestsellers</h2><a class="more" href="/shop/bestsellers">View all bestsellers</a></div>
    ${row(best)}
  </section>

  <section class="repairs-band">
    <img src="/assets/editorial/about-workshop.jpg" alt="" loading="lazy">
    <div class="repairs-copy">
      <h2>We repair what we make, for as long as you own it</h2>
      <p>Torn seams, worn cuffs, a zip that has given up. Bring it to a store or send it to us, free.</p>
      <a class="btn btn-light" href="/help/repairs">How repairs work</a>
    </div>
  </section>

  <section class="page-section">
    <div class="section-head"><h2>Journal</h2><a class="more" href="/journal">All stories</a></div>
    <div class="teasers">
      ${[["caring-for-knitwear", "journal-knit-care", "Caring for knitwear", "Washing, drying and storing wool so it lasts a decade."],
         ["dressing-for-rain", "journal-rain", "Dressing for rain", "What waterproof actually means, and when waxed cotton wins."],
         ["inside-the-mill", "journal-mill", "Inside the mill", "A morning with the people who spin our lambswool."]]
        .map(([slug, img, t, sub]) => `
        <a class="teaser" href="/journal/${slug}">
          <span class="teaser-img"><img src="/assets/editorial/${img}.jpg" alt="" loading="lazy"></span>
          <h3>${t}</h3><p>${sub}</p>
        </a>`).join("")}
    </div>
  </section>`;
  return { title: "Coats, knitwear and accessories", name: "home" };
}
