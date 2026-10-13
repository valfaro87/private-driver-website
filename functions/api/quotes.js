
import { json, ownerSession, sameOrigin } from "../_lib/auth.js";

const clean = (value, max = 500) =>
  String(value ?? "").trim().replace(/\u0000/g, "").slice(0, max);

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Database unavailable." }, 503);
  if (!await ownerSession(request, env)) {
    return json({ error: "Please sign in as the owner." }, 401);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT
        b.reference AS booking_reference,
        b.name,
        b.email,
        b.pickup,
        b.destination,
        b.pickup_date,
        b.pickup_time,
        b.trip_type,
        b.status AS booking_status,
        q.reference AS quote_reference,
        q.status AS quote_status,
        q.mileage,
        q.base_fare_cents,
        q.mileage_fare_cents,
        q.weekend_adjustment_cents,
        q.late_night_adjustment_cents,
        q.manual_adjustment_cents,
        q.final_fare_cents,
        q.owner_notes,
        q.created_at AS quote_created_at,
        q.expires_at
      FROM bookings b
      LEFT JOIN ride_quotes q
        ON q.booking_reference = b.reference
        AND q.status IN ('draft', 'issued', 'accepted')
      ORDER BY b.created_at DESC
      LIMIT 500
    `).all();

    return json({ bookings: result.results || [] });
  } catch {
    return json({
      error: "Could not load quote records. Please verify the ride_quotes table and its schema."
    }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Database unavailable." }, 503);
  if (!sameOrigin(request)) return json({ error: "Request rejected." }, 403);
  if (!await ownerSession(request, env)) {
    return json({ error: "Please sign in as the owner." }, 401);
  }

  let body;
  try {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 8000) return json({ error: "Request too large." }, 413);
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const bookingReference = clean(body.bookingReference, 32);
  const mileage = Number(body.mileage);
  const manualAdjustment = Number(body.manualAdjustment ?? 0);
  const ownerNotes = clean(body.ownerNotes, 1500);
  const weekend = body.weekend === true;
  const lateNight = body.lateNight === true;

  if (!bookingReference) {
    return json({ error: "Choose a booking." }, 400);
  }
  if (!Number.isFinite(mileage) || mileage < 0 || mileage > 10000) {
    return json({ error: "Mileage must be between 0 and 10,000." }, 400);
  }
  if (!Number.isFinite(manualAdjustment) ||
      manualAdjustment < -100000 || manualAdjustment > 100000) {
    return json({ error: "Enter a valid manual adjustment." }, 400);
  }

  try {
    const booking = await env.DB.prepare(
      "SELECT reference FROM bookings WHERE reference = ?"
    ).bind(bookingReference).first();

    if (!booking) return json({ error: "Booking not found." }, 404);

    await env.DB.prepare(`
      INSERT OR IGNORE INTO pricing_settings (
        id, minimum_fare_cents, price_per_mile_cents,
        weekend_adjustment_cents, late_night_adjustment_cents,
        quote_expiration_hours, updated_at
      ) VALUES (1, 5000, 250, 1000, 1000, 24, ?)
    `).bind(new Date().toISOString()).run();

    const pricing = await env.DB.prepare(
      "SELECT * FROM pricing_settings WHERE id = 1"
    ).first();

    if (!pricing) {
      return json({ error: "Pricing settings are unavailable." }, 500);
    }

    const mileageFare = Math.round(mileage * pricing.price_per_mile_cents);
    const baseFare = Math.max(pricing.minimum_fare_cents, mileageFare);
    const weekendCents = weekend ? pricing.weekend_adjustment_cents : 0;
    const lateNightCents = lateNight ? pricing.late_night_adjustment_cents : 0;
    const manualCents = Math.round(manualAdjustment * 100);
    const finalFare = baseFare + weekendCents + lateNightCents + manualCents;

    if (finalFare < 0 || finalFare > 100000000) {
      return json({ error: "The calculated fare is outside the allowed range." }, 400);
    }

    const now = new Date().toISOString();
    const reference = "QT-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

    await env.DB.prepare(`
      UPDATE ride_quotes
      SET status = 'superseded', updated_at = ?
      WHERE booking_reference = ?
        AND status = 'draft'
    `).bind(now, bookingReference).run();

    await env.DB.prepare(`
      INSERT INTO ride_quotes (
        reference, booking_reference, status, mileage,
        base_fare_cents, mileage_fare_cents,
        weekend_adjustment_cents, late_night_adjustment_cents,
        manual_adjustment_cents, final_fare_cents, owner_notes,
        created_at, updated_at
      ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reference,
      bookingReference,
      mileage,
      baseFare,
      mileageFare,
      weekendCents,
      lateNightCents,
      manualCents,
      finalFare,
      ownerNotes,
      now,
      now
    ).run();

    return json({
      ok: true,
      message: "Draft quote calculated. Review it before issuing to the customer.",
      quote: {
        reference,
        bookingReference,
        mileage,
        baseFare: baseFare / 100,
        mileageFare: mileageFare / 100,
        weekendAdjustment: weekendCents / 100,
        lateNightAdjustment: lateNightCents / 100,
        manualAdjustment: manualCents / 100,
        finalFare: finalFare / 100,
        status: "draft"
      }
    }, 201);
  } catch {
    return json({
      error: "Could not create a draft quote. Please check the ride_quotes table and try again."
    }, 500);
  }
}
