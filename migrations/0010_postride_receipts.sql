-- Additive, private post-ride links and a separate optional-tip payment ledger.
CREATE TABLE IF NOT EXISTS postride_receipts (
 quote_reference TEXT PRIMARY KEY REFERENCES ride_quotes(reference),
 booking_reference TEXT NOT NULL REFERENCES bookings(reference),
 nonce TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS square_tip_checkouts (
 quote_reference TEXT PRIMARY KEY REFERENCES postride_receipts(quote_reference),
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 100 AND 50000),
 currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 square_environment TEXT NOT NULL CHECK(square_environment IN ('sandbox','production')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','refunded','review')),
 checkout_key TEXT NOT NULL UNIQUE,
 checkout_request TEXT NOT NULL,
 square_order_id TEXT UNIQUE,
 square_payment_link_id TEXT UNIQUE,
 checkout_url TEXT,
 square_payment_id TEXT UNIQUE,
 paid_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_square_tip_status ON square_tip_checkouts(status);
