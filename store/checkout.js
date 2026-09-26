const money = cents => `$${(cents / 100).toFixed(2)}`;
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || 'The request failed.');
  return data;
}

function credentialJSON(credential) {
  if (credential.toJSON) return credential.toJSON();
  const response = credential.response;
  const base = { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults() };
  if (response.attestationObject) {
    base.response = { attestationObject: encode(response.attestationObject),
      clientDataJSON: encode(response.clientDataJSON), transports: response.getTransports?.() || [] };
  } else {
    base.response = { authenticatorData: encode(response.authenticatorData),
      clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature),
      userHandle: response.userHandle ? encode(response.userHandle) : null };
  }
  return base;
}

function creationOptions(options) {
  return { ...options, challenge: decode(options.challenge),
    user: { ...options.user, id: decode(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: decode(c.id) })) };
}

function requestOptions(options) {
  return { ...options, challenge: decode(options.challenge),
    allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: decode(c.id) })) };
}

export function setupCheckout({ getCart, clearCart, onStatus, onPrepared }) {
  const dialog = document.getElementById('checkout-dialog');
  const details = dialog.querySelector('.checkout-details');
  const message = dialog.querySelector('.checkout-message');
  const approveButton = dialog.querySelector('.checkout-approve');
  const setupButton = dialog.querySelector('.checkout-setup');
  let pending = null;
  let ready = false;
  let busy = false;

  const setMessage = text => { message.textContent = text; };
  const refresh = async () => { const status = await api('/api/checkout/status'); onStatus(status); return status; };
  refresh().catch(err => setMessage(err.message));

  let cancelled = false;
  let credentialAbort = null;
  let revocation = null;
  const revoke = intent => {
    if (revocation) return revocation;
    revocation = api(`/api/checkout/cancel/${encodeURIComponent(intent.intent_id)}`, {})
      .then(() => {
        if (pending?.intent_id === intent.intent_id) pending = null;
        if (dialog.open) dialog.close();
        window.cue?.bus.emit('SAY', { text: 'Checkout cancelled. No order was recorded.' });
        return true;
      }).catch(err => {
        setMessage(err.message);
        window.cue?.bus.emit('SAY', { text: `I couldn't confirm cancellation. ${err.message}` });
        return false;
      }).finally(() => { revocation = null; });
    return revocation;
  };
  const cancel = async () => {
    // Deliberately NOT guarded by `busy`. prepare() holds busy for the whole
    // readback, and refusing to cancel during a payment readback is the one
    // moment it must always work. Stop the speech too, or Cue keeps reading
    // out an order that no longer exists.
    cancelled = true;
    ready = false;
    credentialAbort?.abort();
    try { window.cue?.voice.stopSpeaking(); } catch {}
    approveButton.disabled = true; setupButton.disabled = true;
    setMessage('Cancelling checkout…');
    if (pending) return revoke(pending);
    // If prepare is still in flight, it will revoke the intent as soon as
    // the server returns its ID. Do not announce success before that happens.
    if (busy) return;
    if (dialog.open) dialog.close();
    window.cue?.bus.emit('SAY', { text: "There's no order waiting to cancel." });
  };
  dialog.querySelector('.checkout-cancel').addEventListener('click', cancel);
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });

  async function prepare() {
    if (busy || revocation) return;
    if (pending) {
      if (!await cancel()) return;
    }
    const cart = getCart();
    if (!cart.length) { window.cue?.bus.emit('SAY', { text: 'Your cart is empty.' }); return; }
    busy = true; ready = false; cancelled = false;
    approveButton.disabled = true; setupButton.disabled = true;
    if (!dialog.open) dialog.showModal();
    setMessage('Checking your cart and budget…');
    try {
      const words = [...cart.map(item => item.words).filter(Boolean),
        window.cue?.lastActionUtterance || 'Checkout button pressed'].join(' | ');
      pending = await api('/api/checkout/prepare', {
        items: cart.map(item => ({ id: item.id, size: item.size, color: item.color })), customer_words: words.slice(0, 500),
      });
      if (cancelled) { await revoke(pending); return; }
      const status = await refresh();
      if (cancelled) return;
      onPrepared?.(pending, status);
      details.textContent = pending.items.map(item => `${item.title}, ${item.color}, size ${item.size}, ${money(item.unit_price_cents)}`).join('; ');
      const readback = `${details.textContent}. Total ${money(pending.total_cents)}. ` +
        `You would have ${money(pending.remaining_after_cents)} left this month. ` +
        'Say yes and approve with your passkey to record this demo order. No payment will be charged.';
      setMessage('Reading back your order…');
      await window.cue.voice.speak(readback);
      if (cancelled) return;          // they said no while it was reading
      ready = true;
      approveButton.disabled = false;
      setupButton.disabled = status.passkey_registered;
      setMessage(status.passkey_registered ? 'Say “Cue, yes” or choose Approve with passkey.' :
        'Set up a passkey, then say “Cue, yes” or choose Approve.');
    } catch (err) {
      if (cancelled) {
        setMessage(`Checkout stopped. ${err.message}`);
        window.cue?.bus.emit('SAY', { text: `Checkout stopped. ${err.message}` });
        return;
      }
      setMessage(err.message);
      window.cue?.bus.emit('SAY', { text: err.message });
    } finally { busy = false; }
  }

  async function register() {
    if (busy || !ready || !navigator.credentials?.create) return;
    busy = true; setupButton.disabled = true;
    credentialAbort = new AbortController();
    setMessage('Create a passkey on this device or a nearby phone.');
    try {
      const ceremony = await api('/api/passkey/register/options', {});
      if (cancelled) return;
      const credential = await navigator.credentials.create({ publicKey: creationOptions(ceremony.options), signal: credentialAbort.signal });
      if (cancelled) return;
      if (!credential) throw new Error('Passkey setup was cancelled.');
      await api('/api/passkey/register/verify', { ceremony_id: ceremony.ceremony_id, credential: credentialJSON(credential) });
      await refresh();
      if (cancelled) return;
      setMessage('Passkey ready. Say “Cue, yes” or choose Approve.');
      window.cue?.bus.emit('SAY', { text: 'Passkey ready. Say yes to approve.' });
    } catch (err) {
      if (cancelled) return;
      setupButton.disabled = false;
      setMessage(err.message);
    } finally { busy = false; credentialAbort = null; }
  }

  async function approve() {
    if (!pending && !busy) {
      window.cue?.bus.emit('SAY', { text: "There's no order waiting." });
      return;
    }
    if (busy || !ready) {
      // They answered before the readback finished. Acknowledge rather than
      // swallowing it, or the only feedback is silence.
      window.cue?.bus.emit('SAY', { text: 'One moment — let me finish reading the order.' });
      return;
    }
    if (!navigator.credentials?.get) { setMessage('Passkeys are unavailable in this browser.'); return; }
    busy = true; approveButton.disabled = true;
    const intent = pending;
    credentialAbort = new AbortController();
    setMessage('Waiting for passkey approval…');
    try {
      const ceremony = await api(`/api/passkey/authenticate/options/${encodeURIComponent(intent.intent_id)}`, {});
      if (cancelled) return;
      const credential = await navigator.credentials.get({ publicKey: requestOptions(ceremony.options), signal: credentialAbort.signal });
      if (cancelled) return;
      if (!credential) throw new Error('Passkey approval was cancelled.');
      const order = await api('/api/checkout/approve', {
        ceremony_id: ceremony.ceremony_id, credential: credentialJSON(credential),
      });
      pending = null; ready = false;
      clearCart();
      await refresh();
      dialog.close();
      window.cue?.bus.emit('SAY', { text: `Demo order recorded. ${money(order.remaining_cents)} remains this month. No payment was charged.` });
    } catch (err) {
      if (cancelled) return;
      approveButton.disabled = false;
      setMessage(err.message);
    } finally { busy = false; credentialAbort = null; }
  }

  setupButton.addEventListener('click', register);
  approveButton.addEventListener('click', approve);
  return { prepare, approve, cancel, register, refresh };
}
