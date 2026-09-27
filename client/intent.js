// What the shopper said, apart from where they are looking.
// A named product beats gaze. Size and color count only when spoken.

const FILLER = new Set(["the", "and", "with", "from", "this", "that", "please", "want", "item", "size", "color", "colour"]);

const NOT_A_NAME = new Set(["reviews", "review", "rated", "stars", "sponsored", "ratings", "section", "shop", "more", "about", "best", "price"]);

const SIZES = [
  ["extra small", "XS"], ["extra large", "XL"], ["xxl", "XXL"], ["xs", "XS"], ["xl", "XL"],
  ["small", "S"], ["medium", "M"], ["large", "L"], ["s", "S"], ["m", "M"], ["l", "L"],
];

function words(title) {
  return String(title || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !FILLER.has(w));
}

function norm(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Every top-scoring product. A tie means the words were not specific enough. */
export function matchCandidates(text, products) {
  const t = norm(text);
  if (!t) return [];
  const list = (products || []).map((product) => ({
    product,
    words: new Set(words(product.title || product.product?.title || product.label)),
  }));
  // A word most of the page shares ("headphones" on a headphones search) names
  // the category, not an item; it must not decide which product was meant.
  const common = new Set();
  if (list.length > 2) {
    const seen = new Map();
    for (const { words: ws } of list) for (const w of ws) seen.set(w, (seen.get(w) || 0) + 1);
    for (const [w, n] of seen) if (n / list.length > 0.4) common.add(w);
  }
  const scored = [];
  for (const { product, words: ws } of list) {
    const hits = [...ws].filter((w) => !common.has(w) && !NOT_A_NAME.has(w) && new RegExp(`\\b${w}\\b`).test(t));
    if (hits.length) scored.push({ product, hits: hits.length });
  }
  if (!scored.length) return [];
  const best = Math.max(...scored.map((s) => s.hits));
  const top = scored.filter((s) => s.hits === best).map((s) => s.product);
  return top.length > 3 ? [] : top;
}

/** The visible product named in the utterance, or null when the words tie. */
export function matchProduct(text, products) {
  const hits = matchCandidates(text, products);
  return hits.length === 1 ? hits[0] : null;
}

export function matchOptions(text, product) {
  const t = norm(text);
  let size = null;
  for (const [word, value] of SIZES) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      const offered = product?.variants;
      size = !offered || offered.includes(value) || offered.includes("One size") ? value : null;
      if (size) break;
    }
  }
  const colors = (product?.colors || []).map((c) => (typeof c === "string" ? c : c.name)).filter(Boolean);
  const color = [...colors].sort((a, b) => b.length - a.length).find((name) => t.includes(name.toLowerCase())) || null;
  return { size, color };
}

export function missingChoices(product, stated) {
  const variants = product?.variants || [];
  const colors = product?.colors || [];
  const oneSize = variants.length <= 1;
  return {
    size: !oneSize && !stated?.size,
    color: colors.length > 1 && !stated?.color,
  };
}

export function optionPrompt(title, missing, product) {
  const need = missing.size && missing.color ? "size and color" : missing.size ? "size" : "color";
  const sizes = (product?.variants || []).filter((v) => v !== "One size");
  const colors = (product?.colors || []).map((c) => (typeof c === "string" ? c : c.name)).filter(Boolean);
  const bits = [`Which ${need} for the ${title}?`];
  if (missing.size && sizes.length) bits.push(`Sizes are ${sizes.join(", ")}.`);
  if (missing.color && colors.length) bits.push(`Colors are ${colors.join(", ")}.`);
  return bits.join(" ");
}
