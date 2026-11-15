import { json, ownerSession, sameOrigin } from "../_lib/auth.js";
import { quoteArchiveExists, setQuoteArchived } from "../_lib/quote-archive.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Quote history is unavailable." }, 503);
  if (!await ownerSession(request, env)) return json({ error: "Please sign in as the owner." }, 401);

  const archived = new URL(request.url).searchParams.get("view") === "archived";
  try {
    const hasArchive = await quoteArchiveExists(env.DB);
    if (archived && !hasArchive) return json({ quotes: [] });

    const result = await env.DB.prepare(`
      SELECT q.reference, q.booking_reference, q.status, q.final_fare_cents,
        q.created_at, b.name, ${hasArchive ? "a.archived_at" : "NULL AS archived_at"}
      FROM ride_quotes q JOIN bookings b ON b.reference = q.booking_reference
      ${hasArchive ? "LEFT JOIN owner_quote_archives a ON a.quote_reference = q.reference" : ""}
      ${hasArchive ? (archived ? "WHERE a.quote_reference IS NOT NULL" : "WHERE a.quote_reference IS NULL") : ""}
      ORDER BY ${archived ? "a.archived_at" : "q.created_at"} DESC, q.reference DESC
      LIMIT 500
    `).all();
    return json({ quotes: result.results || [] });
  } catch {
    return json({ error: "Could not load quote history." }, 503);
  }
}

export async function onRequestPatch({ request, env }) {
  if (!env.DB) return json({ error: "Quote history is unavailable." }, 503);
  if (!sameOrigin(request)) return json({ error: "Request rejected." }, 403);
  if (!await ownerSession(request, env)) return json({ error: "Please sign in as the owner." }, 401);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: "Request too large." }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (typeof body?.reference !== "string" || !/^QT-[A-Z0-9]{8,32}$/.test(body.reference) ||
      typeof body.archived !== "boolean") {
    return json({ error: "Choose a valid quote to archive or restore." }, 400);
  }

  try {
    const quote = await env.DB.prepare("SELECT reference FROM ride_quotes WHERE reference = ?")
      .bind(body.reference).first();
    if (!quote) return json({ error: "Quote not found." }, 404);
    await setQuoteArchived(env.DB, quote.reference, body.archived);
    return json({ reference: quote.reference, archived: body.archived });
  } catch {
    return json({ error: "Could not update the quote archive. Please retry." }, 503);
  }
}
