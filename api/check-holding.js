const { neon } = require("@neondatabase/serverless");

// =====================================================
// CONFIG
// =====================================================

const TOTAL_SPOTS = 100;

// TESTE ATUAL
// PRODUÇÃO: alterar para 3_000_000
const MIN_ROAD_REQUIRED = 30;

const TOKEN_MINT =
  "BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";

const SOLANA_RPC =
  "https://api.mainnet-beta.solana.com";

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
// WALLET
// =====================================================

function normalizeWallet(wallet) {
  return String(
    wallet || ""
  ).trim();
}

// =====================================================
// SOLANA BALANCE
// =====================================================

async function getRoadBalance(wallet) {
  const response =
    await fetch(
      SOLANA_RPC,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          jsonrpc: "2.0",

          id: 1,

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
      `Solana RPC returned HTTP ${response.status}`
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
        ?.tokenAmount
        ?.uiAmountString;

    if (amount) {
      const parsedAmount =
        Number(amount);

      if (
        Number.isFinite(
          parsedAmount
        )
      ) {
        balance +=
          parsedAmount;
      }
    }
  }

  return Number.isFinite(balance)
    ? balance
    : 0;
}

// =====================================================
// MAIN
// =====================================================

module.exports = async function handler(
  req,
  res
) {

  // ===================================================
  // OPTIONS
  // ===================================================

  if (
    req.method === "OPTIONS"
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
        success: false,
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
        success: false,
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

    // =================================================
    // FIND CURRENT HOLDERS
    // =================================================

    const holders =
      await sql`
        SELECT
          id,
          spot,
          x_handle,
          wallet,
          initial_balance,
          holding_status,
          nft_status
        FROM roadman_claims
        WHERE holding_status = 'HOLDING'
        ORDER BY spot ASC
      `;

    // =================================================
    // NO HOLDERS
    // =================================================

    if (
      !holders.length
    ) {
      return json(
        res,
        200,
        {
          success: true,

          token_mint:
            TOKEN_MINT,

          minimum_required:
            MIN_ROAD_REQUIRED,

          total_spots:
            TOTAL_SPOTS,

          checked: 0,

          holding: 0,

          disqualified: 0,

          available_spots:
            TOTAL_SPOTS,

          results: [],

          message:
            "No holders currently in HOLDING."
        }
      );
    }

    // =================================================
    // COUNTERS
    // =================================================

    let checked = 0;

    let holding = 0;

    let disqualified = 0;

    const results = [];

    // =================================================
    // CHECK EACH HOLDER
    // =================================================

    for (
      const holder
      of holders
    ) {

      checked++;

      const wallet =
        normalizeWallet(
          holder.wallet
        );

      let balance;

      try {

        balance =
          await getRoadBalance(
            wallet
          );

      } catch (error) {

        console.error(
          "HOLDING BALANCE ERROR:",
          wallet,
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

          x_handle:
            holder.x_handle,

          wallet:
            wallet,

          status:
            "ERROR",

          eligible:
            false,

          error:
            error.message ||
            "Unable to verify wallet balance."
        });

        continue;
      }

      // =================================================
      // STILL HOLDING
      // =================================================

      if (
        balance >=
        MIN_ROAD_REQUIRED
      ) {

        holding++;

        const updated =
          await sql`
            UPDATE roadman_claims
            SET
              final_balance =
                ${balance},

              final_usd_value =
                NULL,

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
              final_balance
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

          minimum_required:
            MIN_ROAD_REQUIRED,

          eligible:
            true
        });

        continue;
      }

      // =================================================
      // DISQUALIFIED
      // =================================================

      disqualified++;

      const updated =
        await sql`
          UPDATE roadman_claims
          SET
            final_balance =
              ${balance},

            final_usd_value =
              NULL,

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

        minimum_required:
          MIN_ROAD_REQUIRED,

        eligible:
          false,

        disqualified_at:
          updated[0].disqualified_at
      });
    }

    // =================================================
    // AVAILABLE SPOTS
    // =================================================

    /*
     * IMPORTANTE:
     *
     * Neste momento o check-holding NÃO libera
     * automaticamente o spot.
     *
     * A regra de reclaim/redistribuição será
     * implementada separadamente.
     */

    const availableSpots =
      Math.max(
        0,
        TOTAL_SPOTS -
        holding
      );

    // =================================================
    // SUCCESS
    // =================================================

    return json(
      res,
      200,
      {
        success: true,

        token_mint:
          TOKEN_MINT,

        minimum_required:
          MIN_ROAD_REQUIRED,

        total_spots:
          TOTAL_SPOTS,

        checked:
          checked,

        holding:
          holding,

        disqualified:
          disqualified,

        available_spots:
          availableSpots,

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
        success: false,

        error:
          error.message ||
          "Unable to check holding status."
      }
    );
  }
};
