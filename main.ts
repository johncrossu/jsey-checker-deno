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

class ChainScanError extends Error {}

function isRateLimitOrError(data: any): boolean {
  if (!data) return true;
  if (typeof data.result === "string") return true;
  if (data.status === "0" && data.message && data.message !== "No transactions found") return true;
  return false;
}

async function fetchWithRetry(url: string, label: string): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const data: any = await httpGetJson(url);
    if (!isRateLimitOrError(data)) return data;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new ChainScanError(`${label} failed after retry (rate-limited or errored)`);
}

function looksLikeAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

const COINGECKO_PLATFORM: Record<string, string> = { "1": "ethereum", "56": "binance-smart-chain", "8453": "base", "137": "polygon-pos", "42161": "arbitrum-one", "10": "optimistic-ethereum", "43114": "avalanche", "42220": "celo", "59144": "linea", "324": "zksync" };

async function resolveTokenAddressByName(query: string, chainId: string): Promise<string | null> {
  const cacheKey = ["nameresolve", chainId, query.toLowerCase()];
  const cached = await kv.get<string | null>(cacheKey);
  if (cached && cached.versionstamp !== null) return cached.value;
  const data: any = await httpGetJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
  const coins = Array.isArray(data?.coins) ? data.coins : [];
  const platform = COINGECKO_PLATFORM[chainId];
  let found: string | null = null;
  for (const cn of coins.slice(0, 5)) {
    const detail: any = await httpGetJson(`https://api.coingecko.com/api/v3/coins/${cn.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`);
    const addr = detail?.platforms?.[platform];
    if (addr) { found = addr; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  await kv.set(cacheKey, found, { expireIn: CACHE_TTL_MS });
  return found;
}

async function getTokenLogo(address: string, chainId: string): Promise<string | null> {
  const cacheKey = ["tokenlogo", chainId, address.toLowerCase()];
  const cached = await kv.get<string | null>(cacheKey);
  if (cached && cached.versionstamp !== null) return cached.value;
  const platform = COINGECKO_PLATFORM[chainId];
  let logo: string | null = null;
  if (platform) {
    const data: any = await httpGetJson(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${address.toLowerCase()}`);
    if (data?.image?.small) logo = data.image.small;
  }
  await kv.set(cacheKey, logo, { expireIn: CACHE_TTL_MS });
  return logo;
}

async function getLiveAllowance(rpcUrl: string, tokenAddress: string, owner: string, spender: string): Promise<bigint> {
  const selector = "0xdd62ed3e";
  const ownerPadded = owner.toLowerCase().replace("0x", "").padStart(64, "0");
  const spenderPadded = spender.toLowerCase().replace("0x", "").padStart(64, "0");
  const data = selector + ownerPadded + spenderPadded;
  const result = await rpcCall(rpcUrl, "eth_call", [{ to: tokenAddress, data }, "latest"]);
  if (!result || result === "0x") return 0n;
  try { return BigInt(result); } catch { return 0n; }
}

async function getWalletTokenTransfers(wallet: string, chainId: string): Promise<TokenInfo[]> {
  if (chainId === "56") {
    if (!NODEREAL_KEY) throw new ChainScanError("Missing NODEREAL_KEY for BSC");
    const rpcUrl = `https://bsc-mainnet.nodereal.io/v1/${NODEREAL_KEY}`;
    const found: TokenInfo[] = [];
    for (const addrField of ["fromAddress", "toAddress"]) {
      let pageKey: string | null = null;
      let pages = 0;
      do {
        const params: any = { category: ["20"] };
        params[addrField] = wallet;
        if (pageKey) params.pageKey = pageKey;
        let data: any = null;
        let ok = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "nr_getAssetTransfers", params: [params], id: 1 }) });
            data = await res.json();
            if (!data.error) { ok = true; break; }
          } catch (e) { data = null; }
          await new Promise((r) => setTimeout(r, 800));
        }
        if (!ok) throw new ChainScanError("BSC NodeReal call failed after retry");
        const transfers = data.result && data.result.transfers ? data.result.transfers : [];
        transfers.forEach((t: any) => { if (t.contractAddress) found.push({ address: t.contractAddress, name: t.name || "", symbol: t.asset || "" }); });
        pageKey = data.result ? data.result.pageKey : null;
        pages++;
        await new Promise((r) => setTimeout(r, 150));
      } while (pageKey && pages < 5);
    }
    return dedupeTokenInfo(found);
  }
  if (chainId in BLOCKSCOUT_DOMAINS) {
    const domain = BLOCKSCOUT_DOMAINS[chainId];
    const data: any = await fetchWithRetry(`https://${domain}/api?module=account&action=tokentx&address=${wallet}&page=1&offset=1000&sort=desc`, `Blockscout(${domain})`);
    const transfers = Array.isArray(data?.result) ? data.result : [];
    return dedupeTokenInfo(transfers.map((t: any) => ({ address: t.contractAddress, name: t.tokenName || "", symbol: t.tokenSymbol || "" })));
  }
  if (chainId in ROUTESCAN_CHAINS) {
    const data: any = await fetchWithRetry(`https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api?module=account&action=tokentx&address=${wallet}&page=1&offset=1000&sort=desc`, `Routescan(${chainId})`);
    const transfers = Array.isArray(data?.result) ? data.result : [];
    return dedupeTokenInfo(transfers.map((t: any) => ({ address: t.contractAddress, name: t.tokenName || "", symbol: t.tokenSymbol || "" })));
  }
  const data: any = await fetchWithRetry(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&address=${wallet}&page=1&offset=1000&sort=desc&apikey=${ETHERSCAN_KEY}`, `Etherscan(chain ${chainId})`);
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

interface GoPlusResult {
  tokenName: string;
  tokenSymbol: string;
  isHoneypot: boolean;
  lpLocked: boolean;
  ownerCanMint: boolean;
  ownershipRenounced: boolean;
  sellTax: string;
  top10HoldersPercent: number | null;
}

async function checkGoPlus(address: string, chainId: string): Promise<GoPlusResult | null> {
  const cacheKey = ["tokenrisk", chainId, address.toLowerCase()];
  const cached = await kv.get<GoPlusResult | null>(cacheKey);
  if (cached && cached.versionstamp !== null) return cached.value;
  const data: any = await httpGetJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`);
  const result = data && data.result && data.result[address.toLowerCase()];
  if (!result) { await kv.set(cacheKey, null, { expireIn: CACHE_TTL_MS }); return null; }
  const parsed = {
    tokenName: result.token_name || "",
    tokenSymbol: result.token_symbol || "",
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
    const bnbConfirmed: { spender: string; amountAtomic: string }[] = [];
    for (const spender of Object.keys(bnbLatestBySpender)) {
      const live = await getLiveAllowance(rpcUrl, tokenAddress, walletAddress, spender);
      if (live > 0n) bnbConfirmed.push({ spender, amountAtomic: live.toString() });
      await new Promise((r) => setTimeout(r, 100));
    }
    return bnbConfirmed;
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
  const rpcUrlForChain = RPC_URLS[chainId];
  const confirmed: { spender: string; amountAtomic: string }[] = [];
  if (rpcUrlForChain) {
    for (const spender of Object.keys(latestBySpender)) {
      const live = await getLiveAllowance(rpcUrlForChain, tokenAddress, walletAddress, spender);
      if (live > 0n) confirmed.push({ spender, amountAtomic: live.toString() });
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return confirmed;
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

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req) => {
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
    const chain = url.searchParams.get("chain") || "ethereum";
    const chainId = CHAIN_IDS[chain] || "1";
    let address = url.searchParams.get("address");
    const query = url.searchParams.get("query");
    if (!address && query) {
      address = looksLikeAddress(query) ? query : await resolveTokenAddressByName(query, chainId);
    }
    if (!address) return json({ error: "Missing or unresolved token address/name" }, 400);
    const goPlusData = await checkGoPlus(address, chainId);
    let deployerData = null;
    if (isPaid) deployerData = await checkDeployerHistory(address, chainId);
    const risk = computeRisk(goPlusData, deployerData);
    const tokenName = goPlusData?.tokenName || "";
    const tokenSymbol = goPlusData?.tokenSymbol || "";
    const tokenLogo = await getTokenLogo(address, chainId);
    if (!isPaid) {
      return json({ address, chain, tokenName, tokenSymbol, tokenLogo, riskLevel: risk.level, summary: risk.level === "HIGH" ? "This token shows multiple high-risk warning signs." : risk.level === "MEDIUM" ? "This token shows some risk factors worth reviewing." : "No major red flags detected." });
    }
    return json({ address, chain, tokenName, tokenSymbol, tokenLogo, riskLevel: risk.level, riskScore: risk.riskPoints, reasons: risk.reasons, deployerData, goPlusData });
  }

  if (url.pathname === "/wallet-scan") {
    const wallet = url.searchParams.get("wallet");
    const chain = url.searchParams.get("chain") || "ethereum";
    const chainId = CHAIN_IDS[chain] || "1";
    if (!wallet) return json({ error: "Missing wallet" }, 400);
    let uniqueTokens: TokenInfo[];
    try {
      uniqueTokens = await getWalletTokenTransfers(wallet, chainId);
    } catch (e) {
      return json({ wallet, chain, tokensChecked: null, riskyCount: null, error: (e as Error).message || "Scan failed for this chain, retry." });
    }
    const riskyTokens: any[] = [];
    for (const tInfo of uniqueTokens) {
      const gp = await checkGoPlus(tInfo.address, chainId);
      if (gp) {
        const r = computeRisk(gp, null);
        if (r.reasons.length > 0) {
          const entry: any = { token: tInfo.address, tokenName: tInfo.name, tokenSymbol: tInfo.symbol, riskLevel: r.level, tokenLogo: await getTokenLogo(tInfo.address, chainId) };
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

    if (url.pathname === "/generate-pdf-report") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!isPaid) return json({ error: "Payment required" }, 402);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
    const reportType = body.reportType === "wallet" ? "wallet" : "token";
    if (!body.data) return json({ error: "Missing data field" }, 400);
    try {
      const pdfBytes = await generatePdfReport(body.data, reportType);
      const filename = "jsey-" + reportType + "-report.pdf";
      return new Response(pdfBytes as unknown as BodyInit, { status: 200, headers: { ...CORS, "content-type": "application/pdf", "content-disposition": "attachment; filename=\"" + filename + "\"" } });
    } catch (e) {
      return json({ error: "PDF generation failed", detail: String(e) }, 500);
    }
  }

if (url.pathname === "/buy-sell-simulation") {
    return json({ error: "Not yet implemented — needs verified DEX router research before building." }, 501);
  }

  return json({ error: "Not found" }, 404);
});

async function generatePdfReport(data: any, reportType: string): Promise<Uint8Array> {
  const { default: PDFDocument } = await import("npm:pdfkit");
  const NAVY = "#0A1A4A";
  const GOLD = "#B8860B";
  const RED = "#C0392B";
  const GREEN = "#2E7D32";
  const GRAY = "#666666";
  const LIGHT_BORDER = "#DDDDDD";

  function sanitizeText(input: any): string {
    if (input === null || input === undefined) return "";
    let str = String(input).normalize("NFKD");
    str = str.replace(/[\p{Mn}\p{Me}]/gu, "");
    str = str.replace(/[\p{Cf}\p{Cc}]/gu, "");
    str = str.replace(/[\uFE00-\uFE0F\u180B-\u180D]/g, "");
    return str.trim();
  }

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.registerFont("Inter", "fonts/NotoSans-Regular.ttf");
  doc.registerFont("Inter-Bold", "fonts/NotoSans-Bold.ttf");
  doc.registerFont("Inter-Italic", "fonts/NotoSans-Italic.ttf");
  const chunks: Uint8Array[] = [];
  doc.on("data", (c: Uint8Array) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const leftMargin = 50;
  const rightMargin = pageWidth - 50;
  const contentWidth = pageWidth - 100;

  function drawWatermark() {
    const wmWidth = 260;
    const wmHeight = wmWidth * (890 / 993);
    doc.save();
    doc.rotate(-28, { origin: [pageWidth / 2, pageHeight / 2] });
    doc.image("assets/jsey-watermark.png", pageWidth / 2 - wmWidth / 2, pageHeight / 2 - wmHeight / 2, { width: wmWidth, height: wmHeight });
    doc.restore();
  }
  drawWatermark();
  doc.on("pageAdded", drawWatermark);

  function drawGlobeIcon(cx: number, cy: number, r: number, color: string = GRAY) {
    doc.save();
    doc.lineWidth(0.75).strokeColor(color);
    doc.circle(cx, cy, r).stroke();
    doc.moveTo(cx - r, cy).lineTo(cx + r, cy).stroke();
    doc.moveTo(cx, cy - r).lineTo(cx, cy + r).stroke();
    doc.ellipse(cx, cy, r * 0.45, r).stroke();
    doc.ellipse(cx, cy, r * 0.85, r * 0.4).stroke();
    doc.restore();
  }
  function drawEnvelopeIcon(x: number, y: number, w: number, h: number, color: string = GRAY) {
    doc.save();
    doc.lineWidth(0.75).strokeColor(color);
    doc.rect(x, y, w, h).stroke();
    doc.moveTo(x, y).lineTo(x + w / 2, y + h * 0.62).lineTo(x + w, y).stroke();
    doc.moveTo(x, y + h).lineTo(x + w * 0.38, y + h * 0.48).stroke();
    doc.moveTo(x + w, y + h).lineTo(x + w * 0.62, y + h * 0.48).stroke();
    doc.restore();
  }

  function drawFooterWithIcons(legalTop: number) {
    doc.rect(leftMargin, legalTop, contentWidth, 70).lineWidth(1).strokeColor(LIGHT_BORDER).stroke();
    doc.font("Inter-Italic").fontSize(7.5).fillColor("#555").text(
      "This report reflects blockchain data available at the time of scan. J-SEY makes no claims of one hundred percent scam or honeypot detection accuracy, and this report does not constitute financial, legal, or investment advice. It is not a guarantee of safety, legitimacy, or profitability of any token or wallet referenced herein. Users act at their own risk and should conduct independent due diligence before any transaction.",
      leftMargin + 12, legalTop + 10, { width: contentWidth - 24 }
    );
    const barY = legalTop + 70 + 10;
    const barHeight = 26;
    const ICON_BLUE = "#6EC1E4";
    doc.rect(leftMargin, barY, contentWidth, barHeight).fillColor(NAVY).fill();
    const websiteText = "jsey.dpdns.org";
    const emailText = "support@jsey.dpdns.org";
    doc.fontSize(8).font("Inter");
    const wTextWidth = doc.widthOfString(websiteText);
    const eTextWidth = doc.widthOfString(emailText);
    const textY = barY + (barHeight - 8) / 2;
    const wClusterWidth = 16 + wTextWidth;
    const eClusterWidth = 16 + eTextWidth;
    const gapBetween = 65;
    const totalGroupWidth = wClusterWidth + gapBetween + eClusterWidth;
    const groupStartX = leftMargin + (contentWidth - totalGroupWidth) / 2;
    const wStartX = groupStartX;
    drawGlobeIcon(wStartX + 6, barY + barHeight / 2, 6, ICON_BLUE);
    doc.fillColor("#FFFFFF").text(websiteText, wStartX + 16, textY, { width: wTextWidth + 5 });
    const eStartX = groupStartX + wClusterWidth + gapBetween;
    drawEnvelopeIcon(eStartX, barY + barHeight / 2 - 5, 12, 8, ICON_BLUE);
    doc.fillColor("#FFFFFF").text(emailText, eStartX + 16, textY, { width: eTextWidth + 5 });
  }

  const lhWidth = 110;
  const lhHeight = lhWidth * (890 / 993);
  const lhX = (pageWidth - lhWidth) / 2;
  const lhY = 28;
  doc.image("assets/jsey-letterhead.png", lhX, lhY, { width: lhWidth, height: lhHeight });

  doc.fontSize(8).fillColor(GRAY).font("Inter").text(
    "Comprehensive blockchain intelligence and risk analysis report.",
    leftMargin, lhY + lhHeight + 8, { width: contentWidth, align: "center" }
  );

  const ruleY = lhY + lhHeight + 24;
  const rule = doc.linearGradient(leftMargin, ruleY, rightMargin, ruleY);
  rule.stop(0, "#0A1A4A").stop(0.5, "#3A6ED0").stop(1, "#0A1A4A");
  doc.rect(leftMargin, ruleY, contentWidth, 2.5).fill(rule);

  function drawDonutSegment(cx: number, cy: number, outerR: number, innerR: number, startAngle: number, endAngle: number, color: string) {
    if (endAngle <= startAngle) return;
    const steps = Math.max(2, Math.ceil((endAngle - startAngle) / (Math.PI / 60)));
    doc.save();
    doc.fillColor(color);
    doc.moveTo(cx + outerR * Math.sin(startAngle), cy - outerR * Math.cos(startAngle));
    for (let i = 1; i <= steps; i++) {
      const a = startAngle + (endAngle - startAngle) * (i / steps);
      doc.lineTo(cx + outerR * Math.sin(a), cy - outerR * Math.cos(a));
    }
    for (let i = steps; i >= 0; i--) {
      const a = startAngle + (endAngle - startAngle) * (i / steps);
      doc.lineTo(cx + innerR * Math.sin(a), cy - innerR * Math.cos(a));
    }
    doc.closePath();
    doc.fill();
    doc.restore();
  }

  const scanTime = new Date().toISOString().replace("T", " ").replace("Z", " UTC");

  if (reportType === "token") {
    doc.y = ruleY + 22;
    doc.x = leftMargin;
    doc.fontSize(14).fillColor(NAVY).font("Inter-Bold").text("Token Details", leftMargin, doc.y);
    doc.moveDown(0.3);
    const boxTop1 = doc.y;
    doc.rect(leftMargin, boxTop1, contentWidth, 78).strokeColor(LIGHT_BORDER).lineWidth(1).stroke();
    doc.fontSize(9).fillColor("#333").font("Inter");
    doc.text(`Address: ${sanitizeText(data.address) || "N/A"}`, leftMargin + 12, boxTop1 + 10, { width: contentWidth - 24 });
    doc.text(`Chain: ${sanitizeText(data.chain) || "N/A"}`, leftMargin + 12, boxTop1 + 30);
    doc.text(`Name: ${sanitizeText(data.tokenName) || "N/A"}`, leftMargin + 12, boxTop1 + 46);
    doc.text(`Symbol: ${sanitizeText(data.tokenSymbol) || "N/A"}`, leftMargin + 12, boxTop1 + 62);
    doc.y = boxTop1 + 78 + 16;
    doc.x = leftMargin;

    const level = (data.riskLevel || "UNKNOWN").toUpperCase();
    const levelColor = level === "HIGH" ? RED : level === "MEDIUM" ? GOLD : level === "LOW" ? GREEN : GRAY;
    doc.fontSize(14).fillColor(NAVY).font("Inter-Bold").text("Risk Assessment", leftMargin, doc.y);
    doc.moveDown(0.3);
    const boxTop2 = doc.y;
    const box2Height = data.riskScore !== undefined ? 90 : 40;
    doc.rect(leftMargin, boxTop2, contentWidth, box2Height).strokeColor(LIGHT_BORDER).lineWidth(1).stroke();
    doc.fontSize(18).fillColor(levelColor).font("Inter-Bold").text(level, leftMargin + 14, boxTop2 + 12);
    if (data.riskScore !== undefined) {
      const barY = boxTop2 + 44;
      const barWidth = contentWidth - 28;
      const pct = Math.max(0, Math.min(100, data.riskScore)) / 100;
      doc.fontSize(9).fillColor("#333").font("Inter").text(`Risk Score: ${data.riskScore} / 100`, leftMargin + 14, barY);
      doc.rect(leftMargin + 14, barY + 14, barWidth, 8).fillColor("#EEEEEE").fill();
      doc.rect(leftMargin + 14, barY + 14, barWidth * pct, 8).fillColor(levelColor).fill();
    }
    doc.y = boxTop2 + box2Height + 14;
    doc.x = leftMargin;

    if (data.summary) {
      doc.fontSize(9).fillColor("#555").font("Inter-Italic").text(sanitizeText(data.summary), leftMargin, doc.y, { width: contentWidth });
      doc.moveDown(0.5);
    }

    if (data.reasons && data.reasons.length) {
      doc.font("Inter-Bold").fontSize(12).fillColor(NAVY).text("Reasons:", leftMargin, doc.y);
      doc.moveDown(0.2);
      doc.font("Inter").fillColor("#333");
      data.reasons.forEach((r: string) => {
        doc.fontSize(9).text(`- ${sanitizeText(r)}`, leftMargin + 10, doc.y, { width: contentWidth - 20 });
      });
      doc.moveDown(0.4);
    }

    if (data.deployerData && data.deployerData.available) {
      doc.font("Inter-Bold").fontSize(12).fillColor(NAVY).text("Deployer Info:", leftMargin, doc.y);
      doc.moveDown(0.2);
      doc.font("Inter").fillColor("#333").fontSize(9);
      doc.text(`Wallet: ${sanitizeText(data.deployerData.deployerAddress) || "N/A"}`, leftMargin + 10, doc.y);
      if (data.deployerData.walletAgeDays !== undefined) doc.text(`Wallet age: ${data.deployerData.walletAgeDays} days`, leftMargin + 10, doc.y + 2);
      if (data.deployerData.otherTokensDeployedCount !== undefined) doc.text(`Other tokens deployed: ${data.deployerData.otherTokensDeployedCount}`, leftMargin + 10, doc.y + 2);
      doc.moveDown(0.6);
    }

    doc.fontSize(8).fillColor("#888").font("Inter").text(`Scan time: ${scanTime}`, leftMargin, doc.y);
    doc.moveDown(0.8);

    if (doc.y > pageHeight - 180) doc.addPage();
    drawFooterWithIcons(doc.y);

  } else if (reportType === "wallet") {
    const riskyTokens: any[] = data.riskyTokens || [];
    let highCount = 0, medCount = 0, lowCount = 0;
    for (const t of riskyTokens) {
      if (t.riskLevel === "HIGH") highCount++;
      else if (t.riskLevel === "MEDIUM") medCount++;
      else lowCount++;
    }
    const total = riskyTokens.length || 1;

    const indicatorDefs = [
      { key: "not locked", label: "Liquidity Not Locked", desc: "Can be removed by the deployer at any time" },
      { key: "not been renounced", label: "Ownership Not Renounced", desc: "Deployer retains control" },
      { key: "can mint new tokens", label: "Mint Function Enabled", desc: "Can mint new tokens, diluting holders" },
      { key: "sell tax", label: "High Sell Tax Detected", desc: "Potentially malicious tax configuration" },
      { key: "honeypot", label: "Honeypot Flagged", desc: "Token cannot be sold after buying" },
      { key: "holders control", label: "High Holder Concentration", desc: "Top holders control majority of supply" },
      { key: "other token(s)", label: "Repeat Offender Deployer", desc: "Deployer has a history of risky tokens" },
    ];
    const indicatorCounts = indicatorDefs.map((def) => {
      let count = 0;
      for (const t of riskyTokens) {
        if (t.reasons && t.reasons.some((r: string) => r.toLowerCase().includes(def.key))) count++;
      }
      return { ...def, count };
    }).filter((i) => i.count > 0).slice(0, 4);

    let y = ruleY + 22;

    doc.rect(leftMargin, y, contentWidth, 70).strokeColor(LIGHT_BORDER).lineWidth(1).stroke();
    const col2X = leftMargin + contentWidth * 0.45;
    const col3X = leftMargin + contentWidth * 0.72;
    const walletFull = data.wallet || "N/A";
    const walletDisplay = walletFull.length > 20 ? walletFull.slice(0, 10) + "..." + walletFull.slice(-8) : walletFull;
    doc.fontSize(8).fillColor(NAVY).font("Inter-Bold").text("WALLET", leftMargin + 12, y + 10);
    doc.fontSize(9).fillColor("#333").font("Inter").text(walletDisplay, leftMargin + 12, y + 22, { width: col2X - leftMargin - 20 });
    doc.fontSize(8).fillColor(NAVY).font("Inter-Bold").text("CHAIN", col2X, y + 10);
    doc.fontSize(9).fillColor("#333").font("Inter").text(sanitizeText(data.chain) || "N/A", col2X, y + 22, { width: contentWidth * 0.25 });
    doc.fontSize(8).fillColor(NAVY).font("Inter-Bold").text("TOKENS CHECKED", col3X, y + 10);
    doc.fontSize(9).fillColor("#333").font("Inter").text(String(data.tokensChecked ?? "N/A"), col3X, y + 22);
    doc.fontSize(8).fillColor(NAVY).font("Inter-Bold").text("RISKY TOKENS FOUND", col2X, y + 42);
    doc.fontSize(9).fillColor("#333").font("Inter").text(String(data.riskyCount ?? "N/A"), col2X, y + 54);
    y += 70 + 16;

    doc.rect(leftMargin, y, contentWidth, 22).fillColor(NAVY).fill();
    doc.fontSize(10).fillColor("#FFFFFF").font("Inter-Bold").text("RISK SUMMARY", leftMargin + 12, y + 6);
    y += 22;
    const summaryBoxTop = y;
    const summaryBoxHeight = 140;
    doc.rect(leftMargin, summaryBoxTop, contentWidth, summaryBoxHeight).strokeColor(LIGHT_BORDER).lineWidth(1).stroke();

    const cx = leftMargin + 70;
    const cy = summaryBoxTop + summaryBoxHeight / 2;
    const outerR = 50, innerR = 28;
    let angleCursor = 0;
    const highAngle = (highCount / total) * Math.PI * 2;
    const medAngle = (medCount / total) * Math.PI * 2;
    const lowAngle = (lowCount / total) * Math.PI * 2;
    drawDonutSegment(cx, cy, outerR, innerR, angleCursor, angleCursor + highAngle, RED); angleCursor += highAngle;
    drawDonutSegment(cx, cy, outerR, innerR, angleCursor, angleCursor + medAngle, GOLD); angleCursor += medAngle;
    drawDonutSegment(cx, cy, outerR, innerR, angleCursor, angleCursor + lowAngle, "#1E56A0");
    doc.fontSize(18).fillColor(NAVY).font("Inter-Bold").text(String(riskyTokens.length), cx - 30, cy - 16, { width: 60, align: "center" });
    doc.fontSize(7).fillColor(GRAY).font("Inter").text("TOTAL", cx - 30, cy + 6, { width: 60, align: "center" });

    const legendX = leftMargin + 150;
    let legendY = summaryBoxTop + 26;
    const legendRows = [
      { label: "HIGH RISK", color: RED, count: highCount },
      { label: "MEDIUM RISK", color: GOLD, count: medCount },
      { label: "LOW RISK", color: "#1E56A0", count: lowCount },
    ];
    legendRows.forEach((row) => {
      doc.circle(legendX + 4, legendY + 4, 4).fillColor(row.color).fill();
      doc.fontSize(9).fillColor("#333").font("Inter-Bold").text(row.label, legendX + 16, legendY, { continued: true });
      doc.font("Inter").text(`   ${row.count} (${((row.count / total) * 100).toFixed(1)}%)`);
      legendY += 24;
    });

    const rlX = leftMargin + 340;
    doc.fontSize(9).fillColor(NAVY).font("Inter-Bold").text("RISK LEVEL", rlX, summaryBoxTop + 16);
    const overallLevel = highCount > 0 ? "ELEVATED RISK" : medCount > 0 ? "MODERATE RISK" : "LOW RISK";
    const overallColor = highCount > 0 ? RED : medCount > 0 ? GOLD : GREEN;
    doc.fontSize(11).fillColor(overallColor).font("Inter-Bold").text(overallLevel, rlX, summaryBoxTop + 34, { width: rightMargin - rlX - 10 });
    const overallMsg = highCount > 0
      ? "A significant number of tokens exhibit potential risk factors. Exercise extreme caution."
      : medCount > 0
      ? "Some tokens show risk factors worth reviewing before proceeding."
      : "No major red flags detected across scanned tokens.";
    doc.fontSize(8).fillColor("#555").font("Inter").text(overallMsg, rlX, summaryBoxTop + 56, { width: rightMargin - rlX - 10 });

    y = summaryBoxTop + summaryBoxHeight + 16;

    const twoColY = y;
    const colWidth = (contentWidth - 16) / 2;
    const rightColX = leftMargin + colWidth + 16;
    doc.rect(leftMargin, twoColY, colWidth, 20).fillColor(NAVY).fill();
    doc.fontSize(9).fillColor("#FFFFFF").font("Inter-Bold").text("KEY RISK INDICATORS", leftMargin + 10, twoColY + 5);
    doc.rect(rightColX, twoColY, colWidth, 20).fillColor(NAVY).fill();
    doc.fontSize(9).fillColor("#FFFFFF").font("Inter-Bold").text("SCAN INFORMATION", rightColX + 10, twoColY + 5);

    const boxesY = twoColY + 20;
    const boxesHeight = 160;
    doc.rect(leftMargin, boxesY, colWidth, boxesHeight).strokeColor(LIGHT_BORDER).lineWidth(1).stroke();
    doc.rect(rightColX, boxesY, colWidth, boxesHeight).strokeColor(LIGHT_BORDER).lineWidth(1).stroke();

    let indY = boxesY + 14;
    if (indicatorCounts.length === 0) {
      doc.fontSize(9).fillColor("#555").font("Inter-Italic").text("No common risk patterns detected.", leftMargin + 12, indY, { width: colWidth - 24 });
    } else {
      indicatorCounts.forEach((ind) => {
        doc.fontSize(9).fillColor("#222").font("Inter-Bold").text(ind.label, leftMargin + 12, indY, { width: colWidth - 60 });
        doc.fontSize(11).fillColor(RED).font("Inter-Bold").text(String(ind.count), leftMargin + colWidth - 40, indY, { width: 28, align: "right" });
        doc.fontSize(7.5).fillColor("#777").font("Inter").text(ind.desc, leftMargin + 12, doc.y, { width: colWidth - 24 });
        indY = doc.y + 10;
      });
    }

    let infoY = boxesY + 14;
    const infoRows = [
      { label: "Scan Time", value: scanTime },
      { label: "Analysis Engine", value: "J-SEY Risk Engine" },
      { label: "Data Sources", value: "On-chain + Heuristics" },
      { label: "Report Type", value: "Wallet Scan" },
    ];
    infoRows.forEach((row) => {
      doc.fontSize(8.5).fillColor("#333").font("Inter-Bold").text(row.label, rightColX + 12, infoY, { width: colWidth - 24 });
      doc.fontSize(8.5).fillColor("#555").font("Inter").text(row.value, rightColX + 12, doc.y, { width: colWidth - 24 });
      infoY = doc.y + 10;
    });

    y = boxesY + boxesHeight + 16;
    doc.y = y;
    doc.x = leftMargin;

    if (riskyTokens.length) {
      const groups = new Map<string, any[]>();
      for (const t of riskyTokens) {
        const key = sanitizeText(t.chain) || "Unknown Chain";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(t);
      }
      const CHAIN_COLORS: Record<string, string> = {
        "ETHEREUM": "#627EEA",
        "BNB CHAIN": "#F3BA2F",
        "BSC": "#F3BA2F",
        "BASE": "#0052FF",
        "POLYGON": "#8247E5",
        "OPTIMISM": "#FF0420",
        "ARBITRUM": "#28A0F0",
        "LINEA": "#121212",
      };
      function autoChainColor(name: string): string {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
        const hue = hash % 360;
        const c = Math.round(0.65 * 255);
        function hslToRgb(h: number, s: number, l: number) {
          const a = s * Math.min(l, 1 - l);
          const f = (n: number) => {
            const k = (n + h / 30) % 12;
            return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
          };
          return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
        }
        const [r, g, b] = hslToRgb(hue, 0.65, 0.42);
        return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      }
      for (const [chainName, tokens] of groups) {
        doc.addPage();
        doc.x = leftMargin;
        const chainKey = chainName.toUpperCase();
        const chainColor = CHAIN_COLORS[chainKey] || autoChainColor(chainKey);
        doc.font("Inter-Bold").fontSize(16);
        const chainLabelWidth = doc.widthOfString(chainName.toUpperCase());
        doc.fillColor(chainColor).text(chainName.toUpperCase(), leftMargin, doc.y);
        const underlineY = doc.y + 2;
        doc.rect(leftMargin, underlineY, chainLabelWidth, 3).fillColor(chainColor).fill();
        doc.moveDown(0.6);
        doc.font("Inter-Bold").fontSize(11).fillColor(GRAY).text(`Risky Tokens (${tokens.length})`, leftMargin, doc.y);
        doc.moveDown(0.4);
        tokens.forEach((t: any) => {
          if (doc.y > pageHeight - 100) doc.addPage();
          const rColor = t.riskLevel === "HIGH" ? RED : t.riskLevel === "MEDIUM" ? GOLD : GREEN;
          doc.x = leftMargin;
          doc.fontSize(11).fillColor("#111").font("Inter-Bold").text(`${sanitizeText(t.tokenName || t.token)} (${sanitizeText(t.tokenSymbol || "")}) `, leftMargin, doc.y, { continued: true });
          doc.fillColor(rColor).text(t.riskLevel);
          doc.font("Inter").fillColor("#555");
          if (t.reasons) t.reasons.forEach((r: string) => {
            doc.fontSize(9).text(`- ${sanitizeText(r)}`, leftMargin + 14, doc.y, { width: contentWidth - 14 });
          });
          doc.x = leftMargin;
          doc.moveDown(0.3);
        });
      }
    }

    if (doc.y > pageHeight - 170) doc.addPage();
    const legalTop = doc.y;
    drawFooterWithIcons(legalTop);
  }

  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}
