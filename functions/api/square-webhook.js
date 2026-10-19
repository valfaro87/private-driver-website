
function respond(message, status = 200) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
async function fetchSquareMerchant(env) {
  const response = await fetch(
    "https://connect.squareupsandbox.com/v2/merchants/me",
    {
      headers: {
        Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        "Square-Version": "2026-09-16"
      }
    }
  );

  if (!response.ok) {
    throw new Error("Unable to verify Square merchant.");
  }

  const data = await response.json();

  if (!data.merchant?.id) {
    throw new Error("Invalid Square merchant response.");
  }

  return data.merchant.id;
}
async function fetchSquarePayment(env, paymentId) {
  if (
    !env.SQUARE_ACCESS_TOKEN ||
    env.SQUARE_ENVIRONMENT !== "sandbox" ||
    typeof paymentId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,192}$/.test(paymentId)
  ) {
    throw new Error("Invalid Square payment configuration.");
  }

  const response = await fetch(
    "https://connect.squareupsandbox.com/v2/payments/" +
      encodeURIComponent(paymentId),
    {
      headers: {
        Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        "Square-Version": "2026-09-16"
      }
    }
  );

  if (!response.ok) {
    throw new Error("Square payment verification failed.");
  }

  const data = await response.json();

  if (!data.payment || data.payment.id !== paymentId) {
    throw new Error("Square returned an invalid payment.");
  }

  return data.payment;
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
  !env.SQUARE_WEBHOOK_URL ||
  !env.SQUARE_ACCESS_TOKEN ||
  !env.SQUARE_LOCATION_ID ||
  !env.DB
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
  console.error("Square webhook signature mismatch");
  return respond("Invalid signature", 401);
}

    const event = JSON.parse(body);

    if (!event.event_id || !event.type) {
      return respond("Invalid event", 400);
    }
if (!['payment.created', 'payment.updated'].includes(event.type)) {
  return respond("Event ignored");
}

const paymentId = event.data?.object?.payment?.id;

if (typeof paymentId !== "string" || !paymentId) {
  return respond("Missing payment ID", 400);
}

const payment = await fetchSquarePayment(env, paymentId);
// Merchant ownership is established through the authenticated
// Square Sandbox payment lookup and the configured location.
// The payment must also match the stored order and amount.
if (
  payment.status !== "COMPLETED" ||
  payment.location_id !== env.SQUARE_LOCATION_ID ||
  payment.amount_money?.currency !== "USD"
) {
  return respond("Payment not eligible for recording");
}
    
const record = await env.DB.prepare(
  `SELECT id, amount_cents, currency, status,
       square_order_id, square_payment_id
   FROM square_payments
   WHERE square_order_id = ?
     AND payment_type = 'deposit'
     AND square_environment = 'sandbox'
   LIMIT 1`
).bind(payment.order_id || "").first();

if (!record) {
  return respond("No matching MVBRI deposit");
}

if (
  record.currency !== payment.amount_money.currency ||
  record.amount_cents !== payment.amount_money.amount ||
  record.square_order_id !== payment.order_id
) {
  return respond("Payment details do not match");
}

if (record.status === "paid") {
  if (record.square_payment_id === payment.id) {
    return respond("Payment already recorded");
  }

  return respond("Different payment already recorded", 409);
}
if (record.status !== "pending") {
  return respond("Payment record is not pending");
}

if (
  typeof payment.id !== "string" ||
  !payment.id ||
  !Number.isSafeInteger(payment.amount_money?.amount) ||
  !payment.order_id
) {
  return respond("Invalid payment details", 400);
}
    const now = new Date().toISOString();

const result = await env.DB.prepare(
  `UPDATE square_payments
   SET status = 'paid',
       square_payment_id = ?,
       paid_at = ?,
       updated_at = ?
   WHERE id = ?
     AND status = 'pending'
     AND square_order_id = ?
     AND amount_cents = ?
     AND currency = 'USD'
     AND square_environment = 'sandbox'`
).bind(
  payment.id,
  now,
  now,
  record.id,
  payment.order_id,
  payment.amount_money.amount
).run();

if (result.meta?.changes !== 1) {
  return respond("Payment record was not updated", 409);
}
   return respond("Verified payment recorded");
 } catch (error) {
  console.error("Square webhook processing failed:", error?.message);
  return respond("Webhook processing failed", 500);
}
}
