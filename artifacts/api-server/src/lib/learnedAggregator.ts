// V2 ensemble aggregation.
//
// Improvement 1 (Douven 2026, arXiv:2607.18269): a learned logistic
// aggregator beats every fixed rule on 254 market questions, and the core
// learned signal is model disagreement — not performance weighting. We fit
// L2 logistic regression (LOO-CV over the regularization strength) on the
// pipeline's own resolved-forecast history, post-cutoff only.
//
// Improvement 5 (Nuthanakaluva & Gaddam 2026, arXiv:2608.28116): when the
// learned weights aren't available yet, aggregate regime-aware — robust
// median under strong disagreement, Gibbs exponential inverse-loss weights
// (online, from the per-model Brier track record) under moderate
// disagreement.
//
// Falls back to the original median + logit-mean when there is no history.

import { desc } from "drizzle-orm";
import { db, aggregatorWeightsTable } from "@workspace/db";
import { scheduleGitSync } from "@workspace/db";
import {
  getResolvedHistory,
  ensembleRunsOf,
  perModelBrier,
} from "@workspace/db";

const clamp01 = (x: number) => Math.min(0.99, Math.max(0.01, x));
const clampLogitArg = (p: number) => Math.min(0.999, Math.max(0.001, p));
const logit = (p: number) => Math.log(clampLogitArg(p) / (1 - clampLogitArg(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface EnsembleMember {
  probability: number;
  model: string;
  source: "ensemble" | "market";
}

export interface AggregatorModel {
  weights: number[];
  intercept: number;
  featureMean: number[];
  featureStd: number[];
  lambda: number;
  nSamples: number;
  shrinkageK: number;
}

const MIN_SAMPLES = 25;
const MAX_RUN_FEATURES = 5;
const DISAGREEMENT_STRONG = 0.35;
const GIBBS_TAU = 0.05;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Disagreement-dependent shrinkage (BLF 3b, Murphy 2026): pull each trial's
 * logit toward the ensemble mean before aggregation. Stronger disagreement
 * → stronger shrinkage. k scales the schedule; fixed at 2.0 (LOO tuning of
 * k is a followup once history is deep).
 */
export function shrinkLogits(logits: number[], k = 2.0): number[] {
  if (logits.length < 2) return logits;
  const probs = logits.map(sigmoid);
  const disagreement = Math.max(...probs) - Math.min(...probs);
  const alpha = Math.min(0.8, Math.max(0, (disagreement - 0.05) * k));
  const mean = logits.reduce((a, b) => a + b, 0) / logits.length;
  return logits.map((l) => (1 - alpha) * l + alpha * mean);
}

/** Fixed-width features: [mean_logit, median_logit, disagreement, n_runs/7]. */
function featuresFor(logits: number[]): number[] {
  const shrunk = shrinkLogits(logits);
  const mean = shrunk.reduce((a, b) => a + b, 0) / shrunk.length;
  const med = median(shrunk);
  const probs = shrunk.map(sigmoid);
  const disagreement = Math.max(...probs) - Math.min(...probs);
  return [mean, med, disagreement, shrunk.length / 7];
}

interface Sample {
  x: number[];
  y: number;
}

function standardize(X: number[][]): { mean: number[]; std: number[]; Z: number[][] } {
  const d = X[0]?.length ?? 0;
  const mean = new Array(d).fill(0);
  for (const row of X) row.forEach((v, j) => { mean[j]! += v; });
  for (let j = 0; j < d; j++) mean[j]! /= X.length;
  const std = new Array(d).fill(0);
  for (const row of X) row.forEach((v, j) => { std[j]! += (v - mean[j]!) ** 2; });
  for (let j = 0; j < d; j++) {
    std[j] = Math.sqrt(std[j]! / X.length) || 1;
  }
  const Z = X.map((row) => row.map((v, j) => (v - mean[j]!) / std[j]!));
  return { mean, std, Z };
}

/** Batch gradient descent for L2 logistic regression. Returns [w, b]. */
function fitLogistic(Z: number[][], y: number[], lambda: number): { w: number[]; b: number } {
  const d = Z[0]?.length ?? 0;
  const w = new Array(d).fill(0);
  let b = 0;
  const lr = 0.5;
  const iters = 2500;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const z = Z[i]!;
      let s = b;
      for (let j = 0; j < d; j++) s += w[j]! * z[j]!;
      const err = sigmoid(s) - y[i]!;
      for (let j = 0; j < d; j++) gw[j]! += err * z[j]!;
      gb += err;
    }
    for (let j = 0; j < d; j++) {
      w[j]! -= lr * (gw[j]! / Z.length + lambda * w[j]!);
    }
    b -= lr * (gb / Z.length);
  }
  return { w, b };
}

function logLoss(Z: number[][], y: number[], w: number[], b: number): number {
  let sum = 0;
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i]!;
    let s = b;
    for (let j = 0; j < w.length; j++) s += w[j]! * z[j]!;
    const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(s)));
    sum += -(y[i]! * Math.log(p) + (1 - y[i]!) * Math.log(1 - p));
  }
  return sum / Z.length;
}

