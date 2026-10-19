
import { json, sameOrigin } from "../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) {
    return json({ error: "Request rejected." }, 403);
  }

  // This diagnostic is disabled unless explicitly enabled.
  const checks = {
  diagnosticEnabled: env.SQUARE_DIAGNOSTIC_ENABLED === "true",
  sandboxEnvironment: env.SQUARE_ENVIRONMENT === "sandbox",
  accessTokenPresent: Boolean(env.SQUARE_ACCESS_TOKEN),
  locationIdPresent: Boolean(env.SQUARE_LOCATION_ID)
};

if (Object.values(checks).some(value => !value)) {
  return json({
    error: "Diagnostic unavailable.",
    checks
  }, 503);
}
  try {
    const response = await fetch(
      "https://connect.squareupsandbox.com/v2/locations",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          "Square-Version": "2025-01-23"
        }
      }
    );

    const data = await response.json();

    const locationMatches =
      response.ok &&
      Array.isArray(data.locations) &&
      data.locations.some(
        location => location.id === env.SQUARE_LOCATION_ID
      );

    return json({
      squareStatus: response.status,
      squareCode: data.errors?.[0]?.code || null,
      squareCategory: data.errors?.[0]?.category || null,
      locationMatches
    });
  } catch {
    return json({ error: "Square diagnostic failed." }, 502);
  }
}
