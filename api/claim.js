const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const TOTAL_SPOTS = 100;

// =====================================================
// CONFIG
// =====================================================

// TESTE:
// 30 = mínimo atual para testar sem precisar comprar/mover
// PRODUÇÃO:
// 3_000_000 = mínimo definitivo
const MIN_ROAD_REQUIRED = 30;

const TOKEN_MINT =
  "BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";

const SOLANA_RPC =
  "https://api.mainnet-beta.solana.com";

const PARTICIPATION_TOKEN_TTL_SECONDS = 86400;

// =====================================================
// HELPERS
// =====================================================

function json(res, status, data) {
  res.status(status);

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  return res.json(data);
}

function normalizeHandle(value) {
  let handle = String(value || "").trim();

  if (!handle) return null;

  if (!handle.startsWith("@")) {
    handle = "@" + handle;
  }

  return handle;
}

function isValidWallet(wallet) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet);
}

function isValidNonce(nonce) {
  return /^[a-f0-9]{64}$/i.test(nonce);
}

// =====================================================
// BASE58
// =====================================================

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Invalid base58 value");
  }

  let bytes = [0];

  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);

    if (index === -1) {
      throw new Error("Invalid base58 character");
    }

    let carry = index;

    for (let i = 0; i < bytes.length; i++) {
      const current = bytes[i] * 58 + carry;

      bytes[i] = current & 0xff;
      carry = current >> 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Leading zero bytes represented by "1"
  for (let i = 0; i < value.length && value[i] === "1"; i++) {
    bytes.push(0);
  }

  return Buffer.from(bytes.reverse());
}

// =====================================================
// WALLET SIGNATURE
// =====================================================

function walletPublicKeyFromRaw(walletBytes) {
  if (!Buffer.isBuffer(walletBytes)) {
    throw new Error("Invalid wallet bytes");
  }

  if (walletBytes.length !== 32) {
    throw new Error("Invalid Solana public key length");
  }

  // Ed25519 SubjectPublicKeyInfo prefix
  const prefix = Buffer.from(
    "302a300506032b6570032100",
    "hex"
  );

  return crypto.createPublicKey({
    key: Buffer.concat([prefix, walletBytes]),
    format: "der",
    type: "spki",
  });
}

function verifyWalletSignature(
  wallet,
  message,
  signature
) {
  try {
    const walletBytes = base58Decode(wallet);
    const signatureBytes = base58Decode(signature);

    if (walletBytes.length !== 32) {
      return false;
    }

    if (signatureBytes.length !== 64) {
      return false;
    }

    const publicKey =
      walletPublicKeyFromRaw(walletBytes);

    return crypto.verify(
      null,
      Buffer.from(message, "utf8"),
      publicKey,
      signatureBytes
    );
  } catch {
    return false;
  }
}

// =====================================================
// VERIFICATION MESSAGE
// MUST MATCH /api/nonce.js EXACTLY
// =====================================================

function buildVerificationMessage(
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
// SOLANA RPC
// =====================================================

async function solanaRpc(method, params) {
  const response = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Solana RPC HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      data.error.message || "Solana RPC error"
    );
  }

  return data.result;
}

// =====================================================
// $ROAD BALANCE
// =====================================================

async function getRoadBalance(wallet) {
  const result = await solanaRpc(
    "getTokenAccountsByOwner",
    [
      wallet,
      {
        mint: TOKEN_MINT,
      },
      {
        encoding: "jsonParsed",
        commitment: "finalized",
      },
    ]
  );

  let total = 0;

  for (const account of result.value || []) {
    const amount =
      account?.account?.data?.parsed?.info
        ?.tokenAmount?.uiAmountString;

    if (amount !== undefined && amount !== null) {
      total += Number(amount);
    }
  }

  if (!Number.isFinite(total)) {
    throw new Error(
      "Invalid $ROAD balance returned by Solana"
    );
  }

  return total;
}

