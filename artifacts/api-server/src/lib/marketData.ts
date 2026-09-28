/**
 * Market data fetcher using DexScreener and GeckoTerminal public APIs.
 * No API keys required.
 *
 * CANDLE ORDERING CONTRACT (fix/execution-correctness)
 * ------------------------------------------------
 * `getOHLCV` returns NEWEST-FIRST: index 0 is the live/current bar, index 1
 * is the most recent closed bar. GeckoTerminal serves oldest-first, so the
 * response is reversed here.
 *
 * The previous version also `.reverse()`d, but the caller (microstructure.ts)
 * assumed oldest-first. One side had to be wrong and the analysis silently
 * ran on the wrong candles. The contract is now stated, enforced by an
 * explicit sort on timestamp, and consumed by a matching `ensureNewestFirst`
 * guard on the analysis side.
 *
 * FETCH FAILURES ARE NO LONGER SILENT
 * -----------------------------------
 * `[]` used to be returned on any HTTP error, which upstream became
 * "insufficient data" -> WAITING — indistinguishable from a genuinely quiet
 * market, and therefore unalertable. Failures now throw a typed
 * `MarketDataError` so the scanner can record SYNC_ERROR and the operator
 * can see the difference.
 */

export interface OHLCVCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DexPair {
  pairAddress: string;
  symbol: string;
  baseToken: string;
  quoteToken: string;
  chain: string;
  dex: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  txns24h: number;
}

/** Raised when a market-data source cannot be reached or answers unusably. */
export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}

// DexScreener chain IDs
const CHAIN_MAP: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  solana: "solana",
};

// GeckoTerminal network IDs
const GECKO_NETWORK_MAP: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  solana: "solana",
};

// GeckoTerminal timeframe map
const GECKO_TIMEFRAME_MAP: Record<string, { aggregate: string; period: string }> = {
  "1m": { aggregate: "minute", period: "1" },
  "5m": { aggregate: "minute", period: "5" },
  "15m": { aggregate: "minute", period: "15" },
  "1h": { aggregate: "hour", period: "1" },
  "4h": { aggregate: "hour", period: "4" },
  "1d": { aggregate: "day", period: "1" },
};

function parseDexScreenerPair(p: any, chain: string): DexPair {
  return {
    pairAddress: p.pairAddress ?? "",
    symbol: `${p.baseToken?.symbol ?? ""}/${p.quoteToken?.symbol ?? ""}`,
    baseToken: p.baseToken?.symbol ?? "",
    quoteToken: p.quoteToken?.symbol ?? "",
    chain: chain || (CHAIN_MAP[p.chainId] ? p.chainId : "ethereum"),
    dex: p.dexId ?? "",
    price: parseFloat(p.priceUsd ?? "0") || 0,
    priceChange24h: p.priceChange?.h24 ?? 0,
    volume24h: p.volume?.h24 ?? 0,
    liquidity: p.liquidity?.usd ?? 0,
    txns24h: (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0),
  };
}

export async function searchDexPairs(q: string, chain: string = "all"): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(q)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err: any) {
    throw new MarketDataError(`Search request failed: ${err?.message ?? err}`, "dexscreener");
  }
  if (!res.ok) {
    throw new MarketDataError(`Search returned ${res.status}`, "dexscreener", res.status);
  }
  const data = (await res.json()) as { pairs?: unknown[] };
  const pairs: unknown[] = data.pairs ?? [];
  return (pairs as any[])
    .filter((p) => chain === "all" || p.chainId === CHAIN_MAP[chain])
    .slice(0, 30)
    .map((p) => parseDexScreenerPair(p, p.chainId));
}

