const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

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

// =====================================================
// BASE58
// =====================================================

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Invalid Base58 value.");
  }

  let num = 0n;

  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);

    if (index === -1) {
      throw new Error("Invalid Base58 character.");
    }

    num = num * 58n + BigInt(index);
  }

  let hex = num.toString(16);

  if (hex.length % 2 !== 0) {
    hex = "0" + hex;
  }

  let bytes =
    hex.length > 0
      ? Buffer.from(hex, "hex")
      : Buffer.alloc(0);

  let leadingZeros = 0;

  for (const char of value) {
    if (char !== "1") {
      break;
    }

    leadingZeros++;
  }

  if (leadingZeros > 0) {
    bytes = Buffer.concat([
      Buffer.alloc(leadingZeros),
      bytes
    ]);
  }

  return bytes;
}

// =====================================================
// SOLANA WALLET VALIDATION
// =====================================================

function isValidSolanaAddress(wallet) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet);
}

// =====================================================
// ED25519 PUBLIC KEY
// =====================================================

function createEd25519PublicKey(rawPublicKey) {
  if (!Buffer.isBuffer(rawPublicKey)) {
    throw new Error("Invalid public key.");
  }

  if (rawPublicKey.length !== 32) {
    throw new Error("Invalid Solana public key length.");
  }

  /*
   * DER SubjectPublicKeyInfo prefix for Ed25519.
   * The final 32 bytes are the raw Solana public key.
   */
  const ED25519_SPKI_PREFIX = Buffer.from(
    "302a300506032b6570032100",
    "hex"
  );

  return crypto.createPublicKey({
    key: Buffer.concat([
      ED25519_SPKI_PREFIX,
      rawPublicKey
    ]),
    format: "der",
    type: "spki"
  });
}

// =====================================================
// SIGNATURE VERIFICATION
// =====================================================

function verifySignature(
  wallet,
  message,
  signatureBase58
) {
  try {
    const publicKeyBytes =
      base58Decode(wallet);

    const signatureBytes =
      base58Decode(signatureBase58);

    if (publicKeyBytes.length !== 32) {
      return false;
    }

    if (signatureBytes.length !== 64) {
      return false;
    }

    const publicKey =
      createEd25519PublicKey(publicKeyBytes);

    return crypto.verify(
      null,
      Buffer.from(message, "utf8"),
      publicKey,
      signatureBytes
    );

  } catch (error) {
    console.error(
      "ROADMAN SIGNATURE ERROR:",
      error
    );

    return false;
  }
}

// =====================================================
// HANDLER
// =====================================================

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

    const wallet = String(
      body.wallet || ""
    ).trim();

    const nonce = String(
      body.nonce || ""
    ).trim();

    const signature = String(
      body.signature || ""
    ).trim();

    if (!isValidSolanaAddress(wallet)) {
      return json(res, 400, {
        success: false,
        error: "Invalid Solana wallet address."
      });
    }

    if (!nonce || nonce.length !== 64) {
      return json(res, 400, {
        success: false,
        error: "Invalid verification nonce."
      });
    }

    if (!signature) {
      return json(res, 400, {
        success: false,
        error: "Wallet signature is required."
      });
    }

    const sql = neon(process.env.DATABASE_URL);

    // =================================================
    // FIND ACTIVE NONCE
    // =================================================

    const rows = await sql`
      SELECT
        id,
        wallet,
        nonce,
        created_at,
        expires_at,
        used_at
      FROM wallet_nonces
      WHERE wallet = ${wallet}
        AND nonce = ${nonce}
      LIMIT 1
    `;

    if (!rows.length) {
      return json(res, 401, {
        success: false,
        error: "Verification challenge not found."
      });
    }

    const challenge = rows[0];

    // =================================================
    // CHECK NONCE STATUS
    // =================================================

    if (challenge.used_at) {
      return json(res, 401, {
        success: false,
        error: "Verification challenge already used."
      });
    }

    const expiresAt =
      new Date(challenge.expires_at);

    if (
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now()
    ) {
      return json(res, 401, {
        success: false,
        error: "Verification challenge expired."
      });
    }

    // =================================================
    // REBUILD EXACT MESSAGE
    // =================================================

    const message = [
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

    // =================================================
    // VERIFY CRYPTOGRAPHIC SIGNATURE
    // =================================================

    const validSignature =
      verifySignature(
        wallet,
        message,
        signature
      );

    if (!validSignature) {
      return json(res, 401, {
        success: false,
        verified: false,
        error: "Invalid wallet signature."
      });
    }

    // =================================================
    // CONSUME NONCE ATOMICALLY
    // =================================================

    const consumed = await sql`
      UPDATE wallet_nonces
      SET used_at = NOW()
      WHERE id = ${challenge.id}
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING
        id,
        wallet,
        nonce,
        used_at
    `;

    if (!consumed.length) {
      return json(res, 409, {
        success: false,
        verified: false,
        error:
          "Verification challenge was already consumed."
      });
    }

    // =================================================
    // SUCCESS
    // =================================================

    return json(res, 200, {
      success: true,
      verified: true,
      wallet,
      nonce,
      verified_at:
        consumed[0].used_at
    });

  } catch (error) {
    console.error(
      "ROADMAN VERIFY WALLET ERROR:",
      error
    );

    return json(res, 500, {
      success: false,
      verified: false,
      error:
        "Unable to verify wallet ownership."
    });
  }
};
