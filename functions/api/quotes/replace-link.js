
import { json, ownerSession, sameOrigin } from "../../_lib/auth.js";

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
    if (Number(request.headers.get("content-length") || 0) > 2000) {
      return json({ error: "Request too large." }, 413);
    }
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const reference = body?.reference;

  if (
    typeof reference !== "string" ||
    !/^QT-[A-Z0-9]{12}$/.test(reference)
  ) {
    return json({ error: "Invalid quote reference." }, 400);
  }

  try {
    const quote = await env.DB.prepare(`
      SELECT reference, status
      FROM ride_quotes
      WHERE reference = ?
      LIMIT 1
    `).bind(reference).first();

    if (!quote) {
      return json({ error: "Quote not found." }, 404);
    }

    if (quote.status !== "accepted") {
      return json({
        error: "Only accepted quotes can receive a replacement link."
      }, 409);
    }

    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);

    const token = Array.from(bytes)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token)
    );

    const tokenHash = Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    const now = new Date().toISOString();

    const update = await env.DB.prepare(`
      UPDATE ride_quotes
      SET customer_token_hash = ?, updated_at = ?
      WHERE reference = ?
        AND status = 'accepted'
    `).bind(tokenHash, now, reference).run();

    if (update.meta?.changes !== 1) {
      return json({
        error: "The quote changed. Refresh and try again."
      }, 409);
    }

    const customerUrl = new URL("/quote.html", request.url);
    customerUrl.searchParams.set("token", token);

    return new Response(
      JSON.stringify({
        ok: true,
        message: "Replacement customer link generated.",
        quote: {
          reference,
          status: "accepted",
          customerUrl: customerUrl.toString()
        }
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, private",
          "Referrer-Policy": "no-referrer"
        }
      }
    );
  } catch (error) {
    console.error("Quote link replacement failed:", error?.message);
    return json({
      error: "Could not generate the replacement link."
    }, 500);
  }
}
