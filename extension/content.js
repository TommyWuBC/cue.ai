// Mark only products for which the live page exposes a title, price, and link
// or a Product JSON-LD record. Cue's existing gaze/voice pipeline does the rest.
(() => {
  if (globalThis.__cueExternalActive && !globalThis.__cueEnded) return;
  globalThis.__cueEnded = false;
  globalThis.__cueExternalActive = true;

  let timer;
  let tagged = new Set();
  const cleanup = () => {
    clearTimeout(timer);
    observer.disconnect();
    removeEventListener('scroll', schedule);
    for (const el of tagged) delete el.dataset.cueProduct;
    tagged.clear();
    globalThis.__cueExternalActive = false;
  };
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
  globalThis.__cueExternalCleanup = cleanup;
  // Content scripts share a page's Web Storage. Keep product memory in the
  // extension's session area so the store cannot read it from sessionStorage.
  const boot = async () => {
    let bag = {};
    try {
      const raw = (await chrome.runtime.sendMessage({ type: 'cue:memory:read' }))?.value ?? null;
      bag = raw ? JSON.parse(raw) : {};
      if (!bag || typeof bag !== 'object') bag = {};
    } catch { bag = {}; }
    const persist = () => {
      chrome.runtime.sendMessage({ type: 'cue:memory:write', value: JSON.stringify(bag) }).catch(() => {});
    };
    globalThis.CUE_MEMORY_STORAGE = {
      getItem: (key) => (key in bag ? bag[key] : null),
      setItem: (key, next) => { bag[key] = next; persist(); },
    };
    const aura = await import(chrome.runtime.getURL('client/aura.js'));
    if (globalThis.__cueExited) {
      globalThis.__cueExited = false;
      await aura.boot();
    }
    await import(chrome.runtime.getURL('client/avatar.js'));
  };
  boot().catch(error => {
    console.error('[cue] Could not load the shopping overlay:', error);
    cleanup();
    globalThis.__cueExternalActive = false;
  });
})();
