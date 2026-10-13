import { json, ownerSession, sameOrigin } from "../_lib/auth.js";

const clean = (value, max = 500) =>
  String(value ?? "").trim().replace(/\u0000/g, "").slice(0, max);

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "Booking database is not connected yet. Please contact the driver directly." }, 503);
  }
  if (!sameOrigin(request)) return json({ error: "Request rejected." }, 403);
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "Please submit the form using the website." }, 415);
  }

  let body;
  try {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 12000) return json({ error: "Request is too large." }, 413);
    body = await request.json();
  } catch {
    return json({ error: "Invalid request. Please check your details and try again." }, 400);
  }

  const booking = {
    name: clean(body.name, 120),
    phone: clean(body.phone, 40),
    email: clean(body.email, 254).toLowerCase(),
    pickup: clean(body.pickup, 500),
    destination: clean(body.destination, 500),
    date: clean(body.date, 10),
    time: clean(body.time, 5),
    passengers: clean(body.passengers, 10),
    trip: clean(body.trip, 40),
    notes: clean(body.notes, 1500)
  };

  if (!booking.name || !booking.phone || !booking.email || !booking.pickup ||
      !booking.destination || !booking.date || !booking.time ||
      !booking.passengers || !booking.trip) {
    return json({ error: "Please complete all required fields." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(booking.email)) {
    return json({ error: "Please enter a valid email address." }, 400);
  }
 
  // Validate actual calendar dates and 24-hour pickup times.
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(booking.date);
  const timeParts = /^(\d{2}):(\d{2})$/.exec(booking.time);

  if (!dateParts || !timeParts) {
    return json({
      error: "Please enter a valid pickup date and time."
    }, 400);
  }

  const year = Number(dateParts[1]);
  const month = Number(dateParts[2]);
  const day = Number(dateParts[3]);
  const hour = Number(timeParts[1]);
  const minute = Number(timeParts[2]);

  const validCalendarDate =
    year >= 2026 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate();

  const validTime =
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59;

  if (!validCalendarDate || !validTime) {
    return json({
      error: "Please enter a valid pickup date and time."
    }, 400);
  }

  if (!["1", "2", "3", "4", "5", "6+"].includes(booking.passengers)) {
    return json({ error: "Please select a valid passenger count." }, 400);
  }
  if (!["One-way", "Round trip", "Multiple stops"].includes(booking.trip)) {
    return json({ error: "Please select a valid trip type." }, 400);
  }

  const reference = "RD-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO bookings
      (reference, name, phone, email, pickup, destination, pickup_date, pickup_time,
       passengers, trip_type, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
    `).bind(
      reference, booking.name, booking.phone, booking.email, booking.pickup,
      booking.destination, booking.date, booking.time, booking.passengers,
      booking.trip, booking.notes, now
    ).run();
    return json({ ok: true, reference }, 201);
  } catch {
    return json({ error: "We could not save your request right now. Please contact the driver directly." }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Database is not configured." }, 503);
  if (!await ownerSession(request, env)) return json({ error: "Please sign in as the owner." }, 401);
  const url = new URL(request.url);
  const status = clean(url.searchParams.get("status") || "", 20);
  const allowed = ["new", "confirmed", "declined", "contacted", "completed", "cancelled"];
  try {
    let result;
    if (status && allowed.includes(status)) {
      result = await env.DB.prepare(`
        SELECT reference, name, phone, email, pickup, destination, pickup_date, pickup_time,
               passengers, trip_type, notes, status, created_at, updated_at, tip_amount, tip_recorded_at
        FROM bookings WHERE status = ? ORDER BY pickup_date DESC, pickup_time DESC LIMIT 500
      `).bind(status).all();
    } else {
      result = await env.DB.prepare(`
        SELECT reference, name, phone, email, pickup, destination, pickup_date, pickup_time,
               passengers, trip_type, notes, status, created_at, updated_at, tip_amount, tip_recorded_at
        FROM bookings ORDER BY created_at DESC LIMIT 500
      `).all();
    }
    return json({ bookings: result.results || [] });
  } catch {
    return json({ error: "Could not load bookings." }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  if (!env.DB) return json({ error: "Database is not configured." }, 503);
  if (!sameOrigin(request)) return json({ error: "Request rejected." }, 403);
  if (!await ownerSession(request, env)) return json({ error: "Please sign in as the owner." }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const reference = clean(body.reference, 32);
  if (!reference) return json({ error: "Choose a valid booking." }, 400);

  try {
    if (Object.prototype.hasOwnProperty.call(body, "tipAmount")) {
      const amount = body.tipAmount === null || body.tipAmount === "" ? null : Number(body.tipAmount);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 10000)) {
        return json({ error: "Enter a valid tip amount between $0 and $10,000, or leave it blank." }, 400);
      }
      const existing = await env.DB.prepare("SELECT status FROM bookings WHERE reference = ?").bind(reference).first();
      if (!existing) return json({ error: "Booking not found." }, 404);
      if (existing.status !== "completed") {
        return json({ error: "Optional tips can only be recorded after the trip is marked completed." }, 409);
      }
      await env.DB.prepare(
        "UPDATE bookings SET tip_amount = ?, tip_recorded_at = ?, updated_at = ? WHERE reference = ?"
      ).bind(amount, amount === null ? null : new Date().toISOString(), new Date().toISOString(), reference).run();
      return json({ ok: true, reference, tipAmount: amount });
    }

    const status = clean(body.status, 20);
    const allowed = ["new", "confirmed", "declined", "contacted", "completed", "cancelled"];
    if (!allowed.includes(status)) {
      return json({ error: "Choose a valid booking status." }, 400);
    }
    const result = await env.DB.prepare(
      "UPDATE bookings SET status = ?, updated_at = ? WHERE reference = ?"
    ).bind(status, new Date().toISOString(), reference).run();
    if (!result.meta || result.meta.changes === 0) return json({ error: "Booking not found." }, 404);
    return json({ ok: true, reference, status });
  } catch {
    return json({ error: "Could not update the booking." }, 500);
  }
}
