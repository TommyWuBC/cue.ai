# Cue — architecture contract

Everyone codes against this. Stub the parts you don't own.

## Coordinate frame

ONE frame: the store page's viewport. Camera, mic, WebGazer, calibration and the
outline overlay all run inside the page. Served from a single origin
(http://localhost:4173) so camera+mic permission is granted once and persists.

Real H&M is handled later by mirroring a PDP onto our origin. Do not try to run
WebGazer from an extension page — the regression output would be in the wrong frame.

## Events (window.cue.bus)

    GAZE      { x, y, confidence }        raw-ish, smoothed, ~25Hz. Debug only.
    FOCUS     { target, prev }            dwell-committed. target = AuraTarget | null
    UTTERANCE { text, final }             from STT, wake word already stripped
    SAY       { text, priority }          request speech out
    DO        { verb, args }              action for the page to perform
    STATE     { listening, calibrated, ttsMode }

## Types

    AuraTarget = {
      kind: "product" | "action",
      id, label, el, rect,
      product?: Product,
      verb?: string            // for kind === "action"
    }

    Product = { id, title, price, currency, variants[], colors[], attrs{} }

## Page → server

    POST /utterance  { text, context }  ->  { say, do: [{verb,args}], source }
      context = { focused: Product|null, visible: Product[], url }
    GET  /tts?text=..  ->  audio/mpeg  |  { mode: "browser" }

Checkout endpoints are implemented in `server/checkout.py`. The server loads
`store/products.json`, validates item ids and sizes, reprices every order, checks
the order and monthly caps, and writes a pending intent. A WebAuthn challenge is
bound to that intent; only a verified passkey response creates an order. Approval
rechecks the budget inside the same SQLite write transaction, so a replayed or
concurrent approval cannot overspend it. The merchant screen reads demo orders
from `/api/merchant/orders`.

## Markup contract for any store page

    <div data-aura-product='{"id":"j1","title":"...","price":129, ...}'>
    <button data-aura-action="add_to_cart" data-aura-label="Add to cart">

Resolver only ever considers elements carrying these attributes. Nothing else is
gaze-targetable. That is deliberate: it makes a 5cm gaze error harmless.

## Hard rule

Gaze sets FOCUS. Voice commits. Gaze alone never triggers an action, ever.
Scroll and resize refresh the focused target's rectangle or clear it when the
element leaves the viewport.
LLM output is filtered on the server to reversible actions only. Explicit
voice commands and verified passkey approval gate cart and order mutations.
