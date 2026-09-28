/**
 * IronHawk Trade Executor
 * Bridges the microstructure signal engine -> on-chain execution.
 * Handles EVM (Ethereum, Base) and Solana chains.
 *
 * REWRITTEN (fix/execution-correctness)
 * -------------------------------------
 * This file is where the two halves of the system met, and it silently
 * disagreed with both.
 *
 * ENTRY
 * - The executor returned amountOut = 0, so positions.tokenAmountOut was
 *   stored as 0. Everything downstream then sized off zero.
 * - decimals were guessed (6 for Solana, 18 for EVM) at the call site. The
 *   real precision is now resolved on chain before the order is placed and
 *   persisted on the position, so the exit never guesses.
 * - No reference price was passed, so no minimum-output bound could exist.
 * - A failed transaction still wrote a position row, with entryPrice taken
 *   from the scanner's CACHED price rather than a fill.
 *
 * EXIT
 * - closePosition computed amountToClose = tokenAmountOut * pct, and
 *   tokenAmountOut was 0, so it sold nothing, every time.
 * - It passed "" as the Solana input mint, and defaulted decimals to 6.
 * - It passed pair.pairAddress as the EVM token to sell. pairAddress is the
 *   POOL address, not the token contract.
 * - exitAmountUsd fell back to the scanner's cached price, so realised P&L
 *   was computed from a quote that was never traded at.
 * - Nothing prevented two scanner ticks closing the same position twice.
 *
 * MONITORING
 * - Stop-loss was evaluated against the scanner's cached price, up to a full
 *   scan interval stale -- exactly when it matters most.
 */

import { db, positionsTable, watchedPairsTable } from "@workspace/db";
import { eq, and, sql, inArray, isNull, or, lt } from "drizzle-orm";
import { logger } from "./logger";
import { calculatePositionSize, recordTradeResult, canOpenPosition } from "./capitalScaling";
import {
  executeBuyEVM,
  executeSellEVM,
  getErc20Decimals,
  getTokenBalance,
  getWalletAddress,
  getWalletBalance,
  DEFAULT_SLIPPAGE_PCT,
} from "./evmExecutor";
import {
  executeBuySolana,
  executeSellSolana,
  getSolanaTokenDecimals,
  getSolanaBalance,
  getSolanaWalletAddress,
  DEFAULT_SLIPPAGE_BPS,
} from "./solanaExecutor";
import { getPairInfo } from "./marketData";
import type { Address } from "viem";

/** How long a position may sit claimed by a close before the claim expires. */
const CLOSE_LOCK_STALE_MS = 2 * 60 * 1000;

/**
 * Slippage tolerance applied to exits. Wider than entries: an exit that
 * fails to fill is worse than an exit that fills slightly worse.
 */
const EXIT_SLIPPAGE_MULTIPLIER = 3;

const SOL_MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface ExecuteSignalOptions {
  pairId: number;
  direction: "BUY" | "SELL";
  /** The TOKEN's contract/mint. Not the pool address. */
  tokenAddress: string;
  tokenDecimals?: number;
  obHigh: number;
  obLow: number;
  ltfMessage: string;
  signalId?: number;
  /** Live price at decision time, used to range the order. */
  referencePriceUsd?: number;
}

export interface ExecuteSignalResult {
  success: boolean;
  positionId?: number;
  txHash?: string;
  error?: string;
  positionSizeUsd?: number;
  shortfallUsd?: number;
}

/**
 * Resolve token precision. Returns null rather than a default -- a wrong
 * decimals value mis-sizes an order by orders of magnitude, which is worse
 * than refusing to trade.
 */
async function resolveEvmDecimals(chain: string, tokenAddress: string): Promise<number | null> {
  try {
    const { createPublicClient, http } = await import("viem");
    const { mainnet, base } = await import("viem/chains");
    const viemChain = chain === "base" ? base : mainnet;
    const rpc =
      chain === "base"
        ? "https://base.publicnode.com"
        : "https://ethereum.publicnode.com";
    const client = createPublicClient({ chain: viemChain, transport: http(rpc) });
    return await getErc20Decimals(client, tokenAddress as Address);
  } catch (err) {
    logger.warn({ err, chain, tokenAddress }, "Failed to resolve EVM token decimals");
    return null;
  }
}

/**
 * Live USD price for a pair, from DexScreener. Never falls back to a cached
 * value for a decision -- a stale price is the defect this rewrite removes.
 */
