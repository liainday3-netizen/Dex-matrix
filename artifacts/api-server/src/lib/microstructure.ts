/**
 * IronHawk Microstructure Engine — TypeScript port of Microstructure_Matrix.mq5
 *
 * Implements:
 *   - HTF Order Block detection (Bullish/Bearish)
 *   - LTF Fractal CHoCH with Volume Z-Score confirmation
 *   - Daily bias filter
 *   - London/NY killzone session filter
 *
 * CANDLE ORDERING CONTRACT (fix/execution-correctness)
 * ------------------------------------------------
 * Every array in this module is NEWEST-FIRST: index 0 is the live,
 * still-forming bar; index 1 is the most recent CLOSED bar; index n is n
 * bars back. `getOHLCV` sorts explicitly to guarantee this.
 *
 * The previous version read `ltfCandles[1]` as "the latest bar" and
 * `slice(1, 50)` as "the last 49 completed candles" against an array that
 * `getOHLCV` returned OLDEST-FIRST. So the volume Z-score was computed over
 * a window 200 bars back from the middle of the series, the CHoCH close was
 * a price from days ago, and the daily bias read the wrong day. Every
 * signal the scanner produced was decided on the wrong candles.
 *
 * STRATEGY DECISION — LIVE vs LAST-CLOSED BAR
 * -------------------------------------------
 * Signals evaluate the last CLOSED bar (index >= 1), never the live bar.
 * Rationale is internal consistency: this module already describes its
 * volume window as "completed candles", and a still-forming bar has
 * incomplete volume (it accumulates over the bar's life and would almost
 * never clear a 1.5-sigma threshold) and an unconfirmed high/low. Reading
 * the live bar would also make a signal flicker on and off within a bar.
 *
 * Known cost: up to one LTF bar (15m) of latency between the break and the
 * entry. That is the dominant slippage term at a 30s scan interval. Adding
 * an explicit intrabar-confirmation path is a feature, deliberately NOT
 * bundled into this correctness fix.
 */

export interface OHLCVCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketState =
  | "WAITING"
  | "FILTERED_BIAS"
  | "OUT_OF_SESSION"
  | "SYNC_ERROR"
  | "IN_HTF_POI"
  | "BULL_EXEC"
  | "BEAR_EXEC";

export interface OrderBlock {
  type: "BULL" | "BEAR";
  high: number;
  low: number;
  time: number; // unix seconds
}

export interface MicrostructureResult {
  state: MarketState;
  htfMessage: string;
  ltfMessage: string;
  signalAction: string;
  obType: "BULL" | "BEAR" | null;
  obHigh: number | null;
  obLow: number | null;
}

// Settings
const VOLUME_ZSCORE_THRESHOLD = 1.5;
const USE_DAILY_BIAS = true;
const USE_KILLZONES = true;

// Killzones in UTC hours, half-open [start, end) so the boundaries do not
// double-count. The previous inclusive `hour <= END` counted 12:00-12:59 and
// 17:00-17:59 in two overlapping windows.
const LONDON_START = 8;
const LONDON_END = 12;
const NY_START = 13;
const NY_END = 17;

/** Minimum candles required to evaluate an order block. */
const MIN_HTF_CANDLES = 5;
/** Minimum CLOSED LTF candles required before any LTF verdict is issued. */
const MIN_LTF_CLOSED_CANDLES = 10;

/**
 * Assert (and, defensively, repair) newest-first ordering.
 *
 * The rest of this module indexes on position, so a reversed array silently
 * produces plausible-but-wrong analysis. Rather than trust a caller,
 * normalise here and make the failure loud in the type system's absence.
 */
export function ensureNewestFirst(candles: OHLCVCandle[]): OHLCVCandle[] {
  if (candles.length < 2) return candles;
  // Timestamps should strictly decrease for a newest-first series.
  const ascending = candles.every((c, i) => i === 0 || candles[i - 1].time <= c.time);
  return ascending ? [...candles].reverse() : candles;
}

/** Candles excluding the live bar — the only ones a signal may read. */
function closedOnly(candles: OHLCVCandle[]): OHLCVCandle[] {
  return ensureNewestFirst(candles).slice(1);
}

/**
 * Detect the most recent valid Order Block from HTF closed candles.
 *
 * Walks newest-first. `impulse` is the candle that produced the move,
 * `ob` is the candle immediately before it (the block itself), and
 * `confirm` is the candle immediately AFTER the block, used as the gap
 * check.
 *
 * Only CLOSED candles are considered, so an OB cannot be identified from a
 * block that is still forming and may yet be invalidated.
 */
