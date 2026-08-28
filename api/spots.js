const { neon } = require("@neondatabase/serverless");

const TOTAL_SPOTS = 100;

// =====================================================
// RESPONSE
// =====================================================

function json(res, statusCode, data) {
  res.status(statusCode);

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  return res.json(data);
}

// =====================================================
// MAIN
// =====================================================

export default async function handler(req, res) {

  // ---------------------------------------------------
  // OPTIONS
  // ---------------------------------------------------

  if (req.method === "OPTIONS") {
    res.status(204);
    return res.end();
  }

  // ---------------------------------------------------
  // GET ONLY
  // ---------------------------------------------------

  if (req.method !== "GET") {
    return json(res, 405, {
      success: false,
      error: "Method not allowed."
    });
  }

  // ---------------------------------------------------
  // DATABASE
  // ---------------------------------------------------

  if (!process.env.DATABASE_URL) {
    return json(res, 500, {
      success: false,
      error: "DATABASE_URL is not configured."
    });
  }

  try {

    const sql = neon(
      process.env.DATABASE_URL
    );

    // =================================================
    // COUNT CLAIMS
    // =================================================

    const result = await sql`

      SELECT COUNT(*)::int AS claimed

      FROM roadman_claims

      WHERE
        status = 'claimed'

    `;

    const claimed = Math.max(
      0,
      Math.min(
        TOTAL_SPOTS,
        Number(
          result?.[0]?.claimed || 0
        )
      )
    );

    const remaining =
      TOTAL_SPOTS - claimed;

    // =================================================
    // RESPONSE
    // =================================================

    return json(res, 200, {

      success: true,

      total:
        TOTAL_SPOTS,

      claimed:
        claimed,

      remaining:
        remaining

    });

  } catch (error) {

    console.error(
      "ROADMAN SPOTS ERROR:",
      error
    );

    return json(res, 500, {

      success: false,

      error:
        "Unable to read Roadman spots."

    });

  }

}