-- MVBRI isolated PREVIEW only: mvbri-preview-bookings.
-- Additive tables/indexes only. Existing records are retained. Safe to rerun.

-- No backfill: existing customers have not opted in to automated updates.
CREATE TABLE IF NOT EXISTS booking_contact_preferences (
  booking_reference TEXT PRIMARY KEY REFERENCES bookings(reference),
  channel TEXT NOT NULL CHECK(channel IN ('none','email','sms')),
  sms_consent INTEGER NOT NULL DEFAULT 0 CHECK(sms_consent IN (0,1)),
  consent_version TEXT NOT NULL DEFAULT 'mvbri-updates-v1',
  consented_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_quote_links (
  quote_reference TEXT PRIMARY KEY REFERENCES ride_quotes(reference),
  token_hash TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  booking_reference TEXT NOT NULL REFERENCES bookings(reference),
  kind TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  queued_at TEXT
);
CREATE TABLE IF NOT EXISTS customer_messages (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  booking_reference TEXT NOT NULL REFERENCES bookings(reference),
  channel TEXT NOT NULL CHECK(channel IN ('email','sms')),
  destination TEXT NOT NULL,
  sender TEXT NOT NULL,
  content_ciphertext TEXT NOT NULL,
  provider_payload_ciphertext TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','pending','sending','accepted','delivered','failed','uncertain','suppressed','held')),
  provider_id TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT,
  draft_expires_at TEXT,
  delivery_status TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_messages_pending ON customer_messages(status,created_at);
CREATE TABLE IF NOT EXISTS sms_suppressions (
  phone_e164 TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS communication_provider_state (
  provider TEXT PRIMARY KEY,
  account_fingerprint TEXT NOT NULL,
  sender TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_callback_events (
  event_key TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

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