async function livePriceForPair(
  pairAddress: string,
  chain: string
): Promise<{ price: number; symbol: string | null } | null> {
  try {
    const info = await getPairInfo(pairAddress, chain);
    if (!info || !(info.price > 0)) return null;
    return { price: info.price, symbol: info.symbol };
  } catch (err) {
    logger.warn({ err, pairAddress, chain }, "Live price lookup failed");
    return null;
  }
}

export async function executeSignal(opts: ExecuteSignalOptions): Promise<ExecuteSignalResult> {
  const pair = await db
    .select()
    .from(watchedPairsTable)
    .where(eq(watchedPairsTable.id, opts.pairId))
    .then((r) => r[0]);

  if (!pair) return { success: false, error: "Pair not found" };

  const chain = pair.chain;

  // ---- GATE. Every entry passes through here. ----------------------------
  const { allowed, reason } = await canOpenPosition(chain);
  if (!allowed) {
    logger.warn({ chain, pairId: pair.id, reason }, "Entry refused");
    return { success: false, error: reason };
  }

  if (!opts.tokenAddress) {
    return { success: false, error: "No token address supplied -- cannot place an order" };
  }

  // ---- REFERENCE PRICE. Without one there is no honest min-out bound. ----
  const live = await livePriceForPair(pair.pairAddress, chain);
  const referencePriceUsd = opts.referencePriceUsd ?? live?.price ?? 0;
  if (!(referencePriceUsd > 0)) {
    return {
      success: false,
      error: "No live reference price available -- refusing to send an unbounded order",
    };
  }

  // ---- PRECISION ---------------------------------------------------------
  let tokenDecimals: number | null = null;
  if (typeof opts.tokenDecimals === "number" && Number.isInteger(opts.tokenDecimals)) {
    tokenDecimals = opts.tokenDecimals;
  } else if (chain === "solana") {
    tokenDecimals = await getSolanaTokenDecimals(opts.tokenAddress);
  } else {
    tokenDecimals = await resolveEvmDecimals(chain, opts.tokenAddress);
  }
  if (tokenDecimals === null) {
    return {
      success: false,
      error: `Could not resolve decimals for ${opts.tokenAddress} -- refusing to guess`,
    };
  }

  const sizing = await calculatePositionSize(chain);

  const walletAddress =
    chain === "solana" ? await getSolanaWalletAddress() : await getWalletAddress(chain);
  if (!walletAddress) {
    return {
      success: false,
      error: `No wallet configured for ${chain}. Set ${
        chain === "solana" ? "SOLANA_WALLET_PRIVATE_KEY" : "EVM_WALLET_PRIVATE_KEY"
      } in Secrets.`,
    };
  }

  // ---- BALANCE CHECK. Capital is a book figure; the wallet is the fact. ---
  const walletBalanceUsd =
    chain === "solana" ? await getSolanaBalance(SOL_MINT_USDC) : await getWalletBalance(chain, "USDC");
  if (walletBalanceUsd !== null && walletBalanceUsd + 1e-9 < sizing.positionSizeUsd) {
    return {
      success: false,
      error: `Wallet holds $${walletBalanceUsd.toFixed(2)} USDC but the order is $${sizing.positionSizeUsd.toFixed(2)}`,
    };
  }

  // ---- EXECUTE -----------------------------------------------------------
  let txResult;
  if (chain === "solana") {
    txResult = await executeBuySolana(opts.tokenAddress, sizing.positionSizeUsd, {
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      tolerateQuoteDrift: true,
    });
  } else {
    txResult = await executeBuyEVM(chain, opts.tokenAddress as Address, sizing.positionSizeUsd, {
      slippagePct: DEFAULT_SLIPPAGE_PCT,
      tokenDecimals,
      referencePriceUsd,
    });
  }

  // A failed transaction must NOT leave a bookable position behind. The old
  // version wrote a row regardless, priced from the scanner's cached quote.
  if (!txResult.success) {
    logger.error(
      { chain, pairId: pair.id, error: txResult.error, txHash: txResult.txHash },
      "Entry execution failed -- booking a FAILED row with no notional"
    );
    const [failed] = await db
      .insert(positionsTable)
      .values({
        pairId: opts.pairId,
        signalId: opts.signalId ?? null,
        symbol: pair.symbol,
        chain,
        dex: pair.dex,
        direction: opts.direction,
        status: "FAILED",
        entryPrice: referencePriceUsd,
        entryAmountUsd: 0,
        tokenAmountIn: sizing.positionSizeUsd,
        tokenAmountOut: 0,
        tokenAddress: opts.tokenAddress,
        tokenDecimals,
        entryTxHash: txResult.txHash ?? null,
        capitalAtEntry: sizing.capitalAtEntry,
        riskPct: sizing.riskPct,
        obHigh: opts.obHigh || null,
        obLow: opts.obLow || null,
        stopLossPrice: null,
        stopLossPct: sizing.stopLossPct,
        maxLossUsd: null,
        tpLevels: JSON.stringify(sizing.tpLevels),
        walletAddress,
        notes: `Entry failed: ${txResult.error ?? "unknown"}`,
      })
      .returning();

    return {
      success: false,
      positionId: failed?.id,
      txHash: txResult.txHash,
      error: txResult.error ?? "Execution failed",
      positionSizeUsd: sizing.positionSizeUsd,
    };
  }

  const amountOut = txResult.amountOut;
  if (!(amountOut > 0)) {
    // Confirmed but unmeasurable. Booking this would recreate the zero-size
    // position that broke every exit in the system.
    logger.error(
      { chain, pairId: pair.id, txHash: txResult.txHash },
      "Entry confirmed but output is not measurable -- not booking a position"
    );
    return {
      success: false,
      txHash: txResult.txHash,
      error:
        "Swap confirmed but the received amount could not be determined -- position not booked. Reconcile the wallet before trading again.",
      positionSizeUsd: sizing.positionSizeUsd,
    };
  }

  // Entry price is what we PAID divided by what we GOT. A fill price, not
  // the scanner's quote.
  const fillPrice = sizing.positionSizeUsd / amountOut;

  const [position] = await db
    .insert(positionsTable)
    .values({
      pairId: opts.pairId,
      signalId: opts.signalId ?? null,
      symbol: pair.symbol,
      chain,
      dex: pair.dex,
      direction: opts.direction,
      status: "OPEN",
      entryPrice: fillPrice,
      entryAmountUsd: sizing.positionSizeUsd,
      tokenAmountIn: sizing.positionSizeUsd,
      tokenAmountOut: amountOut,
      tokenAddress: opts.tokenAddress,
      tokenDecimals,
      entryTxHash: txResult.txHash ?? null,
      entryConfirmedAt: new Date(),
      capitalAtEntry: sizing.capitalAtEntry,
      riskPct: sizing.riskPct,
      obHigh: opts.obHigh || null,
      obLow: opts.obLow || null,
      stopLossPrice:
        opts.direction === "BUY"
          ? fillPrice * (1 - sizing.stopLossPct / 100)
          : fillPrice * (1 + sizing.stopLossPct / 100),
      stopLossPct: sizing.stopLossPct,
      maxLossUsd: sizing.maxLossUsd,
      tpLevels: JSON.stringify(sizing.tpLevels),
      walletAddress,
      notes: `Auto-executed: ${opts.ltfMessage} | Tier: ${sizing.scalingTier}`,
    })
    .returning();

  logger.info(
    {
      positionId: position.id,
      chain,
      direction: opts.direction,
      sizeUsd: sizing.positionSizeUsd,
      amountOut,
      fillPrice,
      referencePriceUsd,
    },
    "Position opened"
  );

  return {
    success: true,
    positionId: position.id,
    txHash: txResult.txHash,
    positionSizeUsd: sizing.positionSizeUsd,
    shortfallUsd: txResult.shortfallUsd,
  };
}

