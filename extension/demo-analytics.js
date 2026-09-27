// A narrow bridge for Cue's own demo store. It shares the extension's local
// journal without running a second copy of the shopping overlay on that page.
if (document.documentElement) document.documentElement.dataset.cueAnalyticsBridge = '1';
else {
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    document.documentElement.dataset.cueAnalyticsBridge = '1';
    observer.disconnect();
  });
  observer.observe(document, { childList: true });
}
document.addEventListener('cue:analytics:request', async request => {
  let payload;
  try { payload = JSON.parse(request.detail); } catch { return; }
  if (!['event', 'summary', 'export'].includes(payload.kind) ||
      typeof payload.id !== 'string' || payload.id.length > 80) return;
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: `cue:analytics:${payload.kind}`,
      event: payload.event });
  } catch (error) {
    response = { ok: false, error: error.message };
  }
  document.dispatchEvent(new CustomEvent('cue:analytics:response', {
    detail: JSON.stringify({ id: payload.id, ...response }),
  }));
});
