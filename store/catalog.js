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
};

export const MERCH = {
  j1: { badge: "Bestseller", blurb: "Dropped shoulders, below-the-knee length." },
  j2: { badge: "Recycled", blurb: "Light quilting that packs into its own pocket." },
  j3: { badge: null, blurb: "Boxy and cropped, in rigid cotton denim." },
  j4: { badge: "New", blurb: "Extra-fine merino in a close, clean crew neck." },
  j5: { badge: null, blurb: "Water-repellent cotton with a relaxed drape." },
  j6: { badge: null, blurb: "A soft rib that holds its shape wash after wash." },
};

export function photo(id, color) {
  const have = PHOTOS[id] ?? [];
  const c = color && have.includes(slug(color)) ? slug(color) : have[0];
  return c ? `/assets/products/${id}-${c}.jpg` : null;
}

export const altPhoto = id => `/assets/products/${id}-alt.jpg`;

export const money = cents => "$" + (cents / 100).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
