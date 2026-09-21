const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

// ============================================================
// THE ROAD PROVIDES
// PARTICIPATION API
//
// File:
// /api/participation.js
//
// PURPOSE
// ------------------------------------------------------------
// Authenticates the participant after a successful claim.
//
// REAL DATABASE ARCHITECTURE
// ------------------------------------------------------------
//
// participation_tokens
//   ├── claim_id
//   ├── token_hash
//   ├── created_at
//   ├── expires_at
//   └── revoked_at
//
//        ↓
//
// roadman_claims
//   ├── id
//   ├── spot
//   ├── x_handle
//   ├── wallet
//   ├── status
//   ├── claimed_at
//   ├── initial_balance
//   ├── holding_status
//   ├── qualified_at
//   ├── disqualified_at
//   ├── nft_number
//   ├── nft_status
//   ├── delivery_tx
//   ├── delivered_at
//   └── nft_assigned_at
//
// ------------------------------------------------------------
// CLIENT REQUEST
//
// GET /api/participation
//
// Header:
//
// Authorization: Bearer <raw participation token>
//
// ------------------------------------------------------------
// IMPORTANT
//
// The client does NOT send:
//
//   spot
//   wallet
//   x_handle
//   claim_id
//
// The token identifies the participation record.
//
// ============================================================

const TOTAL_SPOTS = 100;

// ============================================================
// SECURITY HEADERS
// ============================================================

function securityHeaders() {
return {
"Content-Type":
"application/json; charset=utf-8",

```
"Cache-Control":
  "no-store, no-cache, must-revalidate, proxy-revalidate",

Pragma:
  "no-cache",

Expires:
  "0",

"X-Content-Type-Options":
  "nosniff",

"X-Frame-Options":
  "DENY",

"Referrer-Policy":
  "no-referrer",

"Permissions-Policy":
  "camera=(), microphone=(), geolocation=(), payment=()",

"Content-Security-Policy":
  "default-src 'none'; frame-ancestors 'none';"
```

};
}

// ============================================================
// RESPONSE
// ============================================================

function json(
res,
statusCode,
payload
) {
const headers =
securityHeaders();

for (
const [key, value] of
Object.entries(headers)
) {
res.setHeader(
key,
value
);
}

return res
.status(statusCode)
.json(payload);
}

// ============================================================
// TOKEN EXTRACTION
// ============================================================

function getBearerToken(req) {
const authorization =
req.headers?.authorization ||
req.headers?.Authorization ||
"";

if (
typeof authorization !==
"string"
) {
return null;
}

const match =
authorization.match(
/^Bearer\s+(.+)$/i
);

if (!match) {
return null;
}

const token =
match[1].trim();

if (!token) {
return null;
}

return token;
}

// ============================================================
// TOKEN FORMAT
// ============================================================
//
// claim.js generates a SHA-256 HMAC:
//
// 64 hexadecimal characters.
//
// ============================================================

function isValidTokenFormat(
token
) {
return (
typeof token ===
"string" &&
/^[a-f0-9]{64}$/i.test(
token
)
);
}

// ============================================================
// TOKEN HASH
// ============================================================
//
// claim.js stores:
//
// SHA256(rawToken)
//
// ============================================================

function hashToken(
token
) {
return crypto
.createHash(
"sha256"
)
.update(
token,
"utf8"
)
.digest("hex");
}

// ============================================================
// NORMALIZATION
// ============================================================

function normalizeString(
value
) {
if (
value === null ||
value === undefined
) {
return "";
}

return String(
value
).trim();
}

function normalizeUpper(
value
) {
return normalizeString(
value
).toUpperCase();
}

// ============================================================
// PARTICIPANT STATUS
// ============================================================
//
// This is descriptive.
//
// The backend is authoritative.
//
// The frontend must not invent eligibility.
//
// ============================================================

