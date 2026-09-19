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

function json(res, status, data) {
  res.status(status);

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

  const accounts =
    data.result?.value || [];

  let totalBalance = 0;

  for (
    const account
    of accounts
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
        totalBalance +=
          parsedAmount;
      }
    }
  }

  return Number.isFinite(
    totalBalance
  )
    ? totalBalance
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
  // METHOD
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
          status,
          holding_status,
          initial_balance,
          final_balance,
          qualified_at,
          disqualified_at,
          nft_number,
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

          minimum_required:
            MIN_ROAD_REQUIRED,

          token_mint:
            TOKEN_MINT,

          total_spots:
            TOTAL_SPOTS,

          checked: 0,

          holding: 0,

          disqualified: 0,

          qualified: 0,

          results: [],

          message:
            "No holders currently in HOLDING status."
        }
      );
    }

    // =================================================
    // RESULTS
    // =================================================

    const results = [];

    let holdingCount = 0;

    let disqualifiedCount = 0;

    let qualifiedCount = 0;

    // =================================================
    // CHECK EACH HOLDER
    // =================================================

    for (
      const holder
      of holders
    ) {

      const wallet =
        normalizeWallet(
          holder.wallet
        );

      try {

        const balance =
          await getRoadBalance(
            wallet
          );

        // =============================================
        // STILL HOLDING / QUALIFIED
        // =============================================

        if (
          balance >=
          MIN_ROAD_REQUIRED
        ) {

          const updated =
            await sql`
              UPDATE roadman_claims
              SET
                final_balance =
                  ${balance},

                holding_status =
                  'HOLDING',

                qualified_at =
                  COALESCE(
                    qualified_at,
                    NOW()
                  ),

                disqualified_at =
                  NULL
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
                qualified_at,
                nft_number,
                nft_status
            `;

          holdingCount++;

          qualifiedCount++;

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
              "QUALIFIED",

            balance:
              balance,

            minimum_required:
              MIN_ROAD_REQUIRED,

            eligible:
              true,

            qualified_at:
              updated[0].qualified_at,

            nft_number:
              updated[0].nft_number,

            nft_status:
              updated[0].nft_status
          });

          continue;
        }

        // =============================================
        // DISQUALIFIED
        // =============================================

        const updated =
          await sql`
            UPDATE roadman_claims
            SET
              final_balance =
                ${balance},

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
              qualified_at,
              disqualified_at,
              nft_number,
              nft_status
          `;

        disqualifiedCount++;

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

          qualified_at:
            updated[0].qualified_at,

          disqualified_at:
            updated[0].disqualified_at,

          nft_number:
            updated[0].nft_number,

          nft_status:
            updated[0].nft_status
        });

      } catch (holderError) {

        // =============================================
        // WALLET ERROR
        // =============================================

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
            holderError.message ||
            "Could not verify wallet."
        });
      }
    }

    // =================================================
    // AVAILABLE SPOTS
    // =================================================

    /*
     * IMPORTANT:
     *
     * Neste momento, um spot continua pertencendo
     * ao registro original mesmo depois de uma
     * desqualificação.
     *
     * A redistribuição/reclaim dos spots será tratada
     * separadamente quando definirmos a regra final.
     */

    const availableSpots =
      Math.max(
        0,
        TOTAL_SPOTS -
        holders.length
      );

    // =================================================
    // RESPONSE
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

        checked:
          holders.length,

        holding:
          holdingCount,

        disqualified:
          disqualifiedCount,

        qualified:
          qualifiedCount,

        total_spots:
          TOTAL_SPOTS,

        available_spots:
          availableSpots,

        results:
          results
      }
    );

  } catch (error) {

    console.error(
      "ROADMAN QUALIFY ERROR:",
      error
    );

    return json(
      res,
      500,
      {
        success: false,

        error:
          error.message ||
          "Internal server error."
      }
    );
  }
};
