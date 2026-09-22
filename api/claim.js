const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const TOTAL_SPOTS = 100;

// =====================================================
// CONFIG
// =====================================================
//
// O modo de teste NÃO é controlado pelo frontend.
//
// VERCEL / ENV:
// ROADMAN_TEST_MODE=true
// ROADMAN_TEST_MIN_ROAD=30
//
// PRODUÇÃO:
// ROADMAN_TEST_MODE=false (ou ausente)
// ROADMAN_MIN_ROAD=3000000
//
// Nunca coloque nenhuma dessas variáveis no HTML.
// =====================================================

const TEST_MODE =
  String(process.env.ROADMAN_TEST_MODE || "")
    .toLowerCase() === "true";

const TEST_MIN_ROAD =
  parsePositiveNumber(
    process.env.ROADMAN_TEST_MIN_ROAD,
    30
  );

const PRODUCTION_MIN_ROAD =
  parsePositiveNumber(
    process.env.ROADMAN_MIN_ROAD,
    3_000_000
  );

const MIN_ROAD_REQUIRED =
  TEST_MODE
    ? TEST_MIN_ROAD
    : PRODUCTION_MIN_ROAD;

const TOKEN_MINT =
  "BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";

const SOLANA_RPC =
  "https://api.mainnet-beta.solana.com";

const PARTICIPATION_TOKEN_SECRET =
  process.env.PARTICIPATION_TOKEN_SECRET;

// Mesmo lock usado para serializar o First 100.
const ROADMAN_ADVISORY_LOCK = 784321001;

// =====================================================
// HELPERS
// =====================================================

function parsePositiveNumber(value, fallback) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return fallback;
  }

  return parsed;
}

// =====================================================
// RESPONSE
// =====================================================

function json(res, status, data) {
  res.status(status);

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
// BASIC VALIDATION
// =====================================================

function normalizeHandle(value) {
  let handle = String(value || "").trim();

  if (!handle) {
    return null;
  }

  if (!handle.startsWith("@")) {
    handle = "@" + handle;
  }

  return handle;
}

function isValidWallet(wallet) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(
    wallet
  );
}

function isValidNonce(nonce) {
  return /^[a-f0-9]{64}$/i.test(
    nonce
  );
}

function isValidSignature(signature) {
  return (
    typeof signature === "string" &&
    signature.length >= 80 &&
    signature.length <= 100
  );
}

// =====================================================
// PARTICIPATION TOKEN
// =====================================================
//
// Persistent token.
//
// Raw token:
// HMAC-SHA256(secret, wallet)
//
// Database:
// SHA256(raw token)
//
// The raw token is returned once to the browser.
// It is never stored directly in the database.
// =====================================================

function createParticipationToken(wallet) {
  if (!PARTICIPATION_TOKEN_SECRET) {
    throw new Error(
      "PARTICIPATION_TOKEN_SECRET_NOT_CONFIGURED"
    );
  }

  return crypto
    .createHmac(
      "sha256",
      PARTICIPATION_TOKEN_SECRET
    )
    .update(
      `THE_ROAD_PROVIDES:PARTICIPATION:${wallet}`,
      "utf8"
    )
    .digest("hex");
}

function hashParticipationToken(token) {
  return crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

// =====================================================
// BASE58
// =====================================================

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value) {
  if (
    !value ||
    typeof value !== "string"
  ) {
    throw new Error(
      "INVALID_BASE58_VALUE"
    );
  }

  let bytes = [0];

  for (const char of value) {
    const index =
      BASE58_ALPHABET.indexOf(char);

    if (index === -1) {
      throw new Error(
        "INVALID_BASE58_CHARACTER"
      );
    }

    let carry = index;

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      const current =
        bytes[i] * 58 + carry;

      bytes[i] =
        current & 0xff;

      carry =
        current >> 8;
    }

    while (carry > 0) {
      bytes.push(
        carry & 0xff
      );

      carry >>= 8;
    }
  }

  // Leading zero bytes represented by "1".
  for (
    let i = 0;
    i < value.length &&
    value[i] === "1";
    i++
  ) {
    bytes.push(0);
  }

  return Buffer.from(
    bytes.reverse()
  );
}

// =====================================================
// WALLET PUBLIC KEY
// =====================================================