function getParticipantStatus(
claim
) {
const claimStatus =
normalizeUpper(
claim.status
);

const holdingStatus =
normalizeUpper(
claim.holding_status
);

const nftStatus =
normalizeUpper(
claim.nft_status
);

// ----------------------------------------------------------
// Explicitly revoked / cancelled
// ----------------------------------------------------------

if (
claimStatus ===
"REVOKED" ||
claimStatus ===
"CANCELLED"
) {
return "STATUS CHANGED";
}

// ----------------------------------------------------------
// No longer holding the required token
// ----------------------------------------------------------

if (
holdingStatus ===
"NOT_HOLDING" ||
holdingStatus ===
"NOT HOLDING" ||
holdingStatus ===
"DISQUALIFIED" ||
holdingStatus ===
"INELIGIBLE" ||
holdingStatus ===
"FAILED"
) {
return "ELIGIBILITY CHANGED";
}

// ----------------------------------------------------------
// NFT delivered
// ----------------------------------------------------------

if (
nftStatus ===
"DELIVERED"
) {
return "ROADMAN DELIVERED";
}

// ----------------------------------------------------------
// NFT minted / assigned
// ----------------------------------------------------------

if (
nftStatus ===
"MINTED" ||
nftStatus ===
"ASSIGNED"
) {
return "ROADMAN READY";
}

// ----------------------------------------------------------
// Normal active participation
// ----------------------------------------------------------

if (
holdingStatus ===
"HOLDING"
) {
return "ON THE ROAD";
}

return "ON THE ROAD";
}

// ============================================================
// FIND PARTICIPATION
// ============================================================
//
// IMPORTANT:
//
// expires_at is intentionally NOT used as an expiration
// condition.
//
// The current architecture uses persistent participation.
//
// The token becomes invalid only when:
//
//   - token_hash does not exist
//   - revoked_at IS NOT NULL
//
// expires_at remains available as metadata for future use,
// but NULL means no expiration.
//
// ============================================================

async function findParticipation(
sql,
tokenHash
) {
const rows =
await sql`
SELECT

```
    p.claim_id,

    p.created_at AS
      participation_created_at,

    p.expires_at AS
      participation_expires_at,

    p.revoked_at,

    c.id,

    c.spot,

    c.x_handle,

    c.wallet,

    c.status,

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

  FROM participation_tokens p

  INNER JOIN roadman_claims c
    ON c.id = p.claim_id

  WHERE
    p.token_hash = ${tokenHash}

    AND p.revoked_at IS NULL

    AND (
      p.expires_at IS NULL
      OR p.expires_at > NOW()
    )

  LIMIT 1
`;
```

return (
rows[0] ||
null
);
}

// ============================================================
// ACTIVE SPOTS
// ============================================================
//
// Only HOLDING records occupy current First 100 spots.
//
// Historical DISQUALIFIED records remain in the database
// but do not occupy a current spot.
//
// ============================================================

async function getActiveSpotCount(
sql
) {
const rows =
await sql`
SELECT
COUNT(*)::int AS count

```
  FROM roadman_claims

  WHERE
    holding_status =
      'HOLDING'
`;
```

return Number(
rows[0]?.count ||
0
);
}

// ============================================================
// TOTAL HISTORICAL CLAIMS
// ============================================================

async function getHistoricalClaimCount(
sql
) {
const rows =
await sql`
SELECT
COUNT(*)::int AS count

```
  FROM roadman_claims
`;
```

return Number(
rows[0]?.count ||
0
);
}

// ============================================================
// BUILD PUBLIC PARTICIPANT
// ============================================================
//
// Never return:
//
//   token
//   token_hash
//   participation ID
//   nonce
//   signature
//   database credentials
//
// ============================================================

