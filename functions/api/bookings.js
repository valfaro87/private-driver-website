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

  // Limit booking requests by visitor IP address.
  if (!env.BOOKING_RATE_LIMITER) {
    console.error("Booking rate limiter binding is missing.");
    return json({ error: "Booking service is temporarily unavailable." }, 503);
  }

  const visitorIP = request.headers.get("CF-Connecting-IP");
  if (!visitorIP) {
    console.error("Visitor IP address is unavailable.");
    return json({ error: "Booking service is temporarily unavailable." }, 503);
  }

  try {
    const limiterId = env.BOOKING_RATE_LIMITER.idFromName(
      `booking:${visitorIP}`
    );
    const limiter = env.BOOKING_RATE_LIMITER.get(limiterId);

    const limiterResponse = await limiter.fetch(
      new Request("https://internal/check", { method: "POST" })
    );

    if (limiterResponse.status === 429) {
      return json({
        error: "Too many booking attempts. Please wait a minute and try again."
      }, 429);
    }

   
    if (!limiterResponse.ok) {
      throw new Error("Rate limiter unavailable.");
    }

    const limiterResult = await limiterResponse.json();

    if (limiterResult?.allowed !== true) {
      throw new Error("Rate limiter returned an invalid response.");
    }

  } catch (error) {
    console.error("Booking rate limiter failed:", error);
    return json({
      error: "Booking service is temporarily unavailable. Please try again."
    }, 503);
  }

  
let body;
try {
  const maxBytes = 12000;

  const declaredLength = request.headers.get("content-length");

  if (
    declaredLength !== null &&
    Number(declaredLength) > maxBytes
  ) {
    return json({ error: "Request is too large." }, 413);
  }

  const reader = request.body?.getReader();

  if (!reader) {
    return json({ error: "Invalid request body." }, 400);
  }

  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;

    if (totalBytes > maxBytes) {
      await reader.cancel();
      return json({ error: "Request is too large." }, 413);
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const rawText = new TextDecoder("utf-8", {
    fatal: true
  }).decode(bytes);

  body = JSON.parse(rawText);
} catch {
  return json({
    error: "Invalid request. Please check your details and try again."
  }, 400);
}


  // Reject oversized booking fields before they are truncated.
  const fieldLimits = {
    name: 120,
    phone: 40,
    email: 254,
    pickup: 500,
    destination: 500,
    date: 10,
    time: 5,
    passengers: 10,
    trip: 40,
    notes: 1500
  };

  // Require a JSON object rather than null or an array.
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return json({ error: "Invalid booking details." }, 400);
  }

  for (const [field, maxLength] of Object.entries(fieldLimits)) {
    const value = body[field];

    if (value !== undefined && value !== null) {
      if (typeof value !== "string") {
        return json({
          error: `Invalid value for ${field}.`
        }, 400);
      }

      if (value.trim().replace(/\u0000/g, "").length > maxLength) {
        return json({
          error: `${field} is too long. Maximum ${maxLength} characters.`
        }, 400);
      }
    }
  }

  // MVBRI Upgrade 2: Validate additional stops.
  // Older booking clients may omit this field.
  const additionalStops = body.additionalStops === undefined
    ? []
    : body.additionalStops;

  if (!Array.isArray(additionalStops)) {
    return json({
      error: "Additional stops must be a list."
    }, 400);
  }

  if (additionalStops.length > 10) {
    return json({
      error: "You can add a maximum of 10 additional stops."
    }, 400);
  }

  for (const stop of additionalStops) {
    if (
      typeof stop !== "string" ||
      stop.length > 300 ||
      stop.trim().length === 0 ||
      /[\u0000-\u001F\u007F]/.test(stop)
    ) {
      return json({
        error: "Please enter a valid address for each additional stop (maximum 300 characters)."
      }, 400);
    }
  }

  const validatedStops = additionalStops.map(stop => stop.trim());

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

  // Compare the requested pickup date with today's date in Houston.
  const houstonToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const todayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const getPart = type =>
    todayParts.find(part => part.type === type)?.value;

  const todayKey =
    `${getPart("year")}-${getPart("month")}-${getPart("day")}`;

  if (booking.date < todayKey) {
    return json({
      error: "Please choose a pickup date that is today or later."
    }, 400);
  }

  // Reject pickup times that have already passed today in Houston.
  const houstonTimeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const getTimePart = type =>
    houstonTimeParts.find(part => part.type === type)?.value;

  const currentHoustonTime =
    `${getTimePart("hour")}:${getTimePart("minute")}`;

  if (
    booking.date === todayKey &&
    booking.time <= currentHoustonTime
  ) {
    return json({
      error: "Please choose a pickup time later than the current Houston time."
    }, 400);
  }

  if (!["1", "2", "3", "4", "5", "6+"].includes(booking.passengers)) {
    return json({ error: "Please select a valid passenger count." }, 400);
  }
  if (!["One-way", "Round trip", "Multiple stops"].includes(booking.trip)) {
    return json({ error: "Please select a valid trip type." }, 400);
  }

  // Verify Cloudflare Turnstile before saving the booking.
  const turnstileToken = body.turnstileToken;

  if (
    typeof turnstileToken !== "string" ||
    !turnstileToken ||
    turnstileToken.length > 2048
  ) {
    return json({
      error: "Please complete the security verification."
    }, 403);
  }

  if (!env.TURNSTILE_SECRET_KEY) {
    console.error("Turnstile secret is not configured.");
    return json({
      error: "Booking verification is temporarily unavailable."
    }, 503);
  }

  let verification;

  try {
    const verificationResponse = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY,
          response: turnstileToken,
          remoteip: request.headers.get("CF-Connecting-IP") || ""
        }),
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!verificationResponse.ok) {
      throw new Error("Turnstile verification service unavailable.");
    }

    verification = await verificationResponse.json();
  } catch (error) {
    console.error("Turnstile verification request failed.");
    return json({
      error: "Security verification is temporarily unavailable. Please try again."
    }, 503);
  }

  if (
    !verification.success ||
    !(env.TURNSTILE_ALLOWED_HOSTNAMES || "private-driver-website.pages.dev")
      .split(",").map(host => host.trim().toLowerCase()).includes(String(verification.hostname || "").toLowerCase())
  ) {
    return json({
      error: "Security verification failed. Please try again."
    }, 403);
  }

  const reference = "RD-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const now = new Date().toISOString();
  try {
   
    await env.DB.prepare(`
      INSERT INTO bookings
      (reference, name, phone, email, pickup, destination, additional_stops,
       pickup_date, pickup_time, passengers, trip_type, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
    `).bind(
      reference,
      booking.name,
      booking.phone,
      booking.email,
      booking.pickup,
      booking.destination,
      JSON.stringify(validatedStops),
      booking.date,
      booking.time,
      booking.passengers,
      booking.trip,
      booking.notes,
      now
    ).run();
 
    return json({ ok: true, reference }, 201);
  } catch {
    return json({ error: "We could not save your request right now. Please contact the driver directly." }, 500);
  }
}


