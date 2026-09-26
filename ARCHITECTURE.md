# Cue — architecture contract

Everyone codes against this. Stub the parts you don't own.

## Coordinate frame

ONE frame: the store page's CSS viewport. The calibration overlay labels EyeTrax
features with viewport coordinates; the local companion predicts in that frame;
the content script resolves those coordinates against the page DOM. Browser zoom
or viewport-size changes invalidate the mapping and require calibration again.

The webcam belongs to `server/gaze_companion.py`, a local process. Frames and eye
landmarks never cross its process boundary. The extension receives gaze points,
frame age, and face/blink status through an authenticated localhost websocket.

## Events (window.cue.bus)

    GAZE      { x, y, confidence }        smoothed, ~25Hz. Debug/rendering only.
    FOCUS     { target, prev }            dwell-committed. target = CueTarget | null
    STT       { text, final }             raw transcript, before any intent gating
    UTTERANCE { text, final }             gated: wake word stripped, echo rejected
    SAY       { text, priority }          request speech out
    DO        { verb, args }              action for the page to perform
    STATE     { listening, calibrated, calibrating, ttsMode, sttProvider, accuracy, ptt }

`STT` is the transport layer (Grok or the browser recogniser). `UTTERANCE` is
what survived the wake word / push-to-talk / self-echo gate. Subscribe to
`UTTERANCE` unless you are writing a new transport.

## Types

    CueTarget = {
      kind: "product" | "action",
      id, label, el, rect,
      product?: Product,
      verb?: string            // for kind === "action"
    }

    Product = { id, title, price, currency, variants[], colors[], attrs{} }

## Page → server

    POST /utterance  { text, context }  ->  { say, do: [{verb,args}], source }
      context = { focused: Product|null, focusedAction, visible: Product[], pending, url }

    GET  /tts?text=..    ->  audio/mpeg  |  { mode: "browser", text: "<spoken form>" }
    WS   /stt            ->  binary 16kHz PCM16 up; Grok transcript events down
    POST /api/gaze/session -> one-use extension credential
    WS   /gaze           -> EyeTrax calibration controls and viewport coordinates
    POST /stt/file       ->  batch transcription fallback
    GET  /health         ->  what is actually live right now

When `/tts` returns `mode: "browser"` it also returns `text` — the spoken-form
normalisation ("$79.99" -> "79 dollars and 99 cents"). Speak THAT, not the
original, or the two voices read prices differently.

## Verbs

    scroll{dir}  focus_nth{n}  select_variant{value}  add_to_cart{}
    checkout{}   confirm{}     cancel{}               click_focused{}  navigate{url}

`checkout` stages an order and reads it back. It does not complete anything.
Only `confirm` completes, and only when something is pending.

Checkout endpoints are implemented in `server/checkout.py`. The server loads
`store/products.json`, validates item ids and sizes, reprices every order, checks
the order and monthly caps, and writes a pending intent. A WebAuthn challenge is
bound to that intent; only a verified passkey response creates an order. Approval
rechecks the budget inside the same SQLite write transaction, so a replayed or
concurrent approval cannot overspend it. The merchant screen reads demo orders
from `/api/merchant/orders`.

## Markup contract for any store page

    <div data-cue-product='{"id":"j1","title":"...","price":129, ...}'>
    <button data-cue-action="add_to_cart" data-cue-label="Add to cart">
    <button data-cue-action="select_variant" data-cue-value="M" data-cue-label="Size M">

The legacy `data-aura-*` spelling is still accepted everywhere, so in-flight
branches do not break.

The resolver only ever considers elements carrying these attributes. Nothing
else is gaze-targetable. That is deliberate: it makes a 5cm gaze error harmless.

## Who says what

The **page** announces outcomes it alone can know: "Added…", the over-budget
refusal. The **router/agent** announces intent it is sure of. The router must
never say "Added." up front — the click can still be refused, and then the user
hears the refusal and "Added." one breath apart.

## Hard rules

1. Gaze sets FOCUS. Voice commits. Gaze alone never triggers an action, ever.
   Scroll and resize refresh the focused target's rectangle, or clear it when
   the element leaves the viewport.
2. Nothing spends money on a single utterance. Stage, read back, confirm — and
   for a real order, a verified passkey.
3. LLM output is filtered on the server to reversible actions only. Cart and
   order mutations are reachable only through explicit command routes.
4. Every product-scoped action resolves through the focused card. A bare
   `document.querySelector` grabs item #1 — i.e. charges for the wrong thing.
