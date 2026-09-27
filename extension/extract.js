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

    // A detail page may carry no structured data at all: Amazon ships none.
    // The product you are standing on is not a link, so genericCards cannot
    // see it by construction, and Cue ends up listing the recommendation
    // carousel while the item in front of you is missing. Measured on
    // /dp/B07KWV1N5V: 12 products found, none of them this one.
    if (!found.length && likelyDetail) {
      const item = detailProduct(doc, pageUrl);
      if (item) { found.push(item); seen.add(item.product.id); }
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
      // Amazon prefixes paid placements with "Sponsored Ad - " inside the
      // title itself. Read aloud it is noise, and it is the first thing a
      // shopper who cannot see the screen would hear about the item.
      const title = clean(amazonTitle?.getAttribute('aria-label') || amazonTitle?.textContent ||
        card.querySelector('h2, h3, [class*="product-name"]')?.textContent)
        .replace(/^sponsored\s+ad\s*-\s*/i, '');
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

  // A link is only a product when the page gives a reason to think so: a
  // product-shaped URL, or a price on the card. Without this, reading the whole
  // page instead of the viewport turned "+1 other color/pattern" and
  // "29,222 ratings" into products, and Cue then discussed them.
  const PRODUCT_URL = /\/(?:dp|gp\/product|products?|items?|itm|ip|p)\//i;
  const NOT_PRODUCT = new RegExp([
    '^[+]?\\d[\\d,.]*\\s*(?:ratings?|reviews?|answered questions?|bought|stars?)',
    '^[+]?\\d+\\s+other\\b', '^(?:see|shop|view|learn|compare|explore|discover)\\b',
    '\\bout of \\d\\b', '^(?:sponsored|prime|best ?seller|amazon.s choice|overall pick)\\b',
    '^(?:add to|buy |subscribe|sign in|log in|next page|previous page|back to)',
    '^(?:customer reviews?|more buying choices|other sellers|visit the)\\b',
    '^(?:free |save |get it|deal of|limited time|coupon|up to \\d)',
  ].join('|'), 'i');

  // The buy box price, in preference order. `.a-price .a-offscreen` alone is
  // not usable on an Amazon detail page: the first match is whitespace, and
  // the next non-empty ones belong to other widgets. On /dp/B07KWV1N5V they
  // read $59.99 and $13.25 against a real price of $52.99, so a bare
  // `.a-price` selector does not just fail, it reads the wrong price aloud.
  // Ordered, and deliberately NOT joined into one selector list: querySelector
  // with commas returns the earliest element in DOM order, not the first
  // selector's match. Joined, the title resolves to an accessibility helper
  // heading and the price to a neighbouring widget, which on /dp/B07KWV1N5V
  // reads $59.99 against a real price of $52.99.
  const DETAIL_TITLE = ['#productTitle', '#title', 'main h1', 'h1'];
  const DETAIL_PRICE = [
    '#corePrice_feature_div .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-offscreen',
    '#corePriceDisplay_mobile_feature_div .a-offscreen',
    '.priceToPay .a-offscreen',
    '#price_inside_buybox',
    '#priceblock_ourprice',
    '[itemprop=price]',
  ];

  // First selector, in order, that yields something usable.
  function firstBy(doc, selectors, read) {
    for (const selector of selectors) {
      for (const el of doc.querySelectorAll(selector)) {
        const value = read(el);
        if (value !== null && value !== '') return value;
      }
    }
    return null;
  }

  const BUY_HINT = /^(?:add to (?:cart|bag|basket)|add item to cart)$/i;

  function buyControl(doc) {
    for (const el of doc.querySelectorAll(
      'input[type=submit],input[type=button],button,[role=button]')) {
      const n = (el.getAttribute?.('aria-label') || el.value || el.textContent || '').trim();
      if (BUY_HINT.test(n) && laidOut(el)) return el;
    }
    return null;
  }

  // The region tagged for a detail page has to enclose the buy control as well
  // as the title, or nothing can act on it. On Amazon the title sits in a 22%
  // wide column and the add button is in a different one, so anchoring on the
  // title's column scopes an add that can never find its own button — every
  // add answered "Which one do you mean?". Grow from the heading until both
  // are inside, stopping short of the whole document.
  function productRegion(doc, heading) {
    const fallback = heading.closest('article, main') || heading;
    const buy = buyControl(doc);
    if (!buy) return fallback;
    let region = heading;
    while (region && region !== doc.body && !region.contains(buy)) region = region.parentElement;
    return region && region !== doc.body && region !== doc.documentElement ? region : fallback;
  }

  // The product a detail page is about, when nothing structured describes it.
  function detailProduct(doc, pageUrl) {
    const heading = firstBy(doc, DETAIL_TITLE, el => (laidOut(el) ? el : null));
    const title = clean(heading?.textContent);
    if (!title) return null;
    const amount = firstBy(doc, DETAIL_PRICE,
      el => price(el.getAttribute?.('content') || el.textContent));
    const el = productRegion(doc, heading);
    if (!el || !laidOut(el)) return null;
    let id = '';
    try {
      id = new URL(pageUrl).pathname
        .match(/\/(?:dp|gp\/product|product|item)\/([A-Za-z0-9]{6,})/i)?.[1] || '';
    } catch {}
    return { el, highlight: heading, product: {
      id: clean(id || pageUrl), title, price: amount, currency: 'USD',
      url: clean(pageUrl), attrs: {},
    } };
  }

  // Any shop: a card or a large linked image with a real title.
  // A missing or ambiguous price stays missing.
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
      if (NOT_PRODUCT.test(title) || !/[a-z]{3}/i.test(title)) continue;
      const amount = price(card.textContent || '');
      // Evidence, not just a link in a box.
      if (amount === null && !PRODUCT_URL.test(href)) continue;
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
