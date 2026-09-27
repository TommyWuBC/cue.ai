// What the shopper already said, kept for this tab across page loads.
// Product memory stays separate. This is only the current choice.
const KEY = "cue.shopper.v1";

export function shopperStore(storage) {
  let data = {};
  try { data = JSON.parse(storage?.getItem(KEY) || "null") || {}; } catch { data = {}; }
  return {
    load() {
      const item = data.discussed;
      return {
        discussed: item?.id && item?.title ? { id: item.id, title: item.title, price: item.price ?? null, url: item.url ?? null } : null,
        size: data.size || null,
        color: data.color || null,
      };
    },
    save({ discussed, size, color } = {}) {
      data = {
        discussed: discussed?.id && discussed?.title
          ? { id: String(discussed.id).slice(0, 300), title: String(discussed.title).slice(0, 180), price: discussed.price ?? null,
              url: discussed.url ? String(discussed.url).slice(0, 600) : null }
          : null,
        size: size || null,
        color: color || null,
      };
      try { storage?.setItem(KEY, JSON.stringify(data)); } catch { /* Private mode or a full quota: keep it in memory. */ }
    },
  };
}
