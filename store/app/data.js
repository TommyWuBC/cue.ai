// Catalog access plus the store's presentation copy. Prices, sizes and colors
// come only from products.json, which the server also uses to reprice orders.
import { photo, altPhoto, money } from "/catalog.js";
export { photo, altPhoto, money };

export const PRODUCTS = await fetch("/products.json").then(r => r.json());
export const byId = id => PRODUCTS.find(p => p.id === id);
export const cents = p => Math.round(p.price * 100);

export const MERCH = {
  j1: { blurb: "Dropped shoulders, below-the-knee length.", tags: ["bestseller"] },
  j2: { blurb: "Light quilting that packs into its own pocket.", tags: ["recycled"] },
  j3: { blurb: "Boxy and cropped, in rigid cotton denim." },
  j4: { blurb: "Extra-fine merino in a close, clean crew neck.", tags: ["new"] },
  j5: { blurb: "Water-repellent cotton with a relaxed drape.", tags: ["bestseller"] },
  j6: { blurb: "A soft rib that holds its shape wash after wash." },
  o7: { blurb: "Wool and cashmere, faced on both sides so it needs no lining." },
  o8: { blurb: "Sheepskin through and through. Built for real cold.", tags: ["new"] },
  o9: { blurb: "Waxed cotton that sheds rain and gets better with age." },
  o10: { blurb: "Fully taped seams and a hood that stays up in wind.", tags: ["new", "recycled"] },
  o11: { blurb: "Soft lambskin that breaks in within a week." },
  o12: { blurb: "A thin quilted layer for under a coat or over a knit." },
  k7: { blurb: "Deep cables in a wool blend that won't itch.", tags: ["bestseller"] },
  k8: { blurb: "Grade-A cashmere, knitted two-ply for weight.", tags: ["new", "bestseller"] },
  k9: { blurb: "Scottish lambswool, fully fashioned at the shoulder." },
  k10: { blurb: "Oiled British wool, the way fishermen wore it." },
  k11: { blurb: "Brushed mohair with a cropped, boxy shape.", tags: ["new"] },
  s1: { blurb: "Heavy oxford cloth with a soft roll to the collar." },
  s2: { blurb: "Brushed on both sides. Wear it as a shirt or a layer." },
  s3: { blurb: "Silk and cotton, so it drapes but stays breathable.", tags: ["new"] },
  s4: { blurb: "240gsm organic cotton that keeps its shape.", tags: ["bestseller"] },
  s5: { blurb: "The classic boat-neck stripe, knitted in France." },
  t1: { blurb: "Japanese selvedge that fades to your own shape.", tags: ["bestseller"] },
  t2: { blurb: "A fluid wide leg in Italian wool twill." },
  t3: { blurb: "Double pleats and a gently tapered leg." },
  t4: { blurb: "Soft 8-wale cord with a high, fitted waist." },
  d1: { blurb: "A close rib that skims rather than clings.", tags: ["new"] },
  d2: { blurb: "European linen with a tie belt and deep pockets." },
  a1: { blurb: "Woven in the Scottish Borders and brushed by hand." },
  a2: { blurb: "Merino rib with a deep fold-up cuff.", tags: ["bestseller"] },
  a3: { blurb: "Vegetable-tanned leather that darkens with use.", tags: ["new"] },
  a4: { blurb: "Lambskin lined in cashmere." },
  a5: { blurb: "Forty litres of waxed canvas for a long weekend." },
};
export const blurb = p => MERCH[p.id]?.blurb ?? p.attrs.material;
export const hasTag = (p, t) => (MERCH[p.id]?.tags ?? []).includes(t);
export const badgeFor = p => hasTag(p, "new") ? "New" : hasTag(p, "bestseller") ? "Bestseller"
  : hasTag(p, "recycled") ? "Recycled" : null;

