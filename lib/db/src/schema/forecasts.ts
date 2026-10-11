import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface ForecastSource {
  title?: string;
  url?: string;
  publisher?: string;
  date?: string;
  claim?: string;
  note?: string;
}

export type ForecastOutcome = "yes" | "no" | "ambiguous";

export const forecastsTable = pgTable("forecasts", {
  id: serial("id").primaryKey(),
  question: text("question").notNull(),
  analysis: text("analysis").notNull(),
  // Structured forecast (step 0): the API returns these as JSON fields; the
  // markdown analysis is rendered from them, never scraped back out of it.
  probability: doublePrecision("probability"),
  ciLow: doublePrecision("ci_low"),
  ciHigh: doublePrecision("ci_high"),
  model: text("model"),
  category: text("category"),
  resolveBy: timestamp("resolve_by", { withTimezone: true }),
  resolutionCriteria: text("resolution_criteria"),
  outcome: text("outcome"),
  sources: jsonb("sources").$type<ForecastSource[]>(),
  // Monitor belief state + audit trail (steps 7-8).
  beliefState: jsonb("belief_state").$type<Record<string, unknown>>(),
  beliefLog: jsonb("belief_log").$type<Array<Record<string, unknown>>>(),
  audit: jsonb("audit").$type<Record<string, unknown>>(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertForecastSchema = createInsertSchema(forecastsTable).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
});

export type InsertForecast = z.infer<typeof insertForecastSchema>;
export type Forecast = typeof forecastsTable.$inferSelect;
