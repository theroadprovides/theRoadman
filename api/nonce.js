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

  const origin = process.env.ROADMAN_ORIGIN;

  if (origin) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );

    res.setHeader(
      "Vary",
      "Origin"
    );
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
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
// WALLET-SPECIFIC ADVISORY LOCK
// =====================================================
//
// PostgreSQL advisory locks permitem impedir que duas
// requisições simultâneas criem/inutilizem nonces para
// a mesma carteira ao mesmo tempo.
//
// O hash SHA-256 da carteira é convertido em um inteiro
// signed 64-bit para pg_advisory_xact_lock(bigint).
//
// A trava existe somente durante a transação.
// =====================================================

function walletLockKey(wallet) {
  const digest = crypto
    .createHash("sha256")
    .update(
      `THE_ROAD_PROVIDES:NONCE_LOCK:${wallet}`,
      "utf8"
    )
    .digest();

  let value =
    digest.readBigInt64BE(0);

  // Evita valor negativo para facilitar diagnóstico.
  if (value < 0n) {
    value = -value;
  }

  return value;
}

// =====================================================
// VERIFICATION MESSAGE
// =====================================================
//
// MUST MATCH api/claim.js EXACTLY.
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
    // LOCK KEY
    // =================================================

    const lockKey =
      walletLockKey(wallet);

    // =================================================
    // CREATE NONCE ATOMICALLY
    // =================================================
    //
    // Toda a operação acontece dentro de uma única
    // transação:
    //
    // 1. trava esta carteira;
    // 2. remove nonces expirados;
    // 3. invalida nonce anterior;
    // 4. cria novo nonce;
    // 5. retorna o nonce criado.
    //
    // Outra requisição para a MESMA carteira espera a
    // primeira terminar antes de executar.
    //
    // Outra carteira continua normalmente.
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

    const transaction =
      await sql.transaction([

        // ------------------------------------------------
        // 1. WALLET LOCK
        // ------------------------------------------------

        sql`
          SELECT
            pg_advisory_xact_lock(
              ${lockKey}
            )
        `,

        // ------------------------------------------------
        // 2. REMOVE EXPIRED UNUSED NONCES
        // ------------------------------------------------

        sql`
          DELETE FROM wallet_nonces
          WHERE wallet = ${wallet}
            AND used_at IS NULL
            AND expires_at < NOW()
        `,

        // ------------------------------------------------
        // 3. INVALIDATE PREVIOUS ACTIVE NONCES
        // ------------------------------------------------

        sql`
          UPDATE wallet_nonces
          SET used_at = NOW()
          WHERE wallet = ${wallet}
            AND used_at IS NULL
            AND expires_at >= NOW()
        `,

        // ------------------------------------------------
        // 4. CREATE NEW NONCE
        // ------------------------------------------------

        sql`
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
          RETURNING
            id,
            wallet,
            nonce,
            created_at,
            expires_at
        `,
      ]);

    const createdRows =
      transaction?.[3] || [];

    if (
      createdRows.length === 0
    ) {
      console.error(
        "NONCE_INSERT_FAILED"
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

    const created =
      createdRows[0];

    // =================================================
    // RESPONSE
    // =================================================

    return json(
      res,
      200,
      {
        success: true,

        wallet:
          created.wallet,

        nonce:
          created.nonce,

        message:
          generateMessage(
            created.wallet,
            created.nonce,
            new Date(
              created.expires_at
            )
          ),

        expires_at:
          new Date(
            created.expires_at
          ).toISOString(),
      }
    );

  } catch (error) {

    console.error(
      "ROADMAN_NONCE_ERROR:",
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
