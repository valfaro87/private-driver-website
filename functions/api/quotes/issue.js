
import { json, ownerSession, sameOrigin } from "../../_lib/auth.js";

const clean = (value, max = 500) =>
  String(value ?? "").trim().replace(/\u0000/g, "").slice(0, max);

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "Database unavailable." }, 503);
  }

  if (!sameOrigin(request)) {
    return json({ error: "Request rejected." }, 403);
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

  const reference = clean(body.reference, 40);

  if (!reference) {
    return json({ error: "Quote reference is required." }, 400);
  }

  try {
    const quote = await env.DB.prepare(`
      SELECT
        reference,
        booking_reference,
        status,
        final_fare_cents,
        customer_token_hash
      FROM ride_quotes
      WHERE reference = ?
      LIMIT 1
    `).bind(reference).first();

    if (!quote) {
      return json({ error: "Quote not found." }, 404);
    }

    if (quote.status !== "draft") {
      return json({
        error: "Only draft quotes can be issued. Create a new draft if needed."
      }, 409);
    }

    if (
      !Number.isInteger(quote.final_fare_cents) ||
      quote.final_fare_cents < 0
    ) {
      return json({ error: "The quote amount is invalid." }, 400);
    }

    const settings = await env.DB.prepare(`
      SELECT quote_expiration_hours
      FROM pricing_settings
      WHERE id = 1
    `).first();

    const hours = Number(settings?.quote_expiration_hours ?? 24);

    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      return json({ error: "Quote expiration settings are invalid." }, 500);
    }

    // Generate a cryptographically random customer token.
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);

    const token = Array.from(tokenBytes)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    // Store only a SHA-256 hash of the customer token.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token)
    );

    const tokenHash = Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    const now = new Date();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + hours * 60 * 60 * 1000
    ).toISOString();

    const update = await env.DB.prepare(`
      UPDATE ride_quotes
      SET
        status = 'issued',
        customer_token_hash = ?,
        issued_at = ?,
        expires_at = ?,
        updated_at = ?
      WHERE reference = ?
        AND status = 'draft'
    `).bind(
      tokenHash,
      issuedAt,
      expiresAt,
      issuedAt,
      reference
    ).run();

    if (update.meta?.changes !== 1) {
      return json({
        error: "The quote could not be issued. Refresh and try again."
      }, 409);
    }

    const customerUrl = new URL("/quote.html", request.url);
    customerUrl.searchParams.set("token", token);

    return json({
      ok: true,
      message: "Quote issued successfully.",
      quote: {
        reference: quote.reference,
        bookingReference: quote.booking_reference,
        finalFare: quote.final_fare_cents / 100,
        status: "issued",
        issuedAt,
        expiresAt,
        customerUrl: customerUrl.toString()
      }
    }, 200);
  } catch {
    return json({
      error: "Could not issue the quote. Please try again."
    }, 500);
  }
}
