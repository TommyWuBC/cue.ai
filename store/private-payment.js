// Visa-track demo payment entry. This is deliberately NOT a payment processor:
// the fixed fictional fixture never leaves component memory or this module.
export const DEMO_FIXTURE = Object.freeze({
  cardNumber: '4242424242424242',
  expiry: '1234',
  securityCode: '123',
});

export const validateDemoFields = fields =>
  fields.cardNumber === DEMO_FIXTURE.cardNumber &&
  fields.expiry === DEMO_FIXTURE.expiry &&
  fields.securityCode === DEMO_FIXTURE.securityCode;

export class DwellActivator {
  constructor({ dwellMs = 1000, now = () => performance.now(), onActivate = () => {} } = {}) {
    this.dwellMs = dwellMs;
    this.now = now;
    this.onActivate = onActivate;
    this.current = null;
    this.since = 0;
    this.locked = null;
  }
  setDuration(ms) { this.dwellMs = Math.max(300, Number(ms) || 1000); this.resetProgress(); }
  resetProgress() { this.current = null; this.since = 0; }
  update(target, reliable = true) {
    if (!reliable) { this.resetProgress(); return { progress: 0, activated: false }; }
    // A reliable look away (or at another control) rearms the previous control.
    if (target !== this.locked) this.locked = null;
    if (!target || target === this.locked) { this.resetProgress(); return { progress: 0, activated: false }; }
    const t = this.now();
    if (target !== this.current) { this.current = target; this.since = t; return { progress: 0, activated: false }; }
    const progress = Math.min(1, (t - this.since) / this.dwellMs);
    if (progress >= 1) {
      this.locked = target;
      this.resetProgress();
      this.onActivate(target);
      return { progress: 1, activated: true };
    }
    return { progress, activated: false };
  }
}

const digitsOnly = s => (s || '').replace(/\D/g, '');
const maskCard = s => {
  const d = digitsOnly(s), visible = d.slice(-4), hidden = '•'.repeat(Math.max(0, d.length - 4));
  return (hidden + visible).replace(/(.{4})/g, '$1 ').trim() || '—';
};
const formatExpiry = s => { const d = digitsOnly(s); return d.length > 2 ? `${d.slice(0,2)}/${d.slice(2)}` : d || '—'; };

