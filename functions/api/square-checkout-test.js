import { json, sameOrigin } from "../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) {
    return json({ error: "Request rejected." }, 403);
  }

  if (
    env.SQUARE_DIAGNOSTIC_ENABLED !== "true" ||
    env.SQUARE_ENVIRONMENT !== "sandbox" ||
    !env.SQUARE_ACCESS_TOKEN
  ) {
    return json({ error: "Diagnostic unavailable." }, 503);
  }

  try {
    const response = await fetch(
      "https://connect.squareupsandbox.com/v2/online-checkout/payment-links",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          "Square-Version": "2025-01-23"
        }
      }
    );

    const data = await response.json();

    return json({
      squareStatus: response.status,
      squareCode: data.errors?.[0]?.code || null,
      squareCategory: data.errors?.[0]?.category || null
    });
  } catch {
    return json({ error: "Diagnostic request failed." }, 502);
  }
}
