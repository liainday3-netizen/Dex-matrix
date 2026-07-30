/**
 * IronHawk Scanner Service
 * Periodically fetches market data and runs microstructure analysis on all watched pairs.
 */

import { db, watchedPairsTable, signalsTable } from "@workspace/db";
import { monitorPositions } from "./tradeExecutor";
import { eq, desc, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getOHLCV, getPairInfo } from "./marketData";
import { analyzeAsset } from "./microstructure";

const SCAN_INTERVAL_MS = 30_000; // 30 seconds
let scanTimer: NodeJS.Timeout | null = null;
let isScanning = false;

export async function runScanCycle(): Promise<void> {
  if (isScanning) return;
  isScanning = true;

  try {
    const pairs = await db
      .select()
      .from(watchedPairsTable)
      .where(eq(watchedPairsTable.active, true));

    for (const pair of pairs) {
      try {
        // Fetch market data from public APIs
        const [htf4h, ltf15m, d1, info] = await Promise.all([
          getOHLCV(pair.pairAddress, pair.chain, "4h"),
          getOHLCV(pair.pairAddress, pair.chain, "15m"),
          getOHLCV(pair.pairAddress, pair.chain, "1d"),
          getPairInfo(pair.pairAddress, pair.chain),
        ]);

        const currentPrice = info?.price ?? pair.currentPrice;
        const prevState = pair.state;

        // Run IronHawk microstructure analysis
        const result = analyzeAsset(htf4h, ltf15m, d1, currentPrice);

        // Update the pair in the database
        await db
          .update(watchedPairsTable)
          .set({
            state: result.state,
            htfMessage: result.htfMessage,
            ltfMessage: result.ltfMessage,
            signalAction: result.signalAction,
            obType: result.obType,
            obHigh: result.obHigh,
            obLow: result.obLow,
            currentPrice,
            priceChange24h: info?.priceChange24h ?? pair.priceChange24h,
            volume24h: info?.volume24h ?? pair.volume24h,
            dex: info?.dex || pair.dex,
            symbol: info?.symbol || pair.symbol,
            baseToken: info?.baseToken || pair.baseToken,
            quoteToken: info?.quoteToken || pair.quoteToken,
            lastScannedAt: new Date(),
          })
          .where(eq(watchedPairsTable.id, pair.id));

        // Fire a signal if state transitions to BULL_EXEC or BEAR_EXEC
        const isNewSignal =
          (result.state === "BULL_EXEC" || result.state === "BEAR_EXEC") &&
          prevState !== result.state;

        if (isNewSignal && result.obHigh !== null && result.obLow !== null) {
          const direction = result.state === "BULL_EXEC" ? "BUY" : "SELL";
          await db.insert(signalsTable).values({
            pairId: pair.id,
            symbol: info?.symbol || pair.symbol,
            chain: pair.chain,
            dex: info?.dex || pair.dex,
            direction,
            price: currentPrice,
            obHigh: result.obHigh,
            obLow: result.obLow,
            ltfMessage: result.ltfMessage,
          });
          logger.info({ symbol: pair.symbol, direction, price: currentPrice }, "Signal fired");
        }
      } catch (err) {
        logger.error({ err, pairId: pair.id, symbol: pair.symbol }, "Error scanning pair");
        await db
          .update(watchedPairsTable)
          .set({ state: "SYNC_ERROR", htfMessage: "DATA SYNC ERROR", signalAction: "AWAITING TICKS" })
          .where(eq(watchedPairsTable.id, pair.id));
      }
    }
    // Monitor open positions for TP/SL
    try {
      await monitorPositions();
    } catch (err) {
      logger.error({ err }, "Position monitor error");
    }
  } catch (err) {
    logger.error({ err }, "Scanner cycle error");
  } finally {
    isScanning = false;
  }
}

export function startScanner(): void {
  if (scanTimer) return;
  logger.info("IronHawk scanner started");
  // Initial scan after 2 seconds
  setTimeout(() => runScanCycle(), 2000);
  scanTimer = setInterval(() => runScanCycle(), SCAN_INTERVAL_MS);
}

export function stopScanner(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

export async function getScannerStats() {
  const pairs = await db.select().from(watchedPairsTable).where(eq(watchedPairsTable.active, true));

  const chainBreakdown: Record<string, number> = {};
  let activeBull = 0;
  let activeBear = 0;
  let inPoi = 0;
  let waiting = 0;
  let filteredBias = 0;
  let outOfSession = 0;

  for (const p of pairs) {
    chainBreakdown[p.chain] = (chainBreakdown[p.chain] ?? 0) + 1;
    if (p.state === "BULL_EXEC") activeBull++;
    else if (p.state === "BEAR_EXEC") activeBear++;
    else if (p.state === "IN_HTF_POI") inPoi++;
    else if (p.state === "WAITING") waiting++;
    else if (p.state === "FILTERED_BIAS") filteredBias++;
    else if (p.state === "OUT_OF_SESSION") outOfSession++;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [signalsTodayRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signalsTable)
    .where(sql`${signalsTable.triggeredAt} >= ${today}`);

  const [signalsTotalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signalsTable);

  return {
    totalPairs: pairs.length,
    activeBull,
    activeBear,
    inPoi,
    waiting,
    filteredBias,
    outOfSession,
    signalsToday: signalsTodayRow?.count ?? 0,
    signalsTotal: signalsTotalRow?.count ?? 0,
    chainBreakdown,
  };
}
