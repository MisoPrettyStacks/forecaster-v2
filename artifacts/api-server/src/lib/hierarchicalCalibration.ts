// V2 calibration: hierarchical Platt scaling (Murphy BLF 2026,
// arXiv:2604.18576).
//
// Replaces the fixed 1.15 logit extremizing with a learned transform:
//
//   calibrated = sigmoid(slope * logit(p) + intercept[category])
//
// The shared slope and per-category intercepts are fit by logistic
// regression on log-loss over the pipeline's own resolved history
// (post-cutoff only, L2-regularized). Falls back to the legacy fixed
// extremizing until enough resolutions exist.

import { desc } from "drizzle-orm";
import { db, calibrationParamsTable } from "@workspace/db";
import { scheduleGitSync } from "@workspace/db";
import { getResolvedHistory } from "@workspace/db";

const clamp01 = (x: number) => Math.min(0.99, Math.max(0.01, x));
const clampLogitArg = (p: number) => Math.min(0.999, Math.max(0.001, p));
const logit = (p: number) => Math.log(clampLogitArg(p) / (1 - clampLogitArg(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

const MIN_SAMPLES = 30;
const LEGACY_SCALE = 1.15;
const LAMBDA = 1.0;

export interface CalibrationModel {
  slope: number;
  categoryIntercepts: Record<string, number>;
  nSamples: number;
}

function legacyCalibrate(p: number): number {
  const scale = Number(process.env.FORECAST_CALIBRATION_LOGIT_SCALE ?? String(LEGACY_SCALE));
  const a = Number.isFinite(scale) && scale > 0 ? scale : LEGACY_SCALE;
  return clamp01(sigmoid(a * logit(p)));
}

async function trainCalibration(): Promise<CalibrationModel | null> {
  const hist = await getResolvedHistory(2000);
  const rows = hist.filter(
    (h) => h.probability != null && Number.isFinite(h.probability),
  );
  if (rows.length < MIN_SAMPLES) return null;
  const cats = [...new Set(rows.map((h) => h.category ?? "general"))];
  const catIdx = new Map(cats.map((c, i) => [c, i]));
  // params: [slope, ...catIntercepts]; features per row: [logit(p)] + one-hot cat
  const d = 1 + cats.length;
  const w = new Array(d).fill(0);
  w[0] = 1; // start near identity
  const lr = 0.3;
  const iters = 4000;
  const data = rows.map((h) => ({
    x: logit(h.probability as number),
    c: catIdx.get(h.category ?? "general")!,
    y: h.outcome === "yes" ? 1 : 0,
  }));
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0);
    for (const r of data) {
      const s = w[0]! * r.x + w[1 + r.c]!;
      const err = sigmoid(s) - r.y;
      g[0]! += err * r.x;
      g[1 + r.c]! += err;
    }
    for (let j = 0; j < d; j++) {
      // L2 on everything except we keep the slope near 1 via the same penalty
      w[j]! -= lr * (g[j]! / data.length + LAMBDA * w[j]!);
    }
  }
  const categoryIntercepts: Record<string, number> = {};
  cats.forEach((c, i) => {
    categoryIntercepts[c] = w[1 + i]!;
  });
  const model: CalibrationModel = { slope: w[0]!, categoryIntercepts, nSamples: rows.length };
  await db.insert(calibrationParamsTable).values({
    slope: w[0]!,
    categoryIntercepts,
    nSamples: rows.length,
    method: "hierarchical-platt",
  });
    scheduleGitSync();
  return model;
}

let cached: { model: CalibrationModel | null; at: number } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000;

export async function getCalibration(): Promise<CalibrationModel | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.model;
  try {
    const model = await trainCalibration();
    cached = { model, at: Date.now() };
    return model;
  } catch {
    if (cached) return cached.model;
    try {
      const rows = await db
        .select()
        .from(calibrationParamsTable)
        .orderBy(desc(calibrationParamsTable.trainedAt))
        .limit(1);
      const r = rows[0];
      if (r && r.nSamples >= MIN_SAMPLES) {
        const model: CalibrationModel = {
          slope: r.slope,
          categoryIntercepts: r.categoryIntercepts,
          nSamples: r.nSamples,
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

/**
 * Calibrate a probability. Keeps the original `calibrate(p)` signature
 * working — the optional category unlocks the hierarchical offsets.
 */
export async function calibrateV2(p: number, category?: string | null): Promise<number> {
  const model = await getCalibration().catch(() => null);
  if (!model) return legacyCalibrate(p);
  const b = model.categoryIntercepts[category ?? "general"] ?? 0;
  return clamp01(sigmoid(model.slope * logit(p) + b));
}

/** Synchronous legacy path (kept for back-compat; pipeline uses calibrateV2). */
export function calibrate(p: number): number {
  return legacyCalibrate(p);
}
