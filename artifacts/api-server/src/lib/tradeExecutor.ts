/**
 * IronHawk Trade Executor
 * Bridges the microstructure signal engine → on-chain execution.
 * Handles EVM (Ethereum, Base) and Solana chains.
 */

import { db, positionsTable, watchedPairsTable, capitalConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { calculatePositionSize, recordTradeResult, canOpenPosition } from "./capitalScaling";
import { executeBuyEVM, executeSellEVM, getWalletAddress } from "./evmExecutor";
import { executeBuySolana, executeSellSolana, getSolanaWalletAddress } from "./solanaExecutor";
import type { Address } from "viem";

export interface ExecuteSignalOptions {
  pairId: number;
  direction: "BUY" | "SELL";
  tokenAddress: string;
  tokenDecimals?: number;
  obHigh: number;
  obLow: number;
  ltfMessage: string;
  signalId?: number;
}

export async function executeSignal(opts: ExecuteSignalOptions): Promise<{
  success: boolean;
  positionId?: number;
  txHash?: string;
  error?: string;
  positionSizeUsd?: number;
}> {
  const pair = await db
    .select()
    .from(watchedPairsTable)
    .where(eq(watchedPairsTable.id, opts.pairId))
    .then((r) => r[0]);

  if (!pair) return { success: false, error: "Pair not found" };

  const chain = pair.chain;
  const { allowed, reason } = await canOpenPosition(chain);
  if (!allowed) return { success: false, error: reason };

  const sizing = await calculatePositionSize(chain);
  const walletAddress = chain === "solana"
    ? await getSolanaWalletAddress()
    : await getWalletAddress(chain);

  if (!walletAddress) {
    return { success: false, error: `No wallet configured for ${chain}. Set ${chain === "solana" ? "SOLANA_WALLET_PRIVATE_KEY" : "EVM_WALLET_PRIVATE_KEY"} in Secrets.` };
  }

  let txResult;
  if (chain === "solana") {
    if (opts.direction === "BUY") {
      txResult = await executeBuySolana(opts.tokenAddress, sizing.positionSizeUsd);
    } else {
      txResult = await executeSellSolana(opts.tokenAddress, opts.tokenDecimals ?? 6, 0);
    }
  } else {
    if (opts.direction === "BUY") {
      txResult = await executeBuyEVM(chain, opts.tokenAddress as Address, sizing.positionSizeUsd);
    } else {
      txResult = await executeSellEVM(chain, opts.tokenAddress as Address, 0, opts.tokenDecimals ?? 18);
    }
  }

  const [position] = await db
    .insert(positionsTable)
    .values({
      pairId: opts.pairId,
      signalId: opts.signalId ?? null,
      symbol: pair.symbol,
      chain,
      dex: pair.dex,
      direction: opts.direction,
      status: txResult.success ? "OPEN" : "FAILED",
      entryPrice: pair.currentPrice,
      entryAmountUsd: sizing.positionSizeUsd,
      tokenAmountIn: txResult.amountIn,
      tokenAmountOut: txResult.amountOut,
      entryTxHash: txResult.txHash ?? null,
      capitalAtEntry: sizing.capitalAtEntry,
      riskPct: sizing.riskPct,
      obHigh: opts.obHigh,
      obLow: opts.obLow,
      stopLossPrice: opts.direction === "BUY"
        ? pair.currentPrice * (1 - sizing.stopLossPct / 100)
        : pair.currentPrice * (1 + sizing.stopLossPct / 100),
      stopLossPct: sizing.stopLossPct,
      tpLevels: JSON.stringify(sizing.tpLevels),
      walletAddress,
      notes: `Auto-executed: ${opts.ltfMessage} | Tier: ${sizing.scalingTier}`,
    })
    .returning();

  if (txResult.success) {
    logger.info(
      { positionId: position.id, chain, direction: opts.direction, sizeUsd: sizing.positionSizeUsd },
      "Position opened successfully"
    );
  }

  return {
    success: txResult.success,
    positionId: position.id,
    txHash: txResult.txHash,
    error: txResult.error,
    positionSizeUsd: sizing.positionSizeUsd,
  };
}

/**
 * Close a position (partial or full exit).
 * pctToClose: 1–100
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

  const pair = await db
    .select()
    .from(watchedPairsTable)
    .where(eq(watchedPairsTable.id, position.pairId))
    .then((r) => r[0]);

  const currentPrice = pair?.currentPrice ?? 0;
  const amountToClose = position.tokenAmountOut * (pctToClose / 100);

  let txResult;
  if (position.chain === "solana") {
    txResult = await executeSellSolana("", 6, amountToClose);
  } else {
    const tokenAddress = pair?.pairAddress as Address ?? "0x";
    txResult = await executeSellEVM(position.chain, tokenAddress, amountToClose);
  }

  const exitAmountUsd = txResult.amountOut || currentPrice * amountToClose;
  const pnlUsd = exitAmountUsd - (position.entryAmountUsd * pctToClose / 100);
  const pnlPct = position.entryAmountUsd > 0
    ? (pnlUsd / (position.entryAmountUsd * pctToClose / 100)) * 100
    : 0;
  const isFull = pctToClose >= 100;

  await db
    .update(positionsTable)
    .set({
      status: isFull ? "CLOSED" : "PARTIAL",
      exitPrice: currentPrice,
      exitAmountUsd,
      exitTxHash: txResult.txHash ?? null,
      realizedPnlUsd: (position.realizedPnlUsd ?? 0) + pnlUsd,
      realizedPnlPct: pnlPct,
      closedAt: isFull ? new Date() : null,
      lastUpdatedAt: new Date(),
    })
    .where(eq(positionsTable.id, positionId));

  if (isFull) {
    await recordTradeResult(position.chain, pnlUsd, pnlUsd > 0);
  }

  logger.info({ positionId, pctToClose, pnlUsd, pnlPct }, "Position closed");
  return { success: true, pnlUsd, txHash: txResult.txHash };
}

/**
 * Monitor open positions and auto-trigger take profit / stop loss.
 * Called by the scanner service on each cycle.
 */
export async function monitorPositions(): Promise<void> {
  const openPositions = await db
    .select()
    .from(positionsTable)
    .where(eq(positionsTable.status, "OPEN"));

  for (const pos of openPositions) {
    const pair = await db
      .select()
      .from(watchedPairsTable)
      .where(eq(watchedPairsTable.id, pos.pairId))
      .then((r) => r[0]);

    if (!pair) continue;
    const currentPrice = pair.currentPrice;
    if (!currentPrice) continue;

    const priceMultiplier = pos.direction === "BUY"
      ? currentPrice / pos.entryPrice
      : pos.entryPrice / currentPrice;

    // Stop loss check
    if (pos.stopLossPrice !== null) {
      const slHit = pos.direction === "BUY"
        ? currentPrice <= pos.stopLossPrice
        : currentPrice >= pos.stopLossPrice;

      if (slHit) {
        logger.warn({ positionId: pos.id, currentPrice, sl: pos.stopLossPrice }, "Stop loss triggered");
        await closePosition(pos.id, 100);
        continue;
      }
    }

    // Take profit levels check
    if (pos.tpLevels) {
      const levels: Array<{ pct: number; multiplier: number; hit: boolean }> = JSON.parse(pos.tpLevels);
      let updated = false;

      for (const level of levels) {
        if (!level.hit && priceMultiplier >= level.multiplier) {
          logger.info({ positionId: pos.id, multiplier: level.multiplier, pct: level.pct }, "Take profit hit");
          await closePosition(pos.id, level.pct);
          level.hit = true;
          updated = true;
        }
      }

      if (updated) {
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
}
