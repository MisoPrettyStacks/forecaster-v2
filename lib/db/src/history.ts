// Shared access to the pipeline's own resolved-forecast history.
//
// Every V2 learning component (learned aggregator, hierarchical Platt
// calibration, source-trust memory, category base rates) trains ONLY on
// questions created after HISTORY_CUTOFF — the Douven (2026) contamination
// finding: fitting on pre-cutoff questions lets memorized outcomes leak in.
// Default cutoff sits safely past the ensemble models' knowledge cutoffs.

import { and, desc, isNotNull, ne, gte } from "drizzle-orm";
import { db, forecastsTable } from "@workspace/db";

export interface ResolvedForecast {
  id: number;
  question: string;
  probability: number | null;
  category: string | null;
  outcome: "yes" | "no";
  createdAt: Date;
  resolveBy: Date | null;
  beliefState: Record<string, unknown> | null;
}

export function historyCutoff(): Date {
  const raw = process.env["FORECAST_HISTORY_CUTOFF"] ?? "2025-06-01T00:00:00Z";
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : new Date("2025-06-01T00:00:00Z");
}

/** Resolved yes/no forecasts created after the cutoff, newest first. */
export async function getResolvedHistory(limit = 2000): Promise<ResolvedForecast[]> {
  const cutoff = historyCutoff();
  const rows = await db
    .select({
      id: forecastsTable.id,
      question: forecastsTable.question,
      probability: forecastsTable.probability,
      category: forecastsTable.category,
      outcome: forecastsTable.outcome,
      createdAt: forecastsTable.createdAt,
      resolveBy: forecastsTable.resolveBy,
      beliefState: forecastsTable.beliefState,
    })
    .from(forecastsTable)
    .where(
      and(
        isNotNull(forecastsTable.outcome),
        ne(forecastsTable.outcome, "ambiguous"),
        isNotNull(forecastsTable.probability),
        gte(forecastsTable.createdAt, cutoff),
      ),
    )
    .orderBy(desc(forecastsTable.createdAt))
    .limit(Math.min(5000, Math.max(1, limit)));
  return rows
    .filter((r) => r.outcome === "yes" || r.outcome === "no")
    .map((r) => ({
      id: r.id,
      question: r.question,
      probability: r.probability,
      category: r.category,
      outcome: r.outcome as "yes" | "no",
      createdAt: r.createdAt,
      resolveBy: r.resolveBy,
      beliefState:
        r.beliefState && typeof r.beliefState === "object"
          ? (r.beliefState as Record<string, unknown>)
          : null,
    }));
}

export interface EnsembleRunRecord {
  probability: number;
  model: string;
  source: string;
}

/** Per-run records stored in beliefState.ensemble.runs at forecast time. */
export function ensembleRunsOf(f: ResolvedForecast): EnsembleRunRecord[] {
  const ens = f.beliefState?.["ensemble"] as Record<string, unknown> | undefined;
  const runs = ens?.["runs"];
  if (!Array.isArray(runs)) return [];
  const out: EnsembleRunRecord[] = [];
  for (const r of runs) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const p = rec["probability"];
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    out.push({
      probability: Math.min(0.99, Math.max(0.01, p)),
      model: typeof rec["model"] === "string" ? (rec["model"] as string) : "?",
      source: typeof rec["source"] === "string" ? (rec["source"] as string) : "ensemble",
    });
  }
  return out;
}

/**
 * Empirical base rate per category from resolved history — the quantitative
 * anchor for the AuditForecast scaffold. Falls back to 0.5 below MIN samples.
 */
export async function categoryBaseRate(category: string | null): Promise<number> {
  const MIN = 5;
  try {
    const hist = await getResolvedHistory(2000);
    const pool = hist.filter(
      (h) => (h.category ?? "general") === (category ?? "general"),
    );
    if (pool.length < MIN) return 0.5;
    return pool.filter((h) => h.outcome === "yes").length / pool.length;
  } catch {
    return 0.5;
  }
}

/** Mean Brier score per model id over resolved history (for Gibbs weighting). */
export async function perModelBrier(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const hist = await getResolvedHistory(2000);
    const acc = new Map<string, { sum: number; n: number }>();
    for (const h of hist) {
      const y = h.outcome === "yes" ? 1 : 0;
      for (const r of ensembleRunsOf(h)) {
        if (r.source !== "ensemble") continue;
        const e = acc.get(r.model) ?? { sum: 0, n: 0 };
        e.sum += (r.probability - y) ** 2;
        e.n += 1;
        acc.set(r.model, e);
      }
    }
    for (const [m, e] of acc) if (e.n >= 3) out.set(m, e.sum / e.n);
  } catch {
    // no history yet — caller falls back
  }
  return out;
}

/** Horizon bucket for source-trust memory: short <7d, medium <90d, long otherwise. */
export function horizonBucket(now: Date, resolveBy: Date | null): string {
  if (!resolveBy) return "unknown";
  const days = (resolveBy.getTime() - now.getTime()) / 86_400_000;
  if (days < 7) return "short";
  if (days < 90) return "medium";
  return "long";
}
