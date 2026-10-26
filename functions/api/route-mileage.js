
import { json, ownerSession, sameOrigin } from "../_lib/auth.js";

const DAILY_LIMIT = 20;
const MAX_BODY_BYTES = 1024;
const METERS_PER_MILE = 1609.344;

function validReference(value) {
  return typeof value === "string" &&
    /^RD-[A-Z0-9]{10}$/.test(value);
}

function validAddress(value, maxLength) {
  return typeof value === "string" &&
    value.trim().length >= 5 &&
    value.length <= maxLength &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function dayInHouston() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "Mileage service is not configured." }, 503);
  }

  if (!sameOrigin(request)) {
    return json({ error: "Request rejected." }, 403);
  }

  if (!await ownerSession(request, env)) {
    return json({ error: "Please log in as the owner." }, 401);
  }

  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: "Mileage service is not configured." }, 503);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "JSON required." }, 415);
  }

  const declaredLength = Number(
    request.headers.get("content-length") || 0
  );

  if (declaredLength > MAX_BODY_BYTES) {
    return json({ error: "Request too large." }, 413);
  }

  let body;

  try {
    const raw = await request.text();

    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ error: "Request too large." }, 413);
    }

    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  if (!body || typeof body !== "object" ||
      Array.isArray(body) ||
      !validReference(body.reference)) {
    return json({ error: "Invalid booking reference." }, 400);
  }

  let booking;

  try {
    booking = await env.DB.prepare(`
      SELECT reference, pickup, destination, additional_stops, trip_type
      FROM bookings
      WHERE reference = ?
    `).bind(body.reference).first();
  } catch {
    return json({ error: "Could not load booking." }, 500);
  }

  if (!booking) {
    return json({ error: "Booking not found." }, 404);
  }

  let stops;

  try {
    stops = JSON.parse(booking.additional_stops || "[]");
  } catch {
    return json({ error: "Booking stops are invalid." }, 422);
  }

  if (!Array.isArray(stops) || stops.length > 10 ||
      !validAddress(booking.pickup, 500) ||
      !validAddress(booking.destination, 500) ||
      !stops.every(s => validAddress(s, 300))) {
    return json({ error: "Booking addresses are invalid." }, 422);
  }

  const today = dayInHouston();

  // Atomic daily reservation to prevent concurrent requests
  // from exceeding the configured allowance.
  let allowance;

  try {
    allowance = await env.DB.prepare(`
      INSERT INTO mileage_usage (day, request_count)
      VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET
        request_count = request_count + 1
      WHERE request_count < ?
      RETURNING request_count
    `).bind(today, DAILY_LIMIT).first();
  } catch (error) {
    console.error("Mileage limiter unavailable:", error);
    return json({
      error: "Mileage request protection is unavailable."
    }, 503);
  }

  if (!allowance) {
    return json({
      error: "Daily mileage calculation limit reached. Use manual mileage or try tomorrow."
    }, 429);
  }

  const roundTrip = booking.trip_type === "Round trip";
  const routeStops = roundTrip ? [...stops, booking.destination] : stops;
  const routeRequest = {
    origin: {
      address: booking.pickup.trim()
    },
    destination: {
      address: (roundTrip ? booking.pickup : booking.destination).trim()
    },
    intermediates: routeStops.map(address => ({
      address: address.trim()
    })),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_UNAWARE",
    computeAlternativeRoutes: false,
    optimizeWaypointOrder: false,
    units: "IMPERIAL"
  };

  let route;

  try {
    const response = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "routes.distanceMeters"
        },
        body: JSON.stringify(routeRequest),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      console.error("Google Routes returned:", response.status);
      return json({
        error: "Google could not calculate this route. Enter mileage manually."
      }, 502);
    }

    const result = await response.json();
    route = result.routes?.[0];
  } catch (error) {
    console.error("Route calculation failed:", error);
    return json({
      error: "Mileage calculation is temporarily unavailable. Enter mileage manually."
    }, 502);
  }

  if (!route || !Number.isFinite(route.distanceMeters) ||
      route.distanceMeters <= 0) {
    return json({
      error: "No valid driving route was found. Enter mileage manually."
    }, 422);
  }

  const miles = Math.round(
    (route.distanceMeters / METERS_PER_MILE) * 100
  ) / 100;

  let settings;

  try {
    settings = await env.DB.prepare(`
      SELECT minimum_fare_cents, price_per_mile_cents
      FROM pricing_settings
      WHERE id = 1
    `).first();
  } catch {
    return json({
      error: "Could not load pricing settings."
    }, 500);
  }

  const minimumFareCents = settings?.minimum_fare_cents ?? 5000;
  const pricePerMileCents = settings?.price_per_mile_cents ?? 250;

  const mileageFareCents = Math.max(
    minimumFareCents,
    Math.round(
      route.distanceMeters / METERS_PER_MILE * pricePerMileCents
    )
  );

  return json({
    ok: true,
    reference: booking.reference,
    miles,
    stopsCount: stops.length,
    roundTrip,
    attribution: "Google Maps",
    mileageFare: mileageFareCents / 100,
    minimumFare: minimumFareCents / 100,
    pricePerMile: pricePerMileCents / 100,
    remainingDailyRequests: DAILY_LIMIT - allowance.request_count,
    note: "Estimate only. Owner must review adjustments and issue the final quote manually."
  });
}
