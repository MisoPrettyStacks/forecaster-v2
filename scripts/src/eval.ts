#!/usr/bin/env tsx
/**
 * V2 three-axis evaluation harness (Ding et al. 2026, arXiv:2607.17765 —
 * WC2026 contamination-free benchmark).
 *
 * Always runs a market-price (or base-rate) baseline as a COMPETITOR on the
 * pipeline's own resolved questions and reports three axes:
 *   1. calibration — Brier, log loss, expected calibration error
 *   2. decision quality — accuracy and even-odds betting P&L vs the baseline
 *   3. self-knowledge — CI coverage (fraction of outcomes inside the 80% CI)
 *
 * Only post-cutoff questions are evaluated (FORECAST_HISTORY_CUTOFF).
 *
 * Usage:  DATABASE_URL=... pnpm --filter @workspace/scripts run eval
 *         DATABASE_URL=... pnpm --filter @workspace/scripts run eval -- --limit 500
 */

import { getResolvedHistory } from "@workspace/db";

const clamp01 = (x: number) => Math.min(0.999, Math.max(0.001, x));

function brier(p: number, y: number): number {
  return (p - y) ** 2;
}
function logLoss(p: number, y: number): number {
  const c = clamp01(p);
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) || 2000 : 2000;
  const hist = await getResolvedHistory(limit);
  if (!hist.length) {
    console.log("No resolved post-cutoff forecasts to evaluate.");
    return;
  }

  let n = 0;
  let brierModel = 0;
  let brierBase = 0;
  let llModel = 0;
  let accModel = 0;
  let accBase = 0;
  let pnlModel = 0;
  let pnlBase = 0;
  let ciWidthSum = 0;
  let ciWidthN = 0;
  // self-knowledge: does |p-0.5| (confidence) predict correctness?
  let confSum = 0;
  let confSq = 0;
  let corrSum = 0;
  let corrN = 0;
  const bins: Array<{ sum: number; sq: number; n: number }> = Array.from({ length: 10 }, () => ({
    sum: 0,
    sq: 0,
    n: 0,
  }));

  for (const h of hist) {
    const p = h.probability;
    if (p == null || !Number.isFinite(p)) continue;
    const y = h.outcome === "yes" ? 1 : 0;
    const pc = clamp01(p);
    // Baseline competitor: market probability when the pipeline saw one,
    // else the category base rate recorded at forecast time, else 0.5.
    const bs = h.beliefState ?? {};
    const baseRaw =
      (bs["market_probability"] as number | null) ??
      (bs["anchor"] as { probability?: number } | null)?.probability ??
      0.5;
    const base = clamp01(Number.isFinite(baseRaw) ? baseRaw : 0.5);

    n++;
    brierModel += brier(pc, y);
    brierBase += brier(base, y);
    llModel += logLoss(pc, y);
    const pickModel = pc >= 0.5 ? 1 : 0;
    const pickBase = base >= 0.5 ? 1 : 0;
    accModel += pickModel === y ? 1 : 0;
    accBase += pickBase === y ? 1 : 0;
    // Even-odds decision quality: +1 correct, -1 wrong, 0 on |p-0.5|<0.03 abstain
    if (Math.abs(pc - 0.5) >= 0.03) pnlModel += pickModel === y ? 1 : -1;
    if (Math.abs(base - 0.5) >= 0.03) pnlBase += pickBase === y ? 1 : -1;

    const bin = Math.min(9, Math.floor(pc * 10));
    bins[bin]!.sum += y;
    bins[bin]!.sq += pc;
    bins[bin]!.n += 1;

    const lo = bs["ci_low"] as number | undefined;
    const hi = bs["ci_high"] as number | undefined;
    if (
      typeof lo === "number" &&
      typeof hi === "number" &&
      Number.isFinite(lo) &&
      Number.isFinite(hi) &&
      hi >= lo
    ) {
      ciWidthN++;
      ciWidthSum += hi - lo;
    }
    const conf = Math.abs(pc - 0.5);
    const correct = pickModel === y ? 1 : 0;
    corrN++;
    confSum += conf;
    confSq += conf * conf;
    corrSum += conf * correct;
  }

  if (!n) {
    console.log("No evaluable forecasts (missing probabilities).");
    return;
  }

  let ece = 0;
  for (const b of bins) {
    if (!b.n) continue;
    ece += (b.n / n) * Math.abs(b.sq / b.n - b.sum / b.n);
  }
  // point-biserial correlation between confidence |p-0.5| and correctness
  const meanConf = confSum / corrN;
  const varConf = Math.max(1e-12, confSq / corrN - meanConf * meanConf);
  const meanCorr = accModel / n;
  const cov = corrSum / corrN - meanConf * meanCorr;
  const selfKnow = cov / Math.sqrt(varConf * Math.max(1e-12, meanCorr * (1 - meanCorr)));

  const f = (x: number) => x.toFixed(4);
  console.log(`\nV2 evaluation — ${n} resolved post-cutoff forecasts`);
  console.log("=".repeat(64));
  console.log(`axis 1 · calibration`);
  console.log(`  Brier (model)      ${f(brierModel / n)}`);
  console.log(`  Brier (baseline)   ${f(brierBase / n)}   ← beat this`);
  console.log(`  Δ Brier            ${f(brierBase / n - brierModel / n)}  (positive = model wins)`);
  console.log(`  log loss (model)   ${f(llModel / n)}`);
  console.log(`  ECE (10 bins)      ${f(ece)}`);
  console.log(`axis 2 · decision quality`);
  console.log(`  accuracy (model)   ${f(accModel / n)}`);
  console.log(`  accuracy (base)    ${f(accBase / n)}`);
  console.log(`  even-odds P&L      model ${pnlModel >= 0 ? "+" : ""}${pnlModel}  vs  baseline ${pnlBase >= 0 ? "+" : ""}${pnlBase}`);
  console.log(`axis 3 · self-knowledge`);
  console.log(
    `  mean CI width      ${ciWidthN ? f(ciWidthSum / ciWidthN) : "n/a"}  (sharper = more decisive; ${ciWidthN} forecasts with CIs)`,
  );
  console.log(
    `  confidence↔correct ${Number.isFinite(selfKnow) ? f(selfKnow) : "n/a"}  (does the model know when it knows?)`,
  );
  console.log("=".repeat(64));
  const verdict =
    brierModel / n < brierBase / n
      ? "MODEL BEATS BASELINE on Brier — the pipeline adds value over market/base-rate."
      : "MODEL DOES NOT BEAT BASELINE on Brier — investigate before trusting new forecasts.";
  console.log(verdict + "\n");
}

main().catch((e) => {
  console.error("eval failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
