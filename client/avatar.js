// Cue's face: the Cue mark, driven by springs. The two Cs hold still and the
// dot is the eye. Everything it does answers something real: the eye looks
// where the shopper looks, glances at clicks, turns blue and sends rings while
// it hears words, scans while a request is in flight, pulses with the words it
// is saying, and the mark hops, tilts or shakes depending on how the reply
// went. The eye droops when nothing has happened for a while. Presentation
// only: it never emits events and never touches the page beyond its own dock.
import { bus } from "./bus.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now();
const SLEEPY_AFTER_MS = 30000;
const CHARS_PER_SEC = 14.5;           // roughly how fast Grok and ElevenLabs read

// ── Shared mood, fed by the bus and the page ────────────────────────────────
const mood = {
  ptt: false, awake: false, hearingUntil: 0, thinking: false, thinkingSince: 0,
  happyUntil: 0, concernUntil: 0, curiousUntil: 0, qualityLow: false,
  gaze: null, gazeAt: 0, look: null, hovered: false, activity: now(),
  said: "", speech: null, lastUtteranceAt: 0,
};
// Short, one-off reactions. Every rig replays any it has not seen yet.
const pulses = [];
let pulseId = 0;
function pulse(kind, data = {}) {
  pulses.push({ id: ++pulseId, kind, data, at: now() });
  if (pulses.length > 40) pulses.shift();
}
function active() {
  if (now() - mood.activity > SLEEPY_AFTER_MS - 1000 && sleepiness > .5) pulse("perk");
  mood.activity = now();
}
let sleepiness = 0;

const HAPPY = /^(added|order approved|demo order recorded|passkey ready|calibration done|cue is ready|removed the|opening )/i;
const CONCERN = /(sorry|couldn'?t|can'?t|don'?t|isn'?t|only see|lost my connection|is empty|already empty|first\.?$|cancel|stopped|need to hear you)/i;
const ACK = /^(okay|ok|got it|sure)\b/i;

bus.on("STATE", s => {
  if (s.ptt !== undefined) { mood.ptt = s.ptt; if (s.ptt) { pulse("ping"); active(); } }
  if (s.awake) { pulse("perk"); active(); }
});
function heard(final) {
  mood.hearingUntil = now() + 900;
  active();
  if (now() - mood.lastUtteranceAt > 220) { pulse("ping", { soft: true }); mood.lastUtteranceAt = now(); }
  if (final) { mood.thinking = true; mood.thinkingSince = now(); }
}
bus.on("UTTERANCE", ({ final }) => heard(final));
bus.on("STT", ({ final }) => { if (!final) heard(false); });
bus.on("SAY", ({ text = "" }) => {
  mood.thinking = false;
  mood.said = text;
  active();
  if (HAPPY.test(text)) { mood.happyUntil = now() + 1900; pulse("celebrate"); }
  else if (CONCERN.test(text)) { mood.concernUntil = now() + 2300; pulse("shake"); }
  else if (/\?\s*$/.test(text)) { mood.curiousUntil = now() + 2600; pulse("tilt"); }
  else if (ACK.test(text)) pulse("nod");
});
bus.on("GAZE", ({ x, y }) => {
  if (mood.gaze && Math.hypot(x - mood.gaze.x, y - mood.gaze.y) > 40) active();
  mood.gaze = { x, y }; mood.gazeAt = now();
});
bus.on("FOCUS", ({ target }) => {
  if (!target) return;
  // A focus that lands right after the shopper spoke is a voice selection.
  pulse(now() - mood.lastUtteranceAt < 2500 ? "nod" : "notice");
});
bus.on("GAZE_QUALITY", ({ low }) => { mood.qualityLow = low; });

// Real clicks: glance at them. Buttons get a small nod, Cue itself gets booped.
addEventListener("pointerdown", e => {
  if (!e.isTrusted) return;
  active();
  if (e.target.closest?.(".cue-avatar")) { pulse("boop"); mood.happyUntil = now() + 800; return; }
  mood.look = { x: e.clientX, y: e.clientY, until: now() + 900 };
  pulse(e.target.closest?.("button, a, [data-aura-action], [data-cue-action]") ? "nod" : "notice");
}, { capture: true, passive: true });
addEventListener("keydown", active, { passive: true });

let lastScroll = scrollY;
addEventListener("scroll", () => {
  const d = scrollY - lastScroll; lastScroll = scrollY;
  if (Math.abs(d) > 2) pulse("glance", { dy: clamp(d, -60, 60) });
  active();
}, { passive: true });

const voiceState = () => window.cue?.voice?.getVoiceState?.() ?? {};

