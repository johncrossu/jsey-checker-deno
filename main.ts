const ETHERSCAN_KEY = Deno.env.get("ETHERSCAN_API_KEY") || "";
const INTERNAL_KEY = Deno.env.get("INTERNAL_KEY") || "";
const CHAIN_IDS: Record<string, string> = { ethereum: "1", bsc: "56", base: "8453", polygon: "137", arbitrum: "42161", optimism: "10", avalanche: "43114", celo: "42220", linea: "59144", zksync: "324" };
const RPC_URLS: Record<string, string> = { "1": "https://ethereum-rpc.publicnode.com", "56": "https://bsc-dataseed.binance.org", "8453": "https://mainnet.base.org", "137": "https://polygon-rpc.com", "42161": "https://arb1.arbitrum.io/rpc", "10": "https://mainnet.optimism.io", "43114": "https://api.avax.network/ext/bc/C/rpc", "42220": "https://forno.celo.org", "59144": "https://rpc.linea.build", "324": "https://mainnet.era.zksync.io" };
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const kv = await Deno.openKv();
const NODEREAL_KEY = Deno.env.get("NODEREAL_API_KEY") || "";
const BLOCKSCOUT_DOMAINS: Record<string, string> = { "8453": "base.blockscout.com", "10": "optimism.blockscout.com", "324": "zksync.blockscout.com" };
const ROUTESCAN_CHAINS: Record<string, boolean> = { "43114": true };

const DEX_LABELS: Record<string, Record<string, string>> = {
  "1": {
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router",
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 Router",
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 Router 2",
    "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
  },
  "8453": {
    "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24": "Uniswap V2 Router",
    "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
  },
  "42161": {
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 Router",
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 Router 2",
    "0xa51afafe0263b40edaef0df8781ea9aa03e381a3": "Uniswap Universal Router",
    "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
  },
  "137": {
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 Router",
    "0x1095692a6237d83c6a72f3f5efedb9a670c49223": "Uniswap Universal Router",
    "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
  },
  "43114": {
    "0x94b75331ae8d42c1b61065089b7d48fe14aa73b7": "Uniswap Universal Router",
    "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
  },
  "56": {
    "0x1906c1d672b88cd1b9ac7593301ca990f94eae07": "Uniswap Universal Router",
    "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
  },
};

function getSpenderLabel(spender: string, chainId: string): string | null {
  const map = DEX_LABELS[chainId];
  if (!map) return null;
  return map[spender.toLowerCase()] || null;
}

function isSystemContractAddress(address: string): boolean {
  const clean = address.toLowerCase().replace("0x", "");
  const asNumber = BigInt("0x" + clean);
  return asNumber < 65536n;
}

interface TokenInfo { address: string; name: string; symbol: string; }

function dedupeTokenInfo(list: TokenInfo[]): TokenInfo[] {
  const seen = new Map<string, TokenInfo>();
  for (const t of list) {
    const key = t.address.toLowerCase();
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()].filter((t) => !isSystemContractAddress(t.address)).slice(0, 40);
}

