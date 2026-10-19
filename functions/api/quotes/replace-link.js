
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
  SELECT
    q.reference,
    q.status,
    b.email AS customer_email
  FROM ride_quotes q
  INNER JOIN bookings b
    ON b.reference = q.booking_reference
  WHERE q.reference = ?
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

const customerEmail = String(quote.customer_email || "").trim();

if (
  customerEmail.length > 254 ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)
) {
  return json({
    error: "This booking does not have a valid customer email address."
  }, 400);
}
if (!env.RESEND_API_KEY) {
  return json({
    error: "Resend email service is not configured. The existing customer quote link has not been changed."
  }, 503);
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
   let emailSent = false;
let emailError = null;
    if (!env.RESEND_API_KEY) {
  emailError = "Email service is not configured.";
} else {
  try {
    const emailResponse = await fetch("https://api.resend.com/emails", {
      signal: AbortSignal.timeout(10000),
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "MVBRI Private Driver Services <quotes@mvbri.com>",
        to: [customerEmail],
        subject: `Your MVBRI Quote Link — ${reference}`,
        text: [
          "Hello,",
          "",
          "Here is your updated MVBRI customer quote link:",
          customerUrl.toString(),
          "",
          "Your previously accepted quote remains accepted.",
          "Your quoted amount has not changed.",
          "",
          "MVBRI Private Driver Services"
        ].join("\n")
      })
    });

    if (emailResponse.ok) {
      emailSent = true;
    } else {
      emailError = `Email service returned status ${emailResponse.status}.`;
    }
  } catch {
    emailError = "Email service could not be reached.";
  }
}
   

    return new Response(
      JSON.stringify({
        ok: true,
       message: emailSent
  ? "Replacement link generated. Email accepted by Resend."
  : "Replacement link generated, but email was not sent. Copy the link and send it manually.",
emailSent,
emailError,
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
