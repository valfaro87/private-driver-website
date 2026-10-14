
import { ownerSession } from "../_lib/auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function hashToken(token) {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(digest));
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "Database is not configured." }, 503);
  }

  if (!await ownerSession(request, env)) {
    return json({ error: "Please sign in as the owner." }, 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const bookingReference =
    typeof body?.booking_reference === "string"
      ? body.booking_reference.trim()
      : "";

  if (!bookingReference || bookingReference.length > 100) {
    return json({ error: "Valid booking reference required." }, 400);
  }

  try {
    const booking = await env.DB.prepare(`
      SELECT reference, status
      FROM bookings
      WHERE reference = ?
      LIMIT 1
    `).bind(bookingReference).first();

    if (!booking) {
      return json({ error: "Booking not found." }, 404);
    }

    if (booking.status !== "completed") {
      return json({
        error: "Only completed rides can receive review invitations."
      }, 400);
    }

    const existingReview = await env.DB.prepare(`
      SELECT id
      FROM customer_reviews
      WHERE booking_reference = ?
      LIMIT 1
    `).bind(bookingReference).first();

    if (existingReview) {
      return json({
        error: "This booking already has a review."
      }, 409);
    }

    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);

    const token = bytesToHex(tokenBytes);
    const tokenHash = await hashToken(token);

    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    await env.DB.prepare(`
      INSERT INTO review_invitations (
        booking_reference,
        token_hash,
        expires_at,
        used_at
      )
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(booking_reference)
      DO UPDATE SET
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        used_at = NULL
    `).bind(
      bookingReference,
      tokenHash,
      expiresAt
    ).run();

    const reviewUrl = new URL("/review.html", request.url);
    reviewUrl.searchParams.set("token", token);

    return json({
      success: true,
      review_url: reviewUrl.toString(),
      expires_at: expiresAt
    });
  } catch (error) {
    console.error("Could not create review invitation:", error);

    return json({
      error: "Could not create review invitation."
    }, 500);
  }
}
