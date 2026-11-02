# MVBRI communications release — private setup

The communications source is prepared and locally tested, not activated. The existing owner-restricted preview and production are retained. Apply schema before deploying this source. Never send a real customer message for QA or publish public changes without approval.

## 1. Add the preview tables

In Cloudflare, open **Storage & databases → D1 → mvbri-preview-bookings → Console**. Run the entire `docs/communications-preview-setup.sql` file once. It combines migrations 0009 and 0010 and uses only `CREATE ... IF NOT EXISTS`; existing booking, pricing, quote, review, and payment records are retained. It is safe to rerun. Do not use the production database for this preview step.

After successful execution, trigger the reviewed preview-branch deployment. A `[CF-Pages-Skip]` source checkpoint intentionally does not update the live preview until its schema is ready. Keep the preview's Access policy and separate D1 binding intact.

## 2. Configure delivery privately, initially off

Set runtime secrets through Cloudflare, never in GitHub source, SQL, screenshots, or chat. Use distinct preview/production secrets. Keep the same communications encryption key in the Pages environment and its associated scheduled worker; changing it invalidates encrypted drafts and private links.

| Variable | Purpose |
| --- | --- |
| `COMMUNICATIONS_ENCRYPTION_KEY` | Secret, cryptographically random 32 bytes represented as 64 hexadecimal characters; stable across deployments |
| `CUSTOMER_SITE_URL` | Preview: `https://mvbri-private-upgrades-20261.private-driver-website.pages.dev`; production: `https://www.mvbri.com` |
| `NOTIFICATION_DELIVERY_MODE` | `off` initially, `test` only after exact self-test recipients are approved; `live` after delivery checks and activation approval |
| `EMAIL_NOTIFICATIONS_ENABLED` | `true` only after a verified sender is ready |
| `RESEND_API_KEY` | Secret for approved Resend account and verified sender domain |
| `MVBRI_EMAIL_FROM` | Verified sender, default `MVBRI <quotes@mvbri.com>` |
| `RESEND_WEBHOOK_SECRET` | Secret from the configured Resend webhook endpoint |
| `NOTIFICATION_TEST_EMAIL` | Exact approved self-test recipient, required in test mode |
| `SMS_NOTIFICATIONS_ENABLED` | `true` only after approved business-number connection |
| `SMS_REGISTRATION_APPROVED` | `true` only after applicable US messaging registration/consent setup is complete |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Approved Twilio account identifier and secret, no number provisioning performed by the app |
| `TWILIO_PHONE_NUMBER` | Must be the existing MVBRI business number displayed on the site |
| `NOTIFICATION_TEST_PHONE` | Exact approved self-test recipient in US E.164 format, required in test mode |

`off` sends nothing. Unsupported email/text choices remain disabled; bookings still work with no automatic updates. Existing bookings are not opted in retroactively. Owner custom texts are previewed and locked to the selected customer's opted-in number and fixed business sender. Delivery status distinguishes provider acceptance, actual delivery, failure and uncertainty.

No SMS provider is currently connected. Confirm the business number's current provider and approved connection method before opening a paid account, porting/hosting a number, buying a number, or registering paid messaging. Do not disrupt the existing calling service. Review provider charges and agreements with the owner first. SMS activation also requires the owner-only **Check business number connection** check, which only reads the connected account's SMS-capable numbers.

Configure inbound STOP/START/HELP handling, including provider-standard opt-out/help replies. App callbacks honor signed STOP requests and suppress future queued/custom texts. The privacy and messaging terms are included for the transactional ride update flow; review the actual business/provider details before live activation.

## 3. Callback URLs and scheduled delivery

Provider callbacks use `CUSTOMER_SITE_URL` as the canonical signing origin:

- Twilio status: `/api/message-status?mid=<message UUID>` (set automatically on each send).
- Twilio inbound: `/api/inbound-sms` (POST, signed Twilio request).
- Resend: `/api/message-status` (email.sent/delivered/bounced/complained/failed/delivery_delayed as applicable, signed Svix request).
- Existing Square payment webhook remains `/api/square-webhook`, with its matching configured secret and exact endpoint URL.

