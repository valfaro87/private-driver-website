
CREATE TABLE IF NOT EXISTS mileage_usage (
  day TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0
    CHECK (request_count >= 0)
);
