// Cue's face. A small SVG robot driven by springs. Everything it does answers
// something real: it looks where the shopper looks, glances at clicks, perks up
// at its name, leans in and pings while it hears words, shows dots while a
// request is in flight, shapes its mouth to the words it is saying, and hops,
// tilts or shakes its head depending on how the reply went. It drifts off when
// nothing has happened for a while. Presentation only: it never emits events
// and never touches the page beyond its own dock.
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

// ── Speech shapes: a mouth that follows the words actually being said ───────
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
const round = ch => ch === "o" || ch === "u" || ch === "w";

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
const STAR = "M0 -5 C0.6 -1.2 1.2 -0.6 5 0 C1.2 0.6 0.6 1.2 0 5 C-0.6 1.2 -1.2 0.6 -5 0 C-1.2 -0.6 -0.6 -1.2 0 -5Z";
function art(id) {
  const eye = side => `
          <g class="cue-av-eye" data-side="${side}">
            <path class="cue-av-brow" d="M-5.5 0 H5.5" stroke="#9cc6ff" stroke-width="2.4" stroke-linecap="round" opacity="0"/>
            <g class="cue-av-open">
              <rect x="-5.5" y="-7.5" width="11" height="15" rx="5.5" fill="url(#${id}-iris)"/>
              <circle class="cue-av-glint" cx="-2" cy="-3.6" r="1.7" fill="#fff" opacity=".9"/>
            </g>
            <path class="cue-av-happy" d="M-6 2.5 Q0 -6 6 2.5" fill="none" stroke="#b9d6ff" stroke-width="3.2" stroke-linecap="round" opacity="0"/>
          </g>`;
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
      <circle class="cue-av-ring" cx="60" cy="10" r="5" fill="none" stroke="#2f6bff" stroke-width="1.6" opacity="0"/>
      <circle class="cue-av-ring" cx="60" cy="10" r="5" fill="none" stroke="#2f6bff" stroke-width="1.6" opacity="0"/>
      <circle class="cue-av-ring" cx="60" cy="10" r="5" fill="none" stroke="#2f6bff" stroke-width="1.6" opacity="0"/>
      <circle class="cue-av-bulb-glow" cx="60" cy="10" r="7" fill="#2f6bff" opacity="0"/>
      <circle class="cue-av-bulb" cx="60" cy="10" r="4.6" fill="#d5d8df"/>
    </g>
    <rect class="cue-av-ear" data-side="-1" x="9" y="54" width="9" height="20" rx="4.5" fill="#d9dbe1"/>
    <rect class="cue-av-ear" data-side="1" x="102" y="54" width="9" height="20" rx="4.5" fill="#d9dbe1"/>
    <rect x="16" y="22" width="88" height="80" rx="31" fill="url(#${id}-shell)" filter="url(#${id}-shadow)"/>
    <rect x="16.5" y="22.5" width="87" height="79" rx="30.5" fill="none" stroke="#000" stroke-opacity=".05"/>
    <rect x="27" y="37" width="66" height="48" rx="19" fill="url(#${id}-visor)"/>
    <g clip-path="url(#${id}-clip)">
      <g class="cue-av-face">
        <ellipse class="cue-av-cheek" cx="37" cy="70" rx="5.5" ry="3" fill="#ff8fa8" opacity="0"/>
        <ellipse class="cue-av-cheek" cx="83" cy="70" rx="5.5" ry="3" fill="#ff8fa8" opacity="0"/>
        <g filter="url(#${id}-glow)">
          ${eye(-1)}${eye(1)}
          <rect class="cue-av-mouth" x="-5" y="-1.2" width="10" height="2.4" rx="1.2" fill="#9cc6ff" opacity=".85"/>
          <path class="cue-av-smile" d="M-6 -1.5 Q0 4 6 -1.5" fill="none" stroke="#9cc6ff" stroke-width="2.4" stroke-linecap="round" opacity="0"/>
          <g class="cue-av-dots" opacity="0">
            <circle cx="53" cy="75" r="1.9" fill="#9cc6ff"/><circle cx="60" cy="75" r="1.9" fill="#9cc6ff"/><circle cx="67" cy="75" r="1.9" fill="#9cc6ff"/>
          </g>
        </g>
      </g>
      <path d="M27 50 Q30 38 44 37 H64 Q40 42 27 58 Z" fill="#fff" opacity=".07"/>
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
      body: $(".cue-av-body"), floor: $(".cue-av-floor"), face: $(".cue-av-face"),
      eyes: $$(".cue-av-eye"), open: $$(".cue-av-open"), happy: $$(".cue-av-happy"), glints: $$(".cue-av-glint"),
      brows: $$(".cue-av-brow"), cheeks: $$(".cue-av-cheek"), mouth: $(".cue-av-mouth"), smile: $(".cue-av-smile"),
      dots: $(".cue-av-dots"), dot: $$(".cue-av-dots circle"), ears: $$(".cue-av-ear"),
      bulb: $(".cue-av-bulb"), bulbGlow: $(".cue-av-bulb-glow"), rings: $$(".cue-av-ring"),
      sparkles: $$(".cue-av-sparkles path"),
    };
    this.s = {
      lx: new Spring(0, 120, 16), ly: new Spring(0, 120, 16),
      scale: new Spring(1, 260, 16), squint: new Spring(1, 200, 20),
      happy: new Spring(0, 160, 20), concern: new Spring(0, 140, 18), curious: new Spring(0, 140, 18),
      mouth: new Spring(2.4, 620, 26), mouthW: new Spring(10, 400, 24), smile: new Spring(0, 160, 20),
      glow: new Spring(0, 90, 14), tilt: new Spring(0, 90, 11), lean: new Spring(1, 160, 16),
      y: new Spring(0, 220, 13), faceY: new Spring(0, 300, 14), shake: new Spring(0, 320, 7),
      squash: new Spring(0, 380, 10), ear: new Spring(0, 160, 16), dots: new Spring(0, 160, 18),
      sleepy: new Spring(0, 30, 10),
    };
    this.blinkAt = now() + 1500; this.blinkStart = -1; this.doubleBlink = false;
    this.wanderAt = 0; this.wander = { x: 0, y: 0 };
    this.seen = pulseId;
    this.rings = [];            // { el, at }
    this.stars = [];            // { el, at, x, y, r }
    this.wasSpeaking = false; this.wordAt = -1;
  }

  react(p, t, calm) {
    const s = this.s;
    switch (p.kind) {
      case "celebrate":
        if (!calm) { s.y.kick(-90); s.squash.kick(-14); this.burst(t); }
        break;
      case "boop":
        s.squash.kick(26); s.scale.kick(-2);
        if (!calm) this.burst(t, 3);
        break;
      case "perk":
        this.ring(t); s.scale.kick(3.5);
        if (!calm) { s.y.kick(-45); s.squash.kick(-8); }
        break;
      case "ping":
        this.ring(t, p.data.soft);
        if (!calm) s.faceY.kick(p.data.soft ? 8 : 14);
        break;
      case "nod":
        if (!calm) s.faceY.kick(55);
        s.scale.kick(1.2);
        break;
      case "notice":
        s.scale.kick(2.2);
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
    if (free) this.rings.push({ el: free, at: t, soft });
  }

  burst(t, n = 5) {
    this.stars = [];
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = base + (i / n) * Math.PI * 2 + (Math.random() - .5) * .5;
      this.stars.push({ el: this.el.sparkles[i], at: t + i * 35, a, r: 48 + Math.random() * 10, size: 1 + Math.random() * .45 });
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

    // ── Where to look ────────────────────────────────────────────────────
    const r = this.host.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const toward = (x, y, reachPx = 420) => {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1, reach = clamp(d / reachPx, 0, 1);
      return [(dx / d) * 8.5 * reach, (dy / d) * 5.5 * reach];
    };
    let lx = 0, ly = 0;
    if (thinking) {
      lx = Math.sin(t / 260) * 4.5; ly = -3.5;
    } else if (m.look && t < m.look.until) {
      [lx, ly] = toward(m.look.x, m.look.y);
    } else if (m.gaze && t - m.gazeAt < 1500) {
      [lx, ly] = toward(m.gaze.x, m.gaze.y);
    } else if (!calm) {
      if (t > this.wanderAt) {
        this.wanderAt = t + (s.sleepy.v > .5 ? 5000 : 1600) + Math.random() * 2600;
        this.wander = Math.random() < .35 ? { x: 0, y: 0 }
          : { x: (Math.random() * 2 - 1) * 5, y: (Math.random() * 2 - 1) * 3 };
      }
      lx = this.wander.x; ly = this.wander.y + s.sleepy.v * 2.5;
    }
    s.lx.t = lx; s.ly.t = ly;

    // ── Expression targets ───────────────────────────────────────────────
    s.scale.t = listening ? 1.1 : 1;
    s.squint.t = thinking ? .62 : concerned ? .78 : 1;
    s.happy.t = happy ? 1 : 0;
    s.smile.t = happy ? 1 : m.hovered ? .45 : 0;
    s.concern.t = concerned ? 1 : 0;
    s.curious.t = curious ? 1 : 0;
    s.glow.t = listening ? 1 : thinking ? .55 : 0;
    s.ear.t = listening ? 1 : 0;
    s.lean.t = listening ? 1.035 : 1;
    s.dots.t = thinking ? 1 : 0;
    s.tilt.t = listening ? -5 : curious ? 8 : concerned ? 4 : s.sleepy.v * 5;

    // ── Talking: follow the words, with a small bob at each new word ─────
    if (talking && !this.wasSpeaking) { m.speech = { text: m.said.toLowerCase(), start: t }; this.wordAt = -1; }
    this.wasSpeaking = talking;
    if (talking && m.speech) {
      const i = Math.floor((t - m.speech.start) / 1000 * CHARS_PER_SEC);
      const text = m.speech.text;
      let open, ch;
      if (i < text.length) {
        ch = text[i];
        open = viseme(ch);
        const wordStart = i > 0 && text[i - 1] === " " && ch !== " ";
        if (wordStart && i !== this.wordAt) { this.wordAt = i; if (!calm) s.faceY.kick(10); }
      } else {
        // Audio can run longer than our estimate: keep moving, gently.
        open = Math.max(0, Math.sin(t / 70) * .5 + Math.sin(t / 113) * .3);
      }
      s.mouth.t = 2.4 + open * 6.8;
      s.mouthW.t = round(ch) ? 6.5 : 10 - open * 1.5;
    } else {
      s.mouth.t = 2.4; s.mouthW.t = 10;
    }

    for (const k in s) s[k].step(dt);

    // ── Blink: every few seconds, sometimes twice; slow when drowsy ──────
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

    // ── Body ─────────────────────────────────────────────────────────────
    const breathe = calm ? 0 : Math.sin(t / (620 + s.sleepy.v * 500)) * (1.3 + s.sleepy.v * .6);
    const e = this.el;
    const lift = breathe + s.y.v + s.sleepy.v * 1.5;
    const sq = clamp(s.squash.v, -12, 12) * .012;               // + squash, - stretch
    const lean = s.lean.v;
    e.body.setAttribute("transform",
      `translate(60 102) scale(${(lean * (1 + sq)).toFixed(4)} ${(lean * (1 - sq)).toFixed(4)}) translate(-60 -102)` +
      ` translate(0 ${lift.toFixed(2)}) rotate(${(s.tilt.v + s.shake.v * .09).toFixed(2)} 60 62)`);
    e.floor.setAttribute("rx", (26 - lift * .6).toFixed(2));
    e.floor.setAttribute("opacity", (.08 - clamp(-lift, 0, 12) * .004).toFixed(3));
    e.face.setAttribute("transform", `translate(${(s.lx.v + s.shake.v * .02).toFixed(2)} ${(s.ly.v + s.faceY.v * .06).toFixed(2)})`);

    e.ears.forEach(ear => {
      const side = +ear.dataset.side;
      ear.setAttribute("transform", `translate(${(side * s.ear.v * 1.6).toFixed(2)} 0)`);
      ear.setAttribute("fill", s.ear.v > .5 ? "#c5d6ff" : "#d9dbe1");
    });

    // ── Eyes, brows, cheeks ──────────────────────────────────────────────
    const lids = 1 - s.sleepy.v * .62;
    const openness = Math.max(.08, open * s.squint.v * lids);
    e.eyes.forEach((eye, i) => {
      const side = i ? 1 : -1;
      const rot = side * -6 * s.concern.v;
      const tall = 1 + s.curious.v * (side < 0 ? .14 : -.04);
      eye.setAttribute("transform",
        `translate(${60 + side * 13} 60) rotate(${rot.toFixed(2)}) scale(${s.scale.v.toFixed(3)} ${(s.scale.v * tall).toFixed(3)})`);
      e.open[i].setAttribute("transform", `scale(1 ${openness.toFixed(3)})`);
      e.open[i].setAttribute("opacity", (1 - s.happy.v).toFixed(3));
      e.happy[i].setAttribute("opacity", s.happy.v.toFixed(3));
      e.glints[i].setAttribute("r", (1.7 + clamp(s.scale.v - 1, 0, .3) * 3).toFixed(2));
      // Brows: worried (inner ends up) or curious (one raised).
      const c = s.concern.v, q = side < 0 ? s.curious.v : 0;
      e.brows[i].setAttribute("transform",
        `translate(0 ${(-12.5 + 2 * (1 - c) - 2.5 * q).toFixed(2)}) rotate(${(side * 17 * c - 10 * q).toFixed(2)})`);
      e.brows[i].setAttribute("opacity", clamp(c + q, 0, 1).toFixed(3));
    });
    e.cheeks.forEach(ch => ch.setAttribute("opacity", (.55 * s.happy.v).toFixed(3)));

    // ── Mouth, smile, thinking dots ──────────────────────────────────────
    const mh = Math.max(0.1, s.mouth.v), mw = s.mouthW.v;
    const mouthVis = (1 - s.smile.v) * (1 - s.dots.v);
    e.mouth.setAttribute("x", (60 - mw / 2).toFixed(2)); e.mouth.setAttribute("width", mw.toFixed(2));
    e.mouth.setAttribute("y", (75 - mh / 2).toFixed(2)); e.mouth.setAttribute("height", mh.toFixed(2));
    e.mouth.setAttribute("rx", (Math.min(mw, mh) / 2).toFixed(2));
    e.mouth.setAttribute("opacity", (.85 * mouthVis).toFixed(3));
    e.smile.setAttribute("transform", `translate(60 75) scale(${(.7 + .3 * s.smile.v).toFixed(3)})`);
    e.smile.setAttribute("opacity", s.smile.v.toFixed(3));
    e.dots.setAttribute("opacity", s.dots.v.toFixed(3));
    e.dot.forEach((d, i) => d.setAttribute("transform",
      `translate(0 ${(-2.6 * Math.max(0, Math.sin(t / 170 - i * .9))).toFixed(2)})`));

    // ── Antenna: glow while listening, rings when words arrive ───────────
    const g = s.glow.v, pulseGlow = calm ? 1 : .75 + .25 * Math.sin(t / 180);
    e.bulb.setAttribute("fill", g > .15 ? "#2f6bff" : "#d5d8df");
    e.bulbGlow.setAttribute("opacity", (clamp(g, 0, 1) * .35 * pulseGlow).toFixed(3));
    this.rings = this.rings.filter(rg => {
      const p = (t - rg.at) / (rg.soft ? 520 : 700);
      if (p >= 1) { rg.el.setAttribute("opacity", "0"); return false; }
      rg.el.setAttribute("r", (5 + p * (rg.soft ? 7 : 11)).toFixed(2));
      rg.el.setAttribute("opacity", ((1 - p) * (rg.soft ? .35 : .6)).toFixed(3));
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