Do not weaken Cloudflare Access to make a preview webhook reachable. Preview delivery confirmation can be checked in provider consoles; signed webhook logic has synthetic coverage. Fare/tip verification also works through the protected customer and owner status checks. The scheduled worker independently checks pending Square payments so post-ride receipt delivery does not depend on a customer returning from checkout.

Deploy `workers/communications.js` as a separate scheduled worker using `workers/wrangler.communications.example.toml`, with the same preview D1 and relevant runtime secrets as Pages, including the existing Square environment/location/token and explicit live-payment approval flag. Its five-minute schedule handles outbox processing, missed payment checks, expired quote notices and interrupted-send recovery. It has no public job endpoint, `workers_dev=false`, and `preview_urls=false`. Keep the production worker/database separate. Do not enable delivery until the exact self-test recipients and provider setup are approved.

Email retries reuse the same saved payload and idempotency key within 23 hours. Ambiguous SMS sends are marked uncertain and never automatically retried. The owner must inspect the provider before intentionally sending another custom text.

## 4. Post-ride behavior and payment checks

For opted-in bookings, messages follow request receipt, issued/replaced quotes, acceptance/decline, expiration, status changes, verified deposit, and completed-plus-fully-paid receipt. Receipt and optional-tip URLs are private HMAC links; raw URLs are encrypted in the event/outbox storage. Receipts show fare, verified deposit, verified remaining balance, ride date and reference without customer contact details or addresses.

A tip is optional and separate from the fare. A single saved amount and idempotency key per ride prevent checkout retries or amount changes from creating another tip. The customer chooses the amount before preparing checkout. Tip status is verified from the matching Square payment, with refunds flagged separately. Owner manual tip request/amount controls are removed; historic records remain.

Square reader and website balances continue using one existing invoice for exactly fare minus verified deposit. Test actual invoice creation, reader settlement on the specific supported Android/iPad, online settlement of the same balance, receipt delivery and an optional tip with explicitly approved small real payments. The existing live $1 deposit has not yet been confirmed; do not call it paid or create another deposit while its status is unresolved.

## 5. Final-domain verification and Square branding

Observed production Turnstile error: `110200`, domain not authorized. In the existing **MVBRI Booking Protection** widget's Hostname Management, add `mvbri.com` while preserving Pages/preview hostnames. Root hostname authorization covers its subdomains. Verify the production server's `TURNSTILE_ALLOWED_HOSTNAMES` includes `mvbri.com` and `www.mvbri.com` as well as the existing production Pages hostname; keep the preview override strict. Deploy the prepared callback/allowlist changes only with the approved production source rollout. Keep verification and rate limiting enabled, then test a protected synthetic booking on the final domain.

The website header, browser icon, receipt page and transactional email use the supplied gold logo. Square-hosted checkout, Square invoices and official Square receipts use account/location branding settings. Upload `assets/mvbri-logo.png` through the owner's Square Dashboard, then preview both Payment links → Settings → Branding and receipt customization for the correct location. No Square branding change has been performed yet.

Only after private delivery/payment/reader checks pass: prepare a concrete production rollout, apply missing additive migrations to the verified production database, preserve real records and existing access policies, and obtain approval for public source publication. Keep delivery off during any rollback and retain the additive tables.

## Source references

- [Cloudflare Pages deployment skip flags](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)
- [Cloudflare Turnstile error codes](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/)
- [Cloudflare Turnstile hostnames](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)
- [Twilio incoming phone number ownership/capabilities](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource)
- [Twilio request signing](https://www.twilio.com/docs/usage/security)
- [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Square payment-link branding](https://squareup.com/help/us/en/article/8364-customize-square-payment-links)
- [Square receipt branding](https://squareup.com/help/us/en/article/5424-customize-digital-receipts-and-invoices)