/** LOO-CV log-loss for one lambda (5-fold when n > 100). */
function cvLogLoss(X: number[][], y: number[], lambda: number): number {
  const n = X.length;
  const { Z } = standardize(X);
  if (n <= 100) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const Ztr = Z.filter((_, k) => k !== i);
      const ytr = y.filter((_, k) => k !== i);
      const { w, b } = fitLogistic(Ztr, ytr, lambda);
      sum += logLoss([Z[i]!], [y[i]!], w, b);
    }
    return sum / n;
  }
  // 5-fold fallback for deep histories
  let sum = 0;
  for (let f = 0; f < 5; f++) {
    const Ztr = Z.filter((_, k) => k % 5 !== f);
    const ytr = y.filter((_, k) => k % 5 !== f);
    const Zte = Z.filter((_, k) => k % 5 === f);
    const yte = y.filter((_, k) => k % 5 === f);
    if (!Zte.length) continue;
    const { w, b } = fitLogistic(Ztr, ytr, lambda);
    sum += logLoss(Zte, yte, w, b);
  }
  return sum / 5;
}

async function trainAggregator(): Promise<AggregatorModel | null> {
  const hist = await getResolvedHistory(2000);
  const samples: Sample[] = [];
  for (const h of hist) {
    const runs = ensembleRunsOf(h).filter((r) => r.source === "ensemble").slice(0, MAX_RUN_FEATURES);
    if (runs.length < 2) continue;
    const logits = runs.map((r) => logit(r.probability));
    samples.push({ x: featuresFor(logits), y: h.outcome === "yes" ? 1 : 0 });
  }
  if (samples.length < MIN_SAMPLES) return null;
  const X = samples.map((s) => s.x);
  const y = samples.map((s) => s.y);
  let bestLambda = 1;
  let bestLoss = Infinity;
  for (const lambda of [0.01, 0.1, 1, 10]) {
    const loss = cvLogLoss(X, y, lambda);
    if (loss < bestLoss) {
      bestLoss = loss;
      bestLambda = lambda;
    }
  }
  const { mean, std, Z } = standardize(X);
  const { w, b } = fitLogistic(Z, y, bestLambda);
  const model: AggregatorModel = {
    weights: w,
    intercept: b,
    featureMean: mean,
    featureStd: std,
    lambda: bestLambda,
    nSamples: samples.length,
    shrinkageK: 2.0,
  };
  await db.insert(aggregatorWeightsTable).values({
    weights: w,
    intercept: b,
    featureMean: mean,
    featureStd: std,
    lambda: bestLambda,
    nSamples: samples.length,
    looLogLoss: bestLoss,
    method: "logistic-loo",
  });
    scheduleGitSync();
  return model;
}

