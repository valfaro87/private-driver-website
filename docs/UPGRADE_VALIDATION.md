# MVBRI upgrade validation — October 25, 2026

Status: implemented and validated locally against repository base `e9feab2a18a0ae44fd5b7af1d67c5fe0602ebecd`. No GitHub pushes, production deployments, production database migrations, real payments, purchases, customer emails or live route requests were performed. The owner separately restricted preview access and initialized an empty preview database, as described below.

## Automated checks

`node --test tests/*.test.mjs` — 10 tests passed using synthetic data and in-memory SQLite:

1. Owner-only route calculations, ordered stops, round-trip return and existing daily cap.
2. Explicit live-payment activation gate and accurate Sandbox method labels.
3. Server-derived deposit, stable retry payload, link reuse and premature balance rejection.
4. Signed provider-verified webhook, signature rejection and duplicate notification handling.
5. Single quote response, expiry rejection and omission of private owner notes.
6. Protected owner booking/pricing reads and completed-trip tip eligibility.
7. Booking request security checks and successful protected submission with ordered stops.
8. Quote UI eligibility for issued/accepted/declined/expired/cancelled/superseded/unknown states and invalid deadlines.
9. Review invitation eligibility, one-time submission, publication consent, owner moderation, hiding and public field allowlist.
10. Private payment-status verification rejects browser claims and wrong amounts, retrieves the stored order/payment, and records a matching completed payment once without requiring a public webhook.

Inline JavaScript syntax checks and `git diff --check` passed. Cloudflare Wrangler 4.152.0 compiled the Pages Functions successfully with no deployment.

## Browser checks

Isolated local fixture server; all providers mocked, all customer records synthetic:

- Login: exact MVBRI / Owner title and header; private panels hidden.
- Dashboard: exact branding; two test bookings each automatically show 12.50 miles; pricing, tip controls, quote controls and reviews load.
- Sign-out: booking nodes, review nodes, tip choices and quote choices are removed.
- Quote acceptance: Accept/Decline disappear immediately and after reload. The test deposit is exactly $50.01 for a $100.01 quote and is clearly labelled Sandbox.
- Reviews: a completed-ride invitation opens a verified form; a submitted review stays absent from customer view while pending; the owner-approved synthetic review then appears.

## Deployment gates still open

The current repository is public and the existing homepage at https://private-driver-website.pages.dev/ is unauthenticated. These were not changed. The new code has not been published. The user's instruction requires private deployment and prohibits unapproved public publishing.

The owner is configuring Cloudflare in their own browser because the shared browser could not complete sign-in. Screenshots confirm owner-only Cloudflare Access for previews and a separate empty preview D1 database. Source publication to the existing public GitHub repository still requires explicit approval. Before any production release, verify the live schema, apply additive migration 0007 once, preserve existing data and secrets, and verify owner and customer flows. The production site and main branch remain unchanged.

Sandbox hosted checkout cannot validate Apple Pay, Google Pay or Cash App Pay. Their code configuration exists, but live activation and production verification are still pending. Existing incomplete legacy checkout attempts are preserved for owner verification. The existing optional tip link remains informational. Mileage remains limited to the previously configured 20 requests per day; records beyond the cap show an unavailable state rather than causing additional requests.

## Subsequent private preview setup

User screenshots confirm that preview URLs are restricted by Cloudflare Access to the owner account email. The user created an isolated empty `mvbri-preview-bookings` D1 database, successfully executed the prepared schema, and bound it as `DB` in Preview only. The owner reports that the Preview environment now has OWNER_PASSWORD, TURNSTILE_SECRET_KEY, GOOGLE_MAPS_API_KEY, SQUARE_ENVIRONMENT=sandbox, SQUARE_ACCESS_TOKEN, and SQUARE_LOCATION_ID saved, plus the BOOKING_RATE_LIMITER binding. The final settings screenshot confirms these variable names, encrypted secrets, Sandbox mode, separate preview DB binding, booking rate limiter binding, and Cloudflare Access protection. Secret contents were not inspected. The exact deployed preview hostname must be added to both TURNSTILE_ALLOWED_HOSTNAMES and the Turnstile widget before a protected booking test. Code publication remains unapproved.

- Additional synthetic browser check: Check payment status authenticated a completed mock payment, marked the deposit verified, and removed the deposit payment button. No real provider requests or customer records were used.
