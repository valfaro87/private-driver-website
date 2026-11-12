-- Apply as a single transaction before deploying checkout code that accepts tips over $500.
-- Rebuild the optional-tip table with its existing rows and constraints, minus the MVBRI maximum.
CREATE TABLE square_tip_checkouts_0011 (
 quote_reference TEXT PRIMARY KEY REFERENCES postride_receipts(quote_reference),
 amount_cents INTEGER NOT NULL CHECK(amount_cents >= 100),
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

INSERT INTO square_tip_checkouts_0011 (
 quote_reference, amount_cents, currency, square_environment, status, checkout_key,
 checkout_request, square_order_id, square_payment_link_id, checkout_url, square_payment_id,
 paid_at, created_at, updated_at
)
SELECT
 quote_reference, amount_cents, currency, square_environment, status, checkout_key,
 checkout_request, square_order_id, square_payment_link_id, checkout_url, square_payment_id,
 paid_at, created_at, updated_at
FROM square_tip_checkouts;

DROP TABLE square_tip_checkouts;
ALTER TABLE square_tip_checkouts_0011 RENAME TO square_tip_checkouts;
CREATE INDEX idx_square_tip_status ON square_tip_checkouts(status);