export const CATEGORIES = {
  outerwear: "Coats & jackets", knitwear: "Knitwear", shirts: "Shirts & tops",
  trousers: "Trousers & denim", dresses: "Dresses", accessories: "Accessories",
};
export const DEPARTMENTS = { women: "Women", men: "Men", accessories: "Accessories" };

// A collection is what a /shop/<slug> URL shows before the shopper filters it.
export const COLLECTIONS = {
  all: { title: "All clothing", banner: "banner-new", test: () => true },
  new: { title: "New in", banner: "banner-new", test: p => hasTag(p, "new"),
    lede: "What arrived this week, from shearling to silk." },
  bestsellers: { title: "Bestsellers", banner: "banner-new", test: p => hasTag(p, "bestseller"),
    lede: "The pieces people come back for." },
  women: { title: "Women", banner: "banner-women", test: p => p.department === "women",
    lede: "Coats, knitwear and the things you wear under them." },
  men: { title: "Men", banner: "banner-men", test: p => p.department === "men",
    lede: "Overcoats, field jackets and knitwear made to last." },
  ...Object.fromEntries(Object.entries(CATEGORIES).map(([k, title]) => [k, {
    title, banner: k === "knitwear" ? "banner-knitwear" : k === "accessories" ? "banner-accessories" : "banner-new",
    test: p => p.category === k,
  }])),
};

export const COLOR_FAMILIES = [...new Map(PRODUCTS.flatMap(p => p.colors).map(c => [c.name, c])).values()];
export const PRICE_BANDS = [
  { id: "under-50", label: "Under $50", test: p => p.price < 50 },
  { id: "50-100", label: "$50 to $100", test: p => p.price >= 50 && p.price < 100 },
  { id: "100-150", label: "$100 to $150", test: p => p.price >= 100 && p.price < 150 },
  { id: "150-plus", label: "$150 and over", test: p => p.price >= 150 },
];

export function related(p, n = 4) {
  const score = q => (q.category === p.category ? 2 : 0) + (q.department === p.department ? 1 : 0);
  return PRODUCTS.filter(q => q.id !== p.id).sort((a, b) => score(b) - score(a) || a.price - b.price).slice(0, n);
}

export function searchProducts(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return PRODUCTS.map(p => {
    const hay = [p.title, p.attrs.material, CATEGORIES[p.category], DEPARTMENTS[p.department],
      ...p.colors.map(c => c.name), blurb(p)].join(" ").toLowerCase();
    const hits = words.filter(w => hay.includes(w) || hay.includes(w.replace(/s$/, ""))).length;
    const titleHit = words.some(w => p.title.toLowerCase().includes(w.replace(/s$/, ""))) ? 1 : 0;
    return { p, s: hits === words.length ? hits * 2 + titleHit : 0 };
  }).filter(x => x.s).sort((a, b) => b.s - a.s).map(x => x.p);
}

// ── Reviews: a few written reviews per product, stable across visits ────────
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const NAMES = ["Maya R.", "Daniel K.", "Priya S.", "Tom W.", "Aiko T.", "Jonas B.", "Leah M.", "Chris O.",
  "Sofia G.", "Marcus L.", "Hannah P.", "Ravi D.", "Elena V.", "Sam C.", "Nora F.", "Ben A."];
const PLACES = ["Atlanta, GA", "Portland, OR", "Chicago, IL", "Brooklyn, NY", "Denver, CO", "Austin, TX",
  "Seattle, WA", "Boston, MA", "Minneapolis, MN", "Toronto, ON"];
