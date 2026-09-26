// Boots the storefront: routes, header behavior, and site-wide dialogs.
import { route, start, navigate } from "./router.js";
import { searchProducts, photo, money, cents } from "./data.js";
import { esc } from "./util.js";
import "./cart.js";
import "./ui.js";

const lazy = (file, name = "default") => async ctx => (await import(`./views/${file}.js`))[name](ctx);

route("/", lazy("home"));
route("/shop/:collection", lazy("listing"));
route("/product/:id", lazy("product"));
route("/search", lazy("search"));
route("/bag", lazy("bag"));
route("/account", lazy("account"));
route("/account/:tab", lazy("account"));
route("/journal", lazy("journal", "index"));
route("/journal/:slug", lazy("journal", "article"));
route("/help", lazy("help", "index"));
route("/help/:topic", lazy("help", "topic"));
route("/stores", lazy("stores"));
route("/about", lazy("about"));
route(".*", lazy("notfound"));

// ── Header ──────────────────────────────────────────────────────────────────
const header = document.getElementById("site-header");
addEventListener("scroll", () => header.classList.toggle("scrolled", scrollY > 8), { passive: true });

document.addEventListener("routechange", ({ detail }) => {
  const [, section, slug] = detail.path.split("/");
  const key = section === "shop" ? slug : section;
  for (const a of document.querySelectorAll("[data-nav]")) {
    a.toggleAttribute("aria-current", a.dataset.nav === key);
  }
  document.querySelectorAll("[data-mega]").forEach(m => m.classList.remove("open"));
  document.activeElement?.blur?.();
});

// Small screens: the nav becomes a panel under the header.
const menuBtn = document.getElementById("menu-btn");
menuBtn.addEventListener("click", () => {
  const open = header.classList.toggle("menu-open");
  menuBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("routechange", () => { header.classList.remove("menu-open"); menuBtn.setAttribute("aria-expanded", "false"); });

// Mega menus open on hover with a short intent delay, and on keyboard focus.
for (const item of document.querySelectorAll("[data-mega]")) {
  let t;
  item.addEventListener("mouseenter", () => { clearTimeout(t); t = setTimeout(() => item.classList.add("open"), 90); });
  item.addEventListener("mouseleave", () => { clearTimeout(t); t = setTimeout(() => item.classList.remove("open"), 140); });
  item.addEventListener("focusin", () => item.classList.add("open"));
  item.addEventListener("focusout", e => { if (!item.contains(e.relatedTarget)) item.classList.remove("open"); });
}

// ── Search with suggestions ─────────────────────────────────────────────────
const form = document.getElementById("search-form");
const input = document.getElementById("search");
const suggest = document.getElementById("suggest");
const POPULAR = ["wool coat", "cashmere", "rain jacket", "scarf", "jeans"];

function showSuggest() {
  const q = input.value.trim();
  const hits = q ? searchProducts(q).slice(0, 5) : [];
  suggest.innerHTML = q
    ? (hits.length ? hits.map(p => `
        <a class="suggest-item" role="option" href="/product/${p.id}">
          <img src="${photo(p.id, p.colors[0].name)}" alt=""><span>${esc(p.title)}</span><b class="tabular">${money(cents(p))}</b></a>`).join("")
        + `<a class="suggest-all" href="/search?q=${encodeURIComponent(q)}">See all results for “${esc(q)}”</a>`
        : `<p class="suggest-empty">No matches for “${esc(q)}”.</p>`)
    : `<p class="suggest-label">Popular searches</p>` + POPULAR.map(s =>
        `<a class="suggest-term" href="/search?q=${encodeURIComponent(s)}">${s}</a>`).join("");
  suggest.hidden = false;
}
input.addEventListener("focus", showSuggest);
input.addEventListener("input", showSuggest);
form.addEventListener("focusout", e => { if (!form.contains(e.relatedTarget)) suggest.hidden = true; });
input.addEventListener("keydown", e => { if (e.key === "Escape") { suggest.hidden = true; input.blur(); } });
form.addEventListener("submit", e => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  suggest.hidden = true; input.blur();
  navigate(`/search?q=${encodeURIComponent(q)}`);
});
suggest.addEventListener("click", e => { if (e.target.closest("a")) { suggest.hidden = true; input.blur(); } });
document.addEventListener("routechange", ({ detail }) => {
  if (detail.name !== "search") input.value = "";
});

// ── Newsletter ──────────────────────────────────────────────────────────────
document.getElementById("newsletter").addEventListener("submit", e => {
  e.preventDefault();
  e.target.querySelector("div").hidden = true;
  e.target.querySelector(".newsletter-done").hidden = false;
});

// ── Size guide (opened from any product) ────────────────────────────────────
const guide = document.getElementById("size-guide");
guide.addEventListener("click", e => { if (e.target === guide || e.target.closest("[data-close]")) guide.close(); });
document.addEventListener("click", async e => {
  if (!e.target.closest("[data-size-guide]")) return;
  const { sizeTables } = await import("./views/help.js");
  document.getElementById("sg-body").innerHTML = sizeTables();
  guide.showModal();
});

start();