/**
 * Claim a position for closing. Returns false when another closer holds it.
 *
 * The claim is a single conditional UPDATE, so it is atomic under concurrent
 * scanner ticks: only one caller can move closing_started_at from NULL to a
 * timestamp. This is the guard the old close path lacked entirely -- a
 * stop-loss and a take-profit hitting in one cycle would both sell.
 */
async function claimPositionForClose(positionId: number): Promise<boolean> {
  const staleBefore = new Date(Date.now() - CLOSE_LOCK_STALE_MS);

  const claimed = await db
    .update(positionsTable)
    .set({ closingStartedAt: new Date(), lastUpdatedAt: new Date() })
    .where(
      and(
        eq(positionsTable.id, positionId),
        inArray(positionsTable.status, ["OPEN", "PARTIAL"]),
        or(
          isNull(positionsTable.closingStartedAt),
          lt(positionsTable.closingStartedAt, staleBefore)
        )
      )
    )
    .returning({ id: positionsTable.id });

  return claimed.length > 0;
}

/** Release a claim without recording a close (used when an exit aborts). */
async function releaseClose(positionId: number): Promise<void> {
  await db
    .update(positionsTable)
    .set({ closingStartedAt: null, lastUpdatedAt: new Date() })
    .where(eq(positionsTable.id, positionId));
}

