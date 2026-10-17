
import { json, sameOrigin } from "../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) {
    return json({ error: "Request rejected." }, 403);
  }

  if (
    !env.DB ||
    !env.SQUARE_ACCESS_TOKEN ||
    !env.SQUARE_LOCATION_ID ||
    env.SQUARE_ENVIRONMENT !== "sandbox"
  ) {
    return json({ error: "Square Sandbox is not configured." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  if (body?.paymentType !== "deposit") {
    return json({ error: "Invalid payment type." }, 400);
  }

  const token = body?.token;

  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) {
    return json({ error: "Invalid quote link." }, 400);
  }

  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token.toLowerCase())
    );

    const tokenHash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const quote = await env.DB.prepare(
      `SELECT reference, booking_reference, status, final_fare_cents
       FROM ride_quotes
       WHERE customer_token_hash = ?
       LIMIT 1`
    ).bind(tokenHash).first();

    if (!quote || quote.status !== "accepted") {
      return json({ error: "An accepted quote is required." }, 409);
    }

    const total = quote.final_fare_cents;

    if (!Number.isSafeInteger(total) || total < 2) {
      return json({ error: "Invalid quote amount." }, 400);
    }

    const deposit = Math.round(total / 2);
    const now = new Date().toISOString();

    const existing = await env.DB.prepare(
      `SELECT status, checkout_url
       FROM square_payments
       WHERE quote_reference = ? AND payment_type = 'deposit'`
    ).bind(quote.reference).first();

    if (existing?.status === "paid") {
      return json({ error: "Deposit already paid." }, 409);
    }

    if (existing?.checkout_url) {
      return json({ checkoutUrl: existing.checkout_url });
    }

    // Reserve one checkout creation per quote.
    const reservation = await env.DB.prepare(
      `INSERT OR IGNORE INTO square_payments
       (quote_reference, booking_reference, payment_type,
        amount_cents, currency, status, square_environment,
        created_at, updated_at)
       VALUES (?, ?, 'deposit', ?, 'USD', 'pending', 'sandbox', ?, ?)`
    ).bind(
      quote.reference,
      quote.booking_reference,
      deposit,
      now,
      now
    ).run();

    if (reservation.meta?.changes !== 1) {
      return json({
        error: "Checkout is being prepared. Please try again shortly."
      }, 409);
    }

    const response = await fetch(
      "https://connect.squareupsandbox.com/v2/online-checkout/payment-links",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Square-Version": "2025-01-23"
        },
        body: JSON.stringify({
          idempotency_key: `mvbri-deposit-${quote.reference}`,
          quick_pay: {
            name: "MVBRI Ride Deposit",
            price_money: {
              amount: deposit,
              currency: "USD"
            },
            location_id: env.SQUARE_LOCATION_ID
          }
        })
      }
    );

    const square = await response.json();

    if (!response.ok || !square.payment_link?.url) {
      return json({
        error: "Square checkout could not be created."
      }, 502);
    }

    await env.DB.prepare(
      `UPDATE square_payments
       SET square_payment_link_id = ?,
           square_order_id = ?,
           checkout_url = ?,
           updated_at = ?
       WHERE quote_reference = ? AND payment_type = 'deposit'
         AND status = 'pending'`
    ).bind(
      square.payment_link.id,
      square.payment_link.order_id ?? null,
      square.payment_link.url,
      new Date().toISOString(),
      quote.reference
    ).run();

    return json({ checkoutUrl: square.payment_link.url });

  } catch {
    return json({
      error: "Unable to prepare checkout. Please try again."
    }, 500);
  }
}
