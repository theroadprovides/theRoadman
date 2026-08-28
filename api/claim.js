const { neon } = require("@neondatabase/serverless");

const TOTAL_SPOTS = 100;

// =====================================================
// CONFIG
// =====================================================

// TEST MODE
// TRUE = permite testar sem possuir $ROAD
// FALSE = usa a verificação real
const TEST_MODE = true;

const TEST_KEY =
  "ROADMAN_TEST_2026";

const TOKEN_MINT =
  "BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";


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
// HANDLE
// =====================================================

function normalizeHandle(value) {

  let handle =
    String(value || "")
      .trim();

  if (!handle) {
    return "";
  }

  if (!handle.startsWith("@")) {
    handle =
      "@" + handle;
  }

  return handle;

}


// =====================================================
// WALLET
// =====================================================

function validWallet(wallet) {

  return (
    typeof wallet === "string" &&
    wallet.length >= 32 &&
    wallet.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet)
  );

}


// =====================================================
// SOLANA BALANCE
// =====================================================

async function getRoadBalance(wallet) {

  const rpc =
    "https://api.mainnet-beta.solana.com";

  const response =
    await fetch(
      rpc,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            jsonrpc:
              "2.0",

            id:
              1,

            method:
              "getTokenAccountsByOwner",

            params: [

              wallet,

              {
                mint:
                  TOKEN_MINT
              },

              {
                encoding:
                  "jsonParsed"
              }

            ]

          })
      }
    );


  if (!response.ok) {

    throw new Error(
      "Solana RPC unavailable."
    );

  }


  const data =
    await response.json();


  if (data.error) {

    throw new Error(
      "Solana RPC error."
    );

  }


  let balance = 0;


  for (
    const account
    of data.result?.value || []
  ) {

    const amount =
      account
        ?.account
        ?.data
        ?.parsed
        ?.info
        ?.tokenAmount;


    if (!amount) {
      continue;
    }


    balance +=
      Number(
        amount.uiAmount || 0
      );

  }


  return balance;

}


// =====================================================
// ROAD PRICE
// =====================================================

async function getRoadPrice() {

  try {

    const response =
      await fetch(
        "https://api.dexscreener.com/latest/dex/tokens/" +
        TOKEN_MINT,
        {
          cache:
            "no-store"
        }
      );


    if (!response.ok) {
      return 0;
    }


    const data =
      await response.json();


    return Number(
      data
        ?.pairs
        ?.find(
          pair =>
            pair?.priceUsd
        )
        ?.priceUsd || 0
    );


  } catch {

    return 0;

  }

}


// =====================================================
// RANDOM AVAILABLE SPOT
// =====================================================

async function getRandomAvailableSpot(sql) {

  const available =
    await sql`
      SELECT
        spot

      FROM generate_series(
        1,
        ${TOTAL_SPOTS}
      ) AS s(spot)

      WHERE NOT EXISTS (

        SELECT 1

        FROM roadman_claims r

        WHERE
          r.spot = s.spot

      )

      ORDER BY
        RANDOM()

      LIMIT 1
    `;


  if (
    !available.length
  ) {

    return null;

  }


  return Number(
    available[0].spot
  );

}


// =====================================================
// MAIN
// =====================================================

