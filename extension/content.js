// Mark only products for which the live page exposes a title, price, and link
// or a Product JSON-LD record. Cue's existing gaze/voice pipeline does the rest.
(() => {
  if (globalThis.__cueExternalActive) return;
  globalThis.__cueExternalActive = true;

  let timer;
  let tagged = new Set();
  function tagProducts() {
    const next = new Set();
    for (const entry of CueExtract.extract(document, location.href)) {
      const data = JSON.stringify(entry.product);
      if (entry.el.dataset.cueProduct !== data) entry.el.dataset.cueProduct = data;
      next.add(entry.el);
    }
    for (const el of tagged) if (!next.has(el)) delete el.dataset.cueProduct;
    tagged = next;
    // resolver.js caches the scan until scroll/count changes. A single-page app
    // may update a card in place, so invalidate after each adapter pass.
    import(chrome.runtime.getURL('client/resolver.js')).then(m => m.invalidate()).catch(() => {});
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tagProducts, 300);
  }
  tagProducts();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('scroll', schedule, { passive: true });
  import(chrome.runtime.getURL('client/aura.js')).catch(error => {
    console.error('[cue] Could not load the shopping overlay:', error);
    observer.disconnect();
    globalThis.__cueExternalActive = false;
  });
})();
