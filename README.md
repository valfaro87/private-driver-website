# Private Driver Website — Cloudflare Pages + D1

A responsive private driver / chauffeur website starter with a ride request form and a Cloudflare D1 booking database.

## Included
- Luxury-style, responsive website
- Ride request form submits to `/api/bookings`
- Cloudflare Pages Function validates form input and inserts each request into D1
- Random booking reference returned to the customer
- D1 schema with booking status fields and useful indexes
- No analytics or public booking-list endpoint
- The database is not accessible directly from the public website

## Important limitations
- This starter stores ride requests, but does not include a private admin dashboard to view/manage them. Use the Cloudflare D1 console for initial testing, or add an authenticated dashboard before day-to-day use.
- It does not automatically confirm rides or process payments. The driver must contact the customer to confirm availability and pricing.
- Payment options displayed on the page are informational only until you add secure hosted payment links from your payment provider.
- Before production use, add rate limiting / bot protection, a secure authenticated way to view and manage bookings, and a retention/deletion policy for personal data.
- Never store payment card details, passwords, or sensitive information in booking notes.
- Do not use public read routes for bookings; the database contains personal customer information.

## Set up contact details
Edit `site-settings.js` and replace the business name, phone, email, and service area. Keep API keys and other secrets out of this file.

## Deploy on Cloudflare Pages

### 1. Create a D1 database
1. Sign in to Cloudflare.
2. Open **Workers & Pages → D1 SQL Database** (menu wording may vary).
3. Create a database, for example `private-driver-bookings`.
4. Open the database and copy its database name and ID.

### 2. Apply the migration
From a local terminal with Wrangler installed and authenticated, run from this project folder:

```bash
npx wrangler d1 execute private-driver-bookings --remote --file=./migrations/0001_create_bookings.sql
```

Replace `private-driver-bookings` with the exact database name you created. Alternatively, paste the SQL from `migrations/0001_create_bookings.sql` into the D1 console's query editor and run it.

### 3. Upload/deploy the website
Because the site now uses a Pages Function, deploy it using a Git-connected Pages project or Wrangler rather than a static-only drag-and-drop upload.

Recommended with Wrangler:
1. Install Node.js, then run `npm install -g wrangler`.
2. Run `npx wrangler login`.
3. Create `wrangler.toml` based on `wrangler.example.toml` and fill in your D1 database ID.
4. Run `npx wrangler pages deploy . --project-name=YOUR-PAGES-PROJECT-NAME`.

Or connect the project repository to Cloudflare Pages and set the project root to this folder. Ensure the `functions/` directory is included in the deployment.

### 4. Bind D1 to Pages
In Cloudflare dashboard, open your Pages project:
1. **Settings → Functions → D1 database bindings** (labels may vary).
2. Add a binding with variable name **`DB`**.
3. Select the D1 database you created.
4. Redeploy the project so the binding is available to the Function.

If using a Wrangler configuration, the binding can be defined in `wrangler.toml` as shown in `wrangler.example.toml`.

### 5. Test
Submit a test ride request through the deployed website. It should return a booking reference. Confirm a row was inserted in D1. Do not use real customer personal information for testing.

## Privacy
The booking form sends submitted fields to your Cloudflare Pages Function, which stores them in your Cloudflare D1 database. This means customer details are transmitted to and stored by Cloudflare as your hosting/database provider. This is not “never shared” or end-to-end private. Review Cloudflare's terms and privacy documentation, restrict account access, and do not publish or expose the database contents. Public contact details remain visible on the website.

Cloudflare documentation:
- Pages Functions: https://developers.cloudflare.com/pages/functions/
- D1: https://developers.cloudflare.com/d1/
- Pages D1 bindings: https://developers.cloudflare.com/pages/functions/bindings/#d1-databases


## Owner dashboard

After deployment, open `https://YOUR-DOMAIN/owner.html`. The dashboard lets the owner:
- Sign in with an owner password stored as a Cloudflare secret (not in source code)
- See new and existing ride requests
- Filter by booking status
- Confirm, decline, contact, complete, or cancel reservations
- Use email/call shortcuts to contact the customer
- Refresh bookings and see summary counts

### Configure owner password
In Cloudflare dashboard, open the Pages project and add an environment variable/secret:
- `OWNER_PASSWORD`: choose a long, unique password (ideally 16+ characters).
Mark it as a **secret** if the dashboard offers that option, and set it for Production (and Preview only if needed). Never put it in `site-settings.js` or the repository.

The login route creates an 8-hour HttpOnly, Secure, SameSite=Strict session cookie. Only a hash of the random session token is stored in D1. The password itself is not stored in the database.

### Existing D1 database migration
If you already applied the earlier `0001_create_bookings.sql` migration before the dashboard was added, the old status CHECK constraint will not permit `declined`, and the new `owner_sessions` table will be missing. The simplest safe path for a new test project is to create a fresh D1 database and apply the updated migration. If you have real bookings in an existing database, do not delete it; perform a planned table migration that preserves all rows and then create `owner_sessions`.

### Security before real customer use
- Configure Cloudflare rate limiting or another bot protection on `POST /api/auth/login` and `POST /api/bookings`.
- Use a long, unique owner password and secure your Cloudflare account with MFA.
- Restrict who can access the Cloudflare account and D1 database.
- The owner dashboard is not linked from the public homepage, but its URL is not a security control; authentication is enforced by the API.
- Customer details are personal data stored by your hosting/database provider. Review provider terms, publish a privacy notice, and establish a retention/deletion policy.
- This starter has one owner-password login, not multi-user roles, password reset, or a full audit log.
- Status changes update the database only. They do not automatically email the customer, charge a payment method, or send a booking confirmation.


## Optional tips after trip completion
- The public website explains that gratuity is entirely optional and appreciated but never expected.
- In the owner dashboard, mark the reservation `completed`, then optionally record a tip amount received.
- The tip field is optional; leave it blank if no tip was received or you do not want to track tips.
- This feature only records the amount in the booking database. It does not charge the customer or collect a tip online. If you want customers to pay tips digitally, configure an official payment provider's hosted checkout/tip flow separately.

### Existing database note for the tip feature
If you already created the D1 database from an earlier version of the migration, `CREATE TABLE IF NOT EXISTS` will not add the new tip columns to an existing table. For an existing database, run a one-time migration such as:

```sql
ALTER TABLE bookings ADD COLUMN tip_amount REAL CHECK (tip_amount IS NULL OR tip_amount >= 0);
ALTER TABLE bookings ADD COLUMN tip_recorded_at TEXT;
```

Only run these statements if the columns do not already exist. Keep your existing bookings and never drop a live customer database just to add these fields.


## Optional tips after completed rides

The owner dashboard now includes an optional gratuity section when completed bookings exist. The owner can select a completed trip, choose a tip amount ($5, $10, $15, $20, $25, or custom up to $500), and create a tip-request URL. The database stores a tip request separately from the booking.

**Payment collection is not activated by this starter implementation.** The generated `tip.html` page explains that tips are optional and directs the customer to contact the driver. To accept tips online, integrate a hosted checkout/payment link from a provider such as Stripe, Square, or PayPal. Create checkout sessions server-side, validate the amount and booking reference on the server, and only mark a tip as paid after a verified provider webhook confirms payment. Never trust a browser redirect alone as proof of payment and never store card numbers in D1.

If you already deployed the previous database migration, apply a new migration that creates the `trip_tips` table; do not blindly rerun the original migration against a live database. The SQL for the current fresh-install schema is in `migrations/0001_create_bookings.sql`.
