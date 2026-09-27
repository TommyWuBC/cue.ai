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
  // Laid out, but not necessarily on screen. Someone who cannot scroll freely
  // still needs Cue to know what is further down the page — reading only the
  // viewport is why "what is in my cart" answered with the first two rows.
  const laidOut = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
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
      if (el && laidOut(el)) {
        const item = normalize(pageProduct, el, anchor, pageUrl);
        if (item) { found.push(item); seen.add(item.product.id); }
      }
    }

    // Store search-result adapters use visible title, price, and product link.
    // Missing evidence is left missing; no material or size is inferred.
    const cards = doc.querySelectorAll(
      '[data-component-type="s-search-result"][data-asin], .product-item, [data-testid="product-card"]');
    for (const card of cards) {
      if (!laidOut(card)) continue;
      // Amazon now puts the brand in the first h2 and the actual product title
      // in a second h2. The title's enclosing anchor is the product link.
      const amazonTitle = card.matches?.('[data-component-type="s-search-result"][data-asin]')
        ? card.querySelector('h2[aria-label]') : null;
      const title = clean(amazonTitle?.getAttribute('aria-label') || amazonTitle?.textContent ||
        card.querySelector('h2, h3, [class*="product-name"]')?.textContent);
      // querySelector with a selector list returns the earliest DOM element;
      // Amazon's price wrapper also contains the crossed-out list price.
      const amount = price((card.querySelector('.a-price .a-offscreen') ||
        card.querySelector('[class*="price"]'))?.textContent);
      const link = amazonTitle?.closest('a[href]') ||
        card.querySelector('h2 a[href], h3 a[href], a[href*="productpage"], a[href*="/dp/"]');
      if (!title || amount === null || !link?.href) continue;
      const id = clean(card.getAttribute('data-asin') || link.href);
      if (seen.has(id)) continue;
      const productUrl = amazonTitle && /^[A-Z0-9]{10}$/.test(id)
        ? new URL(`/dp/${id}`, pageUrl).href : link.href;
      found.push({ el: card, product: { id, title, price: amount, currency: 'USD',
        url: productUrl, attrs: {} } });
      seen.add(id);
    }
    for (const card of genericCards(doc)) {
      if (seen.has(card.product.id)) continue;
      found.push(card);
      seen.add(card.product.id);
      if (found.length >= 60) break;
    }
    return found.slice(0, 60);
  }

  // Any shop: a visible card or a large linked image with a real title.
  // A missing or ambiguous price stays missing. The card is still numbered.
  function genericCards(doc) {
    const out = [];
    const seen = new Set();
    const nodes = doc.querySelectorAll(
      'article a[href], li a[href], [role="listitem"] a[href], a[href]');
    for (const link of nodes) {
      if (link.closest?.('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
      const card = link.closest?.('article, li, [role="listitem"]') || link;
      if (!laidOut(card)) continue;
      const box = card.getBoundingClientRect?.() || link.getBoundingClientRect?.();
      if (!box || box.width < 80 || box.height < 80) continue;
      const href = link.href || '';
      if (!/^https?:/i.test(href) || seen.has(href)) continue;
      const heading = card.querySelector?.('h1, h2, h3, h4');
      const title = clean(link.getAttribute?.('aria-label') || heading?.textContent ||
        link.querySelector?.('img[alt]')?.getAttribute?.('alt') || link.textContent);
      if (title.length < 6 || title.length > 140) continue;
      if (/^(search|sign in|log in|account|bag|cart|menu|home)$/i.test(title)) continue;
      const amount = price(card.textContent || '');
      seen.add(href);
      out.push({ el: card, product: {
        id: clean(href), title, price: amount, currency: 'USD', url: href, attrs: {},
      } });
      if (out.length >= 60) break;
    }
    return out;
  }

  root.CueExtract = { extract, price };
  if (typeof module !== 'undefined') module.exports = root.CueExtract;
})(globalThis);