function walletPublicKeyFromRaw(
  walletBytes
) {
  if (
    !Buffer.isBuffer(walletBytes) ||
    walletBytes.length !== 32
  ) {
    throw new Error(
      "INVALID_SOLANA_PUBLIC_KEY"
    );
  }

  // Ed25519 SubjectPublicKeyInfo prefix.
  const prefix = Buffer.from(
    "302a300506032b6570032100",
    "hex"
  );

  return crypto.createPublicKey({
    key: Buffer.concat([
      prefix,
      walletBytes,
    ]),
    format: "der",
    type: "spki",
  });
}

// =====================================================
// WALLET SIGNATURE
// =====================================================

function verifyWalletSignature(
  wallet,
  message,
  signature
) {
  try {
    const walletBytes =
      base58Decode(wallet);

    const signatureBytes =
      base58Decode(signature);

    if (
      walletBytes.length !== 32
    ) {
      return false;
    }

    if (
      signatureBytes.length !== 64
    ) {
      return false;
    }

    const publicKey =
      walletPublicKeyFromRaw(
        walletBytes
      );

    return crypto.verify(
      null,
      Buffer.from(
        message,
        "utf8"
      ),
      publicKey,
      signatureBytes
    );
  } catch {
    return false;
  }
}

// =====================================================
// VERIFICATION MESSAGE
// =====================================================
//
// MUST MATCH /api/nonce.js EXACTLY.
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

async function solanaRpc(
  method,
  params
) {
  const response =
    await fetch(
      SOLANA_RPC,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
      }
    );

  if (!response.ok) {
    throw new Error(
      `SOLANA_RPC_HTTP_${response.status}`
    );
  }

  const data =
    await response.json();

  if (data.error) {
    throw new Error(
      data.error.message ||
        "SOLANA_RPC_ERROR"
    );
  }

  return data.result;
}

// =====================================================
// $ROAD BALANCE
// =====================================================
//
// Uses raw integer token amounts rather than Number()
// for eligibility decisions.
//
// This avoids floating-point precision problems.
// =====================================================

