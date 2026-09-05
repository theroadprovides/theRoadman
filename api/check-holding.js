const { neon } = require("@neondatabase/serverless");

// =====================================================
// CONFIG
// =====================================================

const TOKEN_MINT =
  "BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";

// =====================================================
// HOLDING TEST LIMIT
// =====================================================
//
// DURANTE O TESTE:
// US$1
//
// ANTES DO LANÇAMENTO:
// alterar para 10
//
const MIN_USD_REQUIRED = 1;


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
    "GET, POST, OPTIONS"
  );

  return res.json(data);

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
                  "jsonParsed",

                commitment:
                  "finalized"
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


    const uiAmount =
      Number(
        amount.uiAmount || 0
      );


    if (
      Number.isFinite(
        uiAmount
      )
    ) {

      balance +=
        uiAmount;

    }

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


    const pairs =
      Array.isArray(
        data?.pairs
      )
        ? data.pairs
        : [];


    const validPairs =
      pairs
        .filter(
          pair =>
            pair?.chainId === "solana" &&
            pair?.baseToken?.address === TOKEN_MINT &&
            Number.isFinite(
              Number(pair?.priceUsd)
            ) &&
            Number(pair?.priceUsd) > 0
        )
        .sort(
          (a, b) =>
            Number(
              b?.liquidity?.usd || 0
            ) -
            Number(
              a?.liquidity?.usd || 0
            )
        );


    if (
      !validPairs.length
    ) {

      return 0;

    }


    return Number(
      validPairs[0].priceUsd
    );

  } catch {

    return 0;

  }

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
  // GET / POST ONLY
  // ===================================================

  if (
    req.method !== "GET" &&
    req.method !== "POST"
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


  try {

    const sql =
      neon(
        process.env.DATABASE_URL
      );


    // ===============================================
    // FIND ALL HOLDERS IN HOLDING
    // ===============================================

    const holders =
      await sql`
        SELECT

          id,
          spot,
          x_handle,
          wallet,
          initial_balance,
          initial_usd_value,
          holding_status,
          nft_status

        FROM roadman_claims

        WHERE
          holding_status = 'HOLDING'

        ORDER BY
          spot ASC
      `;


    // ===============================================
    // NO HOLDERS
    // ===============================================

    if (
      !holders.length
    ) {

      return json(
        res,
        200,
        {

          success:
            true,

          message:
            "No holders currently in HOLDING.",

          checked:
            0,

          disqualified:
            0,

          holding:
            0

        }
      );

    }


    // ===============================================
    // CURRENT ROAD PRICE
    // ===============================================

    const price =
      await getRoadPrice();


    if (
      !Number.isFinite(price) ||
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


    // ===============================================
    // RESULTS
    // ===============================================

    let checked = 0;

    let holding = 0;

    let disqualified = 0;

    const results = [];


    // ===============================================
    // CHECK EACH HOLDER
    // ===============================================

    for (
      const holder
      of holders
    ) {

      checked++;


      let balance = 0;

      let usdValue = 0;


      try {

        balance =
          await getRoadBalance(
            holder.wallet
          );


        usdValue =
          balance *
          price;


      } catch (error) {

        console.error(
          "HOLDING BALANCE ERROR:",
          holder.wallet,
          error
        );


        results.push({

          id:
            Number(
              holder.id
            ),

          spot:
            Number(
              holder.spot
            ),

          wallet:
            holder.wallet,

          status:
            "ERROR",

          error:
            "Unable to verify wallet balance."

        });


        continue;

      }


      // =============================================
      // STILL HOLDING
      // =============================================

      if (
        usdValue >=
        MIN_USD_REQUIRED
      ) {

        holding++;


        const updated =
          await sql`
            UPDATE roadman_claims

            SET

              final_balance =
                ${balance},

              final_usd_value =
                ${usdValue},

              holding_status =
                'HOLDING'

            WHERE
              id =
              ${holder.id}

            RETURNING

              id,
              spot,
              x_handle,
              wallet,
              holding_status,
              final_balance,
              final_usd_value
          `;


        results.push({

          id:
            Number(
              updated[0].id
            ),

          spot:
            Number(
              updated[0].spot
            ),

          x_handle:
            updated[0].x_handle,

          wallet:
            updated[0].wallet,

          status:
            "HOLDING",

          balance:
            balance,

          usd_value:
            usdValue

        });


        continue;

      }


      // =============================================
      // DISQUALIFIED
      // =============================================

      disqualified++;


      const updated =
        await sql`
          UPDATE roadman_claims

          SET

            final_balance =
              ${balance},

            final_usd_value =
              ${usdValue},

            holding_status =
              'DISQUALIFIED',

            disqualified_at =
              NOW()

          WHERE
            id =
            ${holder.id}

          RETURNING

            id,
            spot,
            x_handle,
            wallet,
            holding_status,
            final_balance,
            final_usd_value,
            disqualified_at
        `;


      results.push({

        id:
          Number(
            updated[0].id
          ),

        spot:
          Number(
            updated[0].spot
          ),

        x_handle:
          updated[0].x_handle,

        wallet:
          updated[0].wallet,

        status:
          "DISQUALIFIED",

        balance:
          balance,

        usd_value:
          usdValue

      });

    }


    // ===============================================
    // SUCCESS
    // ===============================================

    return json(
      res,
      200,
      {

        success:
          true,

        minimum_required:
          MIN_USD_REQUIRED,

        road_price:
          price,

        checked:
          checked,

        holding:
          holding,

        disqualified:
          disqualified,

        results:
          results

      }
    );


  } catch (error) {

    console.error(
      "ROADMAN HOLDING ERROR:",
      error
    );


    return json(
      res,
      500,
      {

        success:
          false,

        error:
          "Unable to check holding status."

      }
    );

  }

}
