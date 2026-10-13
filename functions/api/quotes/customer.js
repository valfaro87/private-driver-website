
import { json, sameOrigin } from "../../_lib/auth.js";

async function getTokenHash(token) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cleanToken(value) {
  return typeof value === "string" &&
    /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : "";
}

async function findQuote(env, tokenHash) {
  return env.DB.prepare(`
    SELECT
      q.reference,
      q.booking_reference,
      q.status,
      q.final_fare_cents,
      q.expires_at,
      b.pickup,
      b.destination,
      b.pickup_date,
      b.pickup_time
    FROM ride_quotes q
    JOIN bookings b ON b.reference = q.booking_reference
    WHERE q.customer_token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first();
}

async function expireIfNeeded(env, quote) {
  if (
    quote.status === "issued" &&
    quote.expires_at &&
    Date.parse(quote.expires_at) <= Date.now()
  ) {
    await env.DB.prepare(`
      UPDATE ride_quotes
      SET status = 'expired', updated_at = ?
      WHERE reference = ?
        AND status = 'issued'
        AND expires_at <= ?
    `).bind(
      new Date().toISOString(),
      quote.reference,
      new Date().toISOString()
    ).run();

    quote.status = "expired";
  }

  return quote;
}

function publicQuote(quote) {
  return {
    reference: quote.reference,
    bookingReference: quote.booking_reference,
    status: quote.status,
    finalFare: quote.final_fare_cents / 100,
    pickup: quote.pickup,
    destination: quote.destination,
    pickupDate: quote.pickup_date,
    pickupTime: quote.pickup_time,
    expiresAt: quote.expires_at
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return json({ error: "Service temporarily unavailable." }, 503);
  }

  const url = new URL(request.url);
  const token = cleanToken(url.searchParams.get("token"));

  if (!token) {
    return json({ error: "This quote link is invalid." }, 400);
  }

  try {
    const tokenHash = await getTokenHash(token);
    let quote = await findQuote(env, tokenHash);

    if (!quote) {
      return json({
        error: "This quote link is invalid or no longer available."
      }, 404);
    }

    quote = await expireIfNeeded(env, quote);

    return new Response(
      JSON.stringify({ quote: publicQuote(quote) }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, private",
          "Referrer-Policy": "no-referrer"
        }
      }
    );
  } catch {
    return json({ error: "Could not load this quote." }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "Service temporarily unavailable." }, 503);
  }

  if (!sameOrigin(request)) {
    return json({ error: "Request rejected." }, 403);
  }

  let body;

  try {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 2000) {
      return json({ error: "Request too large." }, 413);
    }
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const token = cleanToken(body.token);
  const action = body.action;

  if (!token || !["accept", "decline"].includes(action)) {
    return json({ error: "Invalid quote response." }, 400);
  }

  try {
    const tokenHash = await getTokenHash(token);
    let quote = await findQuote(env, tokenHash);

    if (!quote) {
      return json({
        error: "This quote link is invalid or no longer available."
      }, 404);
    }

    quote = await expireIfNeeded(env, quote);

    if (
      quote.status === "issued" &&
      (!quote.expires_at || Date.parse(quote.expires_at) <= Date.now())
    ) {
      return json({
        error: "This quote has expired. Please contact MVBRI."
      }, 410);
    }

    if (quote.status !== "issued") {
      return json({
        error: quote.status === "expired"
          ? "This quote has expired. Please contact MVBRI."
          : "This quote has already been responded to or is no longer active."
      }, 409);
    }

    const now = new Date().toISOString();
    const newStatus = action === "accept" ? "accepted" : "declined";

    // The conditional update prevents two simultaneous responses from
    // both succeeding, and checks the deadline using the database clock.
    const result = await env.DB.prepare(`
      UPDATE ride_quotes
      SET status = ?, responded_at = ?, updated_at = ?
      WHERE reference = ?
        AND customer_token_hash = ?
        AND status = 'issued'
        AND expires_at IS NOT NULL
        AND julianday(expires_at) > julianday('now')
    `).bind(
      newStatus,
      now,
      now,
      quote.reference,
      tokenHash
    ).run();

    if (result.meta?.changes !== 1) {
      const latest = await findQuote(env, tokenHash);

      if (latest) {
        await expireIfNeeded(env, latest);
      }

      return json({
        error: latest?.status === "expired"
          ? "This quote has expired. Please contact MVBRI."
          : "Your response could not be recorded. The quote may have changed."
      }, 409);
    }

    return json({
      ok: true,
      quote: {
        reference: quote.reference,
        status: newStatus
      }
    });
  } catch {
    return json({
      error: "Could not record your response. Please try again."
    }, 500);
  }
}
