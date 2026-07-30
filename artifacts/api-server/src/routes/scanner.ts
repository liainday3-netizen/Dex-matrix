import { Router } from "express";
import { db, watchedPairsTable, signalsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { getPairInfo } from "../lib/marketData";
import { getScannerStats, runScanCycle } from "../lib/scanner";
import {
  AddPairBody,
  RemovePairParams,
  ListSignalsQueryParams,
} from "@workspace/api-zod";

const router = Router();

// GET /scanner/pairs
router.get("/scanner/pairs", async (req, res) => {
  const pairs = await db
    .select()
    .from(watchedPairsTable)
    .where(eq(watchedPairsTable.active, true))
    .orderBy(desc(watchedPairsTable.addedAt));

  res.json(
    pairs.map((p) => ({
      id: p.id,
      symbol: p.symbol || `${p.baseToken}/${p.quoteToken}`,
      baseToken: p.baseToken,
      quoteToken: p.quoteToken,
      chain: p.chain,
      dex: p.dex,
      pairAddress: p.pairAddress,
      state: p.state,
      htfMessage: p.htfMessage,
      ltfMessage: p.ltfMessage,
      signalAction: p.signalAction,
      currentPrice: p.currentPrice,
      priceChange24h: p.priceChange24h,
      volume24h: p.volume24h,
      obType: p.obType ?? null,
      obHigh: p.obHigh ?? null,
      obLow: p.obLow ?? null,
      lastScannedAt: p.lastScannedAt?.toISOString() ?? null,
      addedAt: p.addedAt.toISOString(),
    }))
  );
});

// POST /scanner/pairs
router.post("/scanner/pairs", async (req, res) => {
  const parsed = AddPairBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { pairAddress, chain, customLabel } = parsed.data;

  // Check duplicate
  const existing = await db
    .select()
    .from(watchedPairsTable)
    .where(eq(watchedPairsTable.pairAddress, pairAddress));

  if (existing.length > 0 && existing[0].active) {
    res.status(409).json({ error: "Pair already being watched" });
    return;
  }

  // Fetch pair info from DexScreener
  let pairInfo;
  try {
    pairInfo = await getPairInfo(pairAddress, chain);
  } catch {
    pairInfo = null;
  }

  const [inserted] = await db
    .insert(watchedPairsTable)
    .values({
      pairAddress,
      chain,
      dex: pairInfo?.dex ?? "",
      symbol: pairInfo?.symbol ?? customLabel ?? pairAddress.slice(0, 10),
      baseToken: pairInfo?.baseToken ?? "",
      quoteToken: pairInfo?.quoteToken ?? "",
      customLabel: customLabel ?? null,
      currentPrice: pairInfo?.price ?? 0,
      priceChange24h: pairInfo?.priceChange24h ?? 0,
      volume24h: pairInfo?.volume24h ?? 0,
      state: "WAITING",
      htfMessage: "Loading...",
      ltfMessage: "---",
      signalAction: "SEARCHING",
      active: true,
    })
    .returning();

  // Trigger an immediate scan cycle for the new pair
  runScanCycle().catch(() => {});

  res.status(201).json({
    id: inserted.id,
    symbol: inserted.symbol,
    baseToken: inserted.baseToken,
    quoteToken: inserted.quoteToken,
    chain: inserted.chain,
    dex: inserted.dex,
    pairAddress: inserted.pairAddress,
    state: inserted.state,
    htfMessage: inserted.htfMessage,
    ltfMessage: inserted.ltfMessage,
    signalAction: inserted.signalAction,
    currentPrice: inserted.currentPrice,
    priceChange24h: inserted.priceChange24h,
    volume24h: inserted.volume24h,
    obType: inserted.obType ?? null,
    obHigh: inserted.obHigh ?? null,
    obLow: inserted.obLow ?? null,
    lastScannedAt: inserted.lastScannedAt?.toISOString() ?? null,
    addedAt: inserted.addedAt.toISOString(),
  });
});

// DELETE /scanner/pairs/:id
router.delete("/scanner/pairs/:id", async (req, res) => {
  const parsed = RemovePairParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { id } = parsed.data;
  const existing = await db
    .select()
    .from(watchedPairsTable)
    .where(eq(watchedPairsTable.id, id));

  if (existing.length === 0) {
    res.status(404).json({ error: "Pair not found" });
    return;
  }

  await db
    .update(watchedPairsTable)
    .set({ active: false })
    .where(eq(watchedPairsTable.id, id));

  res.status(204).send();
});

// GET /scanner/signals
router.get("/scanner/signals", async (req, res) => {
  const parsed = ListSignalsQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;

  const signals = await db
    .select()
    .from(signalsTable)
    .orderBy(desc(signalsTable.triggeredAt))
    .limit(Math.min(Number(limit), 200));

  res.json(
    signals.map((s) => ({
      id: s.id,
      pairId: s.pairId,
      symbol: s.symbol,
      chain: s.chain,
      dex: s.dex,
      direction: s.direction,
      price: s.price,
      obHigh: s.obHigh,
      obLow: s.obLow,
      ltfMessage: s.ltfMessage,
      triggeredAt: s.triggeredAt.toISOString(),
    }))
  );
});

// GET /scanner/stats
router.get("/scanner/stats", async (_req, res) => {
  const stats = await getScannerStats();
  res.json(stats);
});

export default router;
