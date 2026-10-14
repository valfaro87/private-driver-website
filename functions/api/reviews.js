
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

// Public endpoint: published reviews only.
// Never expose booking references, emails,
// phone numbers, or private trip information.
export async function onRequestGet({ env }) {
  if (!env.DB) {
    return json({ error: "Reviews are unavailable." }, 503);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT
        id,
        customer_name,
        rating,
        feedback,
        owner_response,
        created_at
      FROM customer_reviews
      WHERE moderation_status = 'published'
        AND permission_to_publish = 1
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `).all();

    return json({
      reviews: result.results || []
    });
  } catch (error) {
    console.error("Could not load public reviews:", error);
    return json({ error: "Could not load reviews." }, 500);
  }
}
