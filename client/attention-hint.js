// A quiet suggestion in Cue's dock when the eyes keep going back and forth
// between two items: "Deciding between A and B? Say “compare them”."
//
// Silent on purpose. Cue does not start talking because of where you looked;
// it only makes the next useful sentence easy to say. One offer per pair per
// minute (gaze.js decides when), gone after a few seconds or when you speak.
import { bus } from "./bus.js";

let el = null, timer = 0;

function short(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  return t.length > 28 ? t.slice(0, 26).trim() + "…" : t;
}

function hide() {
  clearTimeout(timer);
  el?.classList.remove("on");
}

bus.on("ATTENTION", ({ kind, items }) => {
  if (kind !== "torn" || items?.length < 2) return;
  const hud = document.querySelector("#aura-root .aura-hud");
  if (!hud) return;
  if (!el || !el.isConnected) {
    el = document.createElement("div");
    el.className = "aura-hud-hint";
    el.setAttribute("role", "status");
    const foot = hud.querySelector(".aura-hud-foot");
    hud.insertBefore(el, foot ?? null);
  }
  el.textContent = `Deciding between ${short(items[0].title)} and ${short(items[1].title)}? Say “compare them”.`;
  el.classList.add("on");
  clearTimeout(timer);
  timer = setTimeout(hide, 9000);
});

bus.on("UTTERANCE", ({ final }) => { if (final) hide(); });
