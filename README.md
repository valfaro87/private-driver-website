# MVBRI private driver website

Cloudflare Pages Functions and D1 application. The existing public landing page and password-protected owner APIs are retained. A private business dashboard is not the same as a site protected by Cloudflare Access. Do not publish an update to a public audience without owner approval.

## Implemented behavior

- Protected booking submission retains the existing Turnstile and rate-limit bindings.
- Owner booking management, pricing, draft/issued quotes and 24-hour default quote expiration remain in place. Historic tip records are retained; the prepared communications release replaces manual owner tip controls with automatic receipt and optional-tip links after a fully paid completed ride.
- Quote response controls appear only for issued quotes with a valid future deadline. Accepted, declined, expired, cancelled, superseded, invalid, and failed-load states hide the controls. The server prevents repeated responses.
- The header and main title read **MVBRI / Owner** before and after login. Signing out clears private page data and generated links; stale in-flight responses cannot repopulate it.
- Every loaded booking has an automatically calculated driving-mileage field. Ordered stops and the return to pickup for round trips are included. The existing 20-request daily allowance remains enforced atomically. Results are reused within the open dashboard only; filtering and selecting a quote do not repeat successful requests. Missing configuration, invalid routes and quota limits display an explicit unavailable state. Final quote adjustments remain manual. No extra quota or paid service is enabled by this change.
- Completed rides can receive seven-day, single-use review invitations. Feedback is pending until moderated. Publication requires customer permission and an owner action. The public API exposes only review display fields; booking references and contact details are excluded. The owner may hide reviews and add replies.
- Square-hosted checkout supports a 50% deposit and the exact remaining balance after trip completion and verified deposit payment. Amounts come from the accepted server-side quote, never from the browser. Cancelled/declined bookings cannot start checkout. Retries reuse the saved provider request and idempotency key. Only authenticated Square lookup with matching location/order/amount/currency marks payments paid. Verified signed webhooks retain their existing path; the Check payment status button also retrieves the stored Square order and its payment server-side, so verification works behind private preview access without exposing a webhook URL. Returning from checkout never marks a payment paid.

## Payment configuration

New remaining balances use one Square invoice for online payment or in-person card collection. Its amount is the accepted fare minus the verified deposit. In Square Point of Sale, open More → Invoices → the ride's `QT-…-BAL` invoice → Add payment → Remaining amount, then use the connected reader. Use that invoice rather than creating a separate sale. Completed card/wallet payments are verified against its stored order, including partial payments. A manual "mark paid" entry is not treated as a processed card payment. Paid balances hide both payment choices; refunds, overpayments and mismatches require owner review.

Invoice preparation shares only the booking name and email with Square. Route details and private notes are not shared. `SHARE_MANUALLY` delivery sends no automatic invoice email/SMS; automatic card charges and invoice tips are disabled. No paid invoice subscription features are requested. Reader hardware and exact device compatibility require a physical test, with internet available for invoice payments.

Keep credentials in Cloudflare secrets, never this repository or `site-settings.js`:

- `SQUARE_ENVIRONMENT`: retain `sandbox` for development.
- `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`.
- Optional webhook delivery: `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` (exact configured notification URL). Keep these when using the existing webhook integration. A private preview can instead use Check payment status without any Access bypass rule.
- Live collection additionally requires explicit owner approval and `SQUARE_LIVE_PAYMENTS_APPROVED=true`, production credentials, and verified production payment confirmation.

Sandbox hosted checkout supports test cards only. Apple Pay, Google Pay, and Cash App Pay are configured for live checkout; eligibility depends on Square merchant settings, country and buyer device. No live activation or real payment is part of the local validation. PayPal and Zelle are not connected. The prepared release adds an independent Square optional-tip checkout, with private post-ride links and verified provider status. It does not change fare or deposit amounts. Provider activation and real tip processing still require live checks.

Reference: https://developer.squareup.com/docs/checkout-api/guidelines-and-limitations

## Existing deployment: additive migration only

The deployed application already uses migrations 0001–0006. Verify the live schema before changing it. Apply **`migrations/0007_checkout_retries.sql` once** if its two columns are absent, then apply **`migrations/0008_balance_invoices.sql`** for the shared balance-invoice table. Migration 0008 uses `CREATE TABLE IF NOT EXISTS` and is safe to rerun. The private preview already has migrations through 0008. Before deploying the prepared communications source, apply only 0009 and 0010 there, using `docs/communications-preview-setup.sql`. Both are additive CREATE IF NOT EXISTS migrations and are safe to rerun. Do not replay the entire migration directory: the inherited repository contains duplicate/nested historical migration files.

The migration does not alter or delete existing bookings, quotes, sessions, reviews, tips or payment records. Existing incomplete legacy checkout records without a saved request must be verified by the owner against Square before retrying; they are deliberately not deleted or reset. Existing completed checkouts are reused. Sandbox and production payment records are never treated as interchangeable; use verified production quotes for a later approved live launch.

Existing bindings remain: `DB`, `OWNER_PASSWORD`, `BOOKING_RATE_LIMITER`, `TURNSTILE_SECRET_KEY`, `GOOGLE_MAPS_API_KEY`, and any already configured email secrets. The prepared default Turnstile server allowlist includes the existing production Pages hostname plus `mvbri.com` and `www.mvbri.com`. The widget must authorize the matching hostnames too; the observed final-domain 110200 requires an account setting change. For a preview hostname, set `TURNSTILE_ALLOWED_HOSTNAMES` to that exact hostname (or an explicit comma-separated list), and authorize the same hostname in the existing Turnstile widget. The default production hostname check is preserved when the variable is absent. No hosting, sharing, custom domain, or production environment settings were changed by the source edits.

## Local validation

Run `npm test` with Node 24. Tests use in-memory SQLite and synthetic fixtures. Provider calls are mocked, with no live customer data, emails, route charges or payments. Browser checks use a separate isolated fixture server; no QA code or data is deployed.

Before deployment: confirm owner-approved visibility, apply the required additive migrations, verify runtime bindings, deploy the reviewed source, and perform signed-in/private smoke tests. Do not call an unauthenticated public URL an owner-private deployment. Preserve the production database, main branch, runtime secrets and visibility until an approved production rollout.

References: https://squareup.com/help/us/en/article/8508-accept-payment-for-an-invoice and https://developer.squareup.com/docs/invoices-api/create-publish-invoices

## Prepared communications release

Customer-selected email/SMS updates, encrypted durable outbox, signed opt-outs/delivery callbacks, owner custom-text previews, branded receipts and separate Square optional tips are implemented and locally validated. Delivery defaults off; no real customer is retroactively opted in. The separate five-minute scheduled worker verifies pending payments and drains approved updates without exposing a public job endpoint. New runtime secrets and schema are required before activation.

Read [private setup](docs/COMMUNICATIONS_SETUP.md) and [validation state](docs/UPGRADE_VALIDATION.md). Source checkpoints can use the Cloudflare-supported `[CF-Pages-Skip]` prefix so a schema-dependent update is saved without deploying prematurely. No public rollout, paid SMS activation or number transfer is implied by the prepared source.
