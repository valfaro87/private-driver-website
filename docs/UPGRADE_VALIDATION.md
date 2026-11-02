# MVBRI upgrade validation — October 29, 2026

This report contains no customer links, provider tokens, customer contacts or payment credentials. The production main branch remains at `e9feab2a18a0ae44fd5b7af1d67c5fe0602ebecd`. The existing owner-restricted preview remains at `https://mvbri-private-upgrades-20261.private-driver-website.pages.dev/`, deployment `943a67a7-5b96-4c7c-91af-d8ae1b0e7005`, source `2c7cc200c32c29d7269e9567f1234630db8d70ce`. Its isolated D1 has migrations through 0008.

## Deployment state

The deployed preview retains the working booking, owner dashboard, pricing, quote expiration, reviews and Square deposit/shared-balance features. The next logo/verification/communications/receipt changes are prepared source, not live. New migrations 0009 and 0010 must be applied to the preview before deployment. The owner approved publication of this new source/schema release to the existing public GitHub repository on November 2, 2026. The approved checkpoint uses `[CF-Pages-Skip]` to preserve the working deployment while preview schema setup is pending. This source approval does not activate messages or deploy to the public site. Public main and visibility remain unchanged.

## Preservation and feature validation

`npm test`: **36 tests passed**, with zero failures. The full automated suite uses synthetic records, in-memory SQLite, and mocked Square, Google Maps, Resend and Twilio responses. It covers:

- Booking field validation, Turnstile, rate limiting and exact approved hostnames, including MVBRI production domains while preserving explicit strict preview configuration.
- Owner authorization and same-origin checks, pricing access, session/sign-out behavior, one-time quote acceptance and expiration, and private-note exclusion.
- Automatic mileage for loaded bookings, ordered stops, round trips and the existing 20-request daily allowance.
- Single-use completed-ride review invitations, customer permission, owner approval/hide/reply controls and public review field filtering.
- Explicit live-payment activation, server-derived 50% deposit amounts, saved-payload/idempotency retries, matching Square location/order/currency/amount checks, signed callbacks and private status verification.
- A single balance invoice shared by website and reader, exact fare minus verified deposit, partial payments, invoice retry recovery, and rejection of manual paid entries, wrong-provider data, refunds and overpayments.
- Customer-selected email/text preferences, explicit SMS consent, encrypted event/outbox contents, inline gold email logo, test-recipient restrictions, no historical opt-in, safe email retries and uncertain-SMS suppression.
- Owner-only custom texts: opted-in recipient, fixed business sender, exact previewed text, duplicate-send prevention and read-only connected-number verification against Twilio's documented response.
- Signed STOP/START callbacks, replay protection, private opt-out links, matching signed delivery callbacks, terminal delivery-state preservation and safe callback retry after transient database failure.
- Receipt plus optional-tip message only after completed ride and verified full fare, once per quote; wrong payment environment/amount, reviewed invoices and missing consent cannot trigger receipt delivery.
- Private receipt token validation and minimal response fields, separate optional-tip payment ledger, saved-amount/idempotency recovery, matching provider verification, tip refund tracking and signed tip callbacks.
- Scheduled payment verification and receipt delivery without a customer return, expiration notices, interrupted-send recovery and no public HTTP job endpoint.

## Browser checks

An isolated ignored fixture server intercepts every provider request. No real customer data or recipient is used.

- Supplied gold logo renders cleanly in the header and hero; favicon and Apple touch-icon assets are referenced across customer/owner pages.
- SMS choice reveals explicit consent; email/no-update choices remain available according to backend configuration.
- Custom-text preview shows the selected fake customer, frozen recipient, fixed business sender and exact text. A mocked send displays provider acceptance without falsely claiming delivery.
- Sign-out hides and clears messages, previews, balances, booking data and review management. Manual owner tip request/amount controls are absent.
- A synthetic paid $100.01 ride shows a branded private receipt with $50.01 deposit, $50.00 balance paid and $0.00 fare due, plus the optional-tip page.
- Sandbox notices are conditional on Sandbox mode; live mode does not render that copy. Test screenshots identify simulated payments.

## Build and schema checks

Cloudflare Wrangler 4.152.0 compiles all Pages Functions. The separate scheduled worker passes a deployment dry-run (270.57 KiB raw / 187.72 KiB gzip), with public worker/preview URLs disabled. All server, worker and inline browser scripts parse. The combined additive schema bundle can run twice without changing the existing synthetic booking. No purchases, real messages, new real payment, provider activation or public publication were performed for this release.

## Remaining verification

1. Apply migrations 0009 and 0010 to the isolated preview, deploy the reviewed source privately, and check live runtime schema/bindings with delivery off.
2. Connect approved email/SMS providers and the existing business number without unapproved charges, porting or number purchase. Configure signed callbacks and scheduled worker, then test only exact approved self-test recipients before live activation.
3. Add the final MVBRI hostname to the existing Turnstile widget and server allowlist, then verify an actual protected synthetic booking on that final domain after approved production rollout. The observed `110200` configuration error has not yet been fixed in the public account settings.
4. Set the supplied logo in the correct Square location's payment-link and receipt branding settings; confirm hosted checkout/invoice/official receipt appearance.
5. Complete owner-authorized real deposit, shared balance invoice, physical reader (specific supported Android/iPad) and optional-tip checks. The prior $1 Apple Pay payment sheet was confirmed by the owner, but no completed real payment was verified in the last check.
6. Obtain approval for a concrete production rollout after private checks, verify production schema/bindings, apply only missing additive migrations, and preserve real records and access policies.

See `COMMUNICATIONS_SETUP.md` for exact setup/configuration details. Historic tip records and payment links are retained; new tips use the private optional-tip payment flow after fully paid completed rides.
