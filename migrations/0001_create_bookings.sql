CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  pickup TEXT NOT NULL,
  destination TEXT NOT NULL,
  pickup_date TEXT NOT NULL,
  pickup_time TEXT NOT NULL,
  passengers TEXT NOT NULL,
  trip_type TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'confirmed', 'declined', 'contacted', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  tip_amount REAL CHECK (tip_amount IS NULL OR tip_amount >= 0),
  tip_recorded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_pickup_date ON bookings(pickup_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

-- Stores only hashed session tokens; the raw token exists only in the owner's browser cookie.
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_owner_sessions_expiry ON owner_sessions(expires_at);


-- Optional gratuities recorded separately from ride bookings.
-- Payment processing itself must be handled by a secure payment provider.
CREATE TABLE IF NOT EXISTS trip_tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  booking_reference TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'cancelled')),
  payment_provider TEXT,
  payment_reference TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  FOREIGN KEY (booking_reference) REFERENCES bookings(reference)
);

CREATE INDEX IF NOT EXISTS idx_trip_tips_booking_reference ON trip_tips(booking_reference);
CREATE INDEX IF NOT EXISTS idx_trip_tips_status ON trip_tips(status);
