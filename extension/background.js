import { SERVER_URL } from './runtime.js';

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

async function createGazeSession() {
  let response;
  try {
    response = await fetch(new URL('/api/gaze/session', SERVER), {
      method: 'POST', cache: 'no-store',
    });
  } catch (error) {
    throw new Error(`Cue reached the server health check, but could not start EyeTrax: ${error.message}`);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {}
    throw new Error(detail || `The EyeTrax companion rejected the extension (${response.status}).`);
  }
  const body = await response.json();
  if (typeof body.token !== 'string' || body.token.length < 20) {
    throw new Error('The EyeTrax companion returned an invalid session.');
  }
  return body.token;
}

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

    const gazeToken = await createGazeSession();
    const splashImage = chrome.runtime.getURL('extension/assets/cue-splash.jpg');
    await chrome.scripting.executeScript({
      target,
      func: (server, token, image, previous) => {
        globalThis.CUE_CONFIG = { server, gazeMode: 'eyetrax', gazeToken: token, autoCal: true,
          keepData: false, splashImage: image,
          resuming: Boolean(previous?.started), calibration: previous?.calibration ?? null };
      },
      args: [SERVER.origin, gazeToken, splashImage, session],
    });
    await chrome.scripting.insertCSS({ target, files: ['client/overlay.css'] });
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
    const detail = error instanceof Error && error.message
      ? error.message
      : 'Chrome blocked Cue on this page.';
    return { ok: false, error: `Cue could not start: ${detail}` };
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
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return;
  if (message?.type === 'cue:exit') {
    updateSession(tabId, async () => {
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
  if (message?.type === 'cue:gaze:session') {
    createGazeSession().then(token => respond({ token }), error => respond({ error: error.message }));
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
        const webgazer = calibration?.version === 1 && Array.isArray(calibration.samples);
        const eyetrax = calibration?.version === 2 && calibration.engine === 'eyetrax' &&
          Number.isFinite(calibration.accuracy?.after_px);
        if ((!webgazer && !eyetrax) || JSON.stringify(calibration).length > 4_000_000) {
          return { ok: false };
        }
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
  updateSession(tabId, () => chrome.storage.session.remove([
    `cue.product-memory.${tabId}`, pauseKey(tabId), sessionKey(tabId),
  ])).catch(() => {});
});
