// Presentation-only data for products.json: photography and merchandising copy.
// Kept out of products.json so the server's catalog stays the single price source.

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");

// Colors with no photo of their own fall back to the product's first photo.
const PHOTOS = {
  j1: ["black", "slate", "camel"],
  j2: ["brown", "black"],
  j3: ["blue", "black"],
  j4: ["oat", "black"],
  j5: ["sand", "black"],
  j6: ["plum", "black"],
  o7: ["charcoal", "camel"],
  o8: ["brown"],
  o9: ["olive"],
  o10: ["navy", "yellow"],
  o11: ["black"],
  o12: ["navy"],
  k7: ["cream"],
  k8: ["camel", "black"],
  k9: ["navy", "grey"],
  k10: ["ecru"],
  k11: ["rose"],
  s1: ["white", "blue"],
  s2: ["red"],
  s3: ["ivory"],
  s4: ["white", "black"],
  s5: ["navy"],
  t1: ["indigo"],
  t2: ["grey"],
  t3: ["khaki"],
  t4: ["brown"],
  d1: ["black"],
  d2: ["sand"],
  a1: ["grey", "camel"],
  a2: ["black", "oat"],
  a3: ["cognac"],
  a4: ["black"],
  a5: ["olive"],
};

export function photo(id, color) {
  const have = PHOTOS[id] ?? [];
  const c = color && have.includes(slug(color)) ? slug(color) : have[0];
  return c ? `/assets/products/${id}-${c}.jpg` : "/assets/products/placeholder.svg";
}

const ALTS = new Set(["a1", "a2", "a3", "a4", "a5", "d1", "d2", "j1", "j2", "j3", "j4", "j5", "j6", "k10", "k11", "k7", "k8", "k9", "o10", "o11", "o12", "o7", "o8", "o9", "s1", "s2", "s3", "s4", "s5", "t1", "t2", "t3", "t4"]);
export const altPhoto = id => ALTS.has(id) ? `/assets/products/${id}-alt.jpg` : "";

export const money = cents => "$" + (cents / 100).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
