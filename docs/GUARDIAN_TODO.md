# Guardian approval: steps left

Status as of 2026-09-26, checked against `origin/main` at `af12e13`. **None of the
guardian flow is built.** `CLAUDE.md` ("PLANNED, NOT BUILT: guardian approval")
holds the pitch and the gaps; this file is the ordered work list.

Today: shopper says yes → shopper's own passkey approves → order completes.
Target: shopper says yes → a *request* goes to a guardian → the guardian approves
and pays, or declines and nothing happens. The shopper never enters a card.

## What already exists and can be reused

- Order rows already store `customer_words` (`server/checkout.py`,
  `intent["customer_words"]`), so the exact spoken words are captured.
- `server/trust.py` does RFC 9421 signing with a pinned Ed25519 key, nonce
  replay rejection and expiry. It signs agent → merchant today.
- `store/merchant.html` already renders order and signature evidence for a
  human reviewer. It is the closest shape for the guardian screen.
- The extension refuses money-committing controls on real sites, and
  `sanitize()` in `server/agent.py` never lets the model confirm or approve.

## Steps, in order

1. **Guardian identity and pairing.** A second party in the system. Minimum for
   the demo: a guardian id plus a link or code the shopper's session is paired
   to. `SHOPPER = "local"` in `server/memory.py` is the only party today.
2. **Protected-shopper flag.** A field nothing reads yet: this shopper requires
   guardian approval. Adults may still self-approve; protected shoppers always
   route to a guardian.
3. **Purchase request object.** Item, price, currency, page URL, the shopper's
   exact words, expiry and a nonce. Stage it server-side when checkout is
   spoken instead of raising the passkey prompt for a protected shopper.
4. **Sign the request to the guardian.** Reuse `AgentTrust` or add a second
   instance so the guardian screen can verify nothing changed in transit. This
   is the same primitive pointed the other way. Label the key honestly as
   locally pinned until it is enrolled with Visa.
5. **Guardian screen.** A new page in `store/` modelled on `merchant.html`:
   shows item, price, page and the spoken words, verifies the signature, and has
   Approve and Decline. Approve is the only path that can complete the order.
6. **Decline and expiry paths.** Decline, timeout and a swapped or replayed
   request all end with nothing charged and a spoken message to the shopper.
7. **Shopper-side changes.** Cue reads back the item, then says the request was
   sent to the guardian and waits. The shopper's yes must no longer call
   `approve_checkout`. Update `router.py` and `store/checkout.js` accordingly.
8. **Real-site items (Amazon).** Decide what "page" and "item" mean when the
   product is on a site Cue cannot check out on. Suggested: the request carries
   the page URL, title and price read from the page, marked unverified, and the
   guardian pays on the site themselves.
9. **Payment.** Stripe test mode or Visa Acceptance sandbox behind the guardian's
   approval. Orders never charge a card today (see `docs/ROADMAP.md` item 1).
10. **Tests.** Cover: protected shopper cannot self-approve, tampered request is
    rejected, replay is rejected, expired request is rejected, decline charges
    nothing.
11. **Docs.** Move the section in `CLAUDE.md` from "planned" to real, update
    `ARCHITECTURE.md` and `docs/ROADMAP.md`.
12. **Demo and pitch.** Two screens side by side, shopper and guardian. Record
    the video, state measured limits, and be honest that the Visa key is local.

## Open questions for the team

- Notification channel: another browser tab, QR code, SMS, or email?
- Can a guardian approve for several shoppers, and can one shopper have several?
- Does the guardian see the whole bag or one request per item?

---

## Background moved from CLAUDE.md

### Planned, not built: guardian approval

**Nothing below this line exists in the repo yet.** This is a direction under
active discussion (as of the guardian pitch), written down here so a session
working on it has the context and so no other session assumes it is already
wired up because it reads like architecture.

The pitch, verbatim: *"Cue is a clerk you talk to, and a lock on the payment
… Children, older adults, and anyone who should not put payment details on a
website get one protection: the request goes to a guardian. It shows the
item, the price, the page, and the exact words that were spoken. Visa signs
that request so it cannot be swapped. The guardian approves and pays, or
declines and nothing happens. The agent can help you shop. It cannot spend."*

**This is a different trust model from what is built, not an extension of it.**
Today: shopper says yes → shopper's own passkey approves → order completes.
Self-approval; the confirmation step exists to catch a wrong item, not a wrong
person. The guardian pitch removes the shopper's own ability to pay at all —
approval comes from a second, different human who was not looking at the
screen when the order was assembled.

Known gaps between the pitch and the code, for whoever picks this up:

- **No guardian identity exists.** There is no second account, no
  phone/email/notification channel, nothing to route a request *to*. The
  closest existing concept is `server/checkout.py`'s single local shopper
  (`SHOPPER = "local"` in `server/memory.py`) — there is exactly one party in
  the system today.
- **Self-approval and guardian-approval likely need to coexist, not replace
  each other.** An adult shopping for themselves probably still self-approves;
  a minor's or a protected shopper's order should always route to a guardian.
  That is a mode switch nothing currently reads (no field for "this shopper
  requires guardian approval").
- **The signing infrastructure this needs partly exists, aimed the wrong
  direction.** `server/trust.py` already does real RFC 9421 HTTP message
  signing with a pinned Ed25519 key — see "Signed agent requests" below — but
  it authenticates *the agent's request to the merchant server*. The pitch
  needs a signature over *the request the merchant sends to the guardian*
  (item, price, page, the shopper's exact words), so the guardian can verify
  nothing was altered in transit. Same primitive, different direction; check
  whether `AgentTrust` can be reused or needs a second instance.
- **The "exact words that were spoken" already exist as data.** Every order
  row already stores `customer_words` (see `server/checkout.py`,
  `intent["customer_words"]`) — assembled in `store/checkout.js` from each
  cart item's recorded utterance plus `window.cue.lastActionUtterance`. The
  guardian-facing screen would read from data that is already captured; it
  does not need a new capture mechanism.
- **`store/merchant.html` is the closest existing UI shape** — it already
  renders order/trust evidence for a human reviewer. A guardian-approval
  screen is closer to a rebuild of that audience (a specific approving human,
  not a generic merchant dashboard) than to the shopper-facing checkout dialog.