export function setupPrivatePayment({ onApproved, dwellMs = 1000 } = {}) {
  const dialog = document.getElementById('private-payment-dialog');
  const body = dialog.querySelector('.private-payment-body');
  const bar = document.getElementById('private-mode-bar');
  const resume = document.getElementById('resume-voice');
  let values = { cardNumber: '', expiry: '', securityCode: '' };
  let stage = 'cardNumber';
  let totalCents = 0;
  let lastTarget = null;
  let active = false;

  const clearValues = () => { values = { cardNumber: '', expiry: '', securityCode: '' }; };
  const voice = () => window.cue?.voice;
  const setBar = isPrivate => { bar.hidden = !isPrivate; };

  const engine = new DwellActivator({ dwellMs, onActivate: id => {
    const el = document.querySelector(`[data-dwell-id="${CSS.escape(id)}"]`);
    if (el && !el.disabled && el.offsetParent !== null) el.click();
  }});

  function controls() {
    return [...document.querySelectorAll('[data-gaze-dwell][data-dwell-id]')]
      .filter(el => !el.disabled && !el.hidden && el.offsetParent !== null);
  }
  function targetAt(x, y) {
    let best = null;
    for (const el of controls()) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { best = el; break; }
    }
    return best;
  }
  function clearProgress() {
    if (lastTarget) lastTarget.style.setProperty('--dwell-progress', 0);
    lastTarget = null;
  }
  let cueBound = false;
  function bindCue() {
    if (cueBound || !window.cue?.bus) return;
    cueBound = true;
    window.cue.bus.on('GAZE', ({ x, y, confidence }) => {
    if (!voice()?.isPrivateMode?.()) return;
    const reliable = Number.isFinite(x) && Number.isFinite(y) && (confidence ?? 0) >= 0.28;
    const el = reliable ? targetAt(x, y) : null;
    const id = el?.dataset.dwellId || null;
    const out = engine.update(id, reliable);
    if (lastTarget && lastTarget !== el) lastTarget.style.setProperty('--dwell-progress', 0);
    if (el) el.style.setProperty('--dwell-progress', out.progress);
    if (out.activated && el) el.style.setProperty('--dwell-progress', 0);
    lastTarget = el;
      if (!reliable) clearProgress();
    });
    window.cue.bus.on('STATE', s => { if (s.privateMode !== undefined) setBar(!!s.privateMode); });
  }

  function button(label, action, extra = '') {
    return `<button type="button" class="gaze-key ${extra}" data-gaze-dwell data-dwell-id="pay-${action}">${label}<span class="dwell-fill" aria-hidden="true"></span></button>`;
  }
  function keypad() {
    return `<div class="gaze-pad" aria-label="Gaze-operated number pad">
      ${['1','2','3','4','5','6','7','8','9'].map(d => button(d, `digit-${d}`)).join('')}
      ${button('Delete','delete','gaze-key-action')}${button('0','digit-0')}${button('Next','next','gaze-key-action gaze-key-primary')}
    </div>
    <div class="gaze-pad-secondary">${button('Back','back','gaze-key-action')}${button('Cancel','cancel','gaze-key-action')}</div>`;
  }
  const ref = `<div class="demo-fixture"><strong>Demo only. Use the fictional details shown. No real payment is processed.</strong>
    <span>Card: 4242 4242 4242 4242</span><span>Expiry: 12/34</span><span>Security code: 123</span></div>`;

  function fieldValue() {
    if (stage === 'cardNumber') return maskCard(values.cardNumber);
    if (stage === 'expiry') return formatExpiry(values.expiry);
    return values.securityCode ? '•'.repeat(values.securityCode.length) : '—';
  }
  function title() { return stage === 'cardNumber' ? 'Card number' : stage === 'expiry' ? 'Expiry' : 'Security code'; }
  function render(message = '') {
    if (stage === 'review') {
      body.innerHTML = `${ref}<div class="private-review"><p class="private-kicker">Review demo payment</p>
        <h2>Ready for secure approval</h2><dl><div><dt>Order total</dt><dd>$${(totalCents/100).toFixed(2)}</dd></div>
        <div><dt>Payment</dt><dd>Demo card ending 4242</dd></div></dl>
        <p>No card data will be sent. Approve continues to Cue's existing server checks and passkey authentication.</p>
        <div class="private-review-actions">${button('Edit','edit','gaze-key-action')}${button('Cancel','cancel','gaze-key-action')}${button('Approve','approve','gaze-key-action gaze-key-primary')}</div></div>`;
      bindClicks(); return;
    }
    body.innerHTML = `${ref}<div class="payment-field"><p class="private-kicker">${title()}</p><div class="payment-value" aria-live="polite">${fieldValue()}</div>
      <p class="payment-hint">${message || 'Look steadily at a key for about one second, or click it.'}</p></div>${keypad()}`;
    bindClicks();
  }

  function currentLimit() { return stage === 'cardNumber' ? 16 : stage === 'expiry' ? 4 : 3; }
  function currentKey() { return stage; }
  function expected() { return DEMO_FIXTURE[stage]; }
  function inputDigit(d) {
    const k = currentKey();
    if (values[k].length < currentLimit()) values = { ...values, [k]: values[k] + d };
    render();
  }
  function removeDigit() { const k = currentKey(); values = { ...values, [k]: values[k].slice(0, -1) }; render(); }
  function next() {
    const k = currentKey();
    if (values[k] !== expected()) { render('That does not match the fictional demo value shown above. Use Delete to correct it.'); return; }
    if (stage === 'cardNumber') stage = 'expiry';
    else if (stage === 'expiry') stage = 'securityCode';
    else if (validateDemoFields(values)) stage = 'review';
    render();
  }
  function back() {
    if (stage === 'expiry') stage = 'cardNumber';
    else if (stage === 'securityCode') stage = 'expiry';
    else if (stage === 'review') stage = 'securityCode';
    render();
  }
  function closeAndClear() { clearValues(); active = false; engine.resetProgress(); clearProgress(); if (dialog.open) dialog.close(); }
  function cancel() { closeAndClear(); }
  function approve() {
    if (!validateDemoFields(values)) { stage = 'cardNumber'; render('Complete all fictional demo fields before approval.'); return; }
    closeAndClear();
    onApproved?.();
  }
  function bindClicks() {
    body.querySelectorAll('[data-dwell-id]').forEach(el => el.addEventListener('click', () => {
      const action = el.dataset.dwellId.replace(/^pay-/, '');
      if (action.startsWith('digit-')) inputDigit(action.slice(-1));
      else if (action === 'delete') removeDigit();
      else if (action === 'next') next();
      else if (action === 'back') back();
      else if (action === 'cancel') cancel();
      else if (action === 'edit') { stage = 'cardNumber'; render(); }
      else if (action === 'approve') approve();
    }));
  }

  resume.addEventListener('click', async () => {
    voice()?.exitPrivateMode?.();
    setBar(false);
    await voice()?.startListening?.();
  });
  dialog.addEventListener('cancel', e => { e.preventDefault(); cancel(); });
  dialog.addEventListener('close', () => { if (active) { clearValues(); active = false; } });

  async function start({ total = 0 } = {}) {
    bindCue();
    if (active) return;
    totalCents = total;
    clearValues(); stage = 'cardNumber'; active = true;
    await voice()?.enterPrivateMode?.();
    setBar(true);
    render();
    if (!dialog.open) dialog.showModal();
  }

  return { start, cancel, clear: clearValues, setDwellMs: ms => engine.setDuration(ms), isActive: () => active };
}
