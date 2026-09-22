const { neon } = require("@neondatabase/serverless");

const TOTAL_SPOTS = 100;

// =====================================================
// RESPONSE
// =====================================================

function json(res, statusCode, data) {
  res.status(statusCode);

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );

  // Same-origin only.
  // The claim.html is served by the same Vercel deployment.
  const origin = process.env.ROADMAN_ORIGIN;

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

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

module.exports = async function handler(req, res) {

  // ---------------------------------------------------
  // OPTIONS
  // ---------------------------------------------------

  if (req.method === "OPTIONS") {
    const origin = process.env.ROADMAN_ORIGIN;

    res.status(204);

    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Max-Age",
      "600"
    );

    return res.end();
  }

  // ---------------------------------------------------
  // GET ONLY
  // ---------------------------------------------------

  if (req.method !== "GET") {
    return json(res, 405, {
      success: false,
      error: "METHOD_NOT_ALLOWED"
    });
  }

  // ---------------------------------------------------
  // DATABASE
  // ---------------------------------------------------

  if (!process.env.DATABASE_URL) {
    return json(res, 500, {
      success: false,
      error: "DATABASE_NOT_CONFIGURED"
    });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    // =================================================
    // COUNT ACTIVE SPOTS
    //
    // ONLY CURRENT HOLDING PARTICIPANTS OCCUPY A SPOT.
    //
    // DISQUALIFIED / NON-HOLDING records remain in the
    // database as historical records, but do not occupy
    // one of the 100 active spots.
    // =================================================

    const result = await sql`
      SELECT COUNT(*)::int AS claimed
      FROM roadman_claims
      WHERE holding_status = 'HOLDING'
    `;

    const rawClaimed = Number(
      result?.[0]?.claimed || 0
    );

    const claimed = Number.isFinite(rawClaimed)
      ? Math.max(
          0,
          Math.min(TOTAL_SPOTS, rawClaimed)
        )
      : 0;

    const remaining = TOTAL_SPOTS - claimed;

    // =================================================
    // RESPONSE
    // =================================================

    return json(res, 200, {
      success: true,
      total: TOTAL_SPOTS,
      claimed,
      remaining
    });

  } catch (error) {

    // Do not expose database details to the client.
    console.error(
      "ROADMAN SPOTS ERROR:",
      error?.message || error
    );

    return json(res, 500, {
      success: false,
      error: "UNABLE_TO_READ_SPOTS"
    });
  }
};
