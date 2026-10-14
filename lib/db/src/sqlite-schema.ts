/**
 * SQLite schema for forecaster-v2. Replaces the PostgreSQL schema with
 * file-based storage. The database file lives at DATA_DIR/forecasts.db
 * (default: ./data/forecasts.db) and is committed to the repo for persistence.
 */
import {
  sqliteTable,
  integer,
  text,
  real,
} from "drizzle-orm/sqlite-core";

export interface ForecastSource {
  title?: string;
  url?: string;
  publisher?: string;
  date?: string;
  claim?: string;
  note?: string;
}

export type ForecastOutcome = "yes" | "no" | "ambiguous";

export const forecastsTable = sqliteTable("forecasts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  question: text("question").notNull(),
  analysis: text("analysis").notNull(),
  probability: real("probability"),
  ciLow: real("ci_low"),
  ciHigh: real("ci_high"),
  model: text("model"),
  category: text("category"),
  resolveBy: integer("resolve_by", { mode: "timestamp_ms" }),
  resolutionCriteria: text("resolution_criteria"),
  outcome: text("outcome"),
  sources: text("sources", { mode: "json" }).$type<ForecastSource[]>(),
  beliefState: text("belief_state", { mode: "json" }).$type<Record<string, unknown>>(),
  beliefLog: text("belief_log", { mode: "json" }).$type<Array<Record<string, unknown>>>(),
  audit: text("audit", { mode: "json" }).$type<Record<string, unknown>>(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const aggregatorWeightsTable = sqliteTable("aggregator_weights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  weights: text("weights", { mode: "json" }).$type<number[]>().notNull(),
  intercept: real("intercept").notNull(),
  featureMean: text("feature_mean", { mode: "json" }).$type<number[]>().notNull(),
  featureStd: text("feature_std", { mode: "json" }).$type<number[]>().notNull(),
  lambda: real("lambda").notNull(),
  nSamples: integer("n_samples").notNull(),
  looLogLoss: real("loo_log_loss"),
  trainedAt: integer("trained_at", { mode: "timestamp_ms" }).notNull(),
  method: text("method").notNull().default("logistic-loo"),
});

export const calibrationParamsTable = sqliteTable("calibration_params", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slope: real("slope").notNull(),
  categoryIntercepts: text("category_intercepts", { mode: "json" }).$type<Record<string, number>>().notNull(),
  nSamples: integer("n_samples").notNull(),
  trainedAt: integer("trained_at", { mode: "timestamp_ms" }).notNull(),
  method: text("method").notNull().default("hierarchical-platt"),
});

export const sourceTrustTable = sqliteTable("source_trust", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  family: text("family").notNull(),
  category: text("category").notNull(),
  horizon: text("horizon").notNull(),
  alpha: real("alpha").notNull().default(1),
  beta: real("beta").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const conversationsTable = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const messagesTable = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const probeLogsTable = sqliteTable("probe_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lab: text("lab").notNull(),
  question: text("question").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type Forecast = typeof forecastsTable.$inferSelect;
export type InsertForecast = typeof forecastsTable.$inferInsert;