const POOL = {
  outerwear: [
    ["Worth every cent", "Wore it every day through a Chicago January. Warm enough with just a sweater underneath, and it still looks new."],
    ["Beautiful cut", "The shoulders sit exactly right and the length is perfect over trousers or a dress. I get asked about it constantly."],
    ["Heavier than I expected", "In a good way. It feels substantial. Pockets are deep enough for a phone and gloves."],
    ["Great, with one note", "Love the colour and fabric. The sleeves are a touch long on me, but a tailor sorted that for fifteen dollars."],
    ["Finally a coat that lasts", "My last one pilled after a season. This one hasn't, and I've had it since October."],
  ],
  knitwear: [
    ["So soft", "Not itchy at all, even worn straight against the skin. Washed it by hand twice and it came out the same shape."],
    ["My new favourite", "Bought one, came back for a second colour a week later. The weight is right for layering under a coat."],
    ["Lovely knit", "The texture is even better in person. Slight shedding the first few wears, then none."],
    ["Warm without bulk", "I run cold and this keeps me warm in a drafty office without looking puffy."],
    ["Good quality", "Seams are neat and the cuffs hold their shape. Feels like it will last years."],
  ],
  shirts: [
    ["Wardrobe staple", "Wears well on its own or under a knit. The fabric softens nicely after a couple of washes."],
    ["Excellent fabric", "Thicker than most at this price and it doesn't go see-through. Buttons feel properly sewn on."],
    ["Bought three", "Tried one, bought two more. Holds up in the wash and doesn't need ironing if you hang it straight away."],
    ["Nice, simple", "Exactly what I wanted, no logos, good collar. Slightly long in the body which I like for tucking."],
  ],
  trousers: [
    ["Great fit", "The rise is right and they sit well at the waist without a belt. Hem needed a small adjustment for me."],
    ["Comfortable all day", "Wore them for a long travel day and they didn't bag out at the knees."],
    ["Well made", "Pockets are deep, stitching is clean, fabric has a nice weight to it."],
    ["Love these", "Dress up or down. I've worn them to the office and on weekends."],
  ],
  dresses: [
    ["Easy to wear", "Throw it on and you're done. Works with boots now and sandals in spring."],
    ["Flattering", "Skims without clinging. The length hits right at mid-calf on me at 5'6\"."],
    ["Beautiful fabric", "Feels more expensive than it is. Pockets are a bonus."],
  ],
  accessories: [
    ["Lovely quality", "Feels considered in every detail. Arrived nicely packed, no plastic."],
    ["Exactly as pictured", "Colour is true to the photos. It's become the thing I grab every morning."],
    ["Perfect gift", "Bought as a present and ended up ordering one for myself."],
    ["Solid", "Well made and it has already survived a winter of daily use."],
  ],
};
const FIT = {
  small: ["Size up", "Runs a little small. I usually take a medium and a large fit me better."],
  large: ["Size down", "It's generous. I sized down one and it's perfect."],
  true: ["True to size", "Took my usual size and it fits exactly as I hoped."],
};
export function fitOf(p) {
  const s = p.attrs.sizing.toLowerCase();
  return s.includes("small") ? "small" : s.includes("large") ? "large" : "true";
}
export function reviewsFor(p) {
  const pool = POOL[p.category] ?? POOL.outerwear;
  const h = hash(p.id);
  const picks = [0, 1, 2].map(i => pool[(h + i * 2) % pool.length]);
  if (p.variants.length > 1) picks[2] = FIT[fitOf(p)];
  const month = ["August", "September", "July", "June"];
  return picks.map(([title, body], i) => ({
    title, body,
    name: NAMES[(h + i * 5) % NAMES.length], place: PLACES[(h + i * 3) % PLACES.length],
    stars: Math.max(3, Math.min(5, Math.round(p.attrs.rating + (i === 2 ? -0.6 : 0.3 - i * 0.2)))),
    date: `${month[(h + i) % 4]} ${1 + (h + i * 7) % 27}, 2026`,
    size: p.variants[Math.min(p.variants.length - 1, 1 + ((h + i) % 2))],
  }));
}
export function ratingSpread(p) {
  const r = p.attrs.rating, n = p.attrs.reviews;
  const w = [5, 4, 3, 2, 1].map(s => Math.exp(-Math.abs(s - r) * 1.7));
  const sum = w.reduce((a, b) => a + b, 0);
  return [5, 4, 3, 2, 1].map((s, i) => ({ stars: s, count: Math.round(n * w[i] / sum) }));
}
