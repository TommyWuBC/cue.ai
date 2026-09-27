# Plan: Cue on Amazon, with a guardian lock on payment

Pitch: Cue is a clerk you talk to, and a lock on the payment. The shopper talks,
Cue searches, reads the item back and adds it after they agree. Their yes never
buys. The purchase request goes to a guardian with item, price, page and the
exact words; Visa signs it; the guardian approves and pays or declines.
**The agent can help you shop. It cannot spend.**

Scope for now: **Amazon only**, through the Chrome extension. Order of work:
conversation first, then Amazon actions, then the guardian lock, then demo.
Companion docs: `GUARDIAN_TODO.md` (guardian detail), `ROADMAP.md` (older status).

## Phase 1: Conversation that does not feel like an AI

Goal: a 10-turn shopping chat where a stranger cannot tell what is scripted.

1. **Build a transcript test set first.** Pull real turns from `/tmp/cue-server.log`
   (`[stt]` + `[turn]` lines) and Amazon page snapshots into `tests/convo/`.
   Around 40 cases: search, refine, compare, "the cheaper one", "what about
   reviews", corrections ("no, the other one"), small talk, mishears. Grade each
   reply on: answers first, under 2 short sentences, no invented facts, no
   robotic openers, uses earlier turns. Run it on every prompt change.
2. **Dialogue state, not just chat history.** Keep a small server-side state per
   session: current search, shortlist (numbered), last item discussed, chosen
   options, pending question. Send it to the model as facts so "it", "that one",
   "the cheaper one" resolve reliably instead of by re-reading the log.
3. **Speed.** Target under 1.2s from end of speech to first audio.
   - Stream the model reply and start TTS on the first sentence.
   - Fast path for acknowledgements ("Sure, searching now") spoken while the
     action runs.
   - Cache the fixed lines and pre-warm on startup.
4. **Turn-taking.** Barge-in that works (stop talking the instant they speak),
   no talking over them, quiet fillers only when a tool call is slow, and
   stop the echo of Cue's own voice being heard as the shopper.
5. **Voice.** Pick one ElevenLabs voice with pacing that suits short lines;
   spell numbers and prices the way people say them; no lists longer than three.
6. **Error and repair language.** Mishear ("did you say X?"), not-found
   ("I don't see that here, want me to search?"), disagreement ("no, the other
   one" undoes the last selection). Never blame the user, never apologise twice.
7. **Persona rules stay in one place** (`SYSTEM` in `server/agent.py`), with the
   test set guarding it. Temperature and length limits are tuned against the set.

Exit criteria: the test set passes; median latency under 1.5s; two people who
have not seen Cue hold a five-minute shopping chat without repeating themselves.

## Phase 2: Amazon actions that actually work

The extension currently fixes wrong answers with generic page reading. Amazon
needs deliberate support, written as one adapter (`extension/amazon.js`) with
selectors in one place and a fallback to generic behaviour.

1. **Search**: use the real search box; read the top 3 results aloud with title,
   price, rating, Prime; number them on screen.
2. **Product page**: read title, price, rating and top review themes from the
   page; choose size/colour/quantity from real controls.
3. **Add to cart**: click Amazon's real button only after the spoken yes, then
   verify the cart count changed and say so. Never click Buy Now, Place order
   or Subscribe (already refused in the extension).
4. **Cart**: read the real cart (done via `/cart` fetch, needs validating) and
   support "remove the second one".
5. **Robustness**: detect A/B page layouts, captchas, sign-in walls and say
   what is happening instead of failing silently.
6. **Test with saved HTML** of search, product and cart pages so selectors do
   not rot silently; add a smoke script for a live check.

Exit criteria: search, read, choose, add, read cart and remove work on 10
different products, with the count verified each time.

## Phase 3: The guardian lock (Amazon)

The shopper never checks out. Cue turns the cart into a **purchase request**.

1. **Request object**: items (title, ASIN, price, currency), page URL, the
   exact spoken words per item, session id, timestamp, expiry, nonce.
2. **Guardian identity and pairing**: a guardian id, a pairing code or QR, and a
   protected-shopper flag. Adults can still self-approve when not protected.
3. **Signing**: the server signs the request (RFC 9421, `server/trust.py`) so the
   guardian page can verify it was not swapped. Label the key honestly as
   locally pinned until it is enrolled with Visa.
4. **Guardian screen**: a web page on a second device showing item, price, page,
   the words spoken and the signature check; Approve or Decline. Decline,
   timeout, tamper and replay all end with nothing charged.
5. **What "pay" means on Amazon**: Cue cannot pay on Amazon for the guardian.
   Two workable options:
   - **A (recommended for the demo):** guardian approval opens the item's Amazon
     page or cart link on the guardian's device, where they pay themselves.
   - **B:** guardian approves, then pays through our own sandbox (Stripe test
     mode) and we show the order in the merchant console.
6. **Tell the shopper**: Cue says "I've sent that to Maya" and later "Maya
   approved it" or "Maya said no". The shopper's yes must not call approve.
7. **Reachability**: the guardian device cannot reach `localhost`. Use a tunnel
   or a hosted server for the demo; add shopper and guardian auth before that.

Exit criteria: protected shopper cannot self-approve; tampered, replayed and
expired requests are rejected; decline charges nothing; both screens run side
by side on two devices.

## Phase 4: Demo, honesty and submission

- Script a 3-minute run: shopper talks, guardian phone approves, decline case.
- Measured limits on screen: gaze error 220-350px, so selection is by number.
- Say plainly: Visa key is local, Amazon payment happens on the guardian's side.
- Video, Devpost text, user feedback from at least one person who cannot use a
  mouse.

## Order and rough time

| Order | Work | Depends on |
|---|---|---|
| 1 | Transcript test set, dialogue state | nothing |
| 2 | Streaming replies, barge-in, voice | 1 |
| 3 | Amazon adapter: search, product, add, cart | 1 |
| 4 | Request object, signing, guardian screen | 3 |
| 5 | Pairing, tunnel, decline and expiry paths | 4 |
| 6 | Tests, demo script, video | all |

Phases 1 and 2 can overlap once the test set exists.

## Decisions I need from you

1. Guardian pays via option A (Amazon link on the guardian's device) or B (our
   sandbox)?
2. Guardian channel: second browser tab, QR, or SMS?
3. Do you want to keep self-approval for adults, or is everyone guardian-only?
4. Are you already building the guardian pieces in Cursor? If so, I'll skip
   Phase 3 until you push.
