const COOKIE_NAME = "__Host-driver_owner";

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  return bytesToHex(await crypto.subtle.digest("SHA-256", data));
}

export function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(token, maxAge = 8 * 60 * 60) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function ownerSession(request, env) {
  if (!env.DB) return false;
  const token = cookieValue(request, COOKIE_NAME);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT token_hash FROM owner_sessions WHERE token_hash = ? AND expires_at > ?"
  ).bind(hash, new Date().toISOString()).first();
  return Boolean(row);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders
    }
  });
}

export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // Non-browser clients still require a valid owner session for protected routes.
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