async function buildParticipant(
sql,
claim
) {
const activeSpotCount =
await getActiveSpotCount(
sql
);

const historicalClaimCount =
await getHistoricalClaimCount(
sql
);

const holdingStatus =
normalizeUpper(
claim.holding_status
);

const nftStatus =
normalizeUpper(
claim.nft_status
);

return {
// --------------------------------------------------------
// FIRST 100 POSITION
// --------------------------------------------------------

```
spot:
  claim.spot !==
    null &&
  claim.spot !==
    undefined
    ? Number(
        claim.spot
      )
    : null,

total_spots:
  TOTAL_SPOTS,

// --------------------------------------------------------
// IDENTITY
// --------------------------------------------------------

x_handle:
  normalizeString(
    claim.x_handle
  ),

wallet:
  normalizeString(
    claim.wallet
  ),

// --------------------------------------------------------
// CURRENT STATE
// --------------------------------------------------------

status:
  getParticipantStatus(
    claim
  ),

holding_status:
  holdingStatus,

nft_status:
  nftStatus,

// --------------------------------------------------------
// CLAIM HISTORY
// --------------------------------------------------------

claimed_at:
  claim.claimed_at ||
  claim.participation_created_at ||
  null,

qualified_at:
  claim.qualified_at ||
  null,

disqualified_at:
  claim.disqualified_at ||
  null,

// --------------------------------------------------------
// NFT
// --------------------------------------------------------

nft_number:
  claim.nft_number !==
    null &&
  claim.nft_number !==
    undefined
    ? Number(
        claim.nft_number
      )
    : null,

delivery_tx:
  normalizeString(
    claim.delivery_tx
  ) ||
  null,

delivered_at:
  claim.delivered_at ||
  null,

nft_assigned_at:
  claim.nft_assigned_at ||
  null,

// --------------------------------------------------------
// FIRST 100 COUNTERS
// --------------------------------------------------------

active_spot_count:
  activeSpotCount,

historical_claim_count:
  historicalClaimCount,

// --------------------------------------------------------
// PROJECT PHASE
// --------------------------------------------------------

phase:
  "FIRST 100"
```

};
}

// ============================================================
// METHOD
// ============================================================

function methodAllowed(
method
) {
return (
method === "GET" ||
method === "OPTIONS"
);
}

// ============================================================
// HANDLER
// ============================================================

module.exports =
async function handler(
req,
res
) {
// ========================================================
// OPTIONS
// ========================================================

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

// ========================================================
// METHOD
// ========================================================

if (
  !methodAllowed(
    req.method
  )
) {
  return json(
    res,
    405,
    {
      success: false,

      error:
        "METHOD_NOT_ALLOWED"
    }
  );
}

// ========================================================
// DATABASE CONFIG
// ========================================================

if (
  !process.env
    .DATABASE_URL
) {
  console.error(
    "PARTICIPATION_DATABASE_URL_MISSING"
  );

  return json(
    res,
    500,
    {
      success: false,

      error:
        "SERVER_CONFIGURATION_ERROR"
    }
  );
}

const sql =
  neon(
    process.env
      .DATABASE_URL
  );

// ========================================================
// TOKEN
// ========================================================

const token =
  getBearerToken(req);

if (!token) {
  return json(
    res,
    401,
    {
      success: false,

      error:
        "PARTICIPATION_REQUIRED",

      message:
        "A valid participation session is required."
    }
  );
}

// ========================================================
// TOKEN FORMAT
// ========================================================

if (
  !isValidTokenFormat(
    token
  )
) {
  return json(
    res,
    401,
    {
      success: false,

      error:
        "INVALID_PARTICIPATION_TOKEN",

      message:
        "Invalid participation session."
    }
  );
}

// ========================================================
// HASH
// ========================================================

const tokenHash =
  hashToken(
    token
  );

// ========================================================
// DATABASE
// ========================================================

try {
  const participation =
    await findParticipation(
      sql,
      tokenHash
    );

  // ------------------------------------------------------
  // NOT FOUND / REVOKED / EXPIRED
  // ------------------------------------------------------

  if (
    !participation
  ) {
    return json(
      res,
      401,
      {
        success: false,

        error:
          "PARTICIPATION_SESSION_INVALID",

        message:
          "This participation session is invalid, expired, or revoked."
      }
    );
  }

  // ------------------------------------------------------
  // BUILD PARTICIPANT
  // ------------------------------------------------------

  const participant =
    await buildParticipant(
      sql,
      participation
    );

  // ------------------------------------------------------
  // RESPONSE
  // ------------------------------------------------------

  return json(
    res,
    200,
    {
      success: true,

      participant
    }
  );

} catch (error) {
  console.error(
    "PARTICIPATION_API_ERROR",
    error
  );

  return json(
    res,
    500,
    {
      success: false,

      error:
        "INTERNAL_SERVER_ERROR",

      message:
        "Unable to load participation data."
    }
  );
}
```

};
