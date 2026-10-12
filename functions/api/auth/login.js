import { clearSessionCookie, json, sameOrigin, sessionCookie, sha256Hex } from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.OWNER_PASSWORD) {
    return json({ error: "Owner login is not configured. Set the Cloudflare secrets and database binding first." }, 503);
  }
  if (!sameOrigin(request)) return json({ error: "Request rejected." }, 403);

  let body;
  try {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > 3000) return json({ error: "Request too large." }, 413);
    body = await request.json();
  } catch {
    return json({ error: "Enter your owner password." }, 400);
  }

  const password = String(body.password || "");
  if (password.length < 1 || password.length > 500) {
    return json({ error: "Invalid password." }, 401);
  }

  // Configure Cloudflare rate limiting for POST /api/auth/login before public launch.
  if (password !== env.OWNER_PASSWORD) {
    return json({ error: "Incorrect password." }, 401);
  }

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();

  try {
    await env.DB.prepare("DELETE FROM owner_sessions WHERE expires_at <= ?").bind(now.toISOString()).run();
    await env.DB.prepare(
      "INSERT INTO owner_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)"
    ).bind(tokenHash, expires, now.toISOString()).run();
  } catch {
    return json({ error: "Could not start a secure session. Please try again." }, 500);
  }

  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}

export async function onRequestGet() {
  return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
}