// ── Speech shapes: how open each letter is, for the eye's pulse ─────────────
function viseme(ch) {
  if (!ch) return .1;
  if ("ao".includes(ch)) return 1;
  if ("eiy".includes(ch)) return .7;
  if ("u".includes(ch)) return .8;
  if ("mbp".includes(ch)) return 0;
  if (" \n".includes(ch)) return .12;
  if (",.;:!?—-".includes(ch)) return 0;
  return .35;
}

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

// ── Artwork: the Cue mark on its charcoal tile ──────────────────────────────
// Geometry follows the logo on a 120 grid: an outer C open to the right, an
// inner C whose left side merges into it, and the dot in the inner C's mouth.
// The two Cs never move. The dot is the eye.
let uid = 0;
const STAR = "M0 -5 C0.6 -1.2 1.2 -0.6 5 0 C1.2 0.6 0.6 1.2 0 5 C-0.6 1.2 -1.2 0.6 -5 0 C-1.2 -0.6 -0.6 -1.2 0 -5Z";
const OUTER = { cx: 60, cy: 60, r: 36, w: 6 };
const INNER = { cx: 45, cy: 60, r: 20, w: 5.4 };
const DOT = { x: 72, y: 60, r: 6.8 };
const TIPS = [[60.32, 47.14], [60.32, 72.86]];        // the inner C's two ends
const BONE = "#f4f3ef";

// Keep the eye clear of the strokes, whatever the springs are doing.
function confine(x, y, scale) {
  const r = DOT.r * scale;
  x = Math.max(x, 61);                                  // it may peek into the inner C, not enter
  for (const [tx, ty] of TIPS) {
    const dx = x - tx, dy = y - ty, d = Math.hypot(dx, dy) || 1, min = r + INNER.w / 2 + .8;
    if (d < min) { x = tx + dx / d * min; y = ty + dy / d * min; }
  }
  const dx = x - OUTER.cx, dy = y - OUTER.cy, d = Math.hypot(dx, dy) || 1;
  const max = OUTER.r - OUTER.w / 2 - r - 1.2;
  if (d > max) { x = OUTER.cx + dx / d * max; y = OUTER.cy + dy / d * max; }
  return [x, y];
}

