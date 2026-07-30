import { Router } from "express";
import { db, positionsTable, capitalConfigTable } from "@workspace/db";
import { eq, sql, and, inArray } from "drizzle-orm";
import {
  ListPositionsQueryParams,
  ClosePositionParams,
  ClosePositionBody,
  ExecuteSignalBody,
  UpdateCapitalBody,
} from "@workspace/api-zod";
import {
  getOrCreateCapitalConfig,
  getPerformanceSummary,
  calculatePositionSize,
  MIN_CAPITAL_USD,
} from "../lib/capitalScaling";
import { executeSignal, closePosition } from "../lib/tradeExecutor";

const router = Router();

// GET /trader/positions
router.get("/trader/positions", async (req, res) => {
  const parsed = ListPositionsQueryParams.safeParse(req.query);
  const status = parsed.success ? parsed.data.status ?? "all" : "all";
  const chain = parsed.success ? parsed.data.chain ?? "all" : "all";

  const conditions = [];
  if (status !== "all") conditions.push(eq(positionsTable.status, status));
  if (chain !== "all") conditions.push(eq(positionsTable.chain, chain));

  const positions = await db
    .select()
    .from(positionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${positionsTable.openedAt} DESC`)
    .limit(200);

  res.json(
    positions.map((p) => ({
      id: p.id,
      pairId: p.pairId,
      signalId: p.signalId ?? null,
      symbol: p.symbol,
      chain: p.chain,
      dex: p.dex,
      direction: p.direction,
      status: p.status,
      entryPrice: p.entryPrice,
      entryAmountUsd: p.entryAmountUsd,
      tokenAmountIn: p.tokenAmountIn,
      tokenAmountOut: p.tokenAmountOut,
      entryTxHash: p.entryTxHash ?? null,
      capitalAtEntry: p.capitalAtEntry,
      riskPct: p.riskPct,
      exitPrice: p.exitPrice ?? null,
      exitAmountUsd: p.exitAmountUsd ?? null,
      exitTxHash: p.exitTxHash ?? null,
      realizedPnlUsd: p.realizedPnlUsd ?? null,
      realizedPnlPct: p.realizedPnlPct ?? null,
      tpLevels: p.tpLevels ?? null,
      stopLossPrice: p.stopLossPrice ?? null,
      stopLossPct: p.stopLossPct ?? null,
      obHigh: p.obHigh ?? null,
      obLow: p.obLow ?? null,
      walletAddress: p.walletAddress ?? null,
      openedAt: p.openedAt.toISOString(),
      closedAt: p.closedAt?.toISOString() ?? null,
      notes: p.notes ?? null,
    }))
  );
});

// POST /trader/positions/:id/close
router.post("/trader/positions/:id/close", async (req, res) => {
  const paramsParsed = ClosePositionParams.safeParse({ id: Number(req.params.id) });
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid position id" });
    return;
  }
  const bodyParsed = ClosePositionBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "pctToClose is required (1–100)" });
    return;
  }

  const { id } = paramsParsed.data;
  const { pctToClose } = bodyParsed.data;

  const existing = await db
    .select()
    .from(positionsTable)
    .where(eq(positionsTable.id, id));

  if (existing.length === 0) {
    res.status(404).json({ error: "Position not found" });
    return;
  }

  const result = await closePosition(id, Math.min(100, Math.max(1, pctToClose)));
  res.json({
    success: result.success,
    pnlUsd: result.pnlUsd ?? null,
    txHash: result.txHash ?? null,
    error: result.error ?? null,
  });
});

// POST /trader/execute
router.post("/trader/execute", async (req, res) => {
  const parsed = ExecuteSignalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { pairId, direction, tokenAddress, tokenDecimals } = parsed.data;

  const result = await executeSignal({
    pairId,
    direction,
    tokenAddress,
    tokenDecimals: tokenDecimals ?? 18,
    obHigh: 0,
    obLow: 0,
    ltfMessage: "Manual execution",
  });

  res.json({
    success: result.success,
    positionId: result.positionId ?? null,
    txHash: result.txHash ?? null,
    positionSizeUsd: result.positionSizeUsd ?? null,
    error: result.error ?? null,
  });
});

// GET /trader/capital
router.get("/trader/capital", async (_req, res) => {
  const summary = await getPerformanceSummary();
  // Ensure at least one config exists per chain
  if (summary.length === 0) {
    await Promise.all([
      getOrCreateCapitalConfig("ethereum"),
      getOrCreateCapitalConfig("base"),
      getOrCreateCapitalConfig("solana"),
    ]);
    const fresh = await getPerformanceSummary();
    res.json(fresh);
    return;
  }
  res.json(summary);
});

// PATCH /trader/capital
router.patch("/trader/capital", async (req, res) => {
  const parsed = UpdateCapitalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { chain, ...updates } = parsed.data;

  // Enforce $10 minimum capital
  if (updates.initialCapitalUsd !== undefined && updates.initialCapitalUsd < MIN_CAPITAL_USD) {
    res.status(400).json({ error: `Minimum start capital is $${MIN_CAPITAL_USD}` });
    return;
  }

  const config = await getOrCreateCapitalConfig(chain);

  const setValues: Partial<typeof capitalConfigTable.$inferInsert> = { updatedAt: new Date() };
  if (updates.initialCapitalUsd !== undefined) {
    setValues.initialCapitalUsd = updates.initialCapitalUsd;
    // If resetting capital, also reset current capital
    if (config.totalTradeCount === 0) {
      setValues.currentCapitalUsd = updates.initialCapitalUsd;
    }
  }
  if (updates.riskPct !== undefined) setValues.riskPct = updates.riskPct;
  if (updates.maxRiskPct !== undefined) setValues.maxRiskPct = updates.maxRiskPct;
  if (updates.stopLossPct !== undefined) setValues.stopLossPct = updates.stopLossPct;
  if (updates.maxPositionUsd !== undefined) setValues.maxPositionUsd = updates.maxPositionUsd;
  if (updates.maxConcurrentPositions !== undefined) setValues.maxConcurrentPositions = updates.maxConcurrentPositions;
  if (updates.autoExecute !== undefined) setValues.autoExecute = updates.autoExecute;
  if (updates.walletAddress !== undefined) setValues.walletAddress = updates.walletAddress;

  await db
    .update(capitalConfigTable)
    .set(setValues)
    .where(eq(capitalConfigTable.chain, chain));

  const summary = await getPerformanceSummary(chain);
  res.json(summary[0]);
});

// GET /trader/performance
router.get("/trader/performance", async (_req, res) => {
  const chains = await getPerformanceSummary();

  const totalPnlUsd = chains.reduce((s, c) => s + c.totalPnlUsd, 0);
  const totalInitial = chains.reduce((s, c) => s + c.initialCapital, 0);
  const totalReturnPct = totalInitial > 0 ? (totalPnlUsd / totalInitial) * 100 : 0;
  const totalTrades = chains.reduce((s, c) => s + c.totalTrades, 0);
  const totalWins = chains.reduce((s, c) => s + c.wins, 0);
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  const openCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(positionsTable)
    .where(inArray(positionsTable.status, ["OPEN", "PARTIAL"]));

  const bestChain = chains.length > 0
    ? chains.sort((a, b) => b.totalReturnPct - a.totalReturnPct)[0].chain
    : null;

  res.json({
    chains,
    totalPnlUsd,
    totalReturnPct,
    totalTrades,
    winRate,
    openPositions: openCount[0]?.count ?? 0,
    bestChain,
  });
});

export default router;
