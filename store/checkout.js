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

export function setupCheckout({ getCart, clearCart, onStatus }) {
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

  const cancel = () => {
    if (busy) return;
    pending = null; ready = false;
    dialog.close();
  };
  dialog.querySelector('.checkout-cancel').addEventListener('click', cancel);
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });

  async function prepare() {
    if (busy) return;
    const cart = getCart();
    if (!cart.length) { window.cue?.bus.emit('SAY', { text: 'Your cart is empty.' }); return; }
    busy = true; ready = false; approveButton.disabled = true; setupButton.disabled = true;
    if (!dialog.open) dialog.showModal();
    setMessage('Checking your cart and budget…');
    try {
      const words = [...cart.map(item => item.words).filter(Boolean),
        window.cue?.lastActionUtterance || 'Checkout button pressed'].join(' | ');
      pending = await api('/api/checkout/prepare', {
        items: cart.map(item => ({ id: item.id, size: item.size, color: item.color })), customer_words: words.slice(0, 500),
      });
      const status = await refresh();
      details.textContent = pending.items.map(item => `${item.title}, ${item.color}, size ${item.size}, ${money(item.unit_price_cents)}`).join('; ');
      const readback = `${details.textContent}. Total ${money(pending.total_cents)}. ` +
        `You would have ${money(pending.remaining_after_cents)} left this month. ` +
        'Say yes and approve with your passkey to record this demo order. No payment will be charged.';
      setMessage('Reading back your order…');
      await window.cue.voice.speak(readback);
      ready = true;
      approveButton.disabled = false;
      setupButton.disabled = status.passkey_registered;
      setMessage(status.passkey_registered ? 'Say “Cue, yes” or choose Approve with passkey.' :
        'Set up a passkey, then say “Cue, yes” or choose Approve.');
    } catch (err) {
      pending = null;
      setMessage(err.message);
      window.cue?.bus.emit('SAY', { text: err.message });
    } finally { busy = false; }
  }

  async function register() {
    if (busy || !ready || !navigator.credentials?.create) return;
    busy = true; setupButton.disabled = true;
    setMessage('Create a passkey on this device or a nearby phone.');
    try {
      const ceremony = await api('/api/passkey/register/options', {});
      const credential = await navigator.credentials.create({ publicKey: creationOptions(ceremony.options) });
      if (!credential) throw new Error('Passkey setup was cancelled.');
      await api('/api/passkey/register/verify', { ceremony_id: ceremony.ceremony_id, credential: credentialJSON(credential) });
      await refresh();
      setMessage('Passkey ready. Say “Cue, yes” or choose Approve.');
      window.cue?.bus.emit('SAY', { text: 'Passkey ready. Say yes to approve.' });
    } catch (err) {
      setupButton.disabled = false;
      setMessage(err.message);
    } finally { busy = false; }
  }

  async function approve() {
    if (busy || !ready || !pending) return;
    if (!navigator.credentials?.get) { setMessage('Passkeys are unavailable in this browser.'); return; }
    busy = true; approveButton.disabled = true;
    setMessage('Waiting for passkey approval…');
    try {
      const ceremony = await api(`/api/passkey/authenticate/options/${encodeURIComponent(pending.intent_id)}`, {});
      const credential = await navigator.credentials.get({ publicKey: requestOptions(ceremony.options) });
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
      approveButton.disabled = false;
      setMessage(err.message);
    } finally { busy = false; }
  }

  setupButton.addEventListener('click', register);
  approveButton.addEventListener('click', approve);
  return { prepare, approve, cancel, register, refresh };
}
