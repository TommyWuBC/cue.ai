import { SERVER_URL } from './runtime.js';
import { ANALYTICS_KEY, addActivity, summarizeActivity, activityCSV } from '../client/analytics-store.js';

const SERVER = new URL(SERVER_URL);

function supported(url) {
  try {
    const page = new URL(url);
    return ['http:', 'https:'].includes(page.protocol) && page.origin !== SERVER.origin;
  } catch { return false; }
}

function sitePattern(url) {
  try { return `${new URL(url).origin}/*`; }
  catch { return null; }
}

const pauseKey = tabId => `cue.paused.${tabId}`;
const sessionKey = tabId => `cue.session.${tabId}`;
const sessionWrites = new Map();
let analyticsWrites = Promise.resolve();

// ── Gaze on a real site (docs/GAZE.md, "Known limits") ──────────────────────
// MediaPipe's WASM loader inserts a <script> tag; run that from a content
// script on a third-party page and the tag executes in the PAGE's world, not
// the content script's isolated one, so the two halves of MediaPipe's own
// startup cannot see each other. The camera and MediaPipe run in this
// offscreen document instead — a page the extension fully owns, one
// consistent world — and hand extracted features back over messaging. Only
// one gaze-using tab at a time, which matches the camera itself: one physical
// device, and only one shopper is ever actually looking at it.
const OFFSCREEN_URL = 'extension/offscreen.html';
let gazeTabId = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Camera-based gaze tracking, extracted in one JS world MediaPipe can run in.',
  });
}

async function endGaze() {
  if (!(await chrome.offscreen.hasDocument())) { gazeTabId = null; return; }
  await chrome.runtime.sendMessage({ type: 'cue:gaze:end' }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
  gazeTabId = null;
}

async function analyticsEvents() {
  const value = (await chrome.storage.local.get(ANALYTICS_KEY))[ANALYTICS_KEY];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('The local shopping journal is invalid.');
  return value;
}

function recordAnalytics(event, options) {
  const next = analyticsWrites.catch(() => {}).then(async () => {
    const result = addActivity(await analyticsEvents(), event, options);
    if (result.recorded) await chrome.storage.local.set({ [ANALYTICS_KEY]: result.events });
    return { recorded: result.recorded };
  });
  analyticsWrites = next;
  return next;
}

function updateSession(tabId, action) {
  const previous = sessionWrites.get(tabId) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  const pending = result.finally(() => {
    if (sessionWrites.get(tabId) === pending) sessionWrites.delete(tabId);
  });
  sessionWrites.set(tabId, pending);
  return pending;
}

async function sessionFor(tab) {
  await sessionWrites.get(tab.id);
  const session = (await chrome.storage.session.get(sessionKey(tab.id)))[sessionKey(tab.id)];
  return session?.version === 1 && session.origin === new URL(tab.url).origin
    ? session : null;
}

async function paused(tabId) {
  const key = pauseKey(tabId);
  return Boolean((await chrome.storage.session.get(key))[key]);
}

async function setPaused(tabId, value) {
  const key = pauseKey(tabId);
  if (value) await chrome.storage.session.set({ [key]: true });
  else await chrome.storage.session.remove(key);
}

async function siteAllowed(url) {
  const pattern = sitePattern(url);
  return Boolean(pattern && await chrome.permissions.contains({ origins: [pattern] }));
}

async function serverReady() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(new URL('/health', SERVER), {
      signal: controller.signal, cache: 'no-store',
    });
    return response.ok && (await response.json()).ok === true;
  } catch { return false; }
  finally { clearTimeout(timeout); }
}

// Eye tracking on. 'webgazer' now means "camera" — gaze v2 runs MediaPipe face
// landmarks through a per-user model, loaded as a module by client/eyes.js.
// 'mouse' needs no camera and no calibration.
const GAZE_MODE = 'webgazer';

async function activeOn(tabId) {
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId }, func: () => Boolean(globalThis.__cueExternalActive),
  });
  return Boolean(frame?.result);
}

