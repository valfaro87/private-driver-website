
import { ownerSession, sameOrigin } from "../_lib/auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// OWNER ONLY: View all submitted reviews.
export async function onRequestGet({ request, env }) {
  try {
    const owner = await ownerSession(request, env);

    if (!owner) {
      return json({ error: "Owner login required." }, 401);
    }

    const result = await env.DB.prepare(`
      SELECT
        id,
        booking_reference,
        customer_name,
        rating,
        feedback,
        permission_to_publish,
        moderation_status,
        owner_response,
        created_at
      FROM customer_reviews
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `).all();

    return json({
      reviews: result.results || []
    });
  } catch (error) {
    console.error("Owner reviews GET error:", error);
    return json({ error: "Unable to load reviews." }, 500);
  }
}

// OWNER ONLY: Publish or hide a review.
export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({error:'Request rejected.'},403);
  if (!(request.headers.get('content-type') || '').includes('application/json')) return json({error:'JSON required.'},415);
  try {
    const owner = await ownerSession(request, env);

    if (!owner) {
      return json({ error: "Owner login required." }, 401);
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 10000) return json({error:'Request too large.'},413);
    let body;
    try { body=JSON.parse(raw); } catch {return json({error:'Invalid request.'},400);}

    const reviewId = Number(body?.review_id);
    const action = body?.action;

    if (!Number.isSafeInteger(reviewId) || reviewId < 1) {
      return json({ error: "Invalid review ID." }, 400);
    }

   
    if (!["publish", "hide", "reply"].includes(action)) {
      return json({ error: "Invalid review action." }, 400);
    }

    if (action === "reply") {
      if (typeof body?.owner_response !== "string") {
        return json({ error: "Invalid owner response." }, 400);
      }

      const ownerResponse = body.owner_response.trim();

      if (ownerResponse.length > 1500) {
        return json({
          error: "Owner response must be 1500 characters or fewer."
        }, 400);
      }

      const updated = await env.DB.prepare(`
        UPDATE customer_reviews
        SET owner_response = ?,
            owner_response_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(ownerResponse || null, reviewId).run();

      if (updated.meta?.changes !== 1) {
        return json({ error: "Review not found or could not be updated." }, 404);
      }

      return json({
        success: true,
        review_id: reviewId,
        owner_response: ownerResponse || null
      });
    }


    const existing = await env.DB.prepare(`
      SELECT id, permission_to_publish
      FROM customer_reviews
      WHERE id = ?
    `).bind(reviewId).first();

    if (!existing) {
      return json({ error: "Review not found." }, 404);
    }

    if (action === "publish" && existing.permission_to_publish !== 1) {
      return json({
        error: "Customer did not authorize public publication."
      }, 403);
    }

    const newStatus = action === "publish"
      ? "published"
      : "hidden";

    const updated = await env.DB.prepare(`
      UPDATE customer_reviews
      SET moderation_status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND (? != 'published' OR permission_to_publish = 1)
    `).bind(newStatus, reviewId, newStatus).run();

    if (updated.meta?.changes !== 1) {
      return json({
        error: "Review could not be updated."
      }, 409);
    }

    return json({
      success: true,
      review_id: reviewId,
      moderation_status: newStatus
    });
  } catch (error) {
    console.error("Owner reviews POST error:", error);
    return json({ error: "Unable to update review." }, 500);
  }
}
