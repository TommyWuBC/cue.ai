// Journal: long-form stories, each ending in the products it mentions.
import { crumbs, row } from "../ui.js";
import { byId } from "../data.js";
import { esc } from "../util.js";

const view = () => document.getElementById("view");

export const ARTICLES = [
  {
    slug: "the-long-coat", image: "journal-long-coat",
    title: "The long coat",
    dek: "Four ways to wear the one piece that does the most work in a cold month.",
    author: "Ines Marlowe", date: "September 18, 2026", products: ["j1", "o7", "j5", "a1"],
    body: [
      "Most of what you wear in winter is seen for a few seconds at a time: a collar between a scarf and a chin, a cuff at the end of a sleeve. The coat is different. It is the first and last thing people see, and on the coldest days it is the only thing they see. That is the argument for buying one good long coat before anything else this season.",
      "## Over tailoring",
      "The obvious way first. A coat that falls below the knee covers the jacket underneath entirely, so the shoulders have to be generous enough to sit over it without pulling. Our oversized wool-blend coat is cut with a dropped shoulder for exactly this reason. Button it, turn the collar up, and the whole outfit reads as one long line.",
      "## Over knitwear",
      "This is how we wear it most. A heavy rollneck or a cable crew under an open coat looks deliberate without trying, and the knit does the insulating so the coat can stay unbuttoned indoors-to-outdoors. Keep the colours close: camel over ecru, charcoal over navy. Contrast here tends to look like two separate decisions.",
      "## Over a dress",
      "A long coat over a midi dress is the least fussy formal outfit there is. The trick is length. The coat should finish below the hem of the dress, not at the same point, or the eye reads a hard horizontal line across the calf. If the dress is longer than the coat, wear it with a shorter jacket instead.",
      "## Belted, with nothing under it",
      "On milder days, a trench or a light wool coat can be worn closed and belted as the outfit itself, with a tee and trousers underneath. Tie the belt rather than buckling it, and let the back hang loose. It keeps the shape soft.",
      "## What to look for",
      "Wool content above sixty percent, so it keeps you warm when wet. A lining that runs the full length, so it slides over knitwear. Pockets set low enough to put your hands in without raising your shoulders. And a length that ends a hand's width below the knee, which is long enough to feel protected and short enough to climb stairs without holding it up.",
    ],
  },
  {
    slug: "caring-for-knitwear", image: "journal-knit-care",
    title: "Knitwear, explained",
    dek: "Merino, lambswool, cashmere and mohair behave differently. Here is how to look after each.",
    author: "Tom Achebe", date: "September 11, 2026", products: ["k8", "k7", "j4", "k9"],
    body: [
      "Nearly every knitwear complaint we hear, from pilling to stretched cuffs to a sweater that shrank two sizes, comes down to washing too often and drying the wrong way. Good wool needs far less care than people think. It needs the right care.",
      "## Wash less",
      "Wool is naturally odour resistant. After a day's wear, hang a sweater over a chair back overnight and most of what you would wash out is gone by morning. We wash our own knits three or four times a season.",
      "## When you do wash it",
      "Use cold water, a wool detergent, and your hands. Press the water through the knit instead of rubbing it, because friction is what felts the fibres. Rinse at the same temperature you washed at. A sudden change in temperature shocks the wool and it tightens.",
      "## Dry it flat",
      "Roll the sweater in a dry towel and press to lift out most of the water, then lay it flat on another towel and ease it back to shape with your palms. Never hang a wet knit. The weight of the water will stretch the shoulders and the body, and that does not come back.",
      "## Pilling is normal",
      "Soft fibres such as cashmere and merino pill in the first few weeks where they rub: under the arms, at the sides. It is loose fibre working its way out, and it slows down. Remove pills with a wool comb, not a razor, and do it on a flat surface.",
      "## Storing it",
      "Fold, never hang. Store clean, because moths go for the oils left in worn wool, not the wool itself. A cedar block in the drawer helps. Over summer, put knits in a cotton bag rather than plastic so they can breathe.",
      "## A note on mohair",
      "Mohair is the exception to most of this. Its long fibres shed a little for the life of the garment. A gentle shake before wearing and a cool, dry place to live are about all it needs. It should not be washed more than once or twice a year.",
    ],
  },
  {
    slug: "dressing-for-rain", image: "journal-rain",
    title: "Dressing for rain",
    dek: "Waterproof, water-repellent and waxed are not the same thing. Choose by the weather you actually get.",
    author: "Ines Marlowe", date: "September 4, 2026", products: ["o10", "o9", "j5", "a2"],
    body: [
      "Rainwear is sold on numbers most people never check, and bought on how it looks in a shop that is dry. Before buying anything, think about the rain where you live. A persistent drizzle, a ten-minute downpour and a full day on the hills are three different problems.",
      "## Water-repellent",
      "A coating that makes water bead and roll off, like the finish on our relaxed trench. It handles a walk to the station in light rain comfortably and breathes well, which matters more than people expect. It will soak through in a proper downpour, and the coating wears down over a couple of years. A wash-in reproofer brings it back.",
      "## Waterproof",
      "A membrane or coated fabric with taped seams, like the hooded rain parka. Look at the rating: ten thousand millimetres keeps out a day of heavy rain. The seams matter as much as the fabric, because water comes in through stitch holes long before it comes through cloth. A hood with a stiffened peak is worth more than any other feature.",
      "## Waxed cotton",
      "The oldest answer, and still a good one. Cotton impregnated with wax sheds water, cuts wind and softens with use. It is heavier than a synthetic shell and it needs re-waxing roughly once a year, but it repairs easily and it looks better at ten years old than it does new.",
      "## Layer underneath",
      "A shell does not keep you warm. On a cold wet day, wear a knit or a liner vest under it, and leave the zip open a few inches so condensation can escape. Wool is the best layer here because it keeps you warm even when it is damp.",
      "## Small things",
      "A beanie under a hood stops the hood from turning with your head. Dark colours hide splashes, bright colours make you visible to drivers at dusk. And whatever you buy, hang it to dry at room temperature, never on a radiator.",
    ],
  },
  {
    slug: "inside-the-mill", image: "journal-mill",
    title: "Inside the mill",
    dek: "A day at the Scottish mill that spins the wool for our lambswool knits and scarves.",
    author: "Tom Achebe", date: "August 27, 2026", products: ["k10", "a1", "k9", "o7"],
    body: [
      "The mill sits at the bottom of a valley in the Scottish Borders, on a river that used to turn its wheels. It has spun yarn on the same site since 1874. The wheels are gone, but the river still matters: soft water is why wool from this part of the world washes so well.",
      "## From fleece to yarn",
      "Raw fleece arrives in bales and is washed to remove lanolin and grit, then dyed as loose fibre before it is ever spun. Dyeing the fibre, rather than the finished yarn, is slower and more expensive. It is also why the colour runs all the way through each strand and does not fade at the surface.",
      "Different colours of dyed fibre are then blended by weight, like a recipe. Our grey lambswool is five shades mixed together, which is why it looks warmer and deeper up close than a flat grey.",
      "## Spinning",
      "Carding machines comb the blended fibre into a thin web and split it into strands. Those strands are drawn out and twisted on the spinning frames, then two strands are twisted together into the finished two-ply yarn. The amount of twist decides how the finished knit feels. Less twist is softer and pills more. More twist is harder wearing.",
      "## The people",
      "Around sixty people work here. Several have been at the mill for more than thirty years, and the dyer who blends our colours learned from her father. Every batch is checked by eye against a card of approved shades under daylight lamps before it leaves. Nothing about that step can be automated well.",
      "## Why it costs more",
      "A lambswool sweater made from this yarn costs us about three times what a mass-market one does. We think it is worth it for one simple reason: we have customers still wearing the first knits we sold, and we would rather make fewer things that last than more things that do not.",
    ],
  },
];

