// The toolbar click gives activeTab access only for the page the shopper chose.
chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !/^https?:\/\//.test(tab.url || '') ||
      (tab.url || '').startsWith('http://localhost:4173/')) return;
  const target = { tabId: tab.id };
  try {
    const [{ result: active }] = await chrome.scripting.executeScript({
      target, func: () => Boolean(globalThis.__cueExternalActive),
    });
    if (active) return;
    const models = Object.fromEntries(['blazeface', 'facemesh', 'iris'].map(name =>
      [name, chrome.runtime.getURL(`vendor/models/${name}/model.json`)]));
    await chrome.scripting.executeScript({
      target,
      func: urls => {
        globalThis.CUE_MODELS = urls;
        globalThis.CUE_CONFIG = { server: 'http://localhost:4173', gazeMode: 'webgazer', autoCal: true,
          keepData: false, models: urls };
      },
      args: [models],
    });
    await chrome.scripting.insertCSS({ target, files: ['client/overlay.css'] });
    await chrome.scripting.executeScript({ target, files: ['vendor/webgazer.js'] });
    await chrome.scripting.executeScript({ target, files: ['extension/extract.js', 'extension/content.js'] });
  } catch (error) {
    console.error('[cue] Could not start on this page:', error);
  }
});
