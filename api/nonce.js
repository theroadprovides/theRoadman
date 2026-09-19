const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const NONCE_TTL_SECONDS = 300;

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
    "POST, OPTIONS"
  );

  return res.json(data);
}

function isValidSolanaAddress(wallet) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet);
}

function generateNonce() {
  return crypto.randomBytes(32).toString("hex");
}

function generateMessage(wallet, nonce, expiresAt) {
  return [
    "THE ROAD PROVIDES",
    "",
    "ROADMAN WALLET VERIFICATION",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    "",
    "Sign this message to prove control of this wallet.",
    "This signature does not authorize any transaction."
  ].join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204);
    return res.end();
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "Method not allowed."
    });
  }

  if (!process.env.DATABASE_URL) {
    return json(res, 500, {
      success: false,
      error: "DATABASE_URL is not configured."
    });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const wallet = String(body.wallet || "").trim();

    if (!isValidSolanaAddress(wallet)) {
      return json(res, 400, {
        success: false,
        error: "Invalid Solana wallet address."
      });
    }

    const sql = neon(process.env.DATABASE_URL);

    // Remove expired unused nonces for this wallet.
    await sql`
      DELETE FROM wallet_nonces
      WHERE wallet = ${wallet}
        AND used_at IS NULL
        AND expires_at < NOW()
    `;

    // Invalidate any previous unused nonce for this wallet.
    await sql`
      UPDATE wallet_nonces
      SET used_at = NOW()
      WHERE wallet = ${wallet}
        AND used_at IS NULL
        AND expires_at >= NOW()
    `;

    const nonce = generateNonce();

    const expiresAt = new Date(
      Date.now() + NONCE_TTL_SECONDS * 1000
    );

    const message = generateMessage(
      wallet,
      nonce,
      expiresAt
    );

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

    return json(res, 200, {
      success: true,
      wallet,
      nonce,
      message,
      expires_at: expiresAt.toISOString()
    });

  } catch (error) {
    console.error("ROADMAN NONCE ERROR:", error);

    return json(res, 500, {
      success: false,
      error: "Unable to create wallet verification challenge."
    });
  }
};