function art(id) {
  return `
<svg viewBox="0 0 120 120" role="img" aria-label="Cue" focusable="false">
  <defs>
    <linearGradient id="${id}-tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a2a2a"/><stop offset="1" stop-color="#1a1a1a"/>
    </linearGradient>
    <filter id="${id}-shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="3" stdDeviation="3.4" flood-color="#000" flood-opacity=".22"/>
    </filter>
    <filter id="${id}-glow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="2.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="${id}-clip"><rect x="6" y="6" width="108" height="108" rx="30"/></clipPath>
  </defs>
  <g class="cue-av-body">
    <rect x="6" y="6" width="108" height="108" rx="30" fill="url(#${id}-tile)" filter="url(#${id}-shadow)"/>
    <rect x="6.5" y="6.5" width="107" height="107" rx="29.5" fill="none" stroke="#fff" stroke-opacity=".06"/>
    <g clip-path="url(#${id}-clip)">
      <g class="cue-av-mark">
        <path d="M88.37 37.83 A36 36 0 1 0 88.37 82.17" fill="none" stroke="${BONE}" stroke-width="${OUTER.w}"/>
        <path d="M60.32 47.14 A20 20 0 1 0 60.32 72.86" fill="none" stroke="${BONE}" stroke-width="${INNER.w}"/>
        <circle class="cue-av-ring" cx="${DOT.x}" cy="${DOT.y}" r="8" fill="none" stroke="${BONE}" stroke-width="1.4" opacity="0"/>
        <circle class="cue-av-ring" cx="${DOT.x}" cy="${DOT.y}" r="8" fill="none" stroke="${BONE}" stroke-width="1.4" opacity="0"/>
        <circle class="cue-av-ring" cx="${DOT.x}" cy="${DOT.y}" r="8" fill="none" stroke="${BONE}" stroke-width="1.4" opacity="0"/>
        <g class="cue-av-eye">
          <circle class="cue-av-halo" r="11" fill="#2f6bff" opacity="0"/>
          <circle class="cue-av-dot" r="${DOT.r}" fill="${BONE}"/>
          <circle class="cue-av-live" r="${DOT.r}" fill="#6e9bff" opacity="0" filter="url(#${id}-glow)"/>
        </g>
      </g>
    </g>
  </g>
  <g class="cue-av-sparkles">${Array.from({ length: 6 }, () =>
    `<path d="${STAR}" fill="#7fb0ff" opacity="0"/>`).join("")}</g>
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
      body: $(".cue-av-body"), mark: $(".cue-av-mark"), eye: $(".cue-av-eye"),
      dot: $(".cue-av-dot"), live: $(".cue-av-live"), halo: $(".cue-av-halo"),
      rings: $$(".cue-av-ring"), sparkles: $$(".cue-av-sparkles path"),
    };
    this.s = {
      lx: new Spring(0, 120, 16), ly: new Spring(0, 120, 16),
      size: new Spring(1, 260, 16), glow: new Spring(0, 90, 14), dim: new Spring(1, 60, 12),
      tilt: new Spring(0, 90, 11), y: new Spring(0, 220, 13), eyeY: new Spring(0, 300, 14),
      shake: new Spring(0, 320, 7), squash: new Spring(0, 380, 10), talk: new Spring(0, 620, 26),
      sleepy: new Spring(0, 30, 10),
    };
    this.blinkAt = now() + 1500; this.blinkStart = -1; this.doubleBlink = false;
    this.wanderAt = 0; this.wander = { x: 0, y: 0 };
    this.seen = pulseId;
    this.rings = [];            // { el, at, soft, x, y }
    this.stars = [];            // { el, at, a, r, size }
    this.wasSpeaking = false; this.wordAt = -1;
    this.eyeAt = [DOT.x, DOT.y];
  }

  react(p, t, calm) {
    const s = this.s;
    switch (p.kind) {
      case "celebrate":
        if (!calm) { s.y.kick(-90); s.squash.kick(-14); this.burst(t); }
        s.size.kick(3);
        break;
      case "boop":
        s.squash.kick(26); s.size.kick(-3);
        if (!calm) this.burst(t, 3);
        break;
      case "perk":
        this.ring(t); s.size.kick(4);
        if (!calm) { s.y.kick(-45); s.squash.kick(-8); }
        break;
      case "ping":
        this.ring(t, p.data.soft);
        if (!calm) s.eyeY.kick(p.data.soft ? 10 : 18);
        break;
      case "nod":
        if (!calm) s.eyeY.kick(70);
        s.size.kick(1.5);
        break;
      case "notice":
        s.size.kick(2.6);
        break;
      case "shake":
        if (!calm) s.shake.kick(160);
        break;
      case "tilt":
        if (!calm) s.y.kick(-20);
        break;
      case "glance":
        if (!calm) s.ly.kick(clamp(p.data.dy, -60, 60) * .9);
        break;
    }
  }

  ring(t, soft = false) {
    const free = this.el.rings.find(el => !this.rings.some(r => r.el === el)) ?? this.rings.shift()?.el;
    if (free) this.rings.push({ el: free, at: t, soft, x: this.eyeAt[0], y: this.eyeAt[1] });
  }

  burst(t, n = 5) {
    this.stars = [];
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = base + (i / n) * Math.PI * 2 + (Math.random() - .5) * .5;
      this.stars.push({ el: this.el.sparkles[i], at: t + i * 35, a, r: 60 + Math.random() * 8, size: 1 + Math.random() * .45 });
    }
  }

  frame(t, dt) {
    const s = this.s, m = mood, calm = reduced.matches;
    for (const p of pulses) if (p.id > this.seen) { this.seen = p.id; this.react(p, t, calm); }

    const vs = voiceState();
    const talking = !!vs.speaking;
    const awake = !!vs.awake;
    const listening = m.ptt || awake || t < m.hearingUntil;
    const thinking = m.thinking && t - m.thinkingSince < 8000 && !talking;
    const happy = t < m.happyUntil;
    const concerned = !happy && (t < m.concernUntil || m.qualityLow);
    const curious = !happy && !concerned && t < m.curiousUntil;
    const idleFor = t - m.activity;
    sleepiness = s.sleepy.v;
    s.sleepy.t = !calm && idleFor > SLEEPY_AFTER_MS && !talking && !listening && !thinking ? 1 : 0;

    // ── Where the eye looks ──────────────────────────────────────────────
    const r = this.host.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const toward = (x, y, reachPx = 420) => {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1, reach = clamp(d / reachPx, 0, 1);
      return [(dx / d) * 13 * reach, (dy / d) * 12 * reach];
    };
    let lx = 0, ly = 0;
    if (thinking) {
      lx = Math.sin(t / 260) * 6; ly = -6;
    } else if (m.look && t < m.look.until) {
      [lx, ly] = toward(m.look.x, m.look.y);
    } else if (m.gaze && t - m.gazeAt < 1500) {
      [lx, ly] = toward(m.gaze.x, m.gaze.y);
    } else if (!calm) {
      if (t > this.wanderAt) {
        this.wanderAt = t + (s.sleepy.v > .5 ? 5000 : 1600) + Math.random() * 2600;
        this.wander = Math.random() < .35 ? { x: 0, y: 0 }
          : { x: (Math.random() * 2 - 1) * 6, y: (Math.random() * 2 - 1) * 5 };
      }
      lx = this.wander.x; ly = this.wander.y;
    }
    if (curious) { lx += 3; ly -= 4; }
    if (concerned) ly += 3;
    ly += s.sleepy.v * 7;
    s.lx.t = lx; s.ly.t = ly;

    // ── Expression targets ───────────────────────────────────────────────
    s.size.t = listening ? 1.18 : thinking ? .9 : concerned ? .86 : happy ? 1.1 : m.hovered ? 1.06 : 1;
    s.glow.t = listening ? 1 : thinking ? .4 : 0;
    s.dim.t = 1 - s.sleepy.v * .45;
    s.tilt.t = listening ? -4 : curious ? 8 : concerned ? 3 : s.sleepy.v * 5;

    // ── Talking: the eye pulses with the words, a small bob at each word ─
    if (talking && !this.wasSpeaking) { m.speech = { text: m.said.toLowerCase(), start: t }; this.wordAt = -1; }
    this.wasSpeaking = talking;
    if (talking && m.speech) {
      const i = Math.floor((t - m.speech.start) / 1000 * CHARS_PER_SEC);
      const text = m.speech.text;
      let open;
      if (i < text.length) {
        const ch = text[i];
        open = viseme(ch);
        const wordStart = i > 0 && text[i - 1] === " " && ch !== " ";
        if (wordStart && i !== this.wordAt) { this.wordAt = i; if (!calm) s.eyeY.kick(12); }
      } else {
        open = Math.max(0, Math.sin(t / 70) * .5 + Math.sin(t / 113) * .3);
      }
      s.talk.t = open;
    } else s.talk.t = 0;

    for (const k in s) s[k].step(dt);

    // ── Blink: the dot squashes flat for a moment ────────────────────────
    let open = 1;
    if (calm) this.blinkAt = Infinity;
    else if (this.blinkAt === Infinity) this.blinkAt = t + 1500;
    if (this.blinkStart < 0 && t > this.blinkAt && !happy) { this.blinkStart = t; this.doubleBlink = Math.random() < .22; }
    if (this.blinkStart >= 0) {
      const p = (t - this.blinkStart) / (150 + s.sleepy.v * 250);
      if (p >= 1) {
        this.blinkStart = this.doubleBlink ? t + 90 : -1;
        this.doubleBlink = false;
        if (this.blinkStart < 0) this.blinkAt = t + 2200 + Math.random() * 3800;
      } else if (p > 0) open = 1 - Math.sin(Math.PI * p);
    }

    // ── Tile ─────────────────────────────────────────────────────────────
    const breathe = calm ? 0 : Math.sin(t / (620 + s.sleepy.v * 500)) * (1 + s.sleepy.v * .5);
    const e = this.el;
    const lift = breathe + s.y.v;
    const sq = clamp(s.squash.v, -12, 12) * .012;               // + squash, - stretch
    e.body.setAttribute("transform",
      `translate(60 114) scale(${(1 + sq).toFixed(4)} ${(1 - sq).toFixed(4)}) translate(-60 -114) translate(0 ${lift.toFixed(2)})`);
    e.mark.setAttribute("transform", `rotate(${(s.tilt.v + s.shake.v * .09).toFixed(2)} 60 60)`);

    // ── The eye ──────────────────────────────────────────────────────────
    const size = Math.max(.4, s.size.v * (1 + s.talk.v * .26));
    const [ex, ey] = confine(DOT.x + s.lx.v + s.shake.v * .02, DOT.y + s.ly.v + s.eyeY.v * .06, size);
    this.eyeAt = [ex, ey];
    const lid = Math.max(.1, open);
    e.eye.setAttribute("transform",
      `translate(${ex.toFixed(2)} ${ey.toFixed(2)}) scale(${size.toFixed(3)} ${(size * lid).toFixed(3)})`);
    e.eye.setAttribute("opacity", s.dim.v.toFixed(3));
    const g = clamp(s.glow.v, 0, 1), pulseGlow = calm ? 1 : .75 + .25 * Math.sin(t / 180);
    e.live.setAttribute("opacity", (g * .9).toFixed(3));
    e.halo.setAttribute("opacity", (g * .28 * pulseGlow).toFixed(3));

    // ── Rings from the eye when words arrive ─────────────────────────────
    this.rings = this.rings.filter(rg => {
      const p = (t - rg.at) / (rg.soft ? 520 : 700);
      if (p >= 1) { rg.el.setAttribute("opacity", "0"); return false; }
      rg.el.setAttribute("cx", rg.x.toFixed(2)); rg.el.setAttribute("cy", rg.y.toFixed(2));
      rg.el.setAttribute("r", (8 + p * (rg.soft ? 8 : 14)).toFixed(2));
      rg.el.setAttribute("opacity", ((1 - p) * (rg.soft ? .3 : .55)).toFixed(3));
      return true;
    });

    // ── Sparkles on success ──────────────────────────────────────────────
    this.stars = this.stars.filter(st => {
      const p = (t - st.at) / 720;
      if (p < 0) return true;
      if (p >= 1) { st.el.setAttribute("opacity", "0"); return false; }
      const ease = 1 - Math.pow(1 - p, 3);
      const x = 60 + Math.cos(st.a) * st.r * (.7 + .3 * ease), y = 60 + Math.sin(st.a) * st.r * (.7 + .3 * ease) + lift;
      const sc = st.size * Math.sin(Math.PI * Math.min(1, p * 1.3));
      st.el.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${(p * 90).toFixed(1)}) scale(${sc.toFixed(3)})`);
      st.el.setAttribute("opacity", (1 - p * .6).toFixed(3));
      return true;
    });

    this.host.dataset.state = happy ? "happy" : concerned ? "concerned" : curious ? "curious"
      : talking ? "talking" : thinking ? "thinking" : listening ? "listening"
      : s.sleepy.v > .5 ? "sleepy" : "idle";
  }
}

