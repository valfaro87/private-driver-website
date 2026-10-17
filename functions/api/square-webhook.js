
function respond(message, status = 200) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function toHex(bytes) {
  return Array.from(bytes, byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  if (
    env.SQUARE_ENVIRONMENT !== "sandbox" ||
    !env.SQUARE_WEBHOOK_SIGNATURE_KEY ||
    !env.SQUARE_WEBHOOK_URL
  ) {
    return respond("Webhook not configured", 503);
  }

  const signature = request.headers.get(
    "x-square-hmacsha256-signature"
  );

  if (!signature) {
    return respond("Missing signature", 401);
  }

  const body = await request.text();

  if (body.length > 1000000) {
    return respond("Payload too large", 413);
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(
        env.SQUARE_WEBHOOK_SIGNATURE_KEY
      ),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const payload = env.SQUARE_WEBHOOK_URL + body;

    const expected = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(payload)
      )
    );

    const supplied = Uint8Array.from(
      atob(signature),
      character => character.charCodeAt(0)
    );

    if (!equalBytes(expected, supplied)) {
      return respond("Invalid signature", 401);
    }

    const event = JSON.parse(body);

    if (!event.event_id || !event.type) {
      return respond("Invalid event", 400);
    }

    // Signature verified.
    // Payment lookup and database updates will be added later.
    return respond("Webhook received");

  } catch {
    return respond("Invalid webhook request", 400);
  }
}