export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return json({ error: "Database is not configured." }, 503);
  }

  if (!await ownerSession(request, env)) {
    return json({ error: "Please sign in as the owner." }, 401);
  }

  const url = new URL(request.url);
  const status = clean(url.searchParams.get("status") || "", 20);

  const allowed = [
    "new", "confirmed", "declined",
    "contacted", "completed", "cancelled"
  ];

  try {
    const query = `
      SELECT
        b.reference,
        b.name,
        b.phone,
        b.email,
        b.pickup,
        b.destination,
        b.additional_stops,
        b.pickup_date,
        b.pickup_time,
        b.passengers,
        b.trip_type,
        b.notes,
        b.status,
        b.created_at,
        b.updated_at,
        b.tip_amount,
        b.tip_recorded_at,

        (
          SELECT q.reference
          FROM ride_quotes q
          WHERE q.booking_reference = b.reference
            AND q.status = 'accepted'
          ORDER BY q.updated_at DESC, q.created_at DESC
          LIMIT 1
        ) AS accepted_quote_reference,

        (
          SELECT q.final_fare_cents
          FROM ride_quotes q
          WHERE q.booking_reference = b.reference
            AND q.status = 'accepted'
          ORDER BY q.updated_at DESC, q.created_at DESC
          LIMIT 1
        ) AS accepted_quote_fare_cents

      FROM bookings b
      ${status && allowed.includes(status)
        ? "WHERE b.status = ?"
        : ""}
      ORDER BY b.created_at DESC
      LIMIT 500
    `;

    const statement = env.DB.prepare(query);

    const result = status && allowed.includes(status)
      ? await statement.bind(status).all()
      : await statement.all();

    return json({ bookings: result.results || [] });
  } catch (error) {
    console.error("Could not load bookings:", error);
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
