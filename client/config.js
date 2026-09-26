// Where Cue lives, and how it is configured.
//
// On the demo store, Cue is served by its own server and everything is
// same-origin. Injected into someone else's page, "/" is THEIR origin, so every
// root-relative fetch has to become absolute and the query string stops being
// a safe place to keep config (the host page has its own params).
//
// Resolution order, most specific first:
//   1. window.CUE_CONFIG          — set by the extension content script
//   2. ?gaze=… query params        — dev override, only on our own origin
//   3. defaults

const DEFAULT_SERVER = "http://localhost:4173";

// Are we running on the Cue server itself, or injected into a third party?
// A page that serves /client/config.js from its own origin is ours.
function ownOrigin() {
  try {
    return new URL(import.meta.url).origin === location.origin;
  } catch { return false; }
}

const injected = typeof window !== "undefined" && !!window.CUE_CONFIG;
const qs = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

// Query params are a dev affordance. On a third-party page they would collide
// with the site's own — Amazon uses ?k=, eBay uses ?_nkw= — so they are only
// honoured when Cue is being served from its own origin.
const allowQuery = ownOrigin() && !injected;
const q = (k) => (allowQuery ? qs.get(k) : null);

const injectedCfg = (typeof window !== "undefined" && window.CUE_CONFIG) || {};

export const CONFIG = {
  // Absolute base for every server call. Never build one from location.host:
  // on a third-party page that points at the third party.
  server: (injectedCfg.server || q("server") || DEFAULT_SERVER).replace(/\/+$/, ""),

  gazeMode: injectedCfg.gazeMode || q("gaze") || "webgazer",   // webgazer | mouse | sim
  autoCal: (injectedCfg.autoCal ?? (q("cal") !== "0")),
  sigma: +(injectedCfg.sigma || q("sigma") || 70),
  keepData: injectedCfg.keepData ?? (q("keepdata") === "1"),

  // Filter overrides, for sweeping the tuning against sim mode.
  tune: q("mc") ? {
    minCutoff: +q("mc"), beta: +(q("beta") ?? 0.002), dCutoff: +(q("dc") ?? 0.3),
  } : (injectedCfg.tune || null),

  // Where webgazer's TF.js models live. The extension rewrites these to
  // chrome-extension:// URLs, which is the only way past a host page's CSP.
  models: injectedCfg.models || null,

  // Packaged artwork for the extension's short startup screen.
  splashImage: injectedCfg.splashImage || null,
  resuming: Boolean(injectedCfg.resuming),
  calibration: injectedCfg.calibration || null,

  injected,
};

export const url = (path) => CONFIG.server + path;

export const wsUrl = (path) => {
  const u = new URL(CONFIG.server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.origin.replace(/^http/, "ws") + path;
};