const minutes = a => Math.max(2, Math.round(a.body.join(" ").split(/\s+/).length / 220));
const img = a => `/assets/editorial/${a.image}.jpg`;
const meta = a => `<p class="j-meta">By ${esc(a.author)}<span aria-hidden="true">, </span>${esc(a.date)}<span aria-hidden="true">, </span>${minutes(a)} min read</p>`;

export function index() {
  const [lead, ...rest] = ARTICLES;
  view().innerHTML = `
    <div class="pg j-index">
      ${crumbs([["Home", "/"], ["Journal"]])}
      <h1 class="pg-title">Journal</h1>
      <p class="pg-lede">Notes on what we make, how it is made, and how to wear it for longer.</p>
      <a class="j-lead" href="/journal/${lead.slug}">
        <div class="j-lead-media"><img src="${img(lead)}" alt=""></div>
        <div class="j-lead-copy">
          <h2>${esc(lead.title)}</h2>
          <p>${esc(lead.dek)}</p>
          ${meta(lead)}
          <span class="j-read">Read the story</span>
        </div>
      </a>
      <div class="j-grid">${rest.map(a => `
        <a class="j-card" href="/journal/${a.slug}">
          <div class="j-card-media"><img src="${img(a)}" alt="" loading="lazy"></div>
          <h3>${esc(a.title)}</h3>
          <p>${esc(a.dek)}</p>
          ${meta(a)}
        </a>`).join("")}</div>
    </div>`;
  return { title: "Journal", name: "journal" };
}

export function article({ params }) {
  const a = ARTICLES.find(x => x.slug === params.slug);
  if (!a) return import("./notfound.js").then(m => m.default());
  const products = a.products.map(byId).filter(Boolean);
  const others = ARTICLES.filter(x => x !== a).slice(0, 3);
  const body = a.body.map(p => p.startsWith("## ")
    ? `<h2>${esc(p.slice(3))}</h2>` : `<p>${esc(p)}</p>`).join("");
  view().innerHTML = `
    <article class="j-article">
      <header class="j-head">
        ${crumbs([["Home", "/"], ["Journal", "/journal"], [a.title]])}
        <h1>${esc(a.title)}</h1>
        <p class="j-dek">${esc(a.dek)}</p>
        ${meta(a)}
      </header>
      <figure class="j-hero"><img src="${img(a)}" alt=""></figure>
      <div class="j-body">${body}</div>
    </article>
    <section class="pg j-shop">
      <div class="pg-head"><h2>Shop the story</h2></div>
      ${row(products)}
    </section>
    <section class="pg j-more">
      <div class="pg-head"><h2>More from the journal</h2><a href="/journal">All stories</a></div>
      <div class="j-grid">${others.map(o => `
        <a class="j-card" href="/journal/${o.slug}">
          <div class="j-card-media"><img src="${img(o)}" alt="" loading="lazy"></div>
          <h3>${esc(o.title)}</h3><p>${esc(o.dek)}</p>
        </a>`).join("")}</div>
    </section>`;
  return { title: a.title, name: "article" };
}