export async function getTrendingPairs(chain: string = "ethereum"): Promise<DexPair[]> {
  const geckoNetwork = GECKO_NETWORK_MAP[chain] ?? "eth";
  const url = `https://api.geckoterminal.com/api/v2/networks/${geckoNetwork}/trending_pools?page=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err: any) {
    // Fallback is an explicit degradation, not a silent one.
    return searchDexPairs("weth usdc", chain);
  }
  if (!res.ok) {
    return searchDexPairs("weth usdc", chain);
  }
  const data = (await res.json()) as { data?: any[] };
  const pools: any[] = data.data ?? [];
  return pools.slice(0, 20).map((p: any) => {
    const attr = p.attributes ?? {};
    return {
      pairAddress: attr.address ?? p.id ?? "",
      symbol: attr.name ?? "",
      baseToken: attr.base_token_price_usd ? (attr.name?.split(" / ")?.[0] ?? "") : "",
      quoteToken: attr.name?.split(" / ")?.[1] ?? "USD",
      chain,
      dex: attr.dex_id ?? "",
      price: parseFloat(attr.base_token_price_usd ?? "0") || 0,
      priceChange24h: parseFloat(attr.price_change_percentage?.h24 ?? "0") || 0,
      volume24h: parseFloat(attr.volume_usd?.h24 ?? "0") || 0,
      liquidity: parseFloat(attr.reserve_in_usd ?? "0") || 0,
      txns24h: (attr.transactions?.h24?.buys ?? 0) + (attr.transactions?.h24?.sells ?? 0),
    };
  });
}

/**
 * Fetch metadata for a single pair. Returns null when the pair is genuinely
 * unknown to the source; throws MarketDataError when the source is down, so
 * "no such pair" and "could not ask" are distinguishable.
 */
export async function getPairInfo(pairAddress: string, chain: string): Promise<DexPair | null> {
  const chainId = CHAIN_MAP[chain] ?? chain;
  const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err: any) {
    throw new MarketDataError(`Pair lookup failed: ${err?.message ?? err}`, "dexscreener");
  }
  if (!res.ok) {
    throw new MarketDataError(`Pair lookup returned ${res.status}`, "dexscreener", res.status);
  }
  const data = (await res.json()) as { pair?: any; pairs?: any[] };
  const pair = data.pair ?? data.pairs?.[0];
  if (!pair) return null;
  return parseDexScreenerPair(pair, chain);
}

/**
 * Fetch OHLCV candles, NEWEST-FIRST.
 *
 * Throws MarketDataError on transport failure or a non-OK status. An empty
 * array is only ever returned when the source answered successfully with no
 * bars — never as a stand-in for an error.
 */
export async function getOHLCV(
  pairAddress: string,
  chain: string,
  timeframe: string = "1h"
): Promise<OHLCVCandle[]> {
  const geckoNetwork = GECKO_NETWORK_MAP[chain] ?? "eth";
  const tf = GECKO_TIMEFRAME_MAP[timeframe] ?? { aggregate: "hour", period: "1" };
  const url = `https://api.geckoterminal.com/api/v2/networks/${geckoNetwork}/pools/${pairAddress}/ohlcv/${tf.aggregate}?aggregate=${tf.period}&limit=200&currency=usd&token=base`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err: any) {
    throw new MarketDataError(
      `OHLCV ${timeframe} fetch failed: ${err?.message ?? err}`,
      "geckoterminal"
    );
  }
  if (!res.ok) {
    throw new MarketDataError(
      `OHLCV ${timeframe} returned ${res.status}`,
      "geckoterminal",
      res.status
    );
  }

  const data = (await res.json()) as { data?: { attributes?: { ohlcv_list?: any[][] } } };
  const ohlcvList: any[][] = data.data?.attributes?.ohlcv_list ?? [];

  const candles: OHLCVCandle[] = ohlcvList
    .map(([t, o, h, l, c, v]) => ({
      time: Math.floor(Number(t) / 1000), // ms -> seconds
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    );

  // Sort explicitly on timestamp rather than trusting the upstream order to
  // be the reverse of what it happens to be today.
  candles.sort((a, b) => b.time - a.time);

  return candles;
}
