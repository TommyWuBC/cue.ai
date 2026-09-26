/* Page-local product evidence. No network fetches or hidden-page crawling. */
(function (root) {
  'use strict';
  const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 240) : '';
  const price = value => {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    const matches = [...value.replace(/,/g, '').matchAll(/(?:\$|USD\s*)?([0-9]+(?:\.[0-9]{1,2})?)/gi)];
    const amounts = [...new Set(matches.map(match => Number(match[1])))];
    return amounts.length === 1 ? amounts[0] : null;
  };
  const schemaNodes = value => {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(schemaNodes);
    return [value, ...schemaNodes(value['@graph'])];
  };
  const isProduct = node => {
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    return types.some(type => /(^|\/)Product$/i.test(type || ''));
  };
  const rectVisible = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const normalize = (node, el, highlight, pageUrl) => {
    const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
    const amount = price(offer.price ?? offer.lowPrice);
    const title = clean(node.name);
    if (!title) return null;
    const rawMaterial = node.material;
    const material = clean(Array.isArray(rawMaterial) ? rawMaterial.join(', ') : rawMaterial);
    return { el, highlight, product: {
      id: clean(node.sku || node.productID || node.mpn || node.url || pageUrl),
      title, price: amount, currency: clean(offer.priceCurrency || 'USD'),
      url: clean(node.url || pageUrl), attrs: material ? { material } : {},
    } };
  };

  function extract(doc, pageUrl) {
    const found = [];
    const seen = new Set();
    const structured = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      for (const node of schemaNodes(data)) {
        if (isProduct(node)) structured.push(node);
      }
    }
    // Search pages may contain JSON-LD for many products. Tagging their shared
    // <main> as each one would make gaze select an arbitrary product.
    const canonical = node => {
      try {
        const a = new URL(node.url, pageUrl), b = new URL(pageUrl);
        return a.origin === b.origin && a.pathname === b.pathname;
      } catch { return false; }
    };
    const exact = structured.filter(canonical);
    const likelyDetail = /(?:productpage\.|\/dp\/|\/product\/)/i.test(new URL(pageUrl).pathname);
    const pageProduct = exact[0] || (likelyDetail && structured.length === 1 ? structured[0] : null);
    if (pageProduct) {
      const anchor = doc.querySelector('main h1, h1');
      const el = anchor?.closest('article, main') || anchor;
      if (el && rectVisible(el)) {
        const item = normalize(pageProduct, el, anchor, pageUrl);
        if (item) { found.push(item); seen.add(item.product.id); }
      }
    }

    // Store search-result adapters use visible title, price, and product link.
    // Missing evidence is left missing; no material or size is inferred.
    const cards = doc.querySelectorAll(
      '[data-component-type="s-search-result"][data-asin], .product-item, [data-testid="product-card"]');
    for (const card of cards) {
      if (!rectVisible(card)) continue;
      const title = clean(card.querySelector('h2, h3, [class*="product-name"]')?.textContent);
      const amount = price(card.querySelector('.a-price .a-offscreen, [class*="price"]')?.textContent);
      const link = card.querySelector('h2 a[href], h3 a[href], a[href*="productpage"], a[href*="/dp/"]');
      if (!title || amount === null || !link?.href) continue;
      const id = clean(card.getAttribute('data-asin') || link.href);
      if (seen.has(id)) continue;
      found.push({ el: card, product: { id, title, price: amount, currency: 'USD',
        url: link.href, attrs: {} } });
      seen.add(id);
    }
    return found.slice(0, 40);
  }

  root.CueExtract = { extract, price };
  if (typeof module !== 'undefined') module.exports = root.CueExtract;
})(globalThis);
