
-- MVBRI pricing settings: one row holds the current owner-configured rates.
CREATE TABLE IF NOT EXISTS pricing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minimum_fare_cents INTEGER NOT NULL DEFAULT 5000
    CHECK (minimum_fare_cents >= 0),
  price_per_mile_cents INTEGER NOT NULL DEFAULT 250
    CHECK (price_per_mile_cents >= 0),
  weekend_adjustment_cents INTEGER NOT NULL DEFAULT 1000
    CHECK (weekend_adjustment_cents >= 0),
  late_night_adjustment_cents INTEGER NOT NULL DEFAULT 1000
    CHECK (late_night_adjustment_cents >= 0),
  quote_expiration_hours INTEGER NOT NULL DEFAULT 24
    CHECK (quote_expiration_hours BETWEEN 1 AND 168),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO pricing_settings (
  id,
  minimum_fare_cents,
  price_per_mile_cents,
  weekend_adjustment_cents,
  late_night_adjustment_cents,
  quote_expiration_hours,
  updated_at
) VALUES (
  1, 5000, 250, 1000, 1000, 24, '2026-10-12T00:00:00.000Z'
);

-- Each issued quote has its own deadline and secure-token hash.
-- Multiple quote records preserve the history if a quote is reissued.
CREATE TABLE IF NOT EXISTS ride_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  booking_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'issued', 'accepted', 'declined',
      'expired', 'cancelled', 'superseded'
    )),
  mileage REAL NOT NULL DEFAULT 0
    CHECK (mileage >= 0 AND mileage <= 10000),
  base_fare_cents INTEGER NOT NULL DEFAULT 0
    CHECK (base_fare_cents >= 0),
  mileage_fare_cents INTEGER NOT NULL DEFAULT 0
    CHECK (mileage_fare_cents >= 0),
  weekend_adjustment_cents INTEGER NOT NULL DEFAULT 0
    CHECK (weekend_adjustment_cents >= 0),
  late_night_adjustment_cents INTEGER NOT NULL DEFAULT 0
    CHECK (late_night_adjustment_cents >= 0),
  manual_adjustment_cents INTEGER NOT NULL DEFAULT 0,
  final_fare_cents INTEGER,
  owner_notes TEXT NOT NULL DEFAULT '',
  customer_token_hash TEXT UNIQUE,
  created_at TEXT NOT NULL,
  issued_at TEXT,
  expires_at TEXT,
  responded_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (booking_reference) REFERENCES bookings(reference),
  CHECK (final_fare_cents IS NULL OR final_fare_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ride_quotes_booking
  ON ride_quotes(booking_reference);

CREATE INDEX IF NOT EXISTS idx_ride_quotes_status_expiry
  ON ride_quotes(status, expires_at);
