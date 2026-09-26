// Client-side routing with real URLs. The whole site is one document on
// purpose: a full page load restarts WebGazer and throws away calibration, so
// every "page" here is a view swapped into #view. Back and forward work, and so
// does Cue's "go back", because each view is a real history entry.
//
// Deep links survive a refresh because store/404.html is a symlink to
// index.html: Starlette's StaticFiles serves it for any unknown path.

import { invalidate } from "/client/resolver.js";

const routes = [];
const view = document.getElementById("view");

// Dev flags that must survive navigation (see CLAUDE.md "Run it").
const STICKY = ["gaze", "cal", "sigma", "keepdata", "mc", "beta", "dc"];
const sticky = new URLSearchParams(
  [...new URLSearchParams(location.search)].filter(([k]) => STICKY.includes(k)));

export function route(pattern, render) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ re, keys, render });
}

export function href(path) {
  const url = new URL(path, location.origin);
  for (const [k, v] of sticky) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  return url.pathname + url.search + url.hash;
}

let current = null;
async function render({ restore = null } = {}) {
  const path = decodeURIComponent(location.pathname.replace(/^\/index\.html$/, "/"));
  const query = new URLSearchParams(location.search);
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    current?.cleanup?.();
    const out = (await r.render({ params, query, path })) ?? {};
    current = out;
    document.title = out.title ? `${out.title} | Northfield` : "Northfield";
    document.body.dataset.view = out.name ?? "";
    document.dispatchEvent(new CustomEvent("routechange", { detail: { path, name: out.name } }));
    if (restore != null) scrollTo(0, restore);
    else if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
    else scrollTo(0, 0);
    // Anything Cue had focused or cached belonged to the old view. The
    // resolver's cache key cannot see a view swap, so clear it explicitly.
    invalidate();
    dispatchEvent(new Event("scroll"));
    return;
  }
}

export function navigate(path, { replace = false } = {}) {
  history.replaceState({ ...history.state, y: scrollY }, "");
  const url = href(path);
  if (replace) history.replaceState({ y: 0 }, "", url);
  else history.pushState({ y: 0 }, "", url);
  return render();
}

export function setQuery(query, { replace = true } = {}) {
  const url = new URL(location.href);
  url.search = "";
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
  for (const [k, v] of sticky) url.searchParams.set(k, v);
  history[replace ? "replaceState" : "pushState"]({ y: scrollY }, "", url.pathname + url.search);
}

addEventListener("popstate", e => render({ restore: e.state?.y ?? 0 }));

// Lazy images change card heights after the resolver has cached their rects.
let reflow;
document.addEventListener("load", e => {
  if (e.target.tagName !== "IMG") return;
  clearTimeout(reflow);
  reflow = setTimeout(invalidate, 120);
}, true);

document.addEventListener("click", e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a[href]");
  if (!a || a.target || a.hasAttribute("download")) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || /\.(html|json|jpg|png)$/.test(url.pathname) && !url.pathname.endsWith("/index.html")) return;
  if (url.pathname === location.pathname && url.hash) return;     // in-page anchor
  e.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});

export const start = () => render();
