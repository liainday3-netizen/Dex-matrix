/**
 * IronHawk Capital Scaling Engine — "Profit Monster 2026-2027"
 *
 * Compound position sizing: as realized P&L accumulates, every new trade
 * automatically scales up in proportion to current capital.
 *
 * Formula:
 *   positionSizeUsd = min(currentCapital * riskPct / 100, maxPositionUsd)
 *
 * Scaling tiers (auto-applied as capital grows):
 *   < $5k      → conservative: 2% risk/trade, max 3 concurrent
 *   $5k–$25k   → standard:     3% risk/trade, max 4 concurrent
 *   $25k–$100k → aggressive:   4% risk/trade, max 5 concurrent
 *   > $100k    → institutional: 5% risk/trade, max 6 concurrent
 */

import { db, capitalConfigTable, positionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export interface PositionSizing {
  positionSizeUsd: number;
  riskPct: number;
  stopLossPct: number;
  tpLevels: TakeProfitLevel[];
  capitalAtEntry: number;
  scalingTier: string;
}

export interface TakeProfitLevel {
  pct: number;         // % of position to close
  multiplier: number;  // price multiplier at which to exit (e.g. 1.5 = +50%)
  hit: boolean;
}

const DEFAULT_TP_LEVELS: TakeProfitLevel[] = [
  { pct: 33, multiplier: 1.5, hit: false },   // close 33% at +50%
  { pct: 33, multiplier: 2.0, hit: false },   // close 33% at +100%
  { pct: 34, multiplier: 3.0, hit: false },   // close remainder at +200%
];

function getScalingTier(capital: number): {
  riskPct: number;
  maxConcurrent: number;
  label: string;
} {
  if (capital >= 100_000) return { riskPct: 5, maxConcurrent: 6, label: "INSTITUTIONAL" };
  if (capital >= 25_000)  return { riskPct: 4, maxConcurrent: 5, label: "AGGRESSIVE" };
  if (capital >= 5_000)   return { riskPct: 3, maxConcurrent: 4, label: "STANDARD" };
  return { riskPct: 2, maxConcurrent: 3, label: "CONSERVATIVE" };
}

// Absolute minimum capital to open any trade — $10
export const MIN_CAPITAL_USD = 10;
export const MIN_POSITION_USD = 10;

export async function getOrCreateCapitalConfig(chain: string) {
  const existing = await db
    .select()
    .from(capitalConfigTable)
    .where(eq(capitalConfigTable.chain, chain));

  if (existing.length > 0) return existing[0];

  const tier = getScalingTier(MIN_CAPITAL_USD);
  const [created] = await db
    .insert(capitalConfigTable)
    .values({
      chain,
      initialCapitalUsd: MIN_CAPITAL_USD,
      currentCapitalUsd: MIN_CAPITAL_USD,
      totalRealizedPnlUsd: 0,
      riskPct: tier.riskPct,
      maxRiskPct: 10,
      stopLossPct: 5,
      tpLevels: JSON.stringify(DEFAULT_TP_LEVELS),
      maxPositionUsd: 50_000,
      maxConcurrentPositions: tier.maxConcurrent,
      autoExecute: false,
    })
    .returning();

  return created;
}

export async function calculatePositionSize(chain: string): Promise<PositionSizing> {
  const config = await getOrCreateCapitalConfig(chain);
  const tier = getScalingTier(config.currentCapitalUsd);

  // Use config risk% unless auto-tier gives a better level
  const riskPct = Math.min(config.riskPct, config.maxRiskPct);
  const rawSize = config.currentCapitalUsd * (riskPct / 100);
  // Enforce $10 floor and configured max
  const positionSizeUsd = Math.max(MIN_POSITION_USD, Math.min(rawSize, config.maxPositionUsd));

  const tpLevels: TakeProfitLevel[] = JSON.parse(config.tpLevels || JSON.stringify(DEFAULT_TP_LEVELS));

  return {
    positionSizeUsd,
    riskPct,
    stopLossPct: config.stopLossPct,
    tpLevels,
    capitalAtEntry: config.currentCapitalUsd,
    scalingTier: tier.label,
  };
}

export async function recordTradeResult(
  chain: string,
  pnlUsd: number,
  isWin: boolean
): Promise<void> {
  const config = await getOrCreateCapitalConfig(chain);
  const newCapital = Math.max(0, config.currentCapitalUsd + pnlUsd);
  const tier = getScalingTier(newCapital);

  await db
    .update(capitalConfigTable)
    .set({
      currentCapitalUsd: newCapital,
      totalRealizedPnlUsd: config.totalRealizedPnlUsd + pnlUsd,
      totalTradeCount: config.totalTradeCount + 1,
      winCount: isWin ? config.winCount + 1 : config.winCount,
      lossCount: isWin ? config.lossCount : config.lossCount + 1,
      // Auto-adjust max concurrent on tier change
      maxConcurrentPositions: tier.maxConcurrent,
      updatedAt: new Date(),
    })
    .where(eq(capitalConfigTable.chain, chain));

  logger.info(
    { chain, pnlUsd, newCapital, tier: tier.label },
    `Capital updated — tier: ${tier.label}`
  );
}

export async function canOpenPosition(chain: string): Promise<{ allowed: boolean; reason?: string }> {
  const config = await getOrCreateCapitalConfig(chain);
  if (!config.autoExecute) return { allowed: false, reason: "Auto-execute is disabled" };

  // Count open positions for this chain
  const openCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(positionsTable)
    .where(
      sql`${positionsTable.chain} = ${chain} AND ${positionsTable.status} IN ('OPEN','PARTIAL')`
    );

  const count = openCount[0]?.count ?? 0;
  if (count >= config.maxConcurrentPositions) {
    return { allowed: false, reason: `Max concurrent positions reached (${count}/${config.maxConcurrentPositions})` };
  }

  const sizing = await calculatePositionSize(chain);
  if (config.currentCapitalUsd < MIN_CAPITAL_USD) {
    return { allowed: false, reason: `Minimum capital is $${MIN_CAPITAL_USD}. Current: $${config.currentCapitalUsd.toFixed(2)}` };
  }
  if (sizing.positionSizeUsd < MIN_POSITION_USD) {
    return { allowed: false, reason: `Position size $${sizing.positionSizeUsd.toFixed(2)} is below $${MIN_POSITION_USD} minimum` };
  }

  return { allowed: true };
}

export async function getPerformanceSummary(chain?: string) {
  const configs = chain
    ? await db.select().from(capitalConfigTable).where(eq(capitalConfigTable.chain, chain))
    : await db.select().from(capitalConfigTable);

  return configs.map((c) => {
    const tier = getScalingTier(c.currentCapitalUsd);
    const totalReturn = c.initialCapitalUsd > 0
      ? ((c.currentCapitalUsd - c.initialCapitalUsd) / c.initialCapitalUsd) * 100
      : 0;
    const winRate = c.totalTradeCount > 0
      ? (c.winCount / c.totalTradeCount) * 100
      : 0;

    return {
      chain: c.chain,
      initialCapital: c.initialCapitalUsd,
      currentCapital: c.currentCapitalUsd,
      totalPnlUsd: c.totalRealizedPnlUsd,
      totalReturnPct: totalReturn,
      totalTrades: c.totalTradeCount,
      winRate,
      wins: c.winCount,
      losses: c.lossCount,
      scalingTier: tier.label,
      riskPct: c.riskPct,
      nextPositionSizeUsd: Math.min(
        c.currentCapitalUsd * (c.riskPct / 100),
        c.maxPositionUsd
      ),
      autoExecute: c.autoExecute,
      walletAddress: c.walletAddress,
    };
  });
}