let cached: { model: AggregatorModel | null; at: number } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Latest trained weights (trains on demand; null until enough history). */
export async function getAggregator(): Promise<AggregatorModel | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.model;
  try {
    const model = await trainAggregator();
    cached = { model, at: Date.now() };
    return model;
  } catch {
    // DB unreachable or training failed: fall back without learning.
    if (cached) return cached.model;
    try {
      const rows = await db
        .select()
        .from(aggregatorWeightsTable)
        .orderBy(desc(aggregatorWeightsTable.trainedAt))
        .limit(1);
      const r = rows[0];
      if (r && r.nSamples >= MIN_SAMPLES) {
        const model: AggregatorModel = {
          weights: r.weights,
          intercept: r.intercept,
          featureMean: r.featureMean,
          featureStd: r.featureStd,
          lambda: r.lambda,
          nSamples: r.nSamples,
          shrinkageK: 2.0,
        };
        cached = { model, at: Date.now() };
        return model;
      }
    } catch {
      // ignore
    }
    cached = { model: null, at: Date.now() };
    return null;
  }
}

function applyModel(m: AggregatorModel, logits: number[]): number {
  const x = featuresFor(logits);
  const z = x.map((v, j) => (v - m.featureMean[j]!) / (m.featureStd[j]! || 1));
  let s = m.intercept;
  for (let j = 0; j < m.weights.length; j++) s += m.weights[j]! * z[j]!;
  return clamp01(sigmoid(s));
}

/**
 * Regime-aware fallback (improvement 5): strong disagreement → robust
 * median; moderate disagreement → Gibbs exponential inverse-loss weights
 * from the per-model Brier track record (uniform → logit-mean when no
 * track record yet).
 */
export async function aggregateRegime(
  members: EnsembleMember[],
): Promise<{ probability: number; method: string; detail: string }> {
  const ens = members.filter((m) => m.source === "ensemble");
  const pool = (ens.length ? ens : members).map((m) => clamp01(m.probability));
  if (!pool.length) throw new Error("no ensemble members to aggregate");
  const disagreement = Math.max(...pool) - Math.min(...pool);
  if (disagreement > DISAGREEMENT_STRONG || pool.length < 2) {
    return {
      probability: median(pool),
      method: "robust-median",
      detail: `strong disagreement (${disagreement.toFixed(3)}) — robust median over ${pool.length} members`,
    };
  }
  const briers = await perModelBrier();
  const logits = pool.map(logit);
  const models = (ens.length ? ens : members).map((m) => m.model);
  let weights: number[];
  if (briers.size) {
    const losses = models.map((m) => briers.get(m) ?? 0.25);
    const exps = losses.map((l) => Math.exp(-l / GIBBS_TAU));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    weights = exps.map((e) => e / sum);
  } else {
    weights = logits.map(() => 1 / logits.length);
  }
  const agg = sigmoid(logits.reduce((a, l, i) => a + l * weights[i]!, 0));
  return {
    probability: clamp01(agg),
    method: briers.size ? "gibbs-brier" : "logit-mean",
    detail: `moderate disagreement (${disagreement.toFixed(3)}) — Gibbs inverse-Brier weights over ${pool.length} members`,
  };
}

/**
 * Full V2 aggregation: learned logistic aggregator when trained, else the
 * regime-aware fallback, else the legacy median/logit-mean blend.
 */
export async function aggregateEnsemble(
  members: EnsembleMember[],
): Promise<{ probability: number; method: string; detail: string; disagreement: number }> {
  const pool = members.map((m) => clamp01(m.probability));
  const disagreement = pool.length ? Math.max(...pool) - Math.min(...pool) : 0;
  const agg = await getAggregator().catch(() => null);
  if (agg) {
    const ens = members.filter((m) => m.source === "ensemble");
    const logits = (ens.length ? ens : members)
      .slice(0, MAX_RUN_FEATURES)
      .map((m) => logit(clamp01(m.probability)));
    if (logits.length >= 2) {
      return {
        probability: applyModel(agg, logits),
        method: "learned-logistic",
        detail: `logistic aggregator (n=${agg.nSamples}, λ=${agg.lambda}, LOO fit)`,
        disagreement,
      };
    }
  }
  try {
    const r = await aggregateRegime(members);
    return { ...r, disagreement };
  } catch {
    const med = median(pool);
    const lm = sigmoid(pool.reduce((a, p) => a + logit(p), 0) / pool.length);
    return {
      probability: med,
      method: "median",
      detail: `legacy fallback (median=${med.toFixed(3)}, logit-mean=${lm.toFixed(3)})`,
      disagreement,
    };
  }
}
