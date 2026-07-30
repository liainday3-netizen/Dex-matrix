import { pgTable, serial, text, real, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Capital configuration per chain.
 * Controls position sizing, risk management, and compound scaling.
 *
 * Profit Monster 2026-2027 scaling model:
 *   positionSizeUsd = currentCapital * (riskPct / 100)
 *   As capital grows through profits, position size automatically scales up.
 */
export const capitalConfigTable = pgTable("capital_config", {
  id: serial("id").primaryKey(),
  chain: text("chain").notNull().unique(), // ethereum | base | solana

  // Capital tracking
  initialCapitalUsd: real("initial_capital_usd").notNull().default(1000),
  currentCapitalUsd: real("current_capital_usd").notNull().default(1000),
  totalRealizedPnlUsd: real("total_realized_pnl_usd").notNull().default(0),
  totalTradeCount: integer("total_trade_count").notNull().default(0),
  winCount: integer("win_count").notNull().default(0),
  lossCount: integer("loss_count").notNull().default(0),

  // Risk per trade (% of current capital)
  riskPct: real("risk_pct").notNull().default(2),
  maxRiskPct: real("max_risk_pct").notNull().default(10), // cap per trade
  stopLossPct: real("stop_loss_pct").notNull().default(5), // SL below entry

  // Take profit levels (JSON: [{pct: 33, multiplier: 1.5}, {pct: 33, multiplier: 2.0}, {pct: 34, multiplier: 3.0}])
  tpLevels: text("tp_levels").notNull().default('[{"pct":33,"multiplier":1.5},{"pct":33,"multiplier":2.0},{"pct":34,"multiplier":3.0}]'),

  // Scaling caps
  maxPositionUsd: real("max_position_usd").notNull().default(50000),
  maxConcurrentPositions: integer("max_concurrent_positions").notNull().default(3),

  // Auto-execution toggle
  autoExecute: boolean("auto_execute").notNull().default(false),
  onlyBullExec: boolean("only_bull_exec").notNull().default(true),
  onlyBearExec: boolean("only_bear_exec").notNull().default(true),

  // Wallet (public address only — private key is in env)
  walletAddress: text("wallet_address"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCapitalConfigSchema = createInsertSchema(capitalConfigTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCapitalConfig = z.infer<typeof insertCapitalConfigSchema>;
export type CapitalConfig = typeof capitalConfigTable.$inferSelect;