// =====================================================
// MAIN
// =====================================================

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return json(res, 200, {
      success: true,
    });
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  if (!process.env.DATABASE_URL) {
    return json(res, 500, {
      success: false,
      error: "DATABASE_NOT_CONFIGURED",
    });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const body = req.body || {};

    const xHandle = normalizeHandle(
      body.x_handle
    );

    const wallet = String(
      body.wallet || ""
    ).trim();

    const nonce = String(
      body.nonce || ""
    ).trim();

    const signature = String(
      body.signature || ""
    ).trim();

    // -------------------------------------------------
    // BASIC VALIDATION
    // -------------------------------------------------

    if (!xHandle) {
      return json(res, 400, {
        success: false,
        error: "X_HANDLE_REQUIRED",
      });
    }

    if (xHandle.length > 100) {
      return json(res, 400, {
        success: false,
        error: "X_HANDLE_TOO_LONG",
      });
    }

    if (!isValidWallet(wallet)) {
      return json(res, 400, {
        success: false,
        error: "INVALID_WALLET",
      });
    }

    if (!isValidNonce(nonce)) {
      return json(res, 400, {
        success: false,
        error: "INVALID_NONCE",
      });
    }

    if (!signature) {
      return json(res, 400, {
        success: false,
        error: "SIGNATURE_REQUIRED",
      });
    }

    // -------------------------------------------------
    // FIND NONCE
    // -------------------------------------------------

    const nonceRows = await sql`
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

    if (nonceRows.length === 0) {
      return json(res, 401, {
        success: false,
        error: "NONCE_NOT_FOUND",
      });
    }

    const challenge = nonceRows[0];

    // -------------------------------------------------
    // NONCE VALIDATION
    // -------------------------------------------------

    if (challenge.used_at) {
      return json(res, 401, {
        success: false,
        error: "NONCE_ALREADY_USED",
      });
    }

    const expiresAt =
      new Date(challenge.expires_at);

    if (
      !Number.isFinite(
        expiresAt.getTime()
      )
    ) {
      return json(res, 500, {
        success: false,
        error: "INVALID_NONCE_EXPIRATION",
      });
    }

    if (expiresAt.getTime() <= Date.now()) {
      return json(res, 401, {
        success: false,
        error: "NONCE_EXPIRED",
      });
    }

    // -------------------------------------------------
    // VERIFY SIGNATURE
    // -------------------------------------------------

    const message =
      buildVerificationMessage(
        wallet,
        nonce,
        expiresAt
      );

    const validSignature =
      verifyWalletSignature(
        wallet,
        message,
        signature
      );

    if (!validSignature) {
      return json(res, 401, {
        success: false,
        error: "INVALID_WALLET_SIGNATURE",
      });
    }

    // -------------------------------------------------
    // CONSUME NONCE ATOMICALLY
    // -------------------------------------------------

    const consumedNonce =
      await sql`
        UPDATE wallet_nonces
        SET used_at = NOW()
        WHERE id = ${challenge.id}
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING id
      `;

    if (consumedNonce.length === 0) {
      return json(res, 409, {
        success: false,
        error: "NONCE_ALREADY_CONSUMED",
      });
    }

    // -------------------------------------------------
    // CHECK X HANDLE
    // Only active HOLDING claims block a new Spot.
    // -------------------------------------------------

    const existingHandle =
      await sql`
        SELECT
          id,
          spot,
          wallet,
          holding_status,
          nft_status
        FROM roadman_claims
        WHERE LOWER(x_handle) = LOWER(${xHandle})
          AND holding_status = 'HOLDING'
        LIMIT 1
      `;

    if (existingHandle.length > 0) {
      return json(res, 409, {
        success: false,
        error: "X_HANDLE_ALREADY_CLAIMED",
      });
    }

    // -------------------------------------------------
    // CHECK WALLET
    // -------------------------------------------------

    const existingWallet =
      await sql`
        SELECT
          id,
          spot,
          x_handle,
          holding_status,
          nft_status
        FROM roadman_claims
        WHERE wallet = ${wallet}
          AND holding_status = 'HOLDING'
        LIMIT 1
      `;

    if (existingWallet.length > 0) {
      return json(res, 409, {
        success: false,
        error: "WALLET_ALREADY_CLAIMED",
      });
    }

    // -------------------------------------------------
    // CHECK $ROAD ON-CHAIN
    // -------------------------------------------------

    let roadBalance;

    try {
      roadBalance =
        await getRoadBalance(wallet);
    } catch (error) {
      console.error(
        "SOLANA_BALANCE_ERROR",
        error
      );

      return json(res, 502, {
        success: false,
        error: "SOLANA_BALANCE_CHECK_FAILED",
      });
    }

    if (
      roadBalance <
      MIN_ROAD_REQUIRED
    ) {
      return json(res, 403, {
        success: false,
        error: "INSUFFICIENT_ROAD",
        required: MIN_ROAD_REQUIRED,
        balance: roadBalance,
      });
    }

    // -------------------------------------------------
    // FIND AVAILABLE SPOT
    //
    // IMPORTANT:
    // Only HOLDING records occupy a Spot.
    // DISQUALIFIED records remain as history.
    // -------------------------------------------------

    const availableSpots =
      await sql`
        SELECT s.spot
        FROM generate_series(
          1,
          ${TOTAL_SPOTS}
        ) AS s(spot)
        WHERE NOT EXISTS (
          SELECT 1
          FROM roadman_claims r
          WHERE r.spot = s.spot
            AND r.holding_status = 'HOLDING'
        )
        ORDER BY RANDOM()
        LIMIT 1
      `;

    if (availableSpots.length === 0) {
      return json(res, 409, {
        success: false,
        error: "ALL_SPOTS_FILLED",
      });
    }

    const spot =
      Number(availableSpots[0].spot);

    // -------------------------------------------------
    // INSERT CLAIM
    // -------------------------------------------------

    let claimRows;

    try {
      claimRows = await sql`
        INSERT INTO roadman_claims (
          spot,
          x_handle,
          wallet,
          status,
          claimed_at,
          initial_balance,
          initial_usd_value,
          holding_status,
          nft_status
        )
        VALUES (
          ${spot},
          ${xHandle},
          ${wallet},
          'claimed',
          NOW(),
          ${roadBalance},
          NULL,
          'HOLDING',
          'PENDING'
        )
        RETURNING
          id,
          spot,
          x_handle,
          wallet,
          status,
          created_at,
          claimed_at,
          initial_balance,
          holding_status,
          qualified_at,
          disqualified_at,
          nft_number,
          nft_status,
          delivery_tx,
          delivered_at,
          nft_assigned_at
      `;
    } catch (error) {
      // The database UNIQUE constraint on spot/wallet
      // is the final concurrency protection.
      console.error(
        "CLAIM_INSERT_ERROR",
        error
      );

      return json(res, 409, {
        success: false,
        error: "CLAIM_COULD_NOT_BE_CREATED",
      });
    }

    if (claimRows.length === 0) {
      return json(res, 500, {
        success: false,
        error: "CLAIM_CREATION_FAILED",
      });
    }

    const claim =
      claimRows[0];

    // -------------------------------------------------
    // PARTICIPATION TOKEN
    // -------------------------------------------------

    const rawToken =
      crypto.randomBytes(32).toString("hex");

    const tokenHash =
      crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

    const tokenExpiresAt =
      new Date(
        Date.now() +
          PARTICIPATION_TOKEN_TTL_SECONDS *
            1000
      );

    await sql`
      INSERT INTO participation_tokens (
        claim_id,
        token_hash,
        created_at,
        expires_at,
        revoked_at
      )
      VALUES (
        ${claim.id},
        ${tokenHash},
        NOW(),
        ${tokenExpiresAt},
        NULL
      )
    `;

    // -------------------------------------------------
    // RESPONSE
    // -------------------------------------------------

    return json(res, 200, {
      success: true,

      claim: {
        id: claim.id,
        spot: claim.spot,
        x_handle: claim.x_handle,
        wallet: claim.wallet,
        status: claim.status,
        claimed_at: claim.claimed_at,
        initial_balance:
          claim.initial_balance,
        holding_status:
          claim.holding_status,
        qualified_at:
          claim.qualified_at,
        disqualified_at:
          claim.disqualified_at,
        nft_number:
          claim.nft_number,
        nft_status:
          claim.nft_status,
        delivery_tx:
          claim.delivery_tx,
        delivered_at:
          claim.delivered_at,
        nft_assigned_at:
          claim.nft_assigned_at,
      },

      participation: {
        token: rawToken,
        expires_at: tokenExpiresAt.toISOString(),
      },

      verification: {
        token_mint: TOKEN_MINT,
        minimum_road_required:
          MIN_ROAD_REQUIRED,
        verified_balance:
          roadBalance,
      },
    });
  } catch (error) {
    console.error(
      "CLAIM_API_ERROR",
      error
    );

    return json(res, 500, {
      success: false,
      error: "INTERNAL_SERVER_ERROR",
    });
  }
};
