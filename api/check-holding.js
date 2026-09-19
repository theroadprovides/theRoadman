const { neon } = require("@neondatabase/serverless");

const TOTAL_SPOTS = 100;

// =====================================================
// CONFIG
// =====================================================

// TESTE:
// 30 = mínimo atual para testar
//
// PRODUÇÃO:
// 3_000_000 = mínimo definitivo
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

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
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
// SOLANA RPC
// =====================================================

async function solanaRpc(method, params) {
  const response = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
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

  const data = await response.json();

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

async function getRoadBalance(wallet) {
  const result = await solanaRpc(
    "getTokenAccountsByOwner",
    [
      wallet,
      {
        mint: TOKEN_MINT
      },
      {
        encoding: "jsonParsed",
        commitment: "finalized"
      }
    ]
  );

  let total = 0;

  for (const account of result.value || []) {
    const amount =
      account?.account?.data?.parsed?.info
        ?.tokenAmount?.uiAmountString;

    if (
      amount !== undefined &&
      amount !== null
    ) {
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

  // ---------------------------------------------------
  // OPTIONS
  // ---------------------------------------------------

  if (req.method === "OPTIONS") {
    res.status(204);
    return res.end();
  }

  // ---------------------------------------------------
  // GET / POST ONLY
  // ---------------------------------------------------

  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    return json(res, 405, {
      success: false,
      error: "METHOD_NOT_ALLOWED"
    });
  }

  // ---------------------------------------------------
  // DATABASE
  // ---------------------------------------------------

  if (!process.env.DATABASE_URL) {
    return json(res, 500, {
      success: false,
      error: "DATABASE_NOT_CONFIGURED"
    });
  }

  try {
    const sql = neon(
      process.env.DATABASE_URL
    );

    // =================================================
    // GET CURRENT ACTIVE PARTICIPANTS
    //
    // ONLY HOLDING records are currently eligible.
    // DISQUALIFIED records remain as history.
    // =================================================

    const holders = await sql`
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

    const results = [];

    let holdingCount = 0;
    let disqualifiedCount = 0;
    let errorCount = 0;

    // =================================================
    // VERIFY EVERY ACTIVE HOLDER ON-CHAIN
    // =================================================

    for (const holder of holders) {

      let roadBalance;

      try {
        roadBalance =
          await getRoadBalance(
            holder.wallet
          );
      } catch (error) {

        console.error(
          "SOLANA BALANCE ERROR:",
          {
            claim_id: holder.id,
            wallet: holder.wallet,
            error
          }
        );

        errorCount++;

        results.push({
          id: holder.id,
          spot: holder.spot,
          wallet: holder.wallet,
          status: "ERROR",
          balance: null,
          required:
            MIN_ROAD_REQUIRED
        });

        // IMPORTANT:
        // RPC failure does NOT mean the participant
        // should be disqualified.
        continue;
      }

      // =================================================
      // STILL HOLDING
      // =================================================

      if (
        roadBalance >=
        MIN_ROAD_REQUIRED
      ) {

        await sql`
          UPDATE roadman_claims
          SET
            final_balance =
              ${roadBalance},
            final_usd_value = NULL,
            holding_status = 'HOLDING',
            disqualified_at = NULL
          WHERE id = ${holder.id}
        `;

        holdingCount++;

        results.push({
          id: holder.id,
          spot: holder.spot,
          wallet: holder.wallet,
          status: "HOLDING",
          balance: roadBalance,
          required:
            MIN_ROAD_REQUIRED
        });

        continue;
      }

      // =================================================
      // NO LONGER HOLDING
      // =================================================

      await sql`
        UPDATE roadman_claims
        SET
          final_balance =
            ${roadBalance},
          final_usd_value = NULL,
          holding_status =
            'DISQUALIFIED',
          disqualified_at =
            NOW(),
          qualified_at = NULL
        WHERE id = ${holder.id}
      `;

      disqualifiedCount++;

      results.push({
        id: holder.id,
        spot: holder.spot,
        wallet: holder.wallet,
        status: "DISQUALIFIED",
        balance: roadBalance,
        required:
          MIN_ROAD_REQUIRED
      });
    }

    // =================================================
    // ACTIVE SPOTS AFTER VERIFICATION
    // =================================================

    const availableSpots =
      Math.max(
        0,
        TOTAL_SPOTS - holdingCount
      );

    // =================================================
    // RESPONSE
    // =================================================

    return json(res, 200, {
      success: true,

      token_mint:
        TOKEN_MINT,

      minimum_road_required:
        MIN_ROAD_REQUIRED,

      total_spots:
        TOTAL_SPOTS,

      holding:
        holdingCount,

      disqualified:
        disqualifiedCount,

      errors:
        errorCount,

      available_spots:
        availableSpots,

      results
    });

  } catch (error) {

    console.error(
      "ROADMAN CHECK HOLDING ERROR:",
      error
    );

    return json(res, 500, {
      success: false,
      error: "CHECK_HOLDING_FAILED"
    });
  }
};
