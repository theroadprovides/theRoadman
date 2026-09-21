const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const TOTAL_SPOTS = 100;

// =====================================================
// CONFIG
// =====================================================

// TESTE:
// 30 = mínimo atual para testar sem precisar comprar/mover
//
// PRODUÇÃO:
// 3_000_000 = mínimo definitivo
const MIN_ROAD_REQUIRED = 30;

const TOKEN_MINT =
"BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";

const SOLANA_RPC =
"https://api.mainnet-beta.solana.com";

// =====================================================
// PARTICIPATION TOKEN
// =====================================================
//
// O token é persistente.
//
// Não usamos TTL de 24h.
//
// O token NÃO é armazenado em texto puro.
//
// O servidor consegue reproduzir o mesmo token
// usando a mesma wallet + o mesmo segredo.
//
// Portanto:
//
// wallet A -> token A
// wallet A -> token A
//
// O token é usado apenas como credencial de acesso
// à participação correspondente àquela wallet.
//
// =====================================================

const PARTICIPATION_TOKEN_SECRET =
process.env.PARTICIPATION_TOKEN_SECRET;

// =====================================================
// HELPERS
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

res.setHeader(
"Pragma",
"no-cache"
);

res.setHeader(
"Expires",
"0"
);

res.setHeader(
"X-Content-Type-Options",
"nosniff"
);

res.setHeader(
"Referrer-Policy",
"no-referrer"
);

res.setHeader(
"Access-Control-Allow-Origin",
"*"
);

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

// =====================================================
// PARTICIPATION TOKEN
// =====================================================
//
// O token é determinístico:
//
// HMAC-SHA256(
//   PARTICIPATION_TOKEN_SECRET,
//   THE_ROAD_PROVIDES:PARTICIPATION:wallet
// )
//
// O banco guarda somente SHA-256 desse token.
//
// Nunca armazenamos o token bruto no banco.
//
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
.update(
token,
"utf8"
)
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
"Invalid base58 value"
);
}

let bytes = [0];

for (const char of value) {
const index =
BASE58_ALPHABET.indexOf(char);

```
if (index === -1) {
  throw new Error(
    "Invalid base58 character"
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
```

}

// Leading zero bytes represented by "1"
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
// WALLET SIGNATURE
// =====================================================

