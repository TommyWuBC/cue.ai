// ?gazedebug=1 — what the eye tracker is actually doing, on screen.
//
// Two dots on the page (grey: raw model output, blue: what Cue uses after the
// gate, One Euro and fixation stages) and a small panel with the numbers that
// decide whether a session will work: frame rate, inference time, camera-to-
// estimate latency, face/blink, the fitted model and its measured accuracy.
import { bus } from "./bus.js";

export function mount({ eyes, getState }) {
  if (document.getElementById("cue-gaze-debug")) return;
  const root = document.createElement("div");
  root.id = "cue-gaze-debug";
  root.innerHTML = `
    <div class="gd-dot gd-raw"></div><div class="gd-dot gd-out"></div>
    <div class="gd-panel"><b>Gaze</b><pre></pre></div>`;
  document.body.appendChild(root);
  const raw = root.querySelector(".gd-raw"), out = root.querySelector(".gd-out"), pre = root.querySelector("pre");
  try { root.popover = "manual"; root.showPopover(); } catch {}

  bus.on("GAZE_RAW", ({ x, y }) => { raw.classList.add("on"); raw.style.transform = `translate(${x}px, ${y}px)`; });
  bus.on("GAZE", ({ x, y }) => { out.classList.add("on"); out.style.transform = `translate(${x}px, ${y}px)`; });

  setInterval(() => {
    const e = eyes.stats(), s = getState(), a = s.accuracy;
    pre.textContent = [
      `camera   ${e.fps} fps · ${e.delegate ?? "—"} · infer ${e.infer_ms} ms`,
      `latency  ${e.latency_ms || "—"} ms (frame → estimate)`,
      `face     ${e.face ? (e.blink ? "blink" : "tracked") : "not found"}`,
      `model    ${s.model ? `${s.model.kind} · cv ${s.model.cv_px}px · ${s.model.samples} samples` : "not calibrated"}`,
      `accuracy ${a ? `${a.after_px}px validated${a.lag_ms != null ? ` · pursuit lag ${a.lag_ms}ms` : ""}` : "—"}`,
      `state    ${s.fixating ? "fixating" : "moving"} · conf ${(s.conf ?? 0).toFixed(2)} · ${s.focus?.label ?? s.focus?.product?.title ?? "no focus"}`,
    ].join("\n");
  }, 250);
}
