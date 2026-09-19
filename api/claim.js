const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const TOTAL_SPOTS = 100;

// =====================================================
// CONFIG
// =====================================================

const TEST_MODE = false;

const TEST_KEY = "ROADMAN_TEST_2026";

const TOKEN_MINT =
  "BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";

// TESTE ATUAL
// Depois alterar para 3_000_000
const MIN_USD_REQUIRED = 1;

const SOLANA_RPC =
  "https://api.mainnet-beta.solana.com";

const NONCE_MAX_AGE_SECONDS = 300;

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
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet);
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
    throw new Error("Invalid Base58 value.");
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
      balance += Number(amount);
    }
  }

  return Number.isFinite(balance)
    ? balance
    : 0;
}

// =====================================================
// $ROAD PRICE
// =====================================================

async function getRoadPrice() {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`;

  const response =
    await fetch(url, {
      headers: {
        Accept:
          "application/json"
      }
    });

  if (!response.ok) {
    throw new Error(
      `Price API HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const pairs =
    Array.isArray(data?.pairs)
      ? data.pairs
      : [];

  const validPairs =
    pairs
      .filter((pair) => {
        if (
          String(pair?.chainId || "")
            .toLowerCase() !==
          "solana"
        ) {
          return false;
        }

        const base =
          pair?.baseToken?.address;

        const quote =
          pair?.quoteToken?.address;

        if (
          base !== TOKEN_MINT &&
          quote !== TOKEN_MINT
        ) {
          return false;
        }

        const price =
          Number(pair?.priceUsd);

        return (
          Number.isFinite(price) &&
          price > 0
        );
      })
      .sort((a, b) => {
        const liquidityA =
          Number(
            a?.liquidity?.usd || 0
          );

        const liquidityB =
          Number(
            b?.liquidity?.usd || 0
          );

        return (
          liquidityB -
          liquidityA
        );
      });

  if (!validPairs.length) {
    throw new Error(
      "Unable to determine $ROAD price."
    );
  }

  return Number(
    validPairs[0].priceUsd
  );
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

    const testKey =
      String(
        body.test_key || ""
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

    // =================================================
    // TEST MODE
    // =================================================

    if (
      TEST_MODE &&
      testKey !== TEST_KEY
    ) {
      return json(res, 403, {
        success: false,
        error:
          "Invalid test authorization."
      });
    }

    // =================================================
    // WALLET SIGNATURE
    // =================================================

    if (!TEST_MODE) {
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
    }

    const sql =
      neon(
        process.env.DATABASE_URL
      );

    // =================================================
    // VERIFY NONCE
    // =================================================

    if (!TEST_MODE) {
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
    // PRICE
    // =================================================

    let roadPrice = null;
    let usdValue = null;

    try {
      roadPrice =
        await getRoadPrice();

      usdValue =
        roadBalance *
        roadPrice;
    } catch (error) {
      console.error(
        "ROADMAN PRICE ERROR:",
        error
      );

      /*
       * IMPORTANT:
       * Price is auxiliary information.
       *
       * The blockchain remains the source
       * of truth for token ownership.
       *
       * We do not allow a price API outage
       * to automatically prove ownership.
       *
       * For the current US$1 test rule,
       * however, we need a price to calculate
       * the USD threshold.
       */

      return json(res, 503, {
        success: false,
        error:
          "Unable to determine $ROAD price.",
        detail:
          "Your wallet was not rejected. The market-price service is currently unavailable."
      });
    }

    // =================================================
    // MINIMUM USD
    // =================================================

    if (
      !TEST_MODE &&
      usdValue < MIN_USD_REQUIRED
    ) {
      return json(res, 403, {
        success: false,
        error:
          "Insufficient $ROAD balance.",
        balance:
          roadBalance,
        road_price:
          roadPrice,
        usd_value:
          usdValue,
        minimum_usd:
          MIN_USD_REQUIRED
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
          ${usdValue},
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

    const claim =
      inserted[0];

    // =================================================
    // SUCCESS
    // =================================================

    return json(res, 200, {
      success: true,
      message:
        "Roadman spot claimed successfully.",

      claim: {
        id: claim.id,
        spot: claim.spot,
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
          claim.initial_usd_value,
        holding_status:
          claim.holding_status,
        nft_status:
          claim.nft_status
      },

      token: {
        mint:
          TOKEN_MINT,
        balance:
          roadBalance,
        price_usd:
          roadPrice,
        usd_value:
          usdValue
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
