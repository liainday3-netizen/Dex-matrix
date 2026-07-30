import { pgTable, serial, text, real, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const watchedPairsTable = pgTable("watched_pairs", {
  id: serial("id").primaryKey(),
  pairAddress: text("pair_address").notNull(),
  chain: text("chain").notNull(), // ethereum | base | solana
  dex: text("dex").notNull().default(""),
  symbol: text("symbol").notNull().default(""),
  baseToken: text("base_token").notNull().default(""),
  quoteToken: text("quote_token").notNull().default(""),
  customLabel: text("custom_label"),

  // Microstructure state
  state: text("state").notNull().default("WAITING"),
  htfMessage: text("htf_message").notNull().default("---"),
  ltfMessage: text("ltf_message").notNull().default("---"),
  signalAction: text("signal_action").notNull().default("SEARCHING"),

  // Market data
  currentPrice: real("current_price").notNull().default(0),
  priceChange24h: real("price_change_24h").notNull().default(0),
  volume24h: real("volume_24h").notNull().default(0),

  // Order block cache
  obType: text("ob_type"), // BULL | BEAR | null
  obHigh: real("ob_high"),
  obLow: real("ob_low"),
  htfLastBarTime: text("htf_last_bar_time"), // ISO string cache key

  lastScannedAt: timestamp("last_scanned_at"),
  active: boolean("active").notNull().default(true),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const insertWatchedPairSchema = createInsertSchema(watchedPairsTable).omit({
  id: true,
  addedAt: true,
  lastScannedAt: true,
});

export type InsertWatchedPair = z.infer<typeof insertWatchedPairSchema>;
export type WatchedPair = typeof watchedPairsTable.$inferSelect;
