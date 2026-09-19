const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const TOTAL_SPOTS = 100;

const TOKEN_MINT =
  "BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";

// TESTE ATUAL
// PRODUÇÃO: alterar para 3_000_000
const MIN_ROAD_REQUIRED = 30;

const SOLANA_RPC =
  "https://api.mainnet-beta.solana.com";

// Token de participação válido por 24 horas.
// Ele NÃO substitui a posse da wallet/$ROAD.
// Serve apenas para identificar com segurança
// a participação já registrada no backend.
const PARTICIPATION_TOKEN_TTL_SECONDS =
  60 * 60 * 24;

// =====================================================
// RESPONSE
// =====================================================

function json(res, statusCode, data) {
  res.status(statusCode);

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

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
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(
    wallet
  );
}

function normalizeHandle(value) {
  let handle = String(value || "")
    .trim()
    .replace(/^@+/, "");

  if (!handle) {
    return "";
  }

  return `@${handle}`;
}

// =====================================================
// BASE58
// =====================================================

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value) {
  if (!value || typeof value !== "string") {
    throw new Error(
      "Invalid Base58 value."
    );
  }

  let num = 0n;

  for (const char of value) {
    const index =
      BASE58_ALPHABET.indexOf(char);

    if (index === -1) {
      throw new Error(
        "Invalid Base58 character."
      );
    }

    num =
      num * 58n +
      BigInt(index);
  }

  let hex = num.toString(16);

  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
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
// ED25519
// =====================================================

function createEd25519PublicKey(
  rawPublicKey
) {
  if (
    !Buffer.isBuffer(rawPublicKey) ||
    rawPublicKey.length !== 32
  ) {
    throw new Error(
      "Invalid Solana public key."
    );
  }

  const ED25519_SPKI_PREFIX =
    Buffer.from(
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
// SIGNATURE
// =====================================================

function verifyWalletSignature(
  wallet,
  message,
  signature
) {
  try {
    const publicKeyBytes =
      base58Decode(wallet);

    const signatureBytes =
      base58Decode(signature);

    if (publicKeyBytes.length !== 32) {
      return false;
    }

    if (signatureBytes.length !== 64) {
      return false;
    }

    const publicKey =
      createEd25519PublicKey(
        publicKeyBytes
      );

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
// RPC
// =====================================================

async function solanaRpc(
  method,
  params
) {
  const response =
    await fetch(SOLANA_RPC, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      })
    });

  if (!response.ok) {
    throw new Error(
      `Solana RPC HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (data.error) {
    throw new Error(
      data.error.message ||
      "Solana RPC error."
    );
  }

  return data.result;
}

// =====================================================
// $ROAD BALANCE
// =====================================================

async function getRoadBalance(wallet) {
  const result =
    await solanaRpc(
      "getTokenAccountsByOwner",
      [
        wallet,
        {
          mint: TOKEN_MINT
        },
        {
          encoding: "jsonParsed"
        }
      ]
    );

  const accounts =
    result?.value || [];

  let balance = 0;

  for (const account of accounts) {
    const amount =
      account?.account?.data
        ?.parsed?.info?.tokenAmount
        ?.uiAmountString;

    if (amount) {
      const parsedAmount =
        Number(amount);

      if (Number.isFinite(parsedAmount)) {
        balance += parsedAmount;
      }
    }
  }

  return Number.isFinite(balance)
    ? balance
    : 0;
}

// =====================================================
// VERIFICATION MESSAGE
// =====================================================

function buildVerificationMessage(
  wallet,
  nonce,
  expiresAt
) {
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

// =====================================================
// PARTICIPATION TOKEN
// =====================================================

function createParticipationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashParticipationToken(token) {
  return crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

// =====================================================
// HANDLER
// =====================================================

module.exports = async function handler(
  req,
  res
) {
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
      error:
        "DATABASE_URL is not configured."
    });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const xHandle =
      normalizeHandle(
        body.x_handle
      );

    const wallet =
      String(
        body.wallet || ""
      ).trim();

    const nonce =
      String(
        body.nonce || ""
      ).trim();

    const signature =
      String(
        body.signature || ""
      ).trim();

    // =================================================
    // BASIC VALIDATION
    // =================================================

    if (!xHandle) {
      return json(res, 400, {
        success: false,
        error:
          "X handle is required."
      });
    }

    if (!isValidSolanaAddress(wallet)) {
      return json(res, 400, {
        success: false,
        error:
          "Invalid Solana wallet address."
      });
    }

    if (
      !nonce ||
      nonce.length !== 64
    ) {
      return json(res, 401, {
        success: false,
        error:
          "Wallet verification is required."
      });
    }

    if (!signature) {
      return json(res, 401, {
        success: false,
        error:
          "Wallet signature is required."
      });
    }

    const sql =
      neon(
        process.env.DATABASE_URL
      );

    // =================================================
    // VERIFY NONCE
    // =================================================

    const nonceRows =
      await sql`
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

    if (!nonceRows.length) {
      return json(res, 401, {
        success: false,
        error:
          "Verification challenge not found."
      });
    }

    const challenge =
      nonceRows[0];

    if (challenge.used_at) {
      return json(res, 401, {
        success: false,
        error:
          "Verification challenge already used."
      });
    }

    const expiresAt =
      new Date(
        challenge.expires_at
      );

    if (
      Number.isNaN(
        expiresAt.getTime()
      ) ||
      expiresAt.getTime() <=
        Date.now()
    ) {
      return json(res, 401, {
        success: false,
        error:
          "Verification challenge expired."
      });
    }

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
        error:
          "Invalid wallet signature."
      });
    }

    // =================================================
    // CONSUME NONCE
    // =================================================

    const consumed =
      await sql`
        UPDATE wallet_nonces
        SET used_at = NOW()
        WHERE id = ${challenge.id}
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING id
      `;

    if (!consumed.length) {
      return json(res, 409, {
        success: false,
        error:
          "Verification challenge was already consumed."
      });
    }

    // =================================================
    // DUPLICATE HANDLE
    // =================================================

    const existingHandle =
      await sql`
        SELECT
          id,
          spot,
          wallet,
          status,
          holding_status,
          nft_number,
          nft_status
        FROM roadman_claims
        WHERE LOWER(x_handle) =
              LOWER(${xHandle})
        LIMIT 1
      `;

    if (existingHandle.length) {
      return json(res, 409, {
        success: false,
        error:
          "This X handle has already claimed a Roadman.",
        claim:
          existingHandle[0]
      });
    }

    // =================================================
    // DUPLICATE WALLET
    // =================================================

    const existingWallet =
      await sql`
        SELECT
          id,
          spot,
          x_handle,
          status,
          holding_status,
          nft_number,
          nft_status
        FROM roadman_claims
        WHERE wallet = ${wallet}
        LIMIT 1
      `;

    if (existingWallet.length) {
      return json(res, 409, {
        success: false,
        error:
          "This wallet has already claimed a Roadman.",
        claim:
          existingWallet[0]
      });
    }

    // =================================================
    // BLOCKCHAIN BALANCE
    // =================================================

    let roadBalance = 0;

    try {
      roadBalance =
        await getRoadBalance(
          wallet
        );
    } catch (error) {
      console.error(
        "ROADMAN BALANCE ERROR:",
        error
      );

      return json(res, 502, {
        success: false,
        error:
          "Unable to verify $ROAD balance on Solana."
      });
    }

    // =================================================
    // MINIMUM $ROAD
    // =================================================

    if (
      roadBalance < MIN_ROAD_REQUIRED
    ) {
      return json(res, 403, {
        success: false,
        error:
          "Insufficient $ROAD balance.",
        balance:
          roadBalance,
        minimum_road:
          MIN_ROAD_REQUIRED
      });
    }

    // =================================================
    // SPOT ALLOCATION
    // =================================================

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
        )
        ORDER BY RANDOM()
        LIMIT 1
      `;

    if (!availableSpots.length) {
      return json(res, 409, {
        success: false,
        error:
          "All Roadman spots have already been claimed."
      });
    }

    const spot =
      Number(
        availableSpots[0].spot
      );

    // =================================================
    // CLAIM
    // =================================================

    const inserted =
      await sql`
        INSERT INTO roadman_claims (
          spot,
          x_handle,
          wallet,
          status,
          created_at,
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
          initial_usd_value,
          holding_status,
          nft_status
      `;

    if (!inserted.length) {
      return json(res, 500, {
        success: false,
        error:
          "Unable to create Roadman claim."
      });
    }

    const claim =
      inserted[0];

    // =================================================
    // CREATE PARTICIPATION TOKEN
    // =================================================

    const participationToken =
      createParticipationToken();

    const participationTokenHash =
      hashParticipationToken(
        participationToken
      );

    const participationExpiresAt =
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
        expires_at
      )
      VALUES (
        ${claim.id},
        ${participationTokenHash},
        NOW(),
        ${participationExpiresAt}
      )
    `;

    // =================================================
    // SUCCESS
    // =================================================

    return json(res, 200, {
      success: true,

      message:
        "Roadman spot claimed successfully.",

      claim: {
        id:
          claim.id,

        spot:
          claim.spot,

        x_handle:
          claim.x_handle,

        wallet:
          claim.wallet,

        status:
          claim.status,

        created_at:
          claim.created_at,

        claimed_at:
          claim.claimed_at,

        initial_balance:
          claim.initial_balance,

        initial_usd_value:
          null,

        holding_status:
          claim.holding_status,

        nft_status:
          claim.nft_status
      },

      participation: {
        token:
          participationToken,

        expires_at:
          participationExpiresAt
      },

      token: {
        mint:
          TOKEN_MINT,

        balance:
          roadBalance,

        minimum_required:
          MIN_ROAD_REQUIRED
      }
    });

  } catch (error) {
    console.error(
      "ROADMAN CLAIM ERROR:",
      error
    );

    return json(res, 500, {
      success: false,
      error:
        "Unable to complete Roadman claim."
    });
  }
};
