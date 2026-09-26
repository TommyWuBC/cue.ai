// Cue's face. A small SVG robot driven by springs, reacting only to real events
// on the bus: it looks where the shopper looks, listens while they hold space,
// thinks while a request is in flight, talks while speech plays, and is happy
// or concerned depending on what it just said. Presentation only: it never
// emits events and never touches the page.
import { bus } from "./bus.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now();

// ── Shared mood, fed by the bus ─────────────────────────────────────────────
const mood = {
  listening: false, hearingUntil: 0, thinking: false, thinkingSince: 0,
  happyUntil: 0, concernUntil: 0, qualityLow: false, noticeUntil: 0,
  gaze: null, gazeAt: 0,
};

const HAPPY = /^(added|demo order recorded|passkey ready|calibration done|cue is ready)/i;
const CONCERN = /(sorry|couldn'?t|can'?t|don'?t see|exceed|unavailable|only see|lost my connection|is empty|first\.?$)/i;

bus.on("STATE", s => { if (s.ptt !== undefined) mood.listening = s.ptt; });
bus.on("UTTERANCE", ({ final }) => {
  mood.hearingUntil = now() + 900;
  if (final) { mood.thinking = true; mood.thinkingSince = now(); }
});
bus.on("SAY", ({ text = "" }) => {
  mood.thinking = false;
  if (HAPPY.test(text)) mood.happyUntil = now() + 1800;
  else if (CONCERN.test(text)) mood.concernUntil = now() + 2200;
});
bus.on("GAZE", ({ x, y }) => { mood.gaze = { x, y }; mood.gazeAt = now(); });
bus.on("FOCUS", ({ target }) => { if (target) mood.noticeUntil = now() + 320; });
bus.on("GAZE_QUALITY", ({ low }) => { mood.qualityLow = low; });

const speaking = () => !!window.cue?.voice?.getVoiceState?.().speaking;

// ── Springs ─────────────────────────────────────────────────────────────────
class Spring {
  constructor(v, k = 170, c = 18) { this.v = v; this.t = v; this.vel = 0; this.k = k; this.c = c; }
  step(dt) {
    const a = this.k * (this.t - this.v) - this.c * this.vel;
    this.vel += a * dt; this.v += this.vel * dt;
    return this.v;
  }
  kick(impulse) { this.vel += impulse; }
}

// ── Artwork ─────────────────────────────────────────────────────────────────
let uid = 0;
function art(id) {
  return `
<svg viewBox="0 0 120 120" role="img" aria-label="Cue" focusable="false">
  <defs>
    <linearGradient id="${id}-shell" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e6e7ec"/>
    </linearGradient>
    <linearGradient id="${id}-visor" x1="0" y1="0" x2=".35" y2="1">
      <stop offset="0" stop-color="#2a2d35"/><stop offset="1" stop-color="#0f1014"/>
    </linearGradient>
    <radialGradient id="${id}-iris" cx=".5" cy=".4" r=".7">
      <stop offset="0" stop-color="#e9f3ff"/><stop offset=".55" stop-color="#9cc6ff"/><stop offset="1" stop-color="#5b92ff"/>
    </radialGradient>
    <filter id="${id}-glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="2.4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="${id}-shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="3" stdDeviation="3.2" flood-color="#1d1d1f" flood-opacity=".16"/>
    </filter>
    <clipPath id="${id}-clip"><rect x="27" y="37" width="66" height="48" rx="19"/></clipPath>
  </defs>
  <ellipse class="cue-av-floor" cx="60" cy="112" rx="26" ry="3.2" fill="#1d1d1f" opacity=".08"/>
  <g class="cue-av-body">
    <g class="cue-av-antenna">
      <path d="M60 24 V13" stroke="#c9ccd4" stroke-width="3" stroke-linecap="round"/>
      <circle class="cue-av-bulb-glow" cx="60" cy="10" r="7" fill="#2f6bff" opacity="0"/>
      <circle class="cue-av-bulb" cx="60" cy="10" r="4.6" fill="#d5d8df"/>
    </g>
    <rect x="9" y="54" width="9" height="20" rx="4.5" fill="#d9dbe1"/>
    <rect x="102" y="54" width="9" height="20" rx="4.5" fill="#d9dbe1"/>
    <rect x="16" y="22" width="88" height="80" rx="31" fill="url(#${id}-shell)" filter="url(#${id}-shadow)"/>
    <rect x="16.5" y="22.5" width="87" height="79" rx="30.5" fill="none" stroke="#000" stroke-opacity=".05"/>
    <rect x="27" y="37" width="66" height="48" rx="19" fill="url(#${id}-visor)"/>
    <g clip-path="url(#${id}-clip)">
      <g class="cue-av-face">
        <ellipse class="cue-av-cheek" cx="37" cy="70" rx="5.5" ry="3" fill="#ff8fa8" opacity="0"/>
        <ellipse class="cue-av-cheek" cx="83" cy="70" rx="5.5" ry="3" fill="#ff8fa8" opacity="0"/>
        <g filter="url(#${id}-glow)">
          <g class="cue-av-eye" data-side="-1">
            <g class="cue-av-open">
              <rect x="-5.5" y="-7.5" width="11" height="15" rx="5.5" fill="url(#${id}-iris)"/>
              <circle cx="-2" cy="-3.6" r="1.7" fill="#fff" opacity=".9"/>
            </g>
            <path class="cue-av-brow" d="M-5.5 0 H5.5" stroke="#9cc6ff" stroke-width="2.4" stroke-linecap="round" opacity="0"/>
            <path class="cue-av-happy" d="M-6 2.5 Q0 -6 6 2.5" fill="none" stroke="#b9d6ff" stroke-width="3.2" stroke-linecap="round" opacity="0"/>
          </g>
          <g class="cue-av-eye" data-side="1">
            <g class="cue-av-open">
              <rect x="-5.5" y="-7.5" width="11" height="15" rx="5.5" fill="url(#${id}-iris)"/>
              <circle cx="-2" cy="-3.6" r="1.7" fill="#fff" opacity=".9"/>
            </g>
            <path class="cue-av-brow" d="M-5.5 0 H5.5" stroke="#9cc6ff" stroke-width="2.4" stroke-linecap="round" opacity="0"/>
            <path class="cue-av-happy" d="M-6 2.5 Q0 -6 6 2.5" fill="none" stroke="#b9d6ff" stroke-width="3.2" stroke-linecap="round" opacity="0"/>
          </g>
          <rect class="cue-av-mouth" x="-5" y="-1.2" width="10" height="2.4" rx="1.2" fill="#9cc6ff" opacity=".85"/>
          <path class="cue-av-smile" d="M-6 -1.5 Q0 4 6 -1.5" fill="none" stroke="#9cc6ff" stroke-width="2.4" stroke-linecap="round" opacity="0"/>
        </g>
      </g>
      <path d="M27 50 Q30 38 44 37 H64 Q40 42 27 58 Z" fill="#fff" opacity=".07"/>
    </g>
  </g>
</svg>`;
}

// ── One rig per mounted avatar ──────────────────────────────────────────────
const rigs = new Set();

class Rig {
  constructor(host) {
    const id = `cue-av-${++uid}`;
    host.insertAdjacentHTML("beforeend", art(id));
    this.host = host;
    this.svg = host.lastElementChild;
    const $ = s => this.svg.querySelector(s);
    const $$ = s => [...this.svg.querySelectorAll(s)];
    this.el = {
      body: $(".cue-av-body"), floor: $(".cue-av-floor"), face: $(".cue-av-face"),
      eyes: $$(".cue-av-eye"), open: $$(".cue-av-open"), happy: $$(".cue-av-happy"),
      cheeks: $$(".cue-av-cheek"), brows: $$(".cue-av-brow"), mouth: $(".cue-av-mouth"), smile: $(".cue-av-smile"),
      bulb: $(".cue-av-bulb"), bulbGlow: $(".cue-av-bulb-glow"),
    };
    this.s = {
      lx: new Spring(0, 120, 16), ly: new Spring(0, 120, 16),
      scale: new Spring(1, 260, 16), squint: new Spring(1, 200, 20),
      happy: new Spring(0, 160, 20), concern: new Spring(0, 140, 18),
      mouth: new Spring(2.4, 520, 24), smile: new Spring(0, 160, 20),
      glow: new Spring(0, 90, 14), tilt: new Spring(0, 90, 11),
      y: new Spring(0, 220, 13),
    };
    this.blinkAt = now() + 1500; this.blinkStart = -1; this.doubleBlink = false;
    this.wanderAt = 0; this.wander = { x: 0, y: 0 };
    this.lastHappy = 0;
  }

  frame(t, dt) {
    const s = this.s, m = mood, calm = reduced.matches;
    const listening = m.listening || t < m.hearingUntil;
    const thinking = m.thinking && t - m.thinkingSince < 8000;
    const talking = speaking();
    const happy = t < m.happyUntil;
    const concerned = !happy && (t < m.concernUntil || m.qualityLow);

    // Where to look: the shopper's gaze if we have it, otherwise idle wandering.
    const r = this.host.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let lx = 0, ly = 0;
    if (thinking) {
      lx = Math.sin(t / 260) * 4.5; ly = -3.5;
    } else if (m.gaze && t - m.gazeAt < 1500) {
      const dx = m.gaze.x - cx, dy = m.gaze.y - cy;
      const d = Math.hypot(dx, dy) || 1, reach = clamp(d / 420, 0, 1);
      lx = (dx / d) * 8.5 * reach; ly = (dy / d) * 5.5 * reach;
    } else if (!calm) {
      if (t > this.wanderAt) {
        this.wanderAt = t + 1600 + Math.random() * 2600;
        this.wander = Math.random() < .35 ? { x: 0, y: 0 }
          : { x: (Math.random() * 2 - 1) * 5, y: (Math.random() * 2 - 1) * 3 };
      }
      lx = this.wander.x; ly = this.wander.y;
    }
    s.lx.t = lx; s.ly.t = ly;

    s.scale.t = t < m.noticeUntil ? 1.14 : listening ? 1.12 : 1;
    s.squint.t = thinking ? .62 : concerned ? .78 : 1;
    s.happy.t = happy ? 1 : 0;
    s.smile.t = happy ? 1 : 0;
    s.concern.t = concerned ? 1 : 0;
    s.glow.t = listening ? 1 : thinking ? .55 : 0;
    s.tilt.t = listening ? -5 : concerned ? 4 : 0;
    if (happy && this.lastHappy !== m.happyUntil) { this.lastHappy = m.happyUntil; if (!calm) s.y.kick(-70); }

    // Talking: a mouth that moves like speech, not like a sine wave.
    if (talking) {
      const n = Math.sin(t / 55) * .5 + Math.sin(t / 97 + 1.3) * .35 + Math.sin(t / 31 + .4) * .15;
      s.mouth.t = 3.2 + Math.max(0, n) * 6.5;
    } else s.mouth.t = 2.4;

    for (const k in s) s[k].step(dt);

    // Blink: every few seconds, sometimes twice. Never while happy (eyes are arcs).
    let open = 1;
    if (calm) this.blinkAt = Infinity;
    else if (this.blinkAt === Infinity) this.blinkAt = t + 1500;
    if (this.blinkStart < 0 && t > this.blinkAt && !happy) { this.blinkStart = t; this.doubleBlink = Math.random() < .22; }
    if (this.blinkStart >= 0) {
      const p = (t - this.blinkStart) / 150;
      if (p >= 1) {
        this.blinkStart = this.doubleBlink ? t + 90 : -1;
        this.doubleBlink = false;
        if (this.blinkStart < 0) this.blinkAt = t + 2200 + Math.random() * 3800;
      } else if (p > 0) open = 1 - Math.sin(Math.PI * p);
    }

    // Breathing: the whole head floats a little.
    const breathe = calm ? 0 : Math.sin(t / 620) * 1.3;
    const e = this.el;
    e.body.setAttribute("transform",
      `translate(0 ${(breathe + s.y.v).toFixed(2)}) rotate(${s.tilt.v.toFixed(2)} 60 62)`);
    e.floor.setAttribute("rx", (26 - (breathe + s.y.v) * .6).toFixed(2));
    e.face.setAttribute("transform", `translate(${s.lx.v.toFixed(2)} ${s.ly.v.toFixed(2)})`);

    const openness = Math.max(.08, open * s.squint.v);
    e.eyes.forEach((eye, i) => {
      const side = i ? 1 : -1;
      const rot = side * -6 * s.concern.v;
      eye.setAttribute("transform",
        `translate(${60 + side * 13} 60) rotate(${rot.toFixed(2)}) scale(${s.scale.v.toFixed(3)})`);
      e.open[i].setAttribute("transform", `scale(1 ${openness.toFixed(3)})`);
      e.open[i].setAttribute("opacity", (1 - s.happy.v).toFixed(3));
      e.happy[i].setAttribute("opacity", s.happy.v.toFixed(3));
      // Worried brows: inner ends lifted.
      e.brows[i].setAttribute("transform",
        `translate(0 ${(-12.5 + 2 * (1 - s.concern.v)).toFixed(2)}) rotate(${(side * 17 * s.concern.v).toFixed(2)})`);
      e.brows[i].setAttribute("opacity", clamp(s.concern.v, 0, 1).toFixed(3));
    });
    e.cheeks.forEach(c => c.setAttribute("opacity", (.55 * s.happy.v).toFixed(3)));

    const mh = s.mouth.v, mw = 10 - Math.max(0, mh - 3) * .35;
    e.mouth.setAttribute("x", (60 - mw / 2).toFixed(2)); e.mouth.setAttribute("width", mw.toFixed(2));
    e.mouth.setAttribute("y", (75 - mh / 2).toFixed(2)); e.mouth.setAttribute("height", mh.toFixed(2));
    e.mouth.setAttribute("rx", (Math.min(mw, mh) / 2).toFixed(2));
    e.mouth.setAttribute("opacity", (.85 * (1 - s.smile.v)).toFixed(3));
    e.smile.setAttribute("transform", "translate(60 75)");
    e.smile.setAttribute("opacity", s.smile.v.toFixed(3));

    const g = s.glow.v, pulse = calm ? 1 : .75 + .25 * Math.sin(t / 180);
    e.bulb.setAttribute("fill", g > .15 ? "#2f6bff" : "#d5d8df");
    e.bulbGlow.setAttribute("opacity", (clamp(g, 0, 1) * .35 * pulse).toFixed(3));

    this.host.dataset.state = happy ? "happy" : concerned ? "concerned" : talking ? "talking"
      : thinking ? "thinking" : listening ? "listening" : "idle";
  }
}

let last = 0, running = false;
function loop(t) {
  const dt = Math.min(.05, (t - (last || t)) / 1000); last = t;
  for (const rig of rigs) {
    if (!rig.host.isConnected) { rigs.delete(rig); continue; }
    rig.frame(t, dt);
  }
  if (rigs.size) requestAnimationFrame(loop); else running = false;
}

export function mountAvatar(host) {
  host.classList.add("cue-avatar");
  const rig = new Rig(host);
  rigs.add(rig);
  if (!running) { running = true; requestAnimationFrame(loop); }
  return rig;
}

// Demo and testing hook: cue.avatar.react("happy" | "concerned" | "thinking").
export function react(kind, ms = 1800) {
  if (kind === "happy") mood.happyUntil = now() + ms;
  if (kind === "concerned") mood.concernUntil = now() + ms;
  if (kind === "thinking") { mood.thinking = true; mood.thinkingSince = now(); setTimeout(() => { mood.thinking = false; }, ms); }
}

// Modal dialogs (order review, bag) render in the browser's top layer, above
// any z-index. Cue has to stay visible over them — it is reading the order back —
// so its layer joins the top layer too, and re-enters it after each modal opens.
function raise() {
  const root = document.getElementById("aura-root");
  if (!root?.showPopover) return;
  root.popover = "manual";
  try { if (root.matches(":popover-open")) root.hidePopover(); root.showPopover(); } catch {}
}
new MutationObserver(records => {
  if (records.some(r => r.target.localName === "dialog" && r.target.open)) raise();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["open"], subtree: true });

// The focus outline glides between targets, but must stay glued to its target
// while the page scrolls, so its transition is suspended during a scroll.
let scrollIdle;
addEventListener("scroll", () => {
  const root = document.getElementById("aura-root");
  if (!root) return;
  root.classList.add("cue-scrolling");
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(() => root.classList.remove("cue-scrolling"), 140);
}, { passive: true });

// Seat the avatar in Cue's dock as soon as aura.js has built it.
function seat() {
  const hud = document.querySelector("#aura-root .aura-hud");
  if (!hud || hud.querySelector(".cue-avatar")) return !!hud;
  const slot = document.createElement("div");
  hud.prepend(slot);
  mountAvatar(slot);
  raise();
  return true;
}
if (!seat()) {
  const mo = new MutationObserver(() => { if (seat()) mo.disconnect(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
window.cueAvatar = { mountAvatar, react, mood };
