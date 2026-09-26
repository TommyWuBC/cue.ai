// The startup card stays in the shopping tab. No navigation is needed: when
// calibration closes, the shopper is exactly where they started.
const DURATION_MS = 2000;
const FADE_MS = 350;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function playSplash(imageUrl) {
  if (!imageUrl) return Promise.resolve();

  const splash = document.createElement("div");
  splash.className = "cue-splash";
  splash.setAttribute("role", "status");
  splash.setAttribute("aria-label", "Cue is starting");
  splash.popover = "manual";

  const image = document.createElement("img");
  image.src = imageUrl;
  image.alt = "Cue";
  splash.appendChild(image);
  document.body.appendChild(splash);
  try { splash.showPopover(); } catch { /* Fixed-position fallback. */ }

  return (async () => {
    try {
      // Start the fade once the packaged image can paint, so a slow decode
      // cannot consume the time the logo is meant to be visible.
      await image.decode().catch(() => {});
      // A toolbar activation can leave the shopping tab in the background
      // briefly; requestAnimationFrame may pause there indefinitely.
      void splash.offsetWidth;
      splash.classList.add("cue-splash-visible");
      await pause(DURATION_MS - FADE_MS);
      splash.classList.remove("cue-splash-visible");
      await pause(FADE_MS);
    } finally {
      try { splash.hidePopover(); } catch {}
      splash.remove();
    }
  })();
}