export default async function handler(req, res) {

  // ===================================================
  // OPTIONS
  // ===================================================

  if (
    req.method ===
    "OPTIONS"
  ) {

    res.status(204);

    return res.end();

  }


  // ===================================================
  // POST ONLY
  // ===================================================

  if (
    req.method !==
    "POST"
  ) {

    return json(
      res,
      405,
      {

        success:
          false,

        error:
          "Method not allowed."

      }
    );

  }


  // ===================================================
  // DATABASE
  // ===================================================

  if (
    !process.env.DATABASE_URL
  ) {

    return json(
      res,
      500,
      {

        success:
          false,

        error:
          "DATABASE_URL is not configured."

      }
    );

  }


  // ===================================================
  // BODY
  // ===================================================

  const data =
    req.body || {};


  // ===================================================
  // INPUT
  // ===================================================

  const xHandle =
    normalizeHandle(
      data.x_handle
    );


  const wallet =
    String(
      data.wallet || ""
    ).trim();


  const testMode =
    TEST_MODE === true &&
    data.test_key ===
      TEST_KEY;


  // ===================================================
  // HANDLE VALIDATION
  // ===================================================

  if (!xHandle) {

    return json(
      res,
      400,
      {

        success:
          false,

        error:
          "X handle is required."

      }
    );

  }


  if (
    xHandle.length >
    50
  ) {

    return json(
      res,
      400,
      {

        success:
          false,

        error:
          "Invalid X handle."

      }
    );

  }


  // ===================================================
  // WALLET VALIDATION
  // ===================================================

  if (
    !validWallet(wallet)
  ) {

    return json(
      res,
      400,
      {

        success:
          false,

        error:
          "Invalid Solana wallet."

      }
    );

  }


  // ===================================================
  // DATABASE OPERATION
  // ===================================================

  try {

    const sql =
      neon(
        process.env.DATABASE_URL
      );


    // ===============================================
    // DUPLICATE HANDLE
    // ===============================================

    const existingHandle =
      await sql`
        SELECT

          id,
          spot,
          x_handle,
          wallet,
          status,
          holding_status,
          nft_status

        FROM roadman_claims

        WHERE
          LOWER(x_handle)
          =
          LOWER(${xHandle})

        LIMIT 1
      `;


    if (
      existingHandle.length
    ) {

      return json(
        res,
        409,
        {

          success:
            false,

          error:
            "This X handle already has a Roadman claim.",

          claim:
            existingHandle[0]

        }
      );

    }


    // ===============================================
    // DUPLICATE WALLET
    // ===============================================

    const existingWallet =
      await sql`
        SELECT

          id,
          spot,
          x_handle,
          wallet,
          status,
          holding_status,
          nft_status

        FROM roadman_claims

        WHERE
          wallet =
          ${wallet}

        LIMIT 1
      `;


    if (
      existingWallet.length
    ) {

      return json(
        res,
        409,
        {

          success:
            false,

          error:
            "This wallet already has a Roadman claim.",

          claim:
            existingWallet[0]

        }
      );

    }


    // ===============================================
    // BALANCE VARIABLES
    // ===============================================

    let balance = 0;

    let price = 0;

    let usdValue = 0;


    // ===============================================
    // TEST MODE
    // ===============================================

    if (
      testMode
    ) {

      balance =
        1000000;

      price =
        0.00001;

      usdValue =
        10;

    }


    // ===============================================
    // REAL MODE
    // ===============================================

    else {

      balance =
        await getRoadBalance(
          wallet
        );


      if (
        !Number.isFinite(
          balance
        ) ||
        balance <= 0
      ) {

        return json(
          res,
          403,
          {

            success:
              false,

            error:
              "This wallet does not currently hold $ROAD."

          }
        );

      }


      price =
        await getRoadPrice();


      if (
        !Number.isFinite(
          price
        ) ||
        price <= 0
      ) {

        return json(
          res,
          503,
          {

            success:
              false,

            error:
              "Unable to determine $ROAD price."

          }
        );

      }


      usdValue =
        balance *
        price;


      if (
        usdValue < 10
      ) {

        return json(
          res,
          403,
          {

            success:
              false,

            error:
              `This wallet currently holds approximately US$${usdValue.toFixed(2)} in $ROAD. Minimum required is US$10.00.`,

            balance:
              balance,

            usd_value:
              usdValue

          }
        );

      }

    }


    // ===============================================
    // RANDOM SPOT
    // ===============================================

    const spot =
      await getRandomAvailableSpot(
        sql
      );


    // ===============================================
    // NO SPOTS
    // ===============================================

    if (
      spot === null
    ) {

      return json(
        res,
        409,
        {

          success:
            false,

          error:
            "All 100 Roadman spots have already been claimed."

        }
      );

    }


    // ===============================================
    // INSERT
    // ===============================================

    const inserted =
      await sql`
        INSERT INTO roadman_claims
        (

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

        VALUES
        (

          ${spot},

          ${xHandle},

          ${wallet},

          'claimed',

          NOW(),

          NOW(),

          ${balance},

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


    // ===============================================
    // SAFETY
    // ===============================================

    if (
      !inserted.length
    ) {

      return json(
        res,
        500,
        {

          success:
            false,

          error:
            "Unable to create Roadman claim."

        }
      );

    }


    // ===============================================
    // SUCCESS
    // ===============================================

    const claim =
      inserted[0];


    return json(
      res,
      200,
      {

        success:
          true,

        test_mode:
          testMode,

        message:
          testMode
            ? "TEST MODE claim created successfully."
            : "Roadman claim created successfully.",

        claim: {

          id:
            Number(
              claim.id
            ),

          spot:
            Number(
              claim.spot
            ),

          x_handle:
            claim.x_handle,

          wallet:
            claim.wallet,

          status:
            claim.status,

          initial_balance:
            Number(
              claim.initial_balance
            ),

          initial_usd_value:
            Number(
              claim.initial_usd_value
            ),

          holding_status:
            claim.holding_status,

          nft_status:
            claim.nft_status,

          created_at:
            claim.created_at,

          claimed_at:
            claim.claimed_at

        }

      }
    );


  } catch (error) {

    console.error(
      "ROADMAN CLAIM ERROR:",
      error
    );


    // =============================================
    // UNIQUE CONSTRAINT
    // =============================================

    if (
      error?.code ===
      "23505"
    ) {

      return json(
        res,
        409,
        {

          success:
            false,

          error:
            "This wallet, handle or spot is already registered."

        }
      );

    }


    // =============================================
    // DATABASE ERROR
    // =============================================

    return json(
      res,
      500,
      {

        success:
          false,

        error:
          "Unable to create Roadman claim."

      }
    );

  }

}