/**
 * Close a position, partially or fully.
 * pctToClose is a fraction of the REMAINING position (1-100).
 */
export async function closePosition(
  positionId: number,
  pctToClose: number = 100
): Promise<{ success: boolean; pnlUsd?: number; txHash?: string; error?: string }> {
  const position = await db
    .select()
    .from(positionsTable)
    .where(eq(positionsTable.id, positionId))
    .then((r) => r[0]);

  if (!position) return { success: false, error: "Position not found" };
  if (position.status === "CLOSED") return { success: false, error: "Position already closed" };
  if (position.status === "FAILED") return { success: false, error: "Position never opened" };

  // Token identity must be known. Without it the sell has no target.
  if (!position.tokenAddress) {
    return {
      success: false,
      error: "Position has no recorded token address -- cannot build a sell order",
    };
  }
  if (position.tokenDecimals === null || position.tokenDecimals === undefined) {
    return {
      success: false,
      error: "Position has no recorded token decimals -- refusing to guess a size",
    };
  }

  const pair = await db
    .select()
    .from(watchedPairsTable)
    .where(eq(watchedPairsTable.id, position.pairId))
    .then((r) => r[0]);

  // Sell what the wallet ACTUALLY holds, not what the book believes it holds.
  const onChainHeld = await readHeldAmount(position.chain, position.tokenAddress);
  const held = onChainHeld ?? position.tokenAmountOut;

  if (!(held > 0)) {
    return {
      success: false,
      error: "No token balance to sell -- the position has nothing to close",
    };
  }

  const pct = Math.min(Math.max(pctToClose, 1), 100);
  const amountToClose = held * (pct / 100);

  // Claim the position so a concurrent tick cannot close it too.
  if (!(await claimPositionForClose(positionId))) {
    return { success: false, error: "Position is already being closed by another process" };
  }

  try {
    const live = pair ? await livePriceForPair(pair.pairAddress, position.chain) : null;
    const referencePriceUsd = live?.price ?? 0;
    if (!(referencePriceUsd > 0)) {
      await releaseClose(positionId);
      return { success: false, error: "No live price for the exit -- refusing to sell unbounded" };
    }

    let txResult;
    if (position.chain === "solana") {
      txResult = await executeSellSolana(
        position.tokenAddress,
        position.tokenDecimals,
        amountToClose,
        {
          slippageBps: DEFAULT_SLIPPAGE_BPS * EXIT_SLIPPAGE_MULTIPLIER,
          tolerateQuoteDrift: false,
        }
      );
    } else {
      txResult = await executeSellEVM(
        position.chain,
        position.tokenAddress as Address,
        amountToClose,
        position.tokenDecimals,
        {
          slippagePct: DEFAULT_SLIPPAGE_PCT * EXIT_SLIPPAGE_MULTIPLIER,
          referencePriceUsd,
        }
      );
    }

    if (!txResult.success || !(txResult.amountOut > 0)) {
      await releaseClose(positionId);
      return {
        success: false,
        txHash: txResult.txHash,
        error: txResult.error ?? "Exit failed -- proceeds unknown",
      };
    }

    // Proceeds come from the FILL, never from a price estimate.
    const exitAmountUsd = txResult.amountOut;
    const costBasisUsd = position.entryPrice * amountToClose;
    const pnlUsd = exitAmountUsd - costBasisUsd;
    const pnlPct = costBasisUsd > 0 ? (pnlUsd / costBasisUsd) * 100 : 0;

    const remainingAfter = held - amountToClose;
    const isFull = remainingAfter <= held * 0.001; // 0.1% dust tolerance

    await db
      .update(positionsTable)
      .set({
        status: isFull ? "CLOSED" : "PARTIAL",
        exitPrice: exitAmountUsd / amountToClose,
        exitAmountUsd: (position.exitAmountUsd ?? 0) + exitAmountUsd,
        exitTxHash: txResult.txHash ?? null,
        realizedPnlUsd: (position.realizedPnlUsd ?? 0) + pnlUsd,
        realizedPnlPct: pnlPct,
        tokenAmountOut: Math.max(0, remainingAfter),
        closingStartedAt: null,
        closedAt: isFull ? new Date() : null,
        lastUpdatedAt: new Date(),
      })
      .where(eq(positionsTable.id, positionId));

    // The stop must follow the market, or a position that has run up keeps a
    // stop sitting at the original entry-relative level.
    if (!isFull) {
      await trailStopAfterPartial(positionId, pnlPct);
    }

    // Capital is only affected when the exposure is fully returned.
    let halted = false;
    if (isFull) {
      const totalPnl = (position.realizedPnlUsd ?? 0) + pnlUsd;
      const result = await recordTradeResult(position.chain, totalPnl, totalPnl > 0);
      halted = result.halted;
    }

    logger.info(
      { positionId, pctToClose, amountToClose, exitAmountUsd, pnlUsd, pnlPct, isFull, halted },
      "Position closed"
    );

    return { success: true, pnlUsd, txHash: txResult.txHash };
  } catch (err: any) {
    await releaseClose(positionId);
    logger.error({ err, positionId }, "Close failed");
    return { success: false, error: err?.message ?? String(err) };
  }
}

