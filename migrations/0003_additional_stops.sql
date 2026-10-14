
-- MVBRI Upgrade 2: Store additional stops in travel order.
ALTER TABLE bookings
ADD COLUMN additional_stops TEXT NOT NULL DEFAULT '[]';
