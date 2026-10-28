-- One remaining-balance invoice can be paid online or through Square POS.
-- Additive: existing quotes, payment links, deposits and payments are retained.
CREATE TABLE IF NOT EXISTS square_balance_invoices (
  payment_id INTEGER PRIMARY KEY REFERENCES square_payments(id),
  square_customer_id TEXT,
  square_invoice_id TEXT UNIQUE,
  invoice_status TEXT NOT NULL DEFAULT 'DRAFT',
  preferred_method TEXT NOT NULL DEFAULT 'online'
    CHECK (preferred_method IN ('online', 'reader')),
  verified_payment_ids TEXT NOT NULL DEFAULT '[]',
  verified_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (verified_amount_cents >= 0),
  review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