async function start(tab) {
  if (!tab?.id || !supported(tab.url)) {
    return { ok: false, error: 'Open a shopping page over HTTPS, then try again.' };
  }
  const target = { tabId: tab.id };
  try {
    if (await activeOn(tab.id)) return { ok: true, active: true };
    if (!await serverReady()) {
      return { ok: false, error: `Cue cannot reach ${SERVER.origin}. Start the server and try again.` };
    }
    const session = await sessionFor(tab);

    const models = GAZE_MODE === 'webgazer'
      ? Object.fromEntries(['blazeface', 'facemesh', 'iris'].map(name =>
          [name, chrome.runtime.getURL(`vendor/models/${name}/model.json`)]))
      : null;
    const splashImage = chrome.runtime.getURL('extension/assets/cue-splash.jpg');
    await chrome.scripting.executeScript({
      target,
      func: (server, urls, image, previous, mode) => {
        globalThis.__cueEnded = false;
        globalThis.CUE_MODELS = urls;
        globalThis.CUE_CONFIG = { server, gazeMode: mode, autoCal: mode === 'webgazer',
          keepData: false, models: urls, splashImage: image,
          resuming: Boolean(previous?.started), calibration: previous?.calibration ?? null };
      },
      args: [SERVER.origin, models, splashImage, session, GAZE_MODE],
    });
    await chrome.scripting.insertCSS({
      target, files: ['client/overlay.css', 'client/analytics.css', 'client/compare.css'],
    });
    // Gaze v2 loads its face tracker as a module from the package itself
    // (client/eyes.js -> vendor/mediapipe), so nothing is injected here.
    await chrome.scripting.executeScript({ target, files: ['extension/extract.js', 'extension/content.js'] });
    await updateSession(tab.id, async () => {
      const key = sessionKey(tab.id);
      const current = (await chrome.storage.session.get(key))[key];
      if (current?.version === 1 && current.origin === new URL(tab.url).origin) return;
      await chrome.storage.session.set({ [key]: {
        version: 1, origin: new URL(tab.url).origin, started: true, calibration: null,
      } });
    });
    return { ok: true, active: true };
  } catch (error) {
    console.error('[cue] Could not start on this page:', error);
    return { ok: false, error: 'Chrome blocked Cue on this page. Try a normal shopping tab.' };
  }
}

const starts = new Map();
function startOnce(tab) {
  if (!tab?.id) return Promise.resolve({ ok: false, error: 'No active shopping tab.' });
  if (starts.has(tab.id)) return starts.get(tab.id);
  const promise = start(tab).finally(() => starts.delete(tab.id));
  starts.set(tab.id, promise);
  return promise;
}

async function showActionResult(tabId, result) {
  await Promise.allSettled([
    chrome.action.setBadgeBackgroundColor({
      tabId, color: result.ok ? '#167D57' : '#B42318',
    }),
    chrome.action.setBadgeText({ tabId, text: result.ok ? 'ON' : '!' }),
    chrome.action.setTitle({
      tabId,
      title: result.ok ? 'Cue is active on this page' : result.error,
    }),
  ]);
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab?.id) return;
  const pattern = sitePattern(tab.url);
  if (!pattern || !supported(tab.url)) {
    await showActionResult(tab.id, {
      ok: false, error: 'Open a shopping page over HTTPS, then try again.',
    });
    return;
  }

  // This request must be the first awaited operation in the click handler so
  // Chrome still considers it part of the shopper's gesture. Once granted,
  // this store can start Cue automatically on future visits.
  const allowed = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  if (!allowed) {
    await showActionResult(tab.id, {
      ok: false, error: 'Allow Cue on this store to enable hands-free startup.',
    });
    return;
  }
  await setPaused(tab.id, false);
  await Promise.allSettled([
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#4B5563' }),
    chrome.action.setBadgeText({ tabId: tab.id, text: '…' }),
    chrome.action.setTitle({ tabId: tab.id, title: 'Starting Cue…' }),
  ]);
  await showActionResult(tab.id, await startOnce(tab));
});