/** Read how much of `tokenAddress` the configured wallet currently holds. */
async function readHeldAmount(chain: string, tokenAddress: string): Promise<number | null> {
  try {
    if (chain === "solana") {
      return await getSolanaBalance(tokenAddress);
    }
    return await getTokenBalance(chain, tokenAddress as Address);
  } catch (err) {
    logger.warn({ err, chain, tokenAddress }, "Could not read on-chain token balance");
    return null;
  }
}

/**
 * Ratchet the stop-loss after a profitable partial exit. Moves the stop to at
 * least break-even once the position has paid for itself. Never loosens it.
 */
async function trailStopAfterPartial(positionId: number, pnlPct: number): Promise<void> {
  if (pnlPct <= 0) return;
  const position = await db
    .select()
    .from(positionsTable)
    .where(eq(positionsTable.id, positionId))
    .then((r) => r[0]);
  if (!position || position.stopLossPrice === null) return;

  const breakEven = position.entryPrice;
  const shouldRaise =
    position.direction === "BUY"
      ? position.stopLossPrice < breakEven
      : position.stopLossPrice > breakEven;
  if (!shouldRaise) return;

  await db
    .update(positionsTable)
    .set({ stopLossPrice: breakEven, lastUpdatedAt: new Date() })
    .where(eq(positionsTable.id, positionId));

  logger.info({ positionId, newStop: breakEven }, "Stop-loss ratcheted to break-even");
}

/**
 * Monitor open positions and trigger take-profit / stop-loss.
 *
 * Prices are fetched LIVE. The old version compared against
 * pair.currentPrice, which the scanner refreshes on its own cycle, so a stop
 * could be evaluated against a price up to 30s stale -- precisely when the
 * market is moving fastest.
 */
