import { Router } from "express";
import { searchDexPairs, getTrendingPairs, getOHLCV } from "../lib/marketData";
import {
  SearchPairsQueryParams,
  GetTrendingPairsQueryParams,
  GetCandlesQueryParams,
} from "@workspace/api-zod";

const router = Router();

// GET /market/search?q=&chain=
router.get("/market/search", async (req, res) => {
  const parsed = SearchPairsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { q, chain } = parsed.data;
  const pairs = await searchDexPairs(q, chain ?? "all");
  res.json(pairs);
});

// GET /market/trending?chain=
router.get("/market/trending", async (req, res) => {
  const parsed = GetTrendingPairsQueryParams.safeParse(req.query);
  const chain = parsed.success ? (parsed.data.chain ?? "ethereum") : "ethereum";
  const pairs = await getTrendingPairs(chain);
  res.json(pairs);
});

// GET /market/candles?pairAddress=&chain=&timeframe=
router.get("/market/candles", async (req, res) => {
  const parsed = GetCandlesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { pairAddress, chain, timeframe } = parsed.data;
  const candles = await getOHLCV(pairAddress, chain, timeframe ?? "1h");
  res.json(candles);
});

export default router;
