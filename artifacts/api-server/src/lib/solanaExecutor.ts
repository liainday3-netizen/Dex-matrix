/**
 * Solana On-Chain Executor
 * Uses @solana/web3.js + Jupiter Aggregator v6 REST API — no API keys.
 * Jupiter is the best-rate DEX aggregator on Solana.
 */

import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "./logger";

// Public Solana RPC — no API key
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

// Jupiter v6 API — free, no key
const JUPITER_API = "https://quote-api.jup.ag/v6";

// Common Solana token mints
const SOL_TOKENS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

export interface SolanaSwapResult {
  success: boolean;
  txHash?: string;
  amountIn: number;
  amountOut: number;
  priceImpactPct?: number;
  error?: string;
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
    const amount = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    return Number(amount);
  } catch (err) {
    logger.error({ err }, "Failed to get Solana balance");
    return 0;
  }
}

/**
 * Get Jupiter quote for a swap
 */
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps: number = 50
): Promise<any | null> {
  const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amountLamports)}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Execute a buy on Solana: USDC → token via Jupiter
 */
export async function executeBuySolana(
  outputMint: string,
  amountUsd: number,
  slippagePct: number = 0.5
): Promise<SolanaSwapResult> {
  const kp = getKeypair();
  if (!kp) return { success: false, amountIn: 0, amountOut: 0, error: "No Solana wallet configured" };

  try {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const slippageBps = Math.round(slippagePct * 100);

    // USDC has 6 decimals on Solana
    const amountLamports = Math.floor(amountUsd * 1_000_000);

    const quote = await getJupiterQuote(SOL_TOKENS.USDC, outputMint, amountLamports, slippageBps);
    if (!quote) return { success: false, amountIn: amountUsd, amountOut: 0, error: "Failed to get Jupiter quote" };

    // Get swap transaction
    const swapRes = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 1000, // small priority fee for inclusion
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!swapRes.ok) return { success: false, amountIn: amountUsd, amountOut: 0, error: "Jupiter swap API error" };
    const { swapTransaction } = await swapRes.json() as { swapTransaction: string };

    // Deserialize and sign
    const txBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([kp]);

    const rawTx = tx.serialize();
    const txHash = await conn.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction(txHash, "confirmed");

    const outAmount = Number(quote.outAmount) / Math.pow(10, quote.outputDecimals ?? 6);
    logger.info({ txHash, amountUsd, outputMint }, "Solana BUY executed via Jupiter");

    return {
      success: true,
      txHash,
      amountIn: amountUsd,
      amountOut: outAmount,
      priceImpactPct: Number(quote.priceImpactPct ?? 0),
    };
  } catch (err: any) {
    logger.error({ err }, "Solana buy execution failed");
    return { success: false, amountIn: amountUsd, amountOut: 0, error: err?.message ?? String(err) };
  }
}

/**
 * Execute a sell on Solana: token → USDC via Jupiter
 */
export async function executeSellSolana(
  inputMint: string,
  tokenDecimals: number,
  tokenAmount: number,
  slippagePct: number = 0.5
): Promise<SolanaSwapResult> {
  const kp = getKeypair();
  if (!kp) return { success: false, amountIn: 0, amountOut: 0, error: "No Solana wallet configured" };

  try {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const slippageBps = Math.round(slippagePct * 100);
    const amountLamports = Math.floor(tokenAmount * Math.pow(10, tokenDecimals));

    const quote = await getJupiterQuote(inputMint, SOL_TOKENS.USDC, amountLamports, slippageBps);
    if (!quote) return { success: false, amountIn: tokenAmount, amountOut: 0, error: "Failed to get Jupiter quote" };

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

    if (!swapRes.ok) return { success: false, amountIn: tokenAmount, amountOut: 0, error: "Jupiter swap API error" };
    const { swapTransaction } = await swapRes.json() as { swapTransaction: string };

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([kp]);

    const txHash = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await conn.confirmTransaction(txHash, "confirmed");

    const outAmount = Number(quote.outAmount) / 1_000_000; // USDC 6 decimals
    logger.info({ txHash, tokenAmount, inputMint }, "Solana SELL executed via Jupiter");

    return {
      success: true,
      txHash,
      amountIn: tokenAmount,
      amountOut: outAmount,
      priceImpactPct: Number(quote.priceImpactPct ?? 0),
    };
  } catch (err: any) {
    logger.error({ err }, "Solana sell execution failed");
    return { success: false, amountIn: tokenAmount, amountOut: 0, error: err?.message ?? String(err) };
  }
}
