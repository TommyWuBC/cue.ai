// /shop/<collection>?category=&size=&color=&price=&sort= — filters live in the
// URL so back, forward and shared links all land on the same filtered grid.
import { PRODUCTS, COLLECTIONS, CATEGORIES, PRICE_BANDS } from "../data.js";
import { card, crumbs, esc } from "../ui.js";
import { setQuery } from "../router.js";
import notfound from "./notfound.js";

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "One size"];
const SORTS = { featured: "Featured", new: "Newest", "price-asc": "Price, low to high",
  "price-desc": "Price, high to low", rating: "Top rated" };
const list = v => (v ? v.split(",").filter(Boolean) : []);

export default function listing({ params, query }) {
  const col = COLLECTIONS[params.collection];
  if (!col) return notfound();
  const base = PRODUCTS.filter(col.test);
  const state = {
    category: list(query.get("category")), size: list(query.get("size")),
    color: list(query.get("color")), price: list(query.get("price")),
    sort: SORTS[query.get("sort")] ? query.get("sort") : "featured",
  };
  const view = document.getElementById("view");
  const dept = ["women", "men"].includes(params.collection) ? params.collection : null;
  const catTitle = state.category.length === 1 ? CATEGORIES[state.category[0]] : null;

  view.innerHTML = `
    <section class="plp-banner" style="--img:url('/assets/editorial/${col.banner}.jpg')">
      <div class="plp-banner-inner">
        ${crumbs([["Home", "/"], [col.title, catTitle ? `/shop/${params.collection}` : null], ...(catTitle ? [[catTitle]] : [])])}
        <h1>${esc(catTitle && dept ? `${col.title}'s ${catTitle.toLowerCase()}` : col.title)}</h1>
        ${col.lede ? `<p>${esc(col.lede)}</p>` : ""}
      </div>
    </section>
    <div class="plp">
      <aside class="filters" id="filters" aria-label="Filters"></aside>
      <section class="plp-main">
        <div class="plp-toolbar">
          <button class="btn btn-secondary filter-toggle" type="button" aria-controls="filters" aria-expanded="false">Filters</button>
          <p class="plp-count" id="plp-count" aria-live="polite"></p>
          <div class="chips" id="chips"></div>
          <label class="sort">Sort by
            <select id="sort">${Object.entries(SORTS).map(([k, v]) =>
              `<option value="${k}" ${k === state.sort ? "selected" : ""}>${v}</option>`).join("")}</select>
          </label>
        </div>
        <div class="grid grid-3" id="grid"></div>
        <div class="plp-empty" id="plp-empty" hidden>
          <h2>Nothing matches those filters</h2>
          <p>Try removing a size or color.</p>
          <button class="btn btn-secondary" type="button" data-clear>Clear all filters</button>
        </div>
      </section>
    </div>`;

  const grid = view.querySelector("#grid");
  const passes = (p, except) =>
    (except === "category" || !state.category.length || state.category.includes(p.category)) &&
    (except === "size" || !state.size.length || p.variants.some(v => state.size.includes(v))) &&
    (except === "color" || !state.color.length || p.colors.some(c => state.color.includes(c.name))) &&
    (except === "price" || !state.price.length || PRICE_BANDS.some(b => state.price.includes(b.id) && b.test(p)));

  function facet(key, title, options, render) {
    const counts = options.map(o => base.filter(p => passes(p, key) && o.test(p)).length);
    const rows = options.map((o, i) => counts[i] || state[key].includes(o.id) ? render(o, counts[i], state[key].includes(o.id)) : "").join("");
    return rows ? `<fieldset class="facet"><legend>${title}</legend><div class="facet-${key}">${rows}</div></fieldset>` : "";
  }
  const check = (key) => (o, n, on) => `
    <label class="check"><input type="checkbox" data-facet="${key}" value="${esc(o.id)}" ${on ? "checked" : ""}>
      <span>${esc(o.label)}</span><span class="n">${n}</span></label>`;

  function renderFilters() {
    const cats = [...new Set(base.map(p => p.category))];
    const sizes = SIZE_ORDER.filter(s => base.some(p => p.variants.includes(s)));
    const colors = [...new Map(base.flatMap(p => p.colors).map(c => [c.name, c])).values()]
      .sort((a, b) => a.name.localeCompare(b.name));
    view.querySelector("#filters").innerHTML = `
      <div class="filters-head"><h2>Filter</h2><button class="link-btn" type="button" data-clear>Clear all</button></div>
      ${cats.length > 1 ? facet("category", "Category",
        cats.map(c => ({ id: c, label: CATEGORIES[c], test: p => p.category === c })), check("category")) : ""}
      ${facet("size", "Size", sizes.map(s => ({ id: s, label: s, test: p => p.variants.includes(s) })),
        (o, n, on) => `<button type="button" class="size-chip" data-facet="size" data-value="${esc(o.id)}" aria-pressed="${on}">${esc(o.label)}</button>`)}
      ${facet("color", "Color", colors.map(c => ({ id: c.name, label: c.name, tone: c.tone, test: p => p.colors.some(x => x.name === c.name) })),
        (o, n, on) => `<label class="check"><input type="checkbox" data-facet="color" value="${esc(o.id)}" ${on ? "checked" : ""}>
          <span class="dot" style="--tone:${esc(o.tone)}"></span><span>${esc(o.label)}</span><span class="n">${n}</span></label>`)}
      ${facet("price", "Price", PRICE_BANDS, check("price"))}`;
  }

  function sorted(ps) {
    const s = state.sort;
    if (s === "featured") return ps;
    const by = { new: (a, b) => (b.id.length - a.id.length) || b.id.localeCompare(a.id),
      "price-asc": (a, b) => a.price - b.price, "price-desc": (a, b) => b.price - a.price,
      rating: (a, b) => b.attrs.rating - a.attrs.rating }[s];
    return [...ps].sort(by);
  }

  function renderGrid() {
    const ps = sorted(base.filter(p => passes(p)));
    grid.innerHTML = ps.map(card).join("");
    view.querySelector("#plp-empty").hidden = ps.length > 0;
    view.querySelector("#plp-count").textContent = `${ps.length} ${ps.length === 1 ? "style" : "styles"}`;
    const labels = { category: v => CATEGORIES[v], price: v => PRICE_BANDS.find(b => b.id === v)?.label, size: v => `Size ${v}`, color: v => v };
    view.querySelector("#chips").innerHTML = ["category", "size", "color", "price"].flatMap(k => state[k].map(v =>
      `<button type="button" class="chip" data-unset="${k}" data-value="${esc(v)}">${esc(labels[k](v))}<span aria-hidden="true">×</span><span class="visually-hidden">Remove filter</span></button>`)).join("");
  }

  function sync() {
    setQuery({ category: state.category.join(","), size: state.size.join(","), color: state.color.join(","),
      price: state.price.join(","), sort: state.sort === "featured" ? "" : state.sort });
    renderFilters(); renderGrid();
    dispatchEvent(new Event("scroll"));
  }
  const toggle = (k, v) => { state[k] = state[k].includes(v) ? state[k].filter(x => x !== v) : [...state[k], v]; sync(); };

  view.querySelector(".plp").addEventListener("change", e => {
    if (e.target.id === "sort") { state.sort = e.target.value; sync(); }
    else if (e.target.dataset.facet) toggle(e.target.dataset.facet, e.target.value);
  });
  view.querySelector(".plp").addEventListener("click", e => {
    const chip = e.target.closest("[data-facet='size']");
    if (chip) toggle("size", chip.dataset.value);
    const un = e.target.closest("[data-unset]");
    if (un) toggle(un.dataset.unset, un.dataset.value);
    if (e.target.closest("[data-clear]")) { state.category = []; state.size = []; state.color = []; state.price = []; sync(); }
    const ft = e.target.closest(".filter-toggle");
    if (ft) {
      const open = view.querySelector("#filters").classList.toggle("open");
      ft.setAttribute("aria-expanded", String(open));
    }
  });

  renderFilters(); renderGrid();
  return { title: catTitle ? `${col.title} ${catTitle.toLowerCase()}` : col.title, name: "listing" };
}
