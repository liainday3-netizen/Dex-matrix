import { pgTable, serial, text, real, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Open and closed trading positions.
 * Tracks on-chain executions, P&L, and partial exits.
 */
export const positionsTable = pgTable("positions", {
  id: serial("id").primaryKey(),
  pairId: integer("pair_id").notNull(),
  signalId: integer("signal_id"), // originating signal, if auto-executed
  symbol: text("symbol").notNull(),
  chain: text("chain").notNull(),
  dex: text("dex").notNull(),
  direction: text("direction").notNull(), // BUY | SELL
  status: text("status").notNull().default("OPEN"), // OPEN | PARTIAL | CLOSED | FAILED

  // Entry
  entryPrice: real("entry_price").notNull(),
  entryAmountUsd: real("entry_amount_usd").notNull(),
  tokenAmountIn: real("token_amount_in").notNull(),
  tokenAmountOut: real("token_amount_out").notNull(),
  entryTxHash: text("entry_tx_hash"),

  // Capital context at time of entry
  capitalAtEntry: real("capital_at_entry").notNull(),
  riskPct: real("risk_pct").notNull().default(2), // % of capital risked

  // Exit (filled in progressively as partial/full exits happen)
  exitPrice: real("exit_price"),
  exitAmountUsd: real("exit_amount_usd"),
  exitTxHash: text("exit_tx_hash"),
  realizedPnlUsd: real("realized_pnl_usd"),
  realizedPnlPct: real("realized_pnl_pct"),

  // Take profit levels (JSON: [{pct: 33, multiplier: 1.5, hit: false}, ...])
  tpLevels: text("tp_levels"),

  // Stop loss
  stopLossPrice: real("stop_loss_price"),
  stopLossPct: real("stop_loss_pct").default(5),

  // OB context that triggered this trade
  obHigh: real("ob_high"),
  obLow: real("ob_low"),

  // Wallet used
  walletAddress: text("wallet_address"),

  openedAt: timestamp("opened_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
  lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  notes: text("notes"),
});

export const insertPositionSchema = createInsertSchema(positionsTable).omit({
  id: true,
  openedAt: true,
  lastUpdatedAt: true,
});

export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type Position = typeof positionsTable.$inferSelect;
