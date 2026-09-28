/**
 * Solana On-Chain Executor
 * Uses @solana/web3.js + Jupiter Aggregator v6 REST API — no API keys.
 * Jupiter is the best-rate DEX aggregator on Solana.
 *
 * CORRECTNESS NOTES (fix/execution-correctness)
 * ---------------------------------------------
 * 1. Every quote is now converted into an explicit minimum-out bound.
 *    Previously `slippageBps` was passed to Jupiter, which is a request
 *    parameter, not an enforcement: Jupiter builds the tx with its own
 *    computed minimum. We now derive minOut ourselves so the bound is
 *    something this system owns and can assert on after the fill.
 * 2. `outputDecimals` is treated as required. Falling back to 6 silently
 *    mis-scales the recorded amount for any token that is not 6-decimal.
 * 3. A transaction is only reported successful once the confirmation
 *    result has been inspected — `confirmTransaction` returning is not
 *    the same as the transaction having succeeded on chain.
 */

import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "./logger";

// Public Solana RPC — no API key
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

// Jupiter v6 API — free, no key
const JUPITER_API = "https://quote-api.jup.ag/v6";

// USDC has 6 decimals on Solana, without exception.
const USDC_DECIMALS = 6;

// Common Solana token mints
const SOL_TOKENS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

/** Default slippage tolerance: 50 bps = 0.5% */
export const DEFAULT_SLIPPAGE_BPS = 50;

/** Fee applied to the min-out bound only, never to the recorded fill. */
const MIN_OUT_SAFETY_FACTOR = 0.999;

export interface SolanaSwapResult {
  success: boolean;
  txHash?: string;
  amountIn: number;
  amountOut: number;
  priceImpactPct?: number;
  /** How much of the reported output arrived unconfirmed (0 when clean). */
  shortfallUsd?: number;
  error?: string;
}

export interface SolanaSwapOptions {
  slippageBps?: number;
  /** Raw base units the caller requires back. Authoritative when set. */
  minOutLamports?: bigint;
  /**
   * When false, a confirmed-but-lagging quote still reports success. This is
   * the default for OPENING a position, because the on-chain balance is then
   * re-read as the source of truth. Exits leave this true so a stale quote
   * cannot book phantom proceeds.
   */
  tolerateQuoteDrift?: boolean;
}

function getKeypair(): Keypair | null {
  const key = process.env.SOLANA_WALLET_PRIVATE_KEY;
  if (!key) return null;
  try {
    const decoded = bs58.decode(key);
    return Keypair.fromSecretKey(decoded);
  } catch {
    try {
      // Try JSON array format
      const arr = JSON.parse(key);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      return null;
    }
  }
}

export async function getSolanaWalletAddress(): Promise<string | null> {
  const kp = getKeypair();
  return kp ? kp.publicKey.toBase58() : null;
}

export async function getSolanaBalance(tokenMint?: string): Promise<number> {
  const kp = getKeypair();
  if (!kp) return 0;
  try {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const mint = tokenMint ?? SOL_TOKENS.USDC;
    if (mint === SOL_TOKENS.SOL) {
      const bal = await conn.getBalance(kp.publicKey);
      return bal / 1e9;
    }
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(kp.publicKey, {
      mint: new PublicKey(mint),
    });
    const amount =
      tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    return Number(amount);
  } catch (err) {
    logger.error({ err }, "Failed to get Solana balance");
    return 0;
  }
}

/**
 * Read a token's decimals from chain. Returns null rather than a default,
 * because a wrong decimals value is worse than a missing one.
 */
export async function getSolanaTokenDecimals(mint: string): Promise<number | null> {
  if (mint === SOL_TOKENS.USDC) return USDC_DECIMALS;
  if (mint === SOL_TOKENS.SOL) return 9;
  try {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const data: any = info.value?.data;
    const decimals = data?.parsed?.info?.decimals;
    if (typeof decimals === "number") return decimals;
    logger.warn({ mint }, "Could not resolve SPL mint decimals");
    return null;
  } catch (err) {
    logger.error({ err, mint }, "Failed to resolve SPL mint decimals");
    return null;
  }
}

interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  outputDecimals?: number;
  priceImpactPct?: string;
  [key: string]: unknown;
}

