-- A PayPal order owns the same deposit or balance slot as a Square checkout.
CREATE TABLE IF NOT EXISTS paypal_checkouts (
  payment_id INTEGER PRIMARY KEY REFERENCES square_payments(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('paypal', 'venmo')),
  order_id TEXT UNIQUE,
  capture_id TEXT UNIQUE,
  capture_started_at TEXT
);