export function detectOrderBlock(htfCandles: OHLCVCandle[]): OrderBlock | null {
  const closed = closedOnly(htfCandles);
  if (closed.length < MIN_HTF_CANDLES) return null;

  // newest-first: closed[i] is newer than closed[i + 1]
  for (let i = 0; i < closed.length - 2; i++) {
    const impulse = closed[i];       // the move
    const ob = closed[i + 1];        // the block, one bar before the move
    const confirm = closed[i + 2];   // the bar before the block, used for the gap

    if (!impulse || !ob || !confirm) continue;

    // Bullish OB: bearish block candle, then a bullish impulse closing
    // above the block's high, with the prior bar gapping above it.
    const obBearish = ob.close < ob.open;
    const impulseBullish = impulse.close > impulse.open;
    if (obBearish && impulseBullish && impulse.close > ob.high) {
      if (confirm.low > ob.high) {
        return { type: "BULL", high: ob.high, low: ob.low, time: ob.time };
      }
    }

    // Bearish OB: bullish block candle, then a bearish impulse closing
    // below the block's low, with the prior bar gapping below it.
    const obBullish = ob.close > ob.open;
    const impulseBearish = impulse.close < impulse.open;
    if (obBullish && impulseBearish && impulse.close < ob.low) {
      if (confirm.high < ob.low) {
        return { type: "BEAR", high: ob.high, low: ob.low, time: ob.time };
      }
    }
  }
  return null;
}

/**
 * Detect daily bias from D1 closed candles.
 * Returns 1 for bullish, -1 for bearish, 0 if unknown.
 *
 * Reads closed[0] — the most recent CLOSED daily bar — which is what
 * "last completed" has always meant here. The previous version indexed
 * `d1Candles[length - 2]` on an oldest-first array and labelled it
 * "index 1 = last completed", which was simply not true.
 */
export function getDailyBias(d1Candles: OHLCVCandle[]): number {
  if (!USE_DAILY_BIAS) return 0;
  const closed = closedOnly(d1Candles);
  if (closed.length < 1) return 0;
  const last = closed[0];
  if (!last) return 0;
  if (last.close > last.open) return 1;
  if (last.close < last.open) return -1;
  return 0;
}

/**
 * Check if current UTC hour is within the London or NY killzone.
 * Half-open intervals: [LONDON_START, LONDON_END) and [NY_START, NY_END).
 */
export function isInKillzone(now: Date = new Date()): boolean {
  if (!USE_KILLZONES) return true;
  const hour = now.getUTCHours();
  const inLondon = hour >= LONDON_START && hour < LONDON_END;
  const inNy = hour >= NY_START && hour < NY_END;
  return inLondon || inNy;
}

/**
 * Locate the most recent fractal swing high / low among CLOSED LTF candles.
 * A fractal requires a strictly higher high than BOTH neighbours.
 * Returns null when no confirmed fractal exists in the lookback.
 */
function findSwing(
  closed: OHLCVCandle[],
  lookback: number,
  kind: "high" | "low"
): number | null {
  const limit = Math.min(lookback, closed.length - 2);
  for (let j = 0; j < limit; j++) {
    const curr = closed[j];
    const prev = closed[j + 1];
    const next = closed[j + 2];
    if (!curr || !prev || !next) continue;
    if (kind === "high") {
      if (curr.high > prev.high && curr.high > next.high) return curr.high;
    } else {
      if (curr.low < prev.low && curr.low < next.low) return curr.low;
    }
  }
  return null;
}

/**
 * Run the LTF fractal CHoCH + Volume Z-Score analysis over CLOSED candles.
 *
 * Both the volume window and the price reference are taken from the same
 * population (closed bars), so the Z-score and the CHoCH verdict describe
 * the same moment in time.
 */
function analyzeLTF(
  ltfCandles: OHLCVCandle[],
  inBullOB: boolean,
  inBearOB: boolean
): { state: MarketState; ltfMessage: string } {
  const closed = closedOnly(ltfCandles);

  if (closed.length < MIN_LTF_CLOSED_CANDLES) {
    return { state: "WAITING", ltfMessage: "INSUFFICIENT LTF DATA" };
  }

  // Volume Z-Score over the most recent closed bars (up to 49).
  const volWindow = closed.slice(0, 49).map((c) => c.volume).filter((v) => Number.isFinite(v));
  let volThreshold = Infinity;
  if (volWindow.length >= 2) {
    const volMean = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
    const variance =
      volWindow.reduce((sum, v) => sum + Math.pow(v - volMean, 2), 0) / volWindow.length;
    const stdDev = Math.sqrt(variance);
    volThreshold = volMean + VOLUME_ZSCORE_THRESHOLD * stdDev;
  }

  const latestClosed = closed[0];
  const latestVol = latestClosed.volume;
  const latestClose = latestClosed.close;

  const recentSwingHigh = findSwing(closed, 20, "high");
  const recentSwingLow = findSwing(closed, 20, "low");

  // A CHoCH needs an established level to break. With no confirmed fractal
  // there is no level, so there is no break — do NOT substitute the window
  // max/min, which is a level the market has not actually respected.
  if (inBullOB) {
    if (recentSwingHigh === null) {
      return { state: "IN_HTF_POI", ltfMessage: "NO CONFIRMED SWING HIGH" };
    }
    if (latestClose > recentSwingHigh && latestVol > volThreshold) {
      return { state: "BULL_EXEC", ltfMessage: "FRACTAL CHOCH UP (Z-SCORE MET)" };
    }
    if (latestClose > recentSwingHigh) {
      return { state: "IN_HTF_POI", ltfMessage: "FRACTAL BREAK (LOW VOLUME)" };
    }
    return { state: "IN_HTF_POI", ltfMessage: "WAITING FRACTAL CHOCH" };
  }

  if (inBearOB) {
    if (recentSwingLow === null) {
      return { state: "IN_HTF_POI", ltfMessage: "NO CONFIRMED SWING LOW" };
    }
    if (latestClose < recentSwingLow && latestVol > volThreshold) {
      return { state: "BEAR_EXEC", ltfMessage: "FRACTAL CHOCH DOWN (Z-SCORE MET)" };
    }
    if (latestClose < recentSwingLow) {
      return { state: "IN_HTF_POI", ltfMessage: "FRACTAL BREAK (LOW VOLUME)" };
    }
    return { state: "IN_HTF_POI", ltfMessage: "WAITING FRACTAL CHOCH" };
  }

  return { state: "WAITING", ltfMessage: "---" };
}

