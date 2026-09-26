// Only products the shopper names or discusses enter comparison memory.
// Incidental gaze movement never replaces the last discussed product.
const KEY = 'cue.comparison.v1';
const TTL = 60 * 60 * 1000;
const short = (value, max = 180) => typeof value === 'string' ? value.slice(0, max) : null;

function snapshot(product) {
  if (!product || typeof product !== 'object' || !short(product.id, 300)) return null;
  const attrs = product.attrs ?? {};
  return {
    id: short(product.id, 300), title: short(product.title), url: short(product.url, 1000),
    price: Number.isFinite(product.price) && product.price >= 0 ? product.price : null,
    currency: short(product.currency, 8),
    attrs: Object.fromEntries(['material', 'sizing', 'care', 'warmth', 'origin', 'fit', 'rating', 'reviews']
      .map(key => [key, typeof attrs[key] === 'number' && Number.isFinite(attrs[key])
        ? attrs[key] : short(attrs[key])])),
  };
}

export function productMemory({ storage, now = Date.now } = {}) {
  let current = null, previous = null, updatedAt = 0;
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (saved && now() - saved.updatedAt < TTL && saved.updatedAt <= now()) {
      current = snapshot(saved.current); previous = snapshot(saved.previous); updatedAt = saved.updatedAt;
    }
  } catch { /* Private browsing or invalid stored data: keep memory in this page. */ }
  return {
    remember(product) {
      if (now() - updatedAt >= TTL) { current = null; previous = null; }
      const next = snapshot(product);
      if (next) {
        if (current?.id !== next.id) previous = current;
        current = next;
        updatedAt = now();
        try { storage?.setItem(KEY, JSON.stringify({ current, previous, updatedAt })); } catch {}
      }
      return previous ? structuredClone(previous) : null;
    },
  };
}
