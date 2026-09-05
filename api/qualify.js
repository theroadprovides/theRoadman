const { neon } = require("@neondatabase/serverless");

const TOTAL_SPOTS = 100;

// TESTE: $1
// PRODUÇÃO: mudar para 10
const MIN_USD_REQUIRED = 1;

const TOKEN_MINT =
  "BgVkpGKLuiUGwj4GzaYyoKbWNMBUeem8rpuvEuRApump";

function json(res, status, data) {
  res.status(status).json(data);
}

function normalizeWallet(wallet) {
  return String(wallet || "").trim();
}

async function getRoadBalance(wallet) {
  const response = await fetch(
    "https://api.mainnet-beta.solana.com",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [
          wallet,
          {
            mint: TOKEN_MINT,
          },
          {
            encoding: "jsonParsed",
            commitment: "finalized",
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Solana RPC returned HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      data.error.message || "Solana RPC error"
    );
  }

  const accounts = data.result?.value || [];

  let totalBalance = 0;

  for (const account of accounts) {
    const amount =
      account?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;

    if (typeof amount === "number") {
      totalBalance += amount;
    }
  }

  return totalBalance;
}

async function getRoadPrice() {
  const response = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`
  );

  if (!response.ok) {
    throw new Error(
      `DexScreener returned HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const pairs = Array.isArray(data.pairs)
    ? data.pairs
    : [];

  const validPairs = pairs
    .filter((pair) => {
      return (
        pair.chainId === "solana" &&
        pair.baseToken?.address === TOKEN_MINT &&
        pair.priceUsd &&
        Number(pair.priceUsd) > 0
      );
    })
    .sort((a, b) => {
      const liquidityA =
        Number(a.liquidity?.usd) || 0;

      const liquidityB =
        Number(b.liquidity?.usd) || 0;

      return liquidityB - liquidityA;
    });

  if (validPairs.length === 0) {
    throw new Error(
      "Could not find a valid Solana $ROAD price."
    );
  }

  return Number(validPairs[0].priceUsd);
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    return json(res, 405, {
      success: false,
      error: "Method not allowed.",
    });
  }

  if (!process.env.DATABASE_URL) {
    return json(res, 500, {
      success: false,
      error: "DATABASE_URL is not configured.",
    });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    /*
     * Busca todos os holders atualmente em HOLDING.
     */
    const holders = await sql`
      SELECT
        id,
        spot,
        x_handle,
        wallet,
        status,
        holding_status,
        initial_balance,
        initial_usd_value,
        final_balance,
        final_usd_value,
        qualified_at,
        disqualified_at,
        nft_number,
        nft_status
      FROM roadman_claims
      WHERE holding_status = 'HOLDING'
      ORDER BY spot ASC
    `;

    /*
     * Não há holders para verificar.
     */
    if (holders.length === 0) {
      return json(res, 200, {
        success: true,
        minimum_required: MIN_USD_REQUIRED,
        road_price: null,
        checked: 0,
        holding: 0,
        disqualified: 0,
        qualified: 0,
        total_spots: TOTAL_SPOTS,
        message: "No holders currently in HOLDING status.",
        results: [],
      });
    }

    /*
     * Busca o preço atual do $ROAD.
     */
    const roadPrice = await getRoadPrice();

    const results = [];

    let holdingCount = 0;
    let disqualifiedCount = 0;

    /*
     * Verifica cada holder individualmente.
     */
    for (const holder of holders) {
      const wallet = normalizeWallet(holder.wallet);

      try {
        const balance = await getRoadBalance(wallet);

        const usdValue =
          balance * roadPrice;

        /*
         * Ainda possui o mínimo exigido.
         */
        if (usdValue >= MIN_USD_REQUIRED) {
          await sql`
            UPDATE roadman_claims
            SET
              final_balance = ${balance},
              final_usd_value = ${usdValue},
              holding_status = 'HOLDING'
            WHERE id = ${holder.id}
          `;

          holdingCount++;

          results.push({
            id: holder.id,
            spot: holder.spot,
            x_handle: holder.x_handle,
            wallet: wallet,
            status: "HOLDING",
            balance: balance,
            usd_value: usdValue,
          });
        }

        /*
         * Caiu abaixo do mínimo.
         */
        else {
          await sql`
            UPDATE roadman_claims
            SET
              final_balance = ${balance},
              final_usd_value = ${usdValue},
              holding_status = 'DISQUALIFIED',
              disqualified_at = NOW()
            WHERE id = ${holder.id}
          `;

          disqualifiedCount++;

          results.push({
            id: holder.id,
            spot: holder.spot,
            x_handle: holder.x_handle,
            wallet: wallet,
            status: "DISQUALIFIED",
            balance: balance,
            usd_value: usdValue,
          });
        }
      } catch (holderError) {
        /*
         * Um erro em uma carteira não interrompe
         * a verificação das demais.
         */
        results.push({
          id: holder.id,
          spot: holder.spot,
          x_handle: holder.x_handle,
          wallet: wallet,
          status: "ERROR",
          error:
            holderError.message ||
            "Could not verify wallet.",
        });
      }
    }

    /*
     * QUALIFIED NÃO É DEFINIDO AQUI.
     *
     * A qualificação definitiva será feita
     * posteriormente, no momento da distribuição
     * dos NFTs.
     *
     * Isso é proposital para respeitar a regra:
     *
     * "O holder precisa manter o mínimo até que
     * os 100 NFTs sejam distribuídos."
     */

    return json(res, 200, {
      success: true,
      minimum_required: MIN_USD_REQUIRED,
      road_price: roadPrice,
      checked: holders.length,
      holding: holdingCount,
      disqualified: disqualifiedCount,
      qualified: 0,
      total_spots: TOTAL_SPOTS,
      results: results,
    });
  } catch (error) {
    console.error("QUALIFY ERROR:", error);

    return json(res, 500, {
      success: false,
      error:
        error.message ||
        "Internal server error.",
    });
  }
};
