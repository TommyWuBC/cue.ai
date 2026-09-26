// What the shopper said, apart from where they are looking.
// A named product beats gaze. Size and color count only when spoken.

const FILLER = new Set(["the", "and", "with", "from", "this", "that", "please", "want", "item", "size", "color", "colour"]);

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
  const scored = [];
  for (const product of products || []) {
    const title = product.title || product.product?.title || product.label;
    const hits = words(title).filter((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (hits.length) scored.push({ product, hits: hits.length });
  }
  if (!scored.length) return [];
  const best = Math.max(...scored.map((s) => s.hits));
  return scored.filter((s) => s.hits === best).map((s) => s.product);
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