let last = 0, running = false;
function loop(t) {
  const dt = Math.min(.05, (t - (last || t)) / 1000); last = t;
  for (const rig of rigs) {
    if (!rig.host.isConnected) { rigs.delete(rig); continue; }
    try { rig.frame(t, dt); } catch (err) { console.error("[cue] avatar frame", err); }
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

// Demo and testing hook: cue.avatar.react("celebrate" | "concerned" | "thinking" | …).
export function react(kind, ms = 1800) {
  const t = now();
  if (kind === "happy" || kind === "celebrate") { mood.happyUntil = t + ms; pulse("celebrate"); }
  else if (kind === "concerned") { mood.concernUntil = t + ms; pulse("shake"); }
  else if (kind === "curious" || kind === "ask") { mood.curiousUntil = t + ms; pulse("tilt"); }
  else if (kind === "thinking") { mood.thinking = true; mood.thinkingSince = t; setTimeout(() => { mood.thinking = false; }, ms); }
  else if (kind === "sleep") mood.activity = t - SLEEPY_AFTER_MS - 1;
  else pulse(kind);
}

// ── The dock around the avatar ──────────────────────────────────────────────
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

// New replies slide in; a live transcript shows a caret while it is still coming.
function animateText(hud) {
  const said = hud.querySelector(".aura-hud-said"), heardEl = hud.querySelector(".aura-hud-heard");
  if (said) new MutationObserver(() => {
    said.classList.remove("cue-enter"); void said.offsetWidth; said.classList.add("cue-enter");
  }).observe(said, { childList: true, characterData: true, subtree: true });
  if (heardEl) new MutationObserver(() => {
    heardEl.classList.toggle("cue-live", heardEl.textContent.startsWith("…"));
  }).observe(heardEl, { childList: true, characterData: true, subtree: true });
}

// Seat the avatar in Cue's dock as soon as aura.js has built it.
function seat() {
  const hud = document.querySelector("#aura-root .aura-hud");
  if (!hud || hud.querySelector(".cue-avatar")) return !!hud;
  const slot = document.createElement("div");
  hud.prepend(slot);
  const rig = mountAvatar(slot);
  hud.addEventListener("pointerenter", () => { mood.hovered = true; });
  hud.addEventListener("pointerleave", () => { mood.hovered = false; });
  hud.addEventListener("pointermove", e => { mood.look = { x: e.clientX, y: e.clientY, until: now() + 400 }; }, { passive: true });
  new MutationObserver(() => { hud.dataset.cueState = slot.dataset.state; })
    .observe(slot, { attributes: true, attributeFilter: ["data-state"] });
  animateText(hud);
  raise();
  return rig;
}
if (!seat()) {
  const mo = new MutationObserver(() => { if (seat()) mo.disconnect(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
window.cueAvatar = { mountAvatar, react, mood };
