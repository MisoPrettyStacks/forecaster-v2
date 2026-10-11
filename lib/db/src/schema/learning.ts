import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * V2 learning tables. All three are fitted from the pipeline's own
 * resolved-forecast history (post-cutoff only) and degrade gracefully to
 * fixed fallbacks when history is thin — the forecaster works on day one
 * and gets smarter as resolutions accumulate.
 */

/** Learned logistic ensemble aggregator (Douven 2026: arXiv:2607.18269). */
export const aggregatorWeightsTable = pgTable("aggregator_weights", {
  id: serial("id").primaryKey(),
  // weights[i] multiplies feature i; features = [logit(run1..run5), disagreement]
  weights: jsonb("weights").$type<number[]>().notNull(),
  intercept: doublePrecision("intercept").notNull(),
  // feature standardization (mean/std) captured at train time
  featureMean: jsonb("feature_mean").$type<number[]>().notNull(),
  featureStd: jsonb("feature_std").$type<number[]>().notNull(),
  lambda: doublePrecision("lambda").notNull(),
  nSamples: integer("n_samples").notNull(),
  looLogLoss: doublePrecision("loo_log_loss"),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  method: text("method").notNull().default("logistic-loo"),
});

/** Hierarchical Platt calibration: shared slope + per-category intercepts (Murphy BLF 2026). */
export const calibrationParamsTable = pgTable("calibration_params", {
  id: serial("id").primaryKey(),
  slope: doublePrecision("slope").notNull(),
  // { [category]: interceptOffset }
  categoryIntercepts: jsonb("category_intercepts").$type<Record<string, number>>().notNull(),
  nSamples: integer("n_samples").notNull(),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  method: text("method").notNull().default("hierarchical-platt"),
});

/**
 * Bayesian source-trust memory (Zhao & Welsch 2026): beta-binomial
 * (alpha, beta) per source-family × category × horizon bucket, updated from
 * matured resolution outcomes.
 */
export const sourceTrustTable = pgTable("source_trust", {
  id: serial("id").primaryKey(),
  family: text("family").notNull(),
  category: text("category").notNull(),
  horizon: text("horizon").notNull(),
  alpha: doublePrecision("alpha").notNull().default(1),
  beta: doublePrecision("beta").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
