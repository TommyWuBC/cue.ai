import { searchProducts, CATEGORIES } from "../data.js";
import { card, esc } from "../ui.js";

export default function search({ query }) {
  const q = (query.get("q") ?? "").trim();
  const hits = searchProducts(q);
  document.getElementById("search").value = q;
  document.getElementById("view").innerHTML = `
    <section class="search-page">
      <div class="search-head">
        <p class="muted">${hits.length} ${hits.length === 1 ? "result" : "results"}</p>
        <h1>${q ? `“${esc(q)}”` : "Search"}</h1>
      </div>
      ${hits.length ? `<div class="grid grid-4">${hits.map(card).join("")}</div>` : `
      <div class="search-empty">
        <p>Nothing matched${q ? ` “${esc(q)}”` : ""}. Try a material, a color, or one of these:</p>
        <div class="pill-links">${Object.entries(CATEGORIES).map(([k, v]) => `<a href="/shop/${k}">${v}</a>`).join("")}</div>
      </div>`}
    </section>`;
  return { title: q ? `Search: ${q}` : "Search", name: "search" };
}
