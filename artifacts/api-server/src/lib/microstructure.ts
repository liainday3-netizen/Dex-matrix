/**
 * IronHawk Microstructure Engine — TypeScript port of Microstructure_Matrix.mq5
 *
 * Implements:
 *   - HTF Order Block detection (Bullish/Bearish)
 *   - LTF Fractal CHoCH with Volume Z-Score confirmation
 *   - Daily bias filter
 *   - London/NY killzone session filter
 */

import { OHLCVCandle } from "./marketData";

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
const LONDON_START = 8;
const LONDON_END = 12;
const NY_START = 13;
const NY_END = 17;

/**
 * Detect the most recent valid Order Block from HTF candles.
 * Bullish OB: bearish candle (i+1) followed by strong bullish close above its high, with gap confirmed.
 * Bearish OB: bullish candle (i+1) followed by strong bearish close below its low, with gap confirmed.
 */
export function detectOrderBlock(htfCandles: OHLCVCandle[]): OrderBlock | null {
  if (htfCandles.length < 5) return null;

  for (let i = 2; i < htfCandles.length - 2; i++) {
    const prev = htfCandles[i + 1]; // the OB candle
    const curr = htfCandles[i];     // the impulse candle
    const confirm = htfCandles[i - 1]; // confirmation candle

    // Bullish OB: prev is bearish, curr is bullish and closes above prev.high, confirm.low > prev.high (gap)
    const prevBearish = prev.close < prev.open;
    const currBullish = curr.close > curr.open;
    if (prevBearish && currBullish && curr.close > prev.high) {
      if (confirm.low > prev.high) {
        return { type: "BULL", high: prev.high, low: prev.low, time: prev.time };
      }
    }

    // Bearish OB: prev is bullish, curr is bearish and closes below prev.low, confirm.high < prev.low (gap)
    const prevBullish = prev.close > prev.open;
    const currBearish = curr.close < curr.open;
    if (prevBullish && currBearish && curr.close < prev.low) {
      if (confirm.high < prev.low) {
        return { type: "BEAR", high: prev.high, low: prev.low, time: prev.time };
      }
    }
  }
  return null;
}

/**
 * Detect daily bias from D1 candles (last completed daily candle).
 * Returns 1 for bullish, -1 for bearish, 0 if unknown.
 */
export function getDailyBias(d1Candles: OHLCVCandle[]): number {
  if (!USE_DAILY_BIAS || d1Candles.length < 2) return 0;
  const last = d1Candles[d1Candles.length - 2]; // index 1 = last completed
  if (last.close > last.open) return 1;
  if (last.close < last.open) return -1;
  return 0;
}

/**
 * Check if current UTC hour is within London or NY killzone.
 */
export function isInKillzone(): boolean {
  if (!USE_KILLZONES) return true;
  const hour = new Date().getUTCHours();
  return (hour >= LONDON_START && hour <= LONDON_END) || (hour >= NY_START && hour <= NY_END);
}

/**
 * Run the LTF fractal CHoCH + Volume Z-Score analysis.
 */
function analyzeLTF(
  ltfCandles: OHLCVCandle[],
  inBullOB: boolean,
  inBearOB: boolean
): { state: MarketState; ltfMessage: string } {
  if (ltfCandles.length < 10) {
    return { state: "WAITING", ltfMessage: "INSUFFICIENT LTF DATA" };
  }

  // Volume Z-Score on last 49 completed candles
  const vols = ltfCandles.slice(1, 50).map((c) => c.volume);
  const volMean = vols.reduce((a, b) => a + b, 0) / vols.length;
  const variance = vols.reduce((sum, v) => sum + Math.pow(v - volMean, 2), 0) / vols.length;
  const stdDev = Math.sqrt(variance);
  const volThreshold = volMean + VOLUME_ZSCORE_THRESHOLD * stdDev;
  const latestVol = ltfCandles[1]?.volume ?? 0;

  // Swing high/low detection (last 20 LTF candles)
  let recentSwingHigh = -Infinity;
  let recentSwingLow = Infinity;
  const lookback = Math.min(20, ltfCandles.length - 2);
  for (let j = 2; j < lookback + 2; j++) {
    if (ltfCandles[j].high > ltfCandles[j + 1]?.high && ltfCandles[j].high > ltfCandles[j - 1]?.high) {
      recentSwingHigh = ltfCandles[j].high;
      break;
    }
  }
  for (let j = 2; j < lookback + 2; j++) {
    if (ltfCandles[j].low < ltfCandles[j + 1]?.low && ltfCandles[j].low < ltfCandles[j - 1]?.low) {
      recentSwingLow = ltfCandles[j].low;
      break;
    }
  }

  // Fallback if no fractal found
  if (recentSwingHigh === -Infinity) {
    const highs = ltfCandles.slice(2, 12).map((c) => c.high);
    recentSwingHigh = Math.max(...highs);
  }
  if (recentSwingLow === Infinity) {
    const lows = ltfCandles.slice(2, 12).map((c) => c.low);
    recentSwingLow = Math.min(...lows);
  }

  const latestClose = ltfCandles[1]?.close ?? ltfCandles[0]?.close ?? 0;

  if (inBullOB) {
    if (latestClose > recentSwingHigh && latestVol > volThreshold) {
      return { state: "BULL_EXEC", ltfMessage: "FRACTAL CHOCH UP (Z-SCORE MET)" };
    } else if (latestClose > recentSwingHigh) {
      return { state: "IN_HTF_POI", ltfMessage: "FRACTAL BREAK (LOW VOLUME)" };
    } else {
      return { state: "IN_HTF_POI", ltfMessage: "WAITING FRACTAL CHOCH" };
    }
  }

  if (inBearOB) {
    if (latestClose < recentSwingLow && latestVol > volThreshold) {
      return { state: "BEAR_EXEC", ltfMessage: "FRACTAL CHOCH DOWN (Z-SCORE MET)" };
    } else if (latestClose < recentSwingLow) {
      return { state: "IN_HTF_POI", ltfMessage: "FRACTAL BREAK (LOW VOLUME)" };
    } else {
      return { state: "IN_HTF_POI", ltfMessage: "WAITING FRACTAL CHOCH" };
    }
  }

  return { state: "WAITING", ltfMessage: "---" };
}

/**
 * Full microstructure analysis for a single asset.
 * htfCandles: 4H or higher timeframe (200 bars)
 * ltfCandles: 15M timeframe (50 bars)
 * d1Candles: Daily candles (2 bars minimum)
 * currentPrice: latest price
 */
export function analyzeAsset(
  htfCandles: OHLCVCandle[],
  ltfCandles: OHLCVCandle[],
  d1Candles: OHLCVCandle[],
  currentPrice: number
): MicrostructureResult {
  // Detect order block from HTF data
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

  // Check if price is inside the OB zone
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

  const htfMessage = state === "BULL_EXEC"
    ? "HTF BULLISH"
    : state === "BEAR_EXEC"
    ? "HTF BEARISH"
    : "INSIDE POI (CACHED)";

  const signalAction = state === "BULL_EXEC"
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
