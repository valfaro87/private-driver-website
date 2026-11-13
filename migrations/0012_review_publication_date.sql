-- Existing reviews keep an unknown publication date. New approvals record it.
ALTER TABLE customer_reviews ADD COLUMN published_at TEXT;