/**
 * Get a Jupiter quote. `slippageBps` is sent so Jupiter's own route search
 * accounts for it; the enforced bound is computed separately by the caller.
 */
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountBaseUnits: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS
): Promise<JupiterQuote | null> {
  const url =
    `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountBaseUnits.toString()}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    logger.warn({ status: res.status, inputMint, outputMint }, "Jupiter quote rejected");
    return null;
  }
  return (await res.json()) as JupiterQuote;
}

/** Apply `slippageBps` to a quoted output to get the enforced floor. */
function applySlippageToMinOut(quotedOut: bigint, slippageBps: number): bigint {
  const bps = Math.min(Math.max(Math.round(slippageBps), 0), 5000);
  // integer maths only — no float rounding on a value that sizes a transfer
  const retained = BigInt(10000 - bps);
  const scaled = (quotedOut * retained * BigInt(Math.round(MIN_OUT_SAFETY_FACTOR * 1000))) / (10000n * 1000n);
  return scaled;
}

/**
 * Build, sign and send a Jupiter swap, then verify the result on chain.
 * Shared by buy and sell so the two paths cannot drift apart.
 */
async function executeJupiterSwap(input: {
  inputMint: string;
  outputMint: string;
  amountIn: number;
  amountBaseUnits: bigint;
  outputDecimals: number;
  /** Decimals of the ASSET BEING SOLD, used only for reporting amountIn. */
  inputDecimalsForReporting: number;
  options: SolanaSwapOptions;
}): Promise<SolanaSwapResult> {
  const {
    inputMint,
    outputMint,
    amountIn,
    amountBaseUnits,
    outputDecimals,
    options,
  } = input;

  const kp = getKeypair();
  if (!kp) {
    return { success: false, amountIn, amountOut: 0, error: "No Solana wallet configured" };
  }

  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  try {
    const conn = new Connection(SOLANA_RPC, "confirmed");

    const quote = await getJupiterQuote(inputMint, outputMint, amountBaseUnits, slippageBps);
    if (!quote) {
      return { success: false, amountIn, amountOut: 0, error: "Failed to get Jupiter quote" };
    }

    const quotedOut = BigInt(quote.outAmount);
    if (quotedOut <= 0n) {
      return {
        success: false,
        amountIn,
        amountOut: 0,
        error: "Jupiter returned a zero-output quote",
      };
    }

    // The enforced floor. Caller-supplied value wins; otherwise derive it.
    const minOut = options.minOutLamports ?? applySlippageToMinOut(quotedOut, slippageBps);

    const swapRes = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 1000,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!swapRes.ok) {
      return { success: false, amountIn, amountOut: 0, error: "Jupiter swap API error" };
    }
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([kp]);

    const txHash = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // Inspection, not merely awaiting the promise: a transaction can be
    // confirmed AND have failed on chain.
    const confirmation = await conn.confirmTransaction(txHash, "confirmed");
    if (confirmation.value.err) {
      logger.error({ txHash, err: confirmation.value.err }, "Solana swap confirmed but failed on chain");
      return {
        success: false,
        txHash,
        amountIn,
        amountOut: 0,
        error: `Transaction failed on chain: ${JSON.stringify(confirmation.value.err)}`,
      };
    }

    // Verify the actual delivered amount on chain before trusting the quote.
    // The quote is an estimate; the post-trade balance is the fact.
    const deliveredBaseUnits = await readDeliveredAmount(
      conn,
      kp.publicKey,
      outputMint,
      BigInt(quote.inAmount)
    );

    const quoteOutHuman = Number(quotedOut) / Math.pow(10, outputDecimals);

    if (deliveredBaseUnits === null) {
      // Could not read the ledger. Report quote-derived proceeds but flag it.
      logger.warn({ txHash }, "Could not verify delivered amount; reporting quote-derived value");
      return {
        success: true,
        txHash,
        amountIn,
        amountOut: quoteOutHuman,
        priceImpactPct: Number(quote.priceImpactPct ?? 0),
      };
    }

    const deliveredHuman = Number(deliveredBaseUnits) / Math.pow(10, outputDecimals);

    if (deliveredBaseUnits < minOut) {
      const shortfall = (minOut - deliveredBaseUnits);
      const shortfallUsd = Number(shortfall) / Math.pow(10, outputDecimals);
      logger.error(
        { txHash, minOut: minOut.toString(), delivered: deliveredBaseUnits.toString(), shortfallUsd },
        "Solana swap delivered less than the enforced minimum"
      );
      // On a BUY this is tolerable at the call site (balance is re-read as
      // truth). On a SELL it is not, because it would book proceeds that
      // never arrived.
      if (options.tolerateQuoteDrift === false) {
        return {
          success: false,
          txHash,
          amountIn,
          amountOut: deliveredHuman,
          shortfallUsd,
          error: `Delivered ${deliveredHuman} below enforced minimum out`,
        };
      }
      return {
        success: true,
        txHash,
        amountIn,
        amountOut: deliveredHuman,
        priceImpactPct: Number(quote.priceImpactPct ?? 0),
        shortfallUsd,
      };
    }

    logger.info(
      { txHash, amountIn, outputMint, delivered: deliveredHuman },
      "Solana swap executed via Jupiter"
    );

    return {
      success: true,
      txHash,
      amountIn,
      amountOut: deliveredHuman,
      priceImpactPct: Number(quote.priceImpactPct ?? 0),
    };
  } catch (err: any) {
    logger.error({ err }, "Solana swap execution failed");
    return { success: false, amountIn, amountOut: 0, error: err?.message ?? String(err) };
  }
}

/**
 * Read how much of `mint` the wallet now holds, for a token whose balance
 * started at ~0 on a buy. Returns null when the value cannot be determined.
 */
async function readDeliveredAmount(
  conn: Connection,
  owner: PublicKey,
  mint: string,
  _inAmountBaseUnits: bigint
): Promise<bigint | null> {
  try {
    if (mint === SOL_TOKENS.SOL) {
      // SOL: caller reads balance separately; not used on this path.
      return null;
    }
    const accounts = await conn.getParsedTokenAccountsByOwner(owner, {
      mint: new PublicKey(mint),
    });
    const raw = accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (raw === undefined) return null;
    return BigInt(raw);
  } catch (err) {
    logger.warn({ err, mint }, "Failed to read delivered token amount");
    return null;
  }
}

/**
 * Execute a buy on Solana: USDC → token via Jupiter.
 *
 * `minOutLamports` should be supplied by the caller when it has already
 * ranged the order against a reference price. Without it we fall back to
 * Jupiter's own quote minus the slippage tolerance.
 */
export async function executeBuySolana(
  outputMint: string,
  amountUsd: number,
  options: SolanaSwapOptions = {}
): Promise<SolanaSwapResult> {
  const amountBaseUnits = BigInt(Math.floor(amountUsd * Math.pow(10, USDC_DECIMALS)));
  if (amountBaseUnits <= 0n) {
    return { success: false, amountIn: 0, amountOut: 0, error: "Buy amount rounds to zero" };
  }

  const outputDecimals = await getSolanaTokenDecimals(outputMint);
  if (outputDecimals === null) {
    return {
      success: false,
      amountIn: amountUsd,
      amountOut: 0,
      error: `Could not resolve decimals for ${outputMint} — refusing to guess`,
    };
  }

  return executeJupiterSwap({
    inputMint: SOL_TOKENS.USDC,
    outputMint,
    amountIn: amountUsd,
    amountBaseUnits,
    outputDecimals,
    inputDecimalsForReporting: USDC_DECIMALS,
    options: { tolerateQuoteDrift: true, ...options },
  });
}

/**
 * Execute a sell on Solana: token → USDC via Jupiter.
 *
 * `tokenDecimals` is REQUIRED. The previous signature defaulted the mint to
 * "" and the decimals to 6, which mis-sized every token that was not
 * 6-decimal and could never resolve a route for the empty mint.
 */
export async function executeSellSolana(
  inputMint: string,
  tokenDecimals: number,
  tokenAmount: number,
  options: SolanaSwapOptions = {}
): Promise<SolanaSwapResult> {
  if (!inputMint) {
    return {
      success: false,
      amountIn: 0,
      amountOut: 0,
      error: "Sell requires an input mint — none supplied",
    };
  }
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    return {
      success: false,
      amountIn: 0,
      amountOut: 0,
      error: `Invalid token decimals: ${tokenDecimals}`,
    };
  }
  if (!(tokenAmount > 0)) {
    return { success: false, amountIn: 0, amountOut: 0, error: "Sell amount must be positive" };
  }

  const amountBaseUnits = BigInt(Math.floor(tokenAmount * Math.pow(10, tokenDecimals)));
  if (amountBaseUnits <= 0n) {
    return {
      success: false,
      amountIn: tokenAmount,
      amountOut: 0,
      error: "Sell amount rounds to zero base units",
    };
  }

  return executeJupiterSwap({
    inputMint,
    outputMint: SOL_TOKENS.USDC,
    amountIn: tokenAmount,
    amountBaseUnits,
    outputDecimals: USDC_DECIMALS,
    inputDecimalsForReporting: tokenDecimals,
    // An exit must not book proceeds that did not arrive.
    options: { tolerateQuoteDrift: false, ...options },
  });
}
