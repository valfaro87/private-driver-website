# MVBRI upgrade validation — October 28, 2026

Production/main remains at `e9feab2a18a0ae44fd5b7af1d67c5fe0602ebecd`. The owner-restricted Cloudflare preview is at `https://mvbri-private-upgrades-20261.private-driver-website.pages.dev/`, using a separate preview database. Existing booking, pricing, expiration, optional tips and review moderation remain intact. Never include customer links, provider tokens or payment details in this report.

## Previously verified on the private deployment

- Protected synthetic booking submission and automatic route mileage including an additional stop.
- MVBRI / Owner branding before and after login, restored sessions, and cleared private controls after sign-out.
- Accepted quote buttons disappear immediately and after reload; private notes stay private.
- Required 50% deposit wording and no Sandbox notice in live mode.
- Square Sandbox deposit and balance simulation, exact amounts, completed-trip balance gate and server-side verification.
- Pending/publish/reply/hide review moderation, consent, single-use invitations and customer field allowlist.
- Optional tip records persist; tip request links remain informational.
- Production Square checkout loads the exact synthetic $1 deposit with card, Google Pay and Cash App Pay options. The user confirmed Apple Pay visibility and the MVBRI/$1 payment sheet. Actual authorization has been requested but is not yet verified.
- Owner review management remains hidden before login and after reload in the private version. The older public version has not yet received that source update.

## Shared reader/online balance changes: local validation

`npm test` — 18 tests passed using synthetic records, in-memory SQLite and mocked providers:

- Existing booking security, owner authorization, pricing, quote responses/expiration, reviews, tips and mileage allowance.
- Explicit live-payment gate, exact server-derived deposit, safe checkout retries and signed webhook verification.
- Same balance invoice and order for online and reader collection, for fare minus the verified deposit.
- Owner authentication, same-origin checks, completed ride and matching verified deposit are required.
- Ambiguous provider responses resume the original idempotent invoice workflow without another balance.
- Partial reader payments reduce the remaining amount; a verified final online payment settles the same invoice once.
- Manual paid entries, wrong location/order/currency, uncompleted payments, overpayments and refunds cannot falsely settle a balance.
- Legacy balance payment links remain usable online and cannot spawn a separate reader charge.
- Signed reader-payment events reconcile the invoice and remove both payment choices after verified full payment.

Isolated browser fixture checks passed, with every provider request intercepted:

- A $100.01 quote with a verified $50.01 deposit shows $50.00 for both remaining-balance choices.
- Choosing in-person payment does not navigate or charge; the owner sees the same invoice number and $50.00 due.
- Preparing the invoice again preserves that invoice.
- A simulated completed reader payment, verified through the actual server handler, changes the owner balance to $0.00 and the customer fare to paid in full. Both collection buttons disappear.
- Sign-out and signed-out navigation hide balance collection and review management.

Inline JavaScript syntax and whitespace checks passed. Cloudflare Wrangler 4.152.0 compiled the Pages Functions successfully. No real payment, customer message, purchase or public publication was performed for these balance changes.

## Remaining deployment and launch work

Apply additive migration `0008_balance_invoices.sql` to the isolated preview database before deploying the balance changes. Then verify actual Square invoice creation, website checkout and the connected reader on the chosen Android or iPad device. A live payment requires the owner to authorize the exact test amount. The existing $1 live deposit test is still awaiting confirmation. Keep older Sandbox payment records separate from production verification.

Before public launch, verify production schema and bindings, apply only missing additive migrations, configure production Square verification and preserve existing customer records. Public source rollout remains pending owner approval. Mileage retains the existing 20-request daily limit. Tips retain the existing optional record/link workflow.