export async function monitorPositions(): Promise<void> {
  const openPositions = await db
    .select()
    .from(positionsTable)
    .where(inArray(positionsTable.status, ["OPEN", "PARTIAL"]));

  for (const pos of openPositions) {
    // Skip anything another process already holds.
    if (pos.closingStartedAt) {
      const age = Date.now() - new Date(pos.closingStartedAt).getTime();
      if (age < CLOSE_LOCK_STALE_MS) continue;
    }

    const pair = await db
      .select()
      .from(watchedPairsTable)
      .where(eq(watchedPairsTable.id, pos.pairId))
      .then((r) => r[0]);

    if (!pair) continue;

    const live = await livePriceForPair(pair.pairAddress, pos.chain);
    if (!live || !(live.price > 0)) {
      logger.warn({ positionId: pos.id }, "No live price for monitoring -- skipping this tick");
      continue;
    }

    const currentPrice = live.price;
    const priceMultiplier =
      pos.direction === "BUY" ? currentPrice / pos.entryPrice : pos.entryPrice / currentPrice;

    // ---- HARD LOSS CAP ----------------------------------------------------
    // A price stop does not bound the loss on a gap: the market can print
    // straight through the level. The dollar cap locked at entry is what
    // actually limits the damage.
    if (pos.maxLossUsd !== null && pos.maxLossUsd !== undefined) {
      const pnlUsd =
        pos.direction === "BUY"
          ? (currentPrice - pos.entryPrice) * (pos.tokenAmountOut ?? 0)
          : (pos.entryPrice - currentPrice) * (pos.tokenAmountOut ?? 0);
      if (pnlUsd <= -pos.maxLossUsd) {
        logger.error(
          { positionId: pos.id, pnlUsd, maxLossUsd: pos.maxLossUsd },
          "Loss cap breached -- closing"
        );
        await closePosition(pos.id, 100);
        continue;
      }
    }

    // ---- STOP LOSS --------------------------------------------------------
    if (pos.stopLossPrice !== null) {
      const slHit =
        pos.direction === "BUY"
          ? currentPrice <= pos.stopLossPrice
          : currentPrice >= pos.stopLossPrice;

      if (slHit) {
        logger.warn(
          { positionId: pos.id, currentPrice, sl: pos.stopLossPrice },
          "Stop loss triggered"
        );
        await closePosition(pos.id, 100);
        continue;
      }
    }

    // ---- TAKE PROFIT ------------------------------------------------------
    if (pos.tpLevels) {
      let levels: Array<{ pct: number; multiplier: number; hit: boolean }>;
      try {
        levels = JSON.parse(pos.tpLevels);
      } catch {
        logger.warn({ positionId: pos.id }, "Malformed tp_levels -- skipping");
        continue;
      }

      const toHit = levels.filter((l) => !l.hit && priceMultiplier >= l.multiplier);
      if (toHit.length === 0) continue;

      // Close ONE level per tick. Closing several in a row would run
      // concurrently against a position whose claim is already held.
      const level = toHit[0];
      const result = await closePosition(pos.id, level.pct);
      if (!result.success) {
        logger.warn({ positionId: pos.id, error: result.error }, "Take-profit close refused");
        continue;
      }

      level.hit = true;
      const allHit = levels.every((l) => l.hit);

      await db
        .update(positionsTable)
        .set({
          tpLevels: JSON.stringify(levels),
          status: allHit ? "CLOSED" : "PARTIAL",
          closedAt: allHit ? new Date() : null,
          lastUpdatedAt: new Date(),
        })
        .where(eq(positionsTable.id, pos.id));
    }
  }
}

/**
 * Startup reconciliation.
 *
 * Nothing compared the wallet to the book on boot. A process killed mid-trade
 * left the two permanently diverged with no path back to truth. This reports
 * every mismatch loudly. It deliberately does NOT rewrite positions -- that is
 * an operator decision -- but trading should not resume while it reports
 * discrepancies.
 */
export async function reconcilePositionsOnStartup(): Promise<{
  checked: number;
  discrepancies: Array<{ positionId: number; booked: number; onChain: number | null }>;
}> {
  const live = await db
    .select()
    .from(positionsTable)
    .where(inArray(positionsTable.status, ["OPEN", "PARTIAL"]));

  const discrepancies: Array<{ positionId: number; booked: number; onChain: number | null }> = [];

  for (const pos of live) {
    if (!pos.tokenAddress) {
      discrepancies.push({ positionId: pos.id, booked: pos.tokenAmountOut, onChain: null });
      continue;
    }
    const onChain = await readHeldAmount(pos.chain, pos.tokenAddress);
    if (onChain === null) {
      discrepancies.push({ positionId: pos.id, booked: pos.tokenAmountOut, onChain: null });
      continue;
    }
    const diff = Math.abs(onChain - pos.tokenAmountOut);
    const tolerance = Math.max(pos.tokenAmountOut * 0.01, 1e-9);
    if (diff > tolerance) {
      discrepancies.push({ positionId: pos.id, booked: pos.tokenAmountOut, onChain });
      logger.error(
        { positionId: pos.id, booked: pos.tokenAmountOut, onChain, chain: pos.chain },
        "RECONCILIATION MISMATCH -- book and chain disagree"
      );
    }
  }

  if (discrepancies.length > 0) {
    logger.error(
      { count: discrepancies.length },
      `${discrepancies.length} position(s) failed reconciliation. Resolve before trading.`
    );
  } else {
    logger.info({ checked: live.length }, "Startup reconciliation clean");
  }

  return { checked: live.length, discrepancies };
}
