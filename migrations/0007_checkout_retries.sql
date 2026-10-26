-- Additive: existing payment records, quotes and bookings are retained.
-- Legacy incomplete checkouts require owner verification before retrying.
ALTER TABLE square_payments ADD COLUMN checkout_key TEXT;
ALTER TABLE square_payments ADD COLUMN checkout_request TEXT;
