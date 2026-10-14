
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
