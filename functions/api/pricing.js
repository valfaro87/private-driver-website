
import { json, ownerSession, sameOrigin } from "../_lib/auth.js";

const DEFAULTS = {
  minimum_fare_cents: 5000,
  price_per_mile_cents: 250,
  weekend_adjustment_cents: 1000,
  late_night_adjustment_cents: 1000,
  quote_expiration_hours: 24
};

async function ensureSettings(DB) {
  await DB.prepare(`
    INSERT OR IGNORE INTO pricing_settings (
      id, minimum_fare_cents, price_per_mile_cents,
      weekend_adjustment_cents, late_night_adjustment_cents,
      quote_expiration_hours, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?)
  `).bind(
    DEFAULTS.minimum_fare_cents,
    DEFAULTS.price_per_mile_cents,
    DEFAULTS.weekend_adjustment_cents,
    DEFAULTS.late_night_adjustment_cents,
    DEFAULTS.quote_expiration_hours,
    new Date().toISOString()
  ).run();
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Database unavailable." }, 503);
  if (!await ownerSession(request, env)) {
    return json({ error: "Please log in as the owner." }, 401);
  }

  await ensureSettings(env.DB);

  const settings = await env.DB.prepare(
    "SELECT * FROM pricing_settings WHERE id = 1"
  ).first();

  return json({
    minimumFare: settings.minimum_fare_cents / 100,
    pricePerMile: settings.price_per_mile_cents / 100,
    weekendAdjustment: settings.weekend_adjustment_cents / 100,
    lateNightAdjustment: settings.late_night_adjustment_cents / 100,
    expirationHours: settings.quote_expiration_hours,
    updatedAt: settings.updated_at
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Database unavailable." }, 503);
  if (!sameOrigin(request)) return json({ error: "Request rejected." }, 403);
  if (!await ownerSession(request, env)) {
    return json({ error: "Please log in as the owner." }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  const fields = [
    ["minimumFare", "Minimum fare", 0, 100000],
    ["pricePerMile", "Price per mile", 0, 10000],
    ["weekendAdjustment", "Weekend adjustment", 0, 10000],
    ["lateNightAdjustment", "Late-night adjustment", 0, 10000]
  ];

  const values = {};

  for (const [key, label, min, max] of fields) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value) ||
        value < min || value > max) {
      return json({ error: `${label} is invalid.` }, 400);
    }
    values[key] = Math.round(value * 100);
  }

  const hours = body.expirationHours;
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    return json({
      error: "Expiration must be between 1 and 168 hours."
    }, 400);
  }

  await ensureSettings(env.DB);

  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE pricing_settings
    SET minimum_fare_cents = ?,
        price_per_mile_cents = ?,
        weekend_adjustment_cents = ?,
        late_night_adjustment_cents = ?,
        quote_expiration_hours = ?,
        updated_at = ?
    WHERE id = 1
  `).bind(
    values.minimumFare,
    values.pricePerMile,
    values.weekendAdjustment,
    values.lateNightAdjustment,
    hours,
    now
  ).run();

  return json({ success: true, message: "Pricing settings saved." });
}
