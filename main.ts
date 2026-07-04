const ETHERSCAN_KEY = Deno.env.get("ETHERSCAN_API_KEY") || "";
const INTERNAL_KEY = Deno.env.get("INTERNAL_KEY") || "";
const CHAIN_IDS: Record<string, string> = { ethereum: "1", bsc: "56", base: "8453", polygon: "137", arbitrum: "42161", optimism: "10", avalanche: "43114", celo: "42220", linea: "59144", zksync: "324" };
const RPC_URLS: Record<string, string> = { "1": "https://ethereum-rpc.publicnode.com", "56": "https://bsc-dataseed.binance.org", "8453": "https://mainnet.base.org", "137": "https://polygon-rpc.com", "42161": "https://arb1.arbitrum.io/rpc", "10": "https://mainnet.optimism.io", "43114": "https://api.avax.network/ext/bc/C/rpc", "42220": "https://forno.celo.org", "59144": "https://rpc.linea.build", "324": "https://mainnet.era.zksync.io" };
const tokenCache = new Map<string, { data: any; time: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-internal-key", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });
}

async function httpGetJson(url: string) {
  try { const r = await fetch(url); return await r.json(); } catch (e) { return null; }
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]) {
  try {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const d = await r.json();
    return d.result;
  } catch (e) { return null; }
}