function walletPublicKeyFromRaw(
walletBytes
) {
if (
!Buffer.isBuffer(walletBytes)
) {
throw new Error(
"Invalid wallet bytes"
);
}

if (
walletBytes.length !== 32
) {
throw new Error(
"Invalid Solana public key length"
);
}

// Ed25519 SubjectPublicKeyInfo prefix
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

function verifyWalletSignature(
wallet,
message,
signature
) {
try {
const walletBytes =
base58Decode(wallet);

```
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
```

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

async function solanaRpc(
method,
params
) {
const response =
await fetch(
SOLANA_RPC,
{
method: "POST",

```
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
```

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
"Solana RPC error"
);
}

return data.result;
}

// =====================================================
// $ROAD BALANCE
// =====================================================

async function getRoadBalance(
wallet
) {
const result =
await solanaRpc(
"getTokenAccountsByOwner",
[
wallet,

```
    {
      mint: TOKEN_MINT,
    },

    {
      encoding: "jsonParsed",
      commitment: "finalized",
    },
  ]
);
```

let total = 0;

for (
const account of
result.value || []
) {
const amount =
account
?.account
?.data
?.parsed
?.info
?.tokenAmount
?.uiAmountString;

```
if (
  amount !== undefined &&
  amount !== null
) {
  total += Number(amount);
}
```

}

if (
!Number.isFinite(total)
) {
throw new Error(
"Invalid $ROAD balance returned by Solana"
);
}

return total;
}

// =====================================================
// PUBLIC CLAIM OBJECT
// =====================================================

function publicClaim(
claim
) {
return {
id:
claim.id,

```
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
```

};
}

// =====================================================
// ENSURE PARTICIPATION TOKEN
// =====================================================
//
// Garante que a participação existente possui o token
// persistente correspondente.
//
// expires_at permanece NULL.
// revoked_at permanece NULL enquanto válido.
//
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
await sql`       SELECT
        id,
        token_hash,
        created_at,
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
await sql`       INSERT INTO participation_tokens (
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

```
// Migração de eventual token antigo/random.
//
// Depois que todos os registros estiverem migrados,
// esse caminho normalmente não será utilizado.
if (
  stored.token_hash !==
  tokenHash
) {
  await sql`
    UPDATE participation_tokens
    SET
      token_hash = ${tokenHash},
      expires_at = NULL,
      revoked_at = NULL
    WHERE id = ${stored.id}
  `;
} else if (
  stored.expires_at !== null ||
  stored.revoked_at !== null
) {
  await sql`
    UPDATE participation_tokens
    SET
      expires_at = NULL,
      revoked_at = NULL
    WHERE id = ${stored.id}
  `;
}
```

}

return {
token:
rawToken,

```
expires_at:
  null,
```

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

return {
success: true,

```
existing: true,

claim:
  publicClaim(
    claim
  ),

participation,

verification: {
  token_mint:
    TOKEN_MINT,

  minimum_road_required:
    MIN_ROAD_REQUIRED,

  verified_balance:
    currentBalance,
},
```

};
}

// =====================================================
// MARK EXISTING PARTICIPANT AS DISQUALIFIED
// =====================================================
//
// O histórico NÃO é apagado.
//
// O Spot deixa de estar ocupado porque HOLDING deixa
// de ser verdadeiro.
//
// O token de participação continua existindo para que
// o participante possa consultar seu histórico/estado.
//
// =====================================================

async function markDisqualified(
sql,
claim
) {
const rows =
await sql`       UPDATE roadman_claims
      SET
        holding_status = 'DISQUALIFIED',
        disqualified_at =
          COALESCE(
            disqualified_at,
            NOW()
          )
      WHERE id = ${claim.id}
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
// -------------------------------------------------
// OPTIONS
// -------------------------------------------------

```
if (
  req.method ===
  "OPTIONS"
) {
  return json(
    res,
    200,
    {
      success: true,
    }
  );
}

// -------------------------------------------------
// METHOD
// -------------------------------------------------

if (
  req.method !==
  "POST"
) {
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

// -------------------------------------------------
// DATABASE
// -------------------------------------------------

if (
  !process.env
    .DATABASE_URL
) {
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

// -------------------------------------------------
// PARTICIPATION SECRET
// -------------------------------------------------

if (
  !PARTICIPATION_TOKEN_SECRET
) {
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
    xHandle.length >
    100
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

  if (!signature) {
    return json(
      res,
      400,
      {
        success: false,
        error:
          "SIGNATURE_REQUIRED",
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
    nonceRows.length ===
    0
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

  // =================================================
  // VERIFY SIGNATURE
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
    consumedNonce.length ===
    0
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
  // CHECK CURRENT ROAD BALANCE
  // =================================================
  //
  // We check this before deciding whether an existing
  // wallet remains active.
  //
  // This is what allows the backend to recognize that
  // a participant no longer satisfies the current
  // holding requirement.
  // =================================================

  let roadBalance;

  try {
    roadBalance =
      await getRoadBalance(
        wallet
      );
  } catch (error) {
    console.error(
      "SOLANA_BALANCE_ERROR",
      error
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

  // =================================================
  // EXISTING WALLET
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
    existingWallet.length >
    0
  ) {
    const existing =
      existingWallet[0];

    // ---------------------------------------------
    // EXISTING ACTIVE PARTICIPANT
    // ---------------------------------------------

    if (
      existing.holding_status ===
      "HOLDING"
    ) {
      // Wallet must remain associated with the same X.
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

      // Current balance no longer satisfies the rule.
      if (
        roadBalance <
        MIN_ROAD_REQUIRED
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
              roadBalance,

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

      return json(
        res,
        200,
        await returnExistingClaim(
          sql,
          existing,
          roadBalance
        )
      );
    }

    // ---------------------------------------------
    // EXISTING BUT NOT ACTIVE
    // ---------------------------------------------
    //
    // History remains preserved.
    //
    // We do not create another identity with the
    // same wallet.
    // ---------------------------------------------

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
    existingHandle.length >
    0
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
    roadBalance <
    MIN_ROAD_REQUIRED
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
          roadBalance,
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
  // ATOMIC CLAIM + PARTICIPATION TOKEN
  // =================================================
  //
  // IMPORTANT:
  //
  // The advisory transaction lock serializes the
  // allocation of First 100 Spots.
  //
  // This prevents two simultaneous claim requests
  // from selecting the same currently available Spot.
  //
  // The claim and its participation token are created
  // by the same SQL statement.
  //
  // If any part fails, PostgreSQL rolls the statement
  // back.
  //
  // =================================================

  const claimRows =
    await sql`
      WITH
      roadman_lock AS (
        SELECT
          pg_advisory_xact_lock(
            784321001
          ) AS locked
      ),

      available_spot AS (
        SELECT
          s.spot

        FROM generate_series(
          1,
          ${TOTAL_SPOTS}
        ) AS s(spot)

        CROSS JOIN roadman_lock

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
          ${roadBalance},
          NULL,
          'HOLDING',
          'PENDING'

        FROM available_spot a

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
    `;

  // =================================================
  // NO SPOT
  // =================================================

  if (
    claimRows.length ===
    0
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
    claimRows[0];

  // =================================================
  // RESPONSE
  // =================================================

  return json(
    res,
    200,
    {
      success: true,

      existing: false,

      claim:
        publicClaim(
          claim
        ),

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
          roadBalance,
      },
    }
  );

} catch (error) {
  console.error(
    "CLAIM_API_ERROR",
    error
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
```

};
