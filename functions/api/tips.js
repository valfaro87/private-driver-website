import { json, ownerSession, sameOrigin } from "../../_lib/auth.js";

const clean = (v, max = 80) => String(v ?? "").trim().slice(0, max);

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Database is not configured." }, 503);
  if (!sameOrigin(request)) return json({ error: "Request rejected." }, 403);
  if (!await ownerSession(request, env)) return json({ error: "Please sign in as the owner." }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const bookingReference = clean(body.bookingReference, 32);
  const amount = Number(body.amount);
  if (!bookingReference || !Number.isFinite(amount) || amount < 1 || amount > 500) {
    return json({ error: "Choose a completed booking and a tip between $1 and $500." }, 400);
  }
  const amountCents = Math.round(amount * 100);
  try {
    const booking = await env.DB.prepare(
      "SELECT reference, status FROM bookings WHERE reference = ?"
    ).bind(bookingReference).first();
    if (!booking) return json({ error: "Booking not found." }, 404);
    if (booking.status !== "completed") {
      return json({ error: "Tips can only be requested for completed trips." }, 409);
    }

    const reference = "TIP-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
    await env.DB.prepare(`
      INSERT INTO trip_tips (reference, booking_reference, amount_cents, currency, status, created_at)
      VALUES (?, ?, ?, 'USD', 'pending', ?)
    `).bind(reference, bookingReference, amountCents, new Date().toISOString()).run();

    // The hosted tip page is informational until a secure payment provider is integrated.
    return json({
      ok: true,
      reference,
      amount: (amountCents / 100).toFixed(2),
      tipPath: "/tip.html?ref=" + encodeURIComponent(reference),
      paymentConfigured: false
    }, 201);
  } catch {
    return json({ error: "Could not create the tip request." }, 500);
  }
}

export async function onRequestGet() {
  return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
}
