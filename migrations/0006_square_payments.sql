
-- MVBRI Square payment tracking
-- Sandbox integration: 50% deposit and 50% final balance.

CREATE TABLE IF NOT EXISTS square_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  quote_reference TEXT NOT NULL,
  booking_reference TEXT NOT NULL,

  payment_type TEXT NOT NULL
    CHECK (payment_type IN ('deposit', 'balance')),

  amount_cents INTEGER NOT NULL
    CHECK (amount_cents > 0),

  currency TEXT NOT NULL DEFAULT 'USD'
    CHECK (currency = 'USD'),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'paid',
      'failed',
      'cancelled',
      'refunded'
    )),

  square_environment TEXT NOT NULL DEFAULT 'sandbox'
    CHECK (square_environment IN ('sandbox', 'production')),

  square_order_id TEXT,
  square_payment_link_id TEXT,
  square_payment_id TEXT UNIQUE,

  checkout_url TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,

  FOREIGN KEY (quote_reference)
    REFERENCES ride_quotes(reference),

  FOREIGN KEY (booking_reference)
    REFERENCES bookings(reference),

  UNIQUE (quote_reference, payment_type)
);

CREATE INDEX IF NOT EXISTS idx_square_payments_booking
  ON square_payments(booking_reference);

CREATE INDEX IF NOT EXISTS idx_square_payments_status
  ON square_payments(status);
