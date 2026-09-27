// The same exported shape as client/eyes.js — begin, end, setListener,
// latest, isRunning, stats, showPreview — so gaze.js's setEngine() can swap
// this in without knowing the difference. Where eyes.js runs the camera and
// MediaPipe itself, this module runs neither: it asks the background service
// worker to start them in an offscreen document (extension/offscreen.js) and
// receives extracted features back over chrome.runtime messaging.
//
// Only for the extension on a real site. The demo store never sets
// CONFIG.injected, so it keeps using client/eyes.js directly — there is no
// content-script/page-world split to work around there, and adding a message
// round trip where none is needed would just be latency for nothing.
const state = { running: false, latest: null, listener: null, stats: {} };

// chrome.runtime.sendMessage is extension-wide: every content script sees the
// offscreen document's broadcast directly, not only the background service
// worker relaying it. Two tabs both running Cue would otherwise both act on
// the same camera frame, and the one meant to receive it would get every
// sample twice — once from the broadcast, once from background's own relay
// to it specifically. Only accept what background actually relayed via
// chrome.tabs.sendMessage; a message straight from offscreen is discarded.
//
// Computed lazily, not at module load: this file is statically imported by
// aura.js so gaze.js's setEngine() can reach it, and aura.js loads on the
// demo store too, where there is no `chrome` at all. A top-level
// chrome.runtime.getURL() here crashed the whole module graph on that page —
// found live, not in a test, because nothing here throws until executed.
let offscreenUrl = null;
const OFFSCREEN_URL = () => offscreenUrl ??= chrome.runtime.getURL("extension/offscreen.html");

function onMessage(message, sender) {
  if (message?.type !== "cue:gaze:sample" || sender.url === OFFSCREEN_URL()) return;
  state.latest = message.sample;
  state.stats = message.stats || {};
  try { state.listener?.(message.sample); } catch (e) { console.error("[cue] gaze listener", e); }
}

export async function begin() {
  if (state.running) return true;
  chrome.runtime.onMessage.addListener(onMessage);
  const res = await chrome.runtime.sendMessage({ type: "cue:gaze:start" });
  if (!res?.ok) {
    chrome.runtime.onMessage.removeListener(onMessage);
    throw new Error(res?.error || "offscreen camera could not start");
  }
  state.running = true;
  return true;
}

export function end() {
  state.running = false;
  chrome.runtime.onMessage.removeListener(onMessage);
  chrome.runtime.sendMessage({ type: "cue:gaze:stop" }).catch(() => {});
}

export const setListener = (fn) => { state.listener = fn; };
export const latest = () => state.latest;
export const isRunning = () => state.running;
export const stats = () => state.stats;
// The live preview is off everywhere (see client/eyes.js) — a floating feed
// of the shopper's own face piped across an extra message hop is not
// something to build for a feature that is already disabled at the source.
export function showPreview() {}