/**
 * Full microstructure analysis for a single asset.
 * htfCandles: 4H candles, NEWEST-FIRST
 * ltfCandles: 15M candles, NEWEST-FIRST
 * d1Candles: Daily candles, NEWEST-FIRST
 * currentPrice: latest price, used only for the OB containment test
 *
 * `currentPrice` is a live quote and is appropriate for the containment
 * check — "is price inside the zone right now" is inherently a live
 * question. It is NOT used for the CHoCH or volume verdicts, which read
 * closed bars only.
 */
export function analyzeAsset(
  htfCandles: OHLCVCandle[],
  ltfCandles: OHLCVCandle[],
  d1Candles: OHLCVCandle[],
  currentPrice: number
): MicrostructureResult {
  if (!(currentPrice > 0)) {
    return {
      state: "SYNC_ERROR",
      htfMessage: "NO PRICE",
      ltfMessage: "---",
      signalAction: "AWAITING TICKS",
      obType: null,
      obHigh: null,
      obLow: null,
    };
  }

  const ob = detectOrderBlock(htfCandles);

  if (!ob) {
    return {
      state: "WAITING",
      htfMessage: "OUTSIDE POI",
      ltfMessage: "---",
      signalAction: "WAITING",
      obType: null,
      obHigh: null,
      obLow: null,
    };
  }

  // Containment uses the live price: the question is whether we are in the
  // zone now. The verdicts below use closed bars only.
  const inBullOB = ob.type === "BULL" && currentPrice <= ob.high && currentPrice >= ob.low;
  const inBearOB = ob.type === "BEAR" && currentPrice <= ob.high && currentPrice >= ob.low;

  if (!inBullOB && !inBearOB) {
    return {
      state: "WAITING",
      htfMessage: "OUTSIDE POI",
      ltfMessage: "---",
      signalAction: "WAITING",
      obType: ob.type,
      obHigh: ob.high,
      obLow: ob.low,
    };
  }

  // Daily bias filter
  const dailyBias = getDailyBias(d1Candles);
  if (USE_DAILY_BIAS) {
    if ((inBullOB && dailyBias === -1) || (inBearOB && dailyBias === 1)) {
      return {
        state: "FILTERED_BIAS",
        htfMessage: "IGNORED (D1 BIAS)",
        ltfMessage: "D1 FILTERED",
        signalAction: "D1 FILTERED",
        obType: ob.type,
        obHigh: ob.high,
        obLow: ob.low,
      };
    }
  }

  // Killzone check
  if (!isInKillzone()) {
    return {
      state: "OUT_OF_SESSION",
      htfMessage: "INSIDE POI (CACHED)",
      ltfMessage: "WAITING FOR SESSION",
      signalAction: "OUT OF KILLZONE",
      obType: ob.type,
      obHigh: ob.high,
      obLow: ob.low,
    };
  }

  // LTF analysis
  const { state, ltfMessage } = analyzeLTF(ltfCandles, inBullOB, inBearOB);

  const htfMessage =
    state === "BULL_EXEC"
      ? "HTF BULLISH"
      : state === "BEAR_EXEC"
        ? "HTF BEARISH"
        : "INSIDE POI (CACHED)";

  const signalAction =
    state === "BULL_EXEC"
      ? "EXECUTE BUY"
      : state === "BEAR_EXEC"
        ? "EXECUTE SELL"
        : "MONITOR LTF";

  return {
    state,
    htfMessage,
    ltfMessage,
    signalAction,
    obType: ob.type,
    obHigh: ob.high,
    obLow: ob.low,
  };
}
