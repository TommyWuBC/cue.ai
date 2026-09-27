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
