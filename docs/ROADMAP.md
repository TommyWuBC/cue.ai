# Cue implementation status

Updated September 26, 2026. This tracks implemented behavior separately from
external integrations and live-site validation.

## Implemented

- Webcam gaze calibration, filtering, focus, quality warnings, recalibration,
  and voice/number selection when tracking is poor.
- Wake word, speech questions, page navigation, scrolling, size/color selection,
  and demo-store cart/checkout.
- Comparison with the last product named or discussed, across pages in one tab.
- Server pricing, order limits, monthly budget, spoken order review, and passkeys.
- Checkout cancellation that revokes server intents and aborts passkey prompts.
- Signed agent-to-merchant checkout requests with Ed25519, body integrity,
  expiry checks, persistent nonce rejection, and passkey/intent binding.
- Merchant order feed with the customer's words, passkey status, signature
  evidence, and verification/replay counters.
- Experimental Chrome adapter for visible product details on H&M and Amazon.

## Remaining, in suggested order

1. **Sandbox payment processor.** Choose Stripe test mode or Visa Acceptance
   sandbox, configure credentials, then implement payment state, idempotent
   submission, recovery after timeouts, webhook verification, and merchant
   payment status. Current orders never charge a card.
2. **Live-store completion.** Validate H&M and Amazon layouts in the browser,
   expose real size/color choices, and implement an explicit handoff to the
   demo checkout with a reviewed product/price mapping.
3. **Additional product evidence.** Fetch details from a selected product's
   page or linked size/care pages with source attribution, bounded requests,
   and safeguards against unsafe URLs and page instructions.
4. **Full Visa integration.** Enroll an agent key with the intended directory
   and configure consumer recognition and payment-container requirements.
   Current request signatures use a locally pinned key and are labelled as such.
5. **Review summaries.** Summarize actual review text with source links and
   clear missing-data behavior; distinguish demo content from merchant reviews.
6. **Accessibility validation.** Test gaze accuracy, calibration, correction,
   cancellation, and the phone passkey flow with intended users and their devices.
7. **Submission material.** Record the demo, document measured limitations,
   complete Devpost tags/interest selections, and incorporate user feedback.

Before hosting beyond localhost, add shopper identity, merchant authentication,
explicit origin policy, and operational controls for keys and stored data.