async function autoStart(tab) {
  if (!tab?.id || !supported(tab.url) || await paused(tab.id) || !await siteAllowed(tab.url)) return;
  await showActionResult(tab.id, await startOnce(tab));
}

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status === 'complete') return autoStart(tab).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  return chrome.tabs.get(tabId).then(autoStart).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (sender.url === chrome.runtime.getURL('extension/popup.html') && message?.type === 'cue:start') {
    start(message.tab).then(respond, () => respond({ ok: false, error: 'Cue could not start.' }));
    return true;
  }
  // From the offscreen document, which has no sender.tab of its own — relay
  // to whichever tab actually asked for gaze.
  if (sender.url === chrome.runtime.getURL(OFFSCREEN_URL) && message?.type === 'cue:gaze:sample') {
    if (Number.isInteger(gazeTabId)) chrome.tabs.sendMessage(gazeTabId, message).catch(() => {});
    return;
  }
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return;
  if (message?.type === 'cue:gaze:start') {
    (async () => {
      await ensureOffscreen();
      gazeTabId = tabId;
      const res = await chrome.runtime.sendMessage({ type: 'cue:gaze:begin' }).catch((e) =>
        ({ ok: false, error: String(e?.message || e) }));
      if (!res?.ok) gazeTabId = null;
      return res;
    })().then(respond, (e) => respond({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (message?.type === 'cue:gaze:stop') {
    endGaze().then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (['cue:analytics:event', 'cue:analytics:summary', 'cue:analytics:export'].includes(message?.type)) {
    (async () => {
      const demo = new URL(sender.url).origin === SERVER.origin;
      if (!demo && (!supported(sender.url) || await paused(tabId) ||
          !(await sessionFor({ id: tabId, url: sender.url })))) return { ok: false };
      if (message.type === 'cue:analytics:event') {
        if (!message.event || JSON.stringify(message.event).length > 3000) return { ok: false };
        const data = await recordAnalytics(message.event, {
          site: demo ? 'Northfield demo' : new URL(sender.url).hostname, allowPurchase: demo,
        });
        return { ok: true, data };
      }
      await analyticsWrites.catch(() => {});
      const events = await analyticsEvents();
      return { ok: true, data: message.type === 'cue:analytics:export'
        ? activityCSV(events) : summarizeActivity(events) };
    })().then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'cue:exit' || message?.type === 'cue:stop') {
    updateSession(tabId, async () => {
      if (tabId === gazeTabId) await endGaze();
      await setPaused(tabId, true);
      await chrome.storage.session.remove(sessionKey(tabId));
      await Promise.allSettled([
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#4B5563' }),
        chrome.action.setBadgeText({ tabId, text: 'OFF' }),
        chrome.action.setTitle({ tabId, title: 'Cue is paused on this tab' }),
      ]);
      respond({ ok: true });
    }).catch(() => respond({ ok: false }));
    return true;
  }
  if (message?.type === 'cue:calibration:write' || message?.type === 'cue:calibration:clear') {
    updateSession(tabId, async () => {
      // Read directly within the queue; sessionFor waits for the queue itself.
      const current = (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)];
      if (current?.origin !== new URL(sender.url).origin) return { ok: false };
      let calibration = null;
      if (message.type === 'cue:calibration:write') {
        calibration = message.value;
        if (![1, 2].includes(calibration?.version) || !Array.isArray(calibration.samples) ||
            JSON.stringify(calibration).length > 4_000_000) return { ok: false };
      }
      await chrome.storage.session.set({ [sessionKey(tabId)]: { ...current, calibration } });
      return { ok: true };
    }).then(respond, () => respond({ ok: false }));
    return true;
  }
  const key = `cue.product-memory.${tabId}`;
  if (message?.type === 'cue:memory:read') {
    chrome.storage.session.get(key).then(data => respond({ value: data[key] ?? null }),
      () => respond({ value: null }));
    return true;
  }
  if (message?.type === 'cue:memory:write' && typeof message.value === 'string' &&
      message.value.length <= 10000) {
    chrome.storage.session.set({ [key]: message.value }).then(() => respond({ ok: true }),
      () => respond({ ok: false }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  // Closing the tab that had the camera running must not leave it running,
  // pointed at nothing, with no shopper left to say "Cue, end".
  if (tabId === gazeTabId) endGaze().catch(() => {});
  updateSession(tabId, () => chrome.storage.session.remove([
    `cue.product-memory.${tabId}`, pauseKey(tabId), sessionKey(tabId),
  ])).catch(() => {});
});