async function getWalletTokenTransfers(wallet: string, chainId: string): Promise<TokenInfo[]> {
  if (chainId === "56") {
    if (!NODEREAL_KEY) return [];
    const rpcUrl = `https://bsc-mainnet.nodereal.io/v1/${NODEREAL_KEY}`;
    const found: TokenInfo[] = [];
    for (const addrField of ["fromAddress", "toAddress"]) {
      let pageKey: string | null = null;
      let pages = 0;
      do {
        const params: any = { category: ["20"] };
        params[addrField] = wallet;
        if (pageKey) params.pageKey = pageKey;
        try {
          const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "nr_getAssetTransfers", params: [params], id: 1 }) });
          const data: any = await res.json();
          const transfers = data.result && data.result.transfers ? data.result.transfers : [];
          transfers.forEach((t: any) => { if (t.contractAddress) found.push({ address: t.contractAddress, name: t.name || "", symbol: t.asset || "" }); });
          pageKey = data.result ? data.result.pageKey : null;
        } catch (e) { pageKey = null; }
        pages++;
        await new Promise((r) => setTimeout(r, 150));
      } while (pageKey && pages < 5);
    }
    return dedupeTokenInfo(found);
  }
  if (chainId in BLOCKSCOUT_DOMAINS) {
    const domain = BLOCKSCOUT_DOMAINS[chainId];
    const data: any = await httpGetJson(`https://${domain}/api?module=account&action=tokentx&address=${wallet}&page=1&offset=1000&sort=desc`);
    const transfers = Array.isArray(data?.result) ? data.result : [];
    return dedupeTokenInfo(transfers.map((t: any) => ({ address: t.contractAddress, name: t.tokenName || "", symbol: t.tokenSymbol || "" })));
  }
  if (chainId in ROUTESCAN_CHAINS) {
    const data: any = await httpGetJson(`https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api?module=account&action=tokentx&address=${wallet}&page=1&offset=1000&sort=desc`);
    const transfers = Array.isArray(data?.result) ? data.result : [];
    return dedupeTokenInfo(transfers.map((t: any) => ({ address: t.contractAddress, name: t.tokenName || "", symbol: t.tokenSymbol || "" })));
  }
  const data: any = await httpGetJson(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&address=${wallet}&page=1&offset=1000&sort=desc&apikey=${ETHERSCAN_KEY}`);
  const transfers = Array.isArray(data?.result) ? data.result : [];
  return dedupeTokenInfo(transfers.map((t: any) => ({ address: t.contractAddress, name: t.tokenName || "", symbol: t.tokenSymbol || "" })));
}

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
  const cacheKey = ["tokenrisk", chainId, address.toLowerCase()];
  const cached = await kv.get(cacheKey);
  if (cached && cached.versionstamp !== null) return cached.value;
  const data: any = await httpGetJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`);
  const result = data && data.result && data.result[address.toLowerCase()];
  if (!result) { await kv.set(cacheKey, null, { expireIn: CACHE_TTL_MS }); return null; }
  const parsed = {
    isHoneypot: result.is_honeypot === "1",
    lpLocked: result.lp_holders ? result.lp_holders.some((h: any) => h.is_locked === 1) : false,
    ownerCanMint: result.is_mintable === "1",
    ownershipRenounced: result.owner_address === "0x0000000000000000000000000000000000000000" || result.owner_address === "",
    sellTax: result.sell_tax || "0",
    top10HoldersPercent: result.holders ? result.holders.slice(0, 10).reduce((s: number, h: any) => s + parseFloat(h.percent || 0), 0) : null,
  };
  await kv.set(cacheKey, parsed, { expireIn: CACHE_TTL_MS });
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
  const approvalTopic = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  const ownerTopic = "0x" + walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");

  if (chainId === "56") {
    if (!NODEREAL_KEY) return [];
    const rpcUrl = `https://bsc-mainnet.nodereal.io/v1/${NODEREAL_KEY}`;
    const latestHex = await rpcCall(rpcUrl, "eth_blockNumber", []);
    const latest = parseInt(latestHex, 16);
    const fromBlock = "0x" + Math.max(0, latest - 2000000).toString(16);
    const logs = await rpcCall(rpcUrl, "eth_getLogs", [{ address: tokenAddress, fromBlock, toBlock: "latest", topics: [approvalTopic, ownerTopic, null] }]);
    if (!Array.isArray(logs)) return [];
    const bnbLatestBySpender: Record<string, bigint> = {};
    const bnbBlockBySpender: Record<string, number> = {};
    for (const log of logs) {
      const spender = "0x" + log.topics[2].slice(26);
      const blockNum = parseInt(log.blockNumber, 16);
      if (!(spender in bnbBlockBySpender) || blockNum >= bnbBlockBySpender[spender]) {
        bnbBlockBySpender[spender] = blockNum;
        bnbLatestBySpender[spender] = BigInt(log.data);
      }
    }
    return Object.entries(bnbLatestBySpender).filter(([, amt]) => amt > 0n).map(([spender, amt]) => ({ spender, amountAtomic: amt.toString() }));
  }

  let apiUrl: string;
  if (chainId in BLOCKSCOUT_DOMAINS) {
    const domain = BLOCKSCOUT_DOMAINS[chainId];
    apiUrl = `https://${domain}/api?module=logs&action=getLogs&address=${tokenAddress}&topic0=${approvalTopic}&topic1=${ownerTopic}&topic0_1_opr=and&fromBlock=0&toBlock=latest`;
  } else if (chainId in ROUTESCAN_CHAINS) {
    apiUrl = `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api?module=logs&action=getLogs&address=${tokenAddress}&topic0=${approvalTopic}&topic1=${ownerTopic}&topic0_1_opr=and&fromBlock=0&toBlock=latest`;
  } else {
    apiUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=logs&action=getLogs&address=${tokenAddress}&topic0=${approvalTopic}&topic1=${ownerTopic}&topic0_1_opr=and&fromBlock=0&toBlock=latest&apikey=${ETHERSCAN_KEY}`;
  }
  const data: any = await httpGetJson(apiUrl);
  const logs2 = data && (data.status === "1" || data.message === "OK") && Array.isArray(data.result) ? data.result : [];
  const latestBySpender: Record<string, bigint> = {};
  const blockBySpender: Record<string, number> = {};
  for (const log of logs2) {
    if (!log.topics || log.topics.length < 3) continue;
    const spender = "0x" + log.topics[2].slice(26);
    const blockNum = parseInt(log.blockNumber, 16);
    if (!(spender in blockBySpender) || blockNum >= blockBySpender[spender]) {
      blockBySpender[spender] = blockNum;
      latestBySpender[spender] = BigInt(log.data);
    }
  }
  return Object.entries(latestBySpender).filter(([, amt]) => amt > 0n).map(([spender, amt]) => ({ spender, amountAtomic: amt.toString() }));
}

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

async function getSolanaDelegations(walletAddress: string) {
  try {
    const res = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
        params: [walletAddress, { programId: SPL_TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }]
      })
    });
    const data = await res.json();
    const accounts = data?.result?.value || [];
    const delegations: any[] = [];
    for (const acc of accounts) {
      const info = acc?.account?.data?.parsed?.info;
      if (!info) continue;
      const delegate = info.delegate;
      const delegatedAmount = info.delegatedAmount;
      if (delegate && delegatedAmount && parseFloat(delegatedAmount.uiAmountString || "0") > 0) {
        delegations.push({
          tokenAccount: acc.pubkey,
          mint: info.mint,
          delegate: delegate,
          delegatedAmount: delegatedAmount.uiAmountString,
          rawAmount: delegatedAmount.amount
        });
      }
    }
    return delegations;
  } catch (e) {
    return [];
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const isPaid = req.headers.get("x-internal-key") === INTERNAL_KEY && !!INTERNAL_KEY;

  if (url.pathname === "/health") return json({ status: "ok" });

  if (url.pathname === "/solana-approvals") {
    const wallet = url.searchParams.get("wallet");
    if (!wallet) return json({ error: "Missing wallet" }, 400);
    const delegations = await getSolanaDelegations(wallet);
    return json({ wallet, delegationCount: delegations.length, delegations: isPaid ? delegations : undefined });
  }

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
    const uniqueTokens = await getWalletTokenTransfers(wallet, chainId);
    const riskyTokens: any[] = [];
    for (const tInfo of uniqueTokens) {
      const gp = await checkGoPlus(tInfo.address, chainId);
      if (gp) {
        const r = computeRisk(gp, null);
        if (r.reasons.length > 0) {
          const entry: any = { token: tInfo.address, tokenName: tInfo.name, tokenSymbol: tInfo.symbol, riskLevel: r.level };
          if (isPaid) { entry.reasons = r.reasons; entry.approvals = await getActiveApprovals(wallet, tInfo.address, chainId); }
          riskyTokens.push(entry);
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return json({ wallet, chain, tokensChecked: uniqueTokens.length, riskyCount: riskyTokens.length, riskyTokens: isPaid ? riskyTokens : undefined });
  }

  if (url.pathname === "/wallet-approvals") {
    const wallet = url.searchParams.get("wallet");
    const chain = url.searchParams.get("chain") || "ethereum";
    const chainId = CHAIN_IDS[chain] || "1";
    if (!wallet) return json({ error: "Missing wallet" }, 400);
    if (!isPaid) return json({ error: "Payment required for full approvals scan" }, 402);
    const uniqueTokens = await getWalletTokenTransfers(wallet, chainId);
    const allApprovals: any[] = [];
    const BATCH_SIZE = 5;
    for (let i = 0; i < uniqueTokens.length; i += BATCH_SIZE) {
      const batch = uniqueTokens.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((tInfo) => getActiveApprovals(wallet, tInfo.address, chainId)));
      results.forEach((approvals, idx) => {
        for (const a of approvals) {
          allApprovals.push({ token: batch[idx].address, tokenName: batch[idx].name, tokenSymbol: batch[idx].symbol, spender: a.spender, spenderLabel: getSpenderLabel(a.spender, chainId), amountAtomic: a.amountAtomic, chain, chainId });
        }
      });
      await new Promise((r) => setTimeout(r, 150));
    }
    return json({ wallet, chain, tokensChecked: uniqueTokens.length, approvalsFound: allApprovals.length, approvals: allApprovals });
  }

  if (url.pathname === "/admin/clear-cache") {
    if (req.headers.get("x-internal-key") !== INTERNAL_KEY || !INTERNAL_KEY) return json({ error: "Unauthorized" }, 401);
    const chainId = url.searchParams.get("chain") || "";
    if (!chainId) return json({ error: "Missing chain param" }, 400);
    let deleted = 0;
    const entries = kv.list({ prefix: ["tokenrisk", chainId] });
    for await (const entry of entries) {
      await kv.delete(entry.key);
      deleted++;
    }
    return json({ chain: chainId, deleted });
  }

  if (url.pathname === "/buy-sell-simulation") {
    return json({ error: "Not yet implemented — needs verified DEX router research before building." }, 501);
  }

  return json({ error: "Not found" }, 404);
});