async function getRoadBalance(
  wallet
) {
  const result =
    await solanaRpc(
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

  let totalRaw = 0n;
  let decimals = null;

  for (
    const account of
    result?.value || []
  ) {
    const tokenAmount =
      account
        ?.account
        ?.data
        ?.parsed
        ?.info
        ?.tokenAmount;

    if (!tokenAmount) {
      continue;
    }

    const rawAmount =
      tokenAmount.amount;

    const accountDecimals =
      Number(
        tokenAmount.decimals
      );

    if (
      typeof rawAmount !== "string" ||
      !/^\d+$/.test(rawAmount)
    ) {
      throw new Error(
        "INVALID_ROAD_RAW_BALANCE"
      );
    }

    if (
      !Number.isInteger(
        accountDecimals
      ) ||
      accountDecimals < 0 ||
      accountDecimals > 18
    ) {
      throw new Error(
        "INVALID_ROAD_DECIMALS"
      );
    }

    if (
      decimals === null
    ) {
      decimals =
        accountDecimals;
    }

    if (
      decimals !==
      accountDecimals
    ) {
      throw new Error(
        "INCONSISTENT_ROAD_DECIMALS"
      );
    }

    totalRaw +=
      BigInt(rawAmount);
  }

  if (
    decimals === null
  ) {
    // No token account = zero balance.
    decimals = 0;
  }

  return {
    raw: totalRaw,
    decimals,
  };
}

// =====================================================
// THRESHOLD COMPARISON
// =====================================================

function decimalNumberToScaledBigInt(
  value,
  decimals
) {
  if (
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(
      "INVALID_ROAD_THRESHOLD"
    );
  }

  const stringValue =
    String(value);

  const [
    integerPart,
    fractionPart = "",
  ] =
    stringValue.split(".");

  const fraction =
    fractionPart
      .replace(/[^0-9]/g, "")
      .slice(0, decimals)
      .padEnd(decimals, "0");

  const integer =
    integerPart || "0";

  return (
    BigInt(integer) *
      10n ** BigInt(decimals) +
    BigInt(fraction || "0")
  );
}

function hasEnoughRoad(
  balance,
  required
) {
  const requiredRaw =
    decimalNumberToScaledBigInt(
      required,
      balance.decimals
    );

  return (
    balance.raw >=
    requiredRaw
  );
}

// =====================================================
// BALANCE FOR RESPONSE / DATABASE
// =====================================================

function rawBalanceToNumber(
  raw,
  decimals
) {
  if (
    decimals === 0
  ) {
    const asNumber =
      Number(raw);

    return Number.isSafeInteger(
      asNumber
    )
      ? asNumber
      : Number.MAX_SAFE_INTEGER;
  }

  const divisor =
    10 ** decimals;

  const value =
    Number(raw) / divisor;

  if (
    !Number.isFinite(value)
  ) {
    return Number.MAX_SAFE_INTEGER;
  }

  return value;
}

// =====================================================
// PUBLIC CLAIM
// =====================================================

function publicClaim(
  claim
) {
  return {
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

    claimed_at:
      claim.claimed_at,

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
  };
}

// =====================================================
// ENSURE PARTICIPATION TOKEN
// =====================================================

async function ensureParticipationToken(
  sql,
  claim
) {
  const rawToken =
    createParticipationToken(
      claim.wallet
    );

  const tokenHash =
    hashParticipationToken(
      rawToken
    );

  const existingToken =
    await sql`
      SELECT
        id,
        token_hash,
        expires_at,
        revoked_at
      FROM participation_tokens
      WHERE claim_id = ${claim.id}
      ORDER BY id DESC
      LIMIT 1
    `;

  if (
    existingToken.length === 0
  ) {
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
        NULL,
        NULL
      )
    `;
  } else {
    const stored =
      existingToken[0];

    // A revoked token must not silently become valid again.
    if (
      stored.revoked_at
    ) {
      return {
        token: null,
        expires_at:
          stored.expires_at || null,
        revoked: true,
      };
    }

    if (
      stored.token_hash !==
      tokenHash ||
      stored.expires_at !== null
    ) {
      await sql`
        UPDATE participation_tokens
        SET
          token_hash = ${tokenHash},
          expires_at = NULL
        WHERE id = ${stored.id}
          AND revoked_at IS NULL
      `;
    }
  }

  return {
    token: rawToken,
    expires_at: null,
    revoked: false,
  };
}

// =====================================================
// RETURN EXISTING CLAIM
// =====================================================

async function returnExistingClaim(
  sql,
  claim,
  currentBalance
) {
  const participation =
    await ensureParticipationToken(
      sql,
      claim
    );

  if (
    participation.revoked
  ) {
    return {
      success: false,
      revoked: true,
    };
  }

  return {
    success: true,

    existing: true,

    claim:
      publicClaim(claim),

    participation,

    verification: {
      token_mint:
        TOKEN_MINT,

      minimum_road_required:
        MIN_ROAD_REQUIRED,

      verified_balance:
        rawBalanceToNumber(
          currentBalance.raw,
          currentBalance.decimals
        ),
    },
  };
}

// =====================================================
// DISQUALIFY
// =====================================================
//
// Historical record remains.
//
// The Spot becomes available because
// holding_status changes from HOLDING
// to DISQUALIFIED.
// =====================================================

async function markDisqualified(
  sql,
  claim
) {
  const rows =
    await sql`
      UPDATE roadman_claims
      SET
        holding_status = 'DISQUALIFIED',
        status = 'disqualified',
        disqualified_at =
          COALESCE(
            disqualified_at,
            NOW()
          )
      WHERE id = ${claim.id}
        AND holding_status = 'HOLDING'
      RETURNING
        id,
        spot,
        x_handle,
        wallet,
        status,
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

  return rows[0] || null;
}

// =====================================================
// MAIN
// =====================================================

module.exports =
  async function handler(
    req,
    res
  ) {
    // ---------------------------------------------------
    // OPTIONS
    // ---------------------------------------------------

    if (
      req.method ===
      "OPTIONS"
    ) {
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

    if (
      req.method !==
      "POST"
    ) {
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

    if (
      !process.env.DATABASE_URL
    ) {
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

    if (
      !PARTICIPATION_TOKEN_SECRET
    ) {
      console.error(
        "PARTICIPATION_TOKEN_SECRET_NOT_CONFIGURED"
      );

      return json(
        res,
        500,
        {
          success: false,
          error:
            "PARTICIPATION_TOKEN_SECRET_NOT_CONFIGURED",
        }
      );
    }

    const sql =
      neon(
        process.env.DATABASE_URL
      );

    try {
      const body =
        req.body || {};

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
        return json(
          res,
          400,
          {
            success: false,
            error:
              "X_HANDLE_REQUIRED",
          }
        );
      }

      if (
        xHandle.length > 100
      ) {
        return json(
          res,
          400,
          {
            success: false,
            error:
              "X_HANDLE_TOO_LONG",
          }
        );
      }

      if (
        !isValidWallet(
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

      if (
        !isValidNonce(
          nonce
        )
      ) {
        return json(
          res,
          400,
          {
            success: false,
            error:
              "INVALID_NONCE",
          }
        );
      }

      if (
        !isValidSignature(
          signature
        )
      ) {
        return json(
          res,
          400,
          {
            success: false,
            error:
              "INVALID_SIGNATURE",
          }
        );
      }

      // =================================================
      // FIND NONCE
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

      if (
        nonceRows.length === 0
      ) {
        return json(
          res,
          401,
          {
            success: false,
            error:
              "NONCE_NOT_FOUND",
          }
        );
      }

      const challenge =
        nonceRows[0];

      // =================================================
      // NONCE VALIDATION
      // =================================================

      if (
        challenge.used_at
      ) {
        return json(
          res,
          401,
          {
            success: false,
            error:
              "NONCE_ALREADY_USED",
          }
        );
      }

      const expiresAt =
        new Date(
          challenge.expires_at
        );

      if (
        !Number.isFinite(
          expiresAt.getTime()
        )
      ) {
        return json(
          res,
          500,
          {
            success: false,
            error:
              "INVALID_NONCE_EXPIRATION",
          }
        );
      }

      if (
        expiresAt.getTime() <=
        Date.now()
      ) {
        return json(
          res,
          401,
          {
            success: false,
            error:
              "NONCE_EXPIRED",
          }
        );
      }

      // Ensure the nonce belongs to the submitted wallet.
      if (
        String(
          challenge.wallet
        ) !== wallet
      ) {
        return json(
          res,
          401,
          {
            success: false,
            error:
              "NONCE_WALLET_MISMATCH",
          }
        );
      }

      // =================================================
      // VERIFY WALLET SIGNATURE
      // =================================================

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

      if (
        !validSignature
      ) {
        return json(
          res,
          401,
          {
            success: false,
            error:
              "INVALID_WALLET_SIGNATURE",
          }
        );
      }

      // =================================================
      // CONSUME NONCE ATOMICALLY
      // =================================================

      const consumedNonce =
        await sql`
          UPDATE wallet_nonces
          SET used_at = NOW()
          WHERE id = ${challenge.id}
            AND used_at IS NULL
            AND expires_at > NOW()
          RETURNING id
        `;

      if (
        consumedNonce.length === 0
      ) {
        return json(
          res,
          409,
          {
            success: false,
            error:
              "NONCE_ALREADY_CONSUMED",
          }
        );
      }

      // =================================================
      // CHECK CURRENT $ROAD BALANCE
      // =================================================

      let roadBalance;

      try {
        roadBalance =
          await getRoadBalance(
            wallet
          );
      } catch (error) {
        console.error(
          "SOLANA_BALANCE_ERROR"
        );

        return json(
          res,
          502,
          {
            success: false,
            error:
              "SOLANA_BALANCE_CHECK_FAILED",
          }
        );
      }

      const roadBalanceNumber =
        rawBalanceToNumber(
          roadBalance.raw,
          roadBalance.decimals
        );

      // =================================================
      // EXISTING WALLET
      // =================================================
      //
      // Existing identity checks happen before allocation.
      // Active claims can be revalidated.
      // Historical identities remain registered.
      // =================================================

      const existingWallet =
        await sql`
          SELECT
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
          FROM roadman_claims
          WHERE wallet = ${wallet}
          ORDER BY id DESC
          LIMIT 1
        `;

      if (
        existingWallet.length > 0
      ) {
        const existing =
          existingWallet[0];

        // -------------------------------------------------
        // EXISTING ACTIVE PARTICIPANT
        // -------------------------------------------------

        if (
          existing.holding_status ===
          "HOLDING"
        ) {
          if (
            String(
              existing.x_handle
            ).toLowerCase() !==
            String(
              xHandle
            ).toLowerCase()
          ) {
            return json(
              res,
              409,
              {
                success: false,
                error:
                  "WALLET_ALREADY_REGISTERED_WITH_DIFFERENT_X",
              }
            );
          }

          if (
            !hasEnoughRoad(
              roadBalance,
              MIN_ROAD_REQUIRED
            )
          ) {
            const disqualified =
              await markDisqualified(
                sql,
                existing
              );

            return json(
              res,
              403,
              {
                success: false,

                error:
                  "INSUFFICIENT_ROAD",

                required:
                  MIN_ROAD_REQUIRED,

                balance:
                  roadBalanceNumber,

                status:
                  "DISQUALIFIED",

                claim:
                  disqualified
                    ? publicClaim(
                        disqualified
                      )
                    : null,
              }
            );
          }

          const existingResponse =
            await returnExistingClaim(
              sql,
              existing,
              roadBalance
            );

          if (
            existingResponse.revoked
          ) {
            return json(
              res,
              403,
              {
                success: false,
                error:
                  "PARTICIPATION_REVOKED",
              }
            );
          }

          return json(
            res,
            200,
            existingResponse
          );
        }

        // -------------------------------------------------
        // EXISTING BUT NOT ACTIVE
        // -------------------------------------------------

        return json(
          res,
          409,
          {
            success: false,

            error:
              "WALLET_ALREADY_REGISTERED",

            status:
              existing.status,

            holding_status:
              existing.holding_status,

            spot:
              existing.spot,
          }
        );
      }

      // =================================================
      // EXISTING X HANDLE
      // =================================================

      const existingHandle =
        await sql`
          SELECT
            id,
            spot,
            wallet,
            x_handle,
            status,
            holding_status,
            nft_status
          FROM roadman_claims
          WHERE LOWER(x_handle) =
                LOWER(${xHandle})
          ORDER BY id DESC
          LIMIT 1
        `;

      if (
        existingHandle.length > 0
      ) {
        const existing =
          existingHandle[0];

        if (
          existing.holding_status ===
          "HOLDING"
        ) {
          return json(
            res,
            409,
            {
              success: false,
              error:
                "X_HANDLE_ALREADY_CLAIMED",
              spot:
                existing.spot,
            }
          );
        }

        return json(
          res,
          409,
          {
            success: false,
            error:
              "X_HANDLE_ALREADY_REGISTERED",
            spot:
              existing.spot,
            status:
              existing.status,
            holding_status:
              existing.holding_status,
          }
        );
      }

      // =================================================
      // INITIAL $ROAD CHECK
      // =================================================

      if (
        !hasEnoughRoad(
          roadBalance,
          MIN_ROAD_REQUIRED
        )
      ) {
        return json(
          res,
          403,
          {
            success: false,

            error:
              "INSUFFICIENT_ROAD",

            required:
              MIN_ROAD_REQUIRED,

            balance:
              roadBalanceNumber,
          }
        );
      }

      // =================================================
      // PARTICIPATION TOKEN
      // =================================================

      const rawToken =
        createParticipationToken(
          wallet
        );

      const tokenHash =
        hashParticipationToken(
          rawToken
        );

      // =================================================
      // ATOMIC FIRST-100 ALLOCATION
      // =================================================
      //
      // IMPORTANT:
      //
      // The advisory lock protects the complete allocation
      // operation inside one SQL transaction.
      //
      // This prevents two simultaneous requests from
      // allocating the same logical First-100 capacity.
      //
      // Identity checks are repeated inside the locked
      // transaction because requests can arrive concurrently.
      // =================================================

      const transaction =
        await sql.transaction([
          sql`
            SELECT
              pg_advisory_xact_lock(
                ${ROADMAN_ADVISORY_LOCK}
              )
          `,

          sql`
            SELECT
              id
            FROM roadman_claims
            WHERE wallet = ${wallet}
            LIMIT 1
          `,

          sql`
            SELECT
              id
            FROM roadman_claims
            WHERE LOWER(x_handle) =
                  LOWER(${xHandle})
            LIMIT 1
          `,
        ]);

      const walletAlreadyInserted =
        transaction?.[1] || [];

      const handleAlreadyInserted =
        transaction?.[2] || [];

      // =================================================
      // CONCURRENT WALLET CHECK
      // =================================================

      if (
        walletAlreadyInserted.length > 0
      ) {
        return json(
          res,
          409,
          {
            success: false,
            error:
              "WALLET_ALREADY_REGISTERED",
          }
        );
      }

      // =================================================
      // CONCURRENT X HANDLE CHECK
      // =================================================

      if (
        handleAlreadyInserted.length > 0
      ) {
        return json(
          res,
          409,
          {
            success: false,
            error:
              "X_HANDLE_ALREADY_REGISTERED",
          }
        );
      }

      // =================================================
      // FINAL ATOMIC ALLOCATION
      // =================================================
      //
      // We now perform the actual INSERT in its own
      // transaction with the same advisory lock.
      //
      // This is kept separate from the identity transaction
      // above because Neon transaction arrays execute as
      // one transaction per call.
      //
      // The database-level unique constraints recommended
      // below provide the final duplicate protection.
      // =================================================

      const claimRows =
        await sql.transaction([
          sql`
            SELECT
              pg_advisory_xact_lock(
                ${ROADMAN_ADVISORY_LOCK}
              )
          `,

          sql`
            WITH available_spot AS (
              SELECT
                s.spot

              FROM generate_series(
                1,
                ${TOTAL_SPOTS}
              ) AS s(spot)

              WHERE NOT EXISTS (
                SELECT 1
                FROM roadman_claims r
                WHERE
                  r.spot = s.spot
                  AND r.holding_status =
                    'HOLDING'
              )

              ORDER BY RANDOM()

              LIMIT 1
            ),

            inserted_claim AS (
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

              SELECT
                a.spot,
                ${xHandle},
                ${wallet},
                'claimed',
                NOW(),
                ${roadBalanceNumber},
                NULL,
                'HOLDING',
                'PENDING'

              FROM available_spot a

              WHERE NOT EXISTS (
                SELECT 1
                FROM roadman_claims r
                WHERE
                  r.wallet = ${wallet}
              )

              AND NOT EXISTS (
                SELECT 1
                FROM roadman_claims r
                WHERE
                  LOWER(r.x_handle) =
                  LOWER(${xHandle})
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
            ),

            inserted_token AS (
              INSERT INTO participation_tokens (
                claim_id,
                token_hash,
                created_at,
                expires_at,
                revoked_at
              )

              SELECT
                id,
                ${tokenHash},
                NOW(),
                NULL,
                NULL

              FROM inserted_claim

              RETURNING
                claim_id
            )

            SELECT
              c.id,
              c.spot,
              c.x_handle,
              c.wallet,
              c.status,
              c.created_at,
              c.claimed_at,
              c.initial_balance,
              c.holding_status,
              c.qualified_at,
              c.disqualified_at,
              c.nft_number,
              c.nft_status,
              c.delivery_tx,
              c.delivered_at,
              c.nft_assigned_at

            FROM inserted_claim c

            INNER JOIN inserted_token t
              ON t.claim_id = c.id
          `,
        ]);

      const claimRowsFinal =
        claimRows?.[1] || [];

      // =================================================
      // NO AVAILABLE SPOT
      // =================================================

      if (
        claimRowsFinal.length === 0
      ) {
        return json(
          res,
          409,
          {
            success: false,
            error:
              "ALL_SPOTS_FILLED",
          }
        );
      }

      const claim =
        claimRowsFinal[0];

      // =================================================
      // SUCCESS
      // =================================================

      return json(
        res,
        200,
        {
          success: true,

          existing: false,

          claim:
            publicClaim(claim),

          participation: {
            token:
              rawToken,

            expires_at:
              null,
          },

          verification: {
            token_mint:
              TOKEN_MINT,

            minimum_road_required:
              MIN_ROAD_REQUIRED,

            verified_balance:
              roadBalanceNumber,
          },

          mode:
            TEST_MODE
              ? "TEST"
              : "PRODUCTION",
        }
      );
    } catch (error) {
      console.error(
        "CLAIM_API_ERROR",
        error?.message || "UNKNOWN_ERROR"
      );

      return json(
        res,
        500,
        {
          success: false,
          error:
            "INTERNAL_SERVER_ERROR",
        }
      );
    }
  };
