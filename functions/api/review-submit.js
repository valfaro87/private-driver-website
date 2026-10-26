import { sameOrigin } from "../_lib/auth.js";

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

// Validate a review invitation before displaying the form.
export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return json({ error: "Reviews are unavailable." }, 503);
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";

  // Invitation tokens are 32 random bytes encoded as 64 hex characters.
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return json({ valid: false, error: "Invalid review link." }, 400);
  }

  try {
    const tokenHash = await hashToken(token);

    const invitation = await env.DB.prepare(`
      SELECT
        i.booking_reference,
        i.expires_at,
        i.used_at,
        b.status AS booking_status,
        r.id AS existing_review_id
      FROM review_invitations i
      JOIN bookings b
        ON b.reference = i.booking_reference
      LEFT JOIN customer_reviews r
        ON r.booking_reference = i.booking_reference
      WHERE i.token_hash = ?
      LIMIT 1
    `).bind(tokenHash).first();

    if (!invitation) {
      return json({
        valid: false,
        error: "Review invitation not found."
      }, 404);
    }

    if (invitation.booking_status !== "completed") {
      return json({
        valid: false,
        error: "This ride has not been completed."
      }, 403);
    }

    if (invitation.used_at || invitation.existing_review_id) {
      return json({
        valid: false,
        error: "A review has already been submitted."
      }, 409);
    }

    if (
      !invitation.expires_at ||
      Date.parse(invitation.expires_at) <= Date.now()
    ) {
      return json({
        valid: false,
        error: "This review invitation has expired."
      }, 410);
    }

    return json({
      valid: true,
      message: "Your review invitation is valid."
    });
  } catch (error) {
    console.error("Review validation failed:", error);
    return json({
      valid: false,
      error: "Could not validate review invitation."
    }, 500);
  }
}


export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({error:"Request rejected."},403);
  if (!env.DB) {
    return json({ error: "Reviews are unavailable." }, 503);
  }

  // Require JSON and limit the request size.
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "JSON is required." }, 415);
  }

  const contentLength = Number(
    request.headers.get("content-length") || 0
  );

  if (contentLength > 10000) {
    return json({ error: "Request is too large." }, 413);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 10000) {
      return json({ error: "Request is too large." }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const token =
    typeof body?.token === "string" ? body.token : "";

  const name =
    typeof body?.customer_name === "string"
      ? body.customer_name.trim()
      : "";

  const feedback =
    typeof body?.feedback === "string"
      ? body.feedback.trim()
      : "";

  const rating = body?.rating;
  const permission = body?.permission_to_publish === true ? 1 : 0;

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return json({ error: "Invalid review invitation." }, 400);
  }

  if (
    !name || name.length > 60 ||
    !feedback || feedback.length > 2000 ||
    !Number.isInteger(rating) ||
    rating < 1 || rating > 5
  ) {
    return json({
      error: "Please provide a valid name, rating, and review."
    }, 400);
  }

  try {
    const tokenHash = await hashToken(token);

    // Check eligibility without revealing booking details.
    const invitation = await env.DB.prepare(`
      SELECT
        i.booking_reference,
        i.expires_at,
        i.used_at,
        b.status AS booking_status
      FROM review_invitations i
      JOIN bookings b
        ON b.reference = i.booking_reference
      WHERE i.token_hash = ?
      LIMIT 1
    `).bind(tokenHash).first();

    if (!invitation) {
      return json({ error: "Review invitation not found." }, 404);
    }

    if (invitation.booking_status !== "completed") {
      return json({ error: "Ride is not completed." }, 403);
    }

    if (
      invitation.used_at ||
      !invitation.expires_at ||
      Date.parse(invitation.expires_at) <= Date.now()
    ) {
      return json({
        error: "Review invitation is expired or already used."
      }, 410);
    }

    // Atomically consume the invitation and insert the review.
    // The UNIQUE booking_reference constraint prevents duplicates.
    const result = await env.DB.batch([
      env.DB.prepare(`
        UPDATE review_invitations
        SET used_at = CURRENT_TIMESTAMP
        WHERE token_hash = ?
          AND used_at IS NULL
          AND julianday(expires_at) > julianday('now')
          AND EXISTS (
            SELECT 1 FROM bookings
            WHERE bookings.reference =
              review_invitations.booking_reference
              AND bookings.status = 'completed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM customer_reviews
            WHERE customer_reviews.booking_reference =
              review_invitations.booking_reference
          )
      `).bind(tokenHash),

      env.DB.prepare(`
        INSERT INTO customer_reviews (
          booking_reference,
          customer_name,
          rating,
          feedback,
          permission_to_publish,
          moderation_status
        )
        SELECT
          i.booking_reference, ?, ?, ?, ?, 'pending'
        FROM review_invitations i
        JOIN bookings b
          ON b.reference = i.booking_reference
        WHERE i.token_hash = ?
          AND i.used_at IS NOT NULL
          AND b.status = 'completed'
          AND julianday(i.expires_at) > julianday('now')
          AND NOT EXISTS (
            SELECT 1 FROM customer_reviews r
            WHERE r.booking_reference = i.booking_reference
          )
      `).bind(
        name,
        rating,
        feedback,
        permission,
        tokenHash
      )
    ]);

    if (
      result[0].meta?.changes !== 1 ||
      result[1].meta?.changes !== 1
    ) {
      return json({
        error: "This invitation cannot be used."
      }, 409);
    }

    return json({
      success: true,
      message: "Thank you! Your review has been submitted."
    }, 201);

  } catch (error) {
    console.error("Review submission failed:", error);
    return json({
      error: "Could not submit your review."
    }, 500);
  }
}

