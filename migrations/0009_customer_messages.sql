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