async function checkGoPlus(address: string, chainId: string) {
  const cacheKey = chainId + ":" + address.toLowerCase();
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.data;
  const data: any = await httpGetJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`);
  const result = data && data.result && data.result[address.toLowerCase()];
  if (!result) { tokenCache.set(cacheKey, { data: null, time: Date.now() }); return null; }
  const parsed = {
    isHoneypot: result.is_honeypot === "1",
    lpLocked: result.lp_holders ? result.lp_holders.some((h: any) => h.is_locked === 1) : false,
    ownerCanMint: result.is_mintable === "1",
    ownershipRenounced: result.owner_address === "0x0000000000000000000000000000000000000000" || result.owner_address === "",
    sellTax: result.sell_tax || "0",
    top10HoldersPercent: result.holders ? result.holders.slice(0, 10).reduce((s: number, h: any) => s + parseFloat(h.percent || 0), 0) : null,
  };
  tokenCache.set(cacheKey, { data: parsed, time: Date.now() });
  return parsed;
}

function computeRisk(goPlusData: any, deployerData: any) {
  let riskPoints = 0;
  const reasons: string[] = [];
  if (goPlusData) {
    if (goPlusData.isHoneypot) { riskPoints += 50; reasons.push("Token is flagged as a honeypot (cannot sell after buying)."); }
    if (!goPlusData.lpLocked) { riskPoints += 25; reasons.push("Liquidity is not locked — can be removed by the deployer at any time."); }
    if (goPlusData.ownerCanMint) { riskPoints += 20; reasons.push("Contract owner can mint new tokens, diluting holders at will."); }
    if (!goPlusData.ownershipRenounced) { riskPoints += 15; reasons.push("Ownership has not been renounced — deployer retains control."); }
    if (goPlusData.top10HoldersPercent !== null && goPlusData.top10HoldersPercent > 50) { riskPoints += 20; reasons.push(`Top 10 holders control ${goPlusData.top10HoldersPercent.toFixed(1)}% of supply.`); }
    if (parseFloat(goPlusData.sellTax) > 0.1) { riskPoints += 15; reasons.push(`High sell tax of ${(goPlusData.sellTax * 100).toFixed(1)}% detected.`); }
  }
  if (deployerData && deployerData.isSerialRugger) {
    riskPoints += 35;
    reasons.push(`This deployer has created ${deployerData.otherTokensDeployedCount} other token(s) — ${deployerData.otherTokensHighRiskCount} of ${deployerData.otherTokensCheckedCount} checked show high-risk signs.`);
  }
  let level = "LOW";
  if (riskPoints >= 60) level = "HIGH"; else if (riskPoints >= 30) level = "MEDIUM";
  return { riskPoints, level, reasons };
}

async function checkDeployerHistory(address: string, chainId: string) {
  if (!ETHERSCAN_KEY) return { available: false, reason: "No API key configured" };
  const creationData: any = await httpGetJson(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${ETHERSCAN_KEY}`);
  const creation = creationData?.result?.[0];
  if (!creation) return { available: false, reason: "Could not find deployer" };
  const deployer = creation.contractCreator;
  await new Promise((r) => setTimeout(r, 250));
  const txData: any = await httpGetJson(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=txlist&address=${deployer}&startblock=0&endblock=99999999&sort=asc&page=1&offset=500&apikey=${ETHERSCAN_KEY}`);
  const allTxs = Array.isArray(txData?.result) ? txData.result : [];
  const deployedTokens = [...new Set(allTxs.filter((t: any) => t.contractAddress && t.contractAddress.toLowerCase() !== address.toLowerCase()).map((t: any) => t.contractAddress))].slice(0, 10) as string[];
  let highRiskCount = 0, checkedCount = 0;
  for (const t of deployedTokens) {
    const gp = await checkGoPlus(t, chainId);
    if (gp) { checkedCount++; const r = computeRisk(gp, null); if (r.level === "HIGH") highRiskCount++; }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    available: true, deployerAddress: deployer,
    otherTokensDeployedCount: deployedTokens.length, otherTokensCheckedCount: checkedCount, otherTokensHighRiskCount: highRiskCount,
    isSerialRugger: checkedCount >= 2 && highRiskCount / checkedCount >= 0.5,
  };
}

async function getActiveApprovals(walletAddress: string, tokenAddress: string, chainId: string) {
  const rpc = RPC_URLS[chainId];
  if (!rpc) return [];
  const approvalTopic = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  const ownerTopic = "0x" + walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");
  const latestHex = await rpcCall(rpc, "eth_blockNumber", []);
  const latest = parseInt(latestHex, 16);
  const fromBlock = "0x" + Math.max(0, latest - 2000000).toString(16);
  const logs = await rpcCall(rpc, "eth_getLogs", [{ address: tokenAddress, fromBlock, toBlock: "latest", topics: [approvalTopic, ownerTopic, null] }]);
  if (!Array.isArray(logs)) return [];
  const latestBySpender: Record<string, bigint> = {};
  for (const log of logs) {
    const spender = "0x" + log.topics[2].slice(26);
    latestBySpender[spender] = BigInt(log.data);
  }
  return Object.entries(latestBySpender).filter(([, amt]) => amt > 0n).map(([spender, amt]) => ({ spender, amountAtomic: amt.toString() }));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const isPaid = req.headers.get("x-internal-key") === INTERNAL_KEY && !!INTERNAL_KEY;

  if (url.pathname === "/health") return json({ status: "ok" });

  if (url.pathname === "/token-check") {
    const address = url.searchParams.get("address");
    const chain = url.searchParams.get("chain") || "ethereum";
    const chainId = CHAIN_IDS[chain] || "1";
    if (!address) return json({ error: "Missing address" }, 400);
    const goPlusData = await checkGoPlus(address, chainId);
    let deployerData = null;
    if (isPaid) deployerData = await checkDeployerHistory(address, chainId);
    const risk = computeRisk(goPlusData, deployerData);
    if (!isPaid) {
      return json({ address, chain, riskLevel: risk.level, summary: risk.level === "HIGH" ? "This token shows multiple high-risk warning signs." : risk.level === "MEDIUM" ? "This token shows some risk factors worth reviewing." : "No major red flags detected." });
    }
    return json({ address, chain, riskLevel: risk.level, riskScore: risk.riskPoints, reasons: risk.reasons, deployerData, goPlusData });
  }

  if (url.pathname === "/wallet-scan") {
    const wallet = url.searchParams.get("wallet");
    const chain = url.searchParams.get("chain") || "ethereum";
    const chainId = CHAIN_IDS[chain] || "1";
    if (!wallet) return json({ error: "Missing wallet" }, 400);
    if (!ETHERSCAN_KEY) return json({ error: "Not configured" });
    const txData: any = await httpGetJson(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&address=${wallet}&page=1&offset=1000&sort=desc&apikey=${ETHERSCAN_KEY}`);
    const transfers = Array.isArray(txData?.result) ? txData.result : [];
    const uniqueTokens = [...new Set(transfers.map((t: any) => t.contractAddress))].slice(0, 40) as string[];
    const riskyTokens: any[] = [];
    for (const t of uniqueTokens) {
      const gp = await checkGoPlus(t, chainId);
      if (gp) {
        const r = computeRisk(gp, null);
        if (r.reasons.length > 0) {
          const entry: any = { token: t, riskLevel: r.level };
          if (isPaid) { entry.reasons = r.reasons; entry.approvals = await getActiveApprovals(wallet, t, chainId); }
          riskyTokens.push(entry);
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return json({ wallet, chain, tokensChecked: uniqueTokens.length, riskyCount: riskyTokens.length, riskyTokens: isPaid ? riskyTokens : undefined });
  }

  if (url.pathname === "/buy-sell-simulation") {
    return json({ error: "Not yet implemented — needs verified DEX router research before building." }, 501);
  }

  return json({ error: "Not found" }, 404);
});
