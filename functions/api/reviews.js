
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

const pageSize = 100;
const newest = "COALESCE(published_at, created_at) DESC, id DESC";
const reviewOrder = new Map([
  ["newest", newest],
  ["oldest", "COALESCE(published_at, created_at) ASC, id ASC"],
  ["highest", "rating DESC, " + newest],
  ["lowest", "rating ASC, " + newest]
]);
const visibleReviews = "moderation_status = 'published' AND permission_to_publish = 1";

// Only share reviews that the customer and owner have approved.
export async function onRequestGet({ env, request }) {
  if (!env.DB) {
    return json({ error: "Reviews are unavailable." }, 503);
  }

  const params = new URL(request.url).searchParams;
  const sort = reviewOrder.get(params.get("sort")) || newest;
  const page = Number(params.get("page") ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / pageSize)) {
    return json({ error: "Invalid reviews page." }, 400);
  }

  try {
    const [result, counts] = await env.DB.batch([
      env.DB.prepare(`
        SELECT id, customer_name, rating, feedback, owner_response, created_at, published_at,
          CASE WHEN owner_response IS NOT NULL THEN owner_response_at END AS owner_response_at
        FROM customer_reviews
        WHERE ${visibleReviews}
        ORDER BY ${sort}
        LIMIT ? OFFSET ?
      `).bind(pageSize, (page - 1) * pageSize),
      env.DB.prepare(`
        SELECT rating, COUNT(*) AS count
        FROM customer_reviews
        WHERE ${visibleReviews}
        GROUP BY rating
      `)
    ]);

    const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const { rating, count } of counts.results) {
      ratingCounts[rating] = count;
    }

    return json({
      reviews: result.results,
      ratingCounts,
      total: Object.values(ratingCounts).reduce((sum, count) => sum + count, 0),
      pageSize
    });
  } catch (error) {
    console.error("Could not load public reviews:", error);
    return json({ error: "Could not load reviews." }, 500);
  }
}
