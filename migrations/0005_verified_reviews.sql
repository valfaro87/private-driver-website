
-- MVBRI Verified Customer Reviews
-- Migration 0005

-- Secure review invitations for completed bookings.
CREATE TABLE IF NOT EXISTS review_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_reference TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT
);

-- Customer reviews.
CREATE TABLE IF NOT EXISTS customer_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_reference TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  rating INTEGER NOT NULL
    CHECK (rating BETWEEN 1 AND 5),
  feedback TEXT NOT NULL,
  permission_to_publish INTEGER NOT NULL DEFAULT 0
    CHECK (permission_to_publish IN (0, 1)),
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      moderation_status IN (
        'pending',
        'published',
        'hidden'
      )
    ),
  owner_response TEXT,
  owner_response_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_reference)
    REFERENCES bookings(reference)
);

-- Speed up loading public reviews.
CREATE INDEX IF NOT EXISTS idx_customer_reviews_public
ON customer_reviews (
  moderation_status,
  permission_to_publish,
  created_at
);

-- Speed up review invitation lookups.
CREATE INDEX IF NOT EXISTS idx_review_invitations_token
ON review_invitations (token_hash);
