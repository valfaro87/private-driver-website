import { clearSessionCookie, cookieValue, json, sameOrigin, sha256Hex } from "../../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "Request rejected." }, 403);
  const cookie = cookieValue(request, "__Host-driver_owner");
  if (env.DB && cookie && /^[a-f0-9]{64}$/.test(cookie)) {
    try {
      await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash = ?")
        .bind(await sha256Hex(cookie)).run();
    } catch {}
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function onRequestGet() {
  return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
}
