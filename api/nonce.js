const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const NONCE_TTL_SECONDS = 300;

// =====================================================
// RESPONSE
// =====================================================

function json(res, statusCode, data) {
  res.status(statusCode);

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "X-Frame-Options",
    "DENY"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );

  return res.json(data);
}

// =====================================================
// VALIDATION
// =====================================================

function isValidSolanaAddress(wallet) {
  return (
    typeof wallet === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(
      wallet
    )
  );
}

// =====================================================
// NONCE
// =====================================================

function generateNonce() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

// =====================================================
// VERIFICATION MESSAGE
// =====================================================
//
// THIS MUST MATCH api/claim.js EXACTLY.
// =====================================================

function generateMessage(
  wallet,
  nonce,
  expiresAt
) {
  return `THE ROAD PROVIDES

ROADMAN WALLET VERIFICATION

Wallet: ${wallet}
Nonce: ${nonce}
Expires: ${expiresAt.toISOString()}

Sign this message to prove control of this wallet.
This signature does not authorize any transaction.`;
}

// =====================================================
// MAIN
// =====================================================

module.exports = async function handler(
  req,
  res
) {
  // ---------------------------------------------------
  // OPTIONS
  // ---------------------------------------------------

  if (req.method === "OPTIONS") {
    res.setHeader(
      "Allow",
      "POST, OPTIONS"
    );

    return json(
      res,
      204,
      {}
    );
  }

  // ---------------------------------------------------
  // METHOD
  // ---------------------------------------------------

  if (req.method !== "POST") {
    res.setHeader(
      "Allow",
      "POST, OPTIONS"
    );

    return json(
      res,
      405,
      {
        success: false,
        error:
          "METHOD_NOT_ALLOWED",
      }
    );
  }

  // ---------------------------------------------------
  // ENVIRONMENT
  // ---------------------------------------------------

  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL_NOT_CONFIGURED"
    );

    return json(
      res,
      500,
      {
        success: false,
        error:
          "DATABASE_NOT_CONFIGURED",
      }
    );
  }

  try {
    // =================================================
    // BODY
    // =================================================

    let body;

    try {
      body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};
    } catch {
      return json(
        res,
        400,
        {
          success: false,
          error:
            "INVALID_JSON",
        }
      );
    }

    // =================================================
    // WALLET
    // =================================================

    const wallet =
      String(
        body.wallet || ""
      ).trim();

    if (
      !isValidSolanaAddress(
        wallet
      )
    ) {
      return json(
        res,
        400,
        {
          success: false,
          error:
            "INVALID_WALLET",
        }
      );
    }

    // =================================================
    // DATABASE
    // =================================================

    const sql =
      neon(
        process.env.DATABASE_URL
      );

    // =================================================
    // REMOVE EXPIRED UNUSED NONCES
    // =================================================

    await sql`
      DELETE FROM wallet_nonces
      WHERE wallet = ${wallet}
        AND used_at IS NULL
        AND expires_at < NOW()
    `;

    // =================================================
    // INVALIDATE PREVIOUS NONCES
    // =================================================
    //
    // Only one active challenge should exist for a
    // wallet at a time.
    // =================================================

    await sql`
      UPDATE wallet_nonces
      SET used_at = NOW()
      WHERE wallet = ${wallet}
        AND used_at IS NULL
        AND expires_at >= NOW()
    `;

    // =================================================
    // CREATE NEW NONCE
    // =================================================

    const nonce =
      generateNonce();

    const expiresAt =
      new Date(
        Date.now() +
          NONCE_TTL_SECONDS *
            1000
      );

    const message =
      generateMessage(
        wallet,
        nonce,
        expiresAt
      );

    // =================================================
    // STORE NONCE
    // =================================================

    await sql`
      INSERT INTO wallet_nonces (
        wallet,
        nonce,
        created_at,
        expires_at
      )
      VALUES (
        ${wallet},
        ${nonce},
        NOW(),
        ${expiresAt.toISOString()}
      )
    `;

    // =================================================
    // RESPONSE
    // =================================================

    return json(
      res,
      200,
      {
        success: true,

        wallet,

        nonce,

        message,

        expires_at:
          expiresAt.toISOString(),
      }
    );
  } catch (error) {
    console.error(
      "ROADMAN_NONCE_ERROR",
      error?.message ||
        "UNKNOWN_ERROR"
    );

    return json(
      res,
      500,
      {
        success: false,
        error:
          "NONCE_CREATION_FAILED",
      }
    );
  }
};
