/**
 * Client for GET /api/forecasts/stats — the forecaster's track record.
 * Types mirror the route's response shape exactly (routes/forecasts.ts).
 */

export interface TrackRecordTotals {
  issued: number;
  resolved: number;
  ambiguous: number;
  pending: number;
  /** Directional hit rate among settled forecasts (null until any settle). */
  hitRate: number | null;
  /** Hit rate of always guessing the majority class — the no-skill bar. */
  majorityRate: number | null;
  /** Mean Brier score; a constant-0.5 forecaster scores exactly 0.25. */
  brier: number | null;
  /** 1 - brier/0.25; positive beats the coin flip. */
  skillVsCoinFlip: number | null;
  /** 1 - brier/(baseRate*(1-baseRate)); positive beats climatology. */
  skillVsBaseRate: number | null;
  /** Mean log loss; a constant-0.5 forecaster scores 0.6931. */
  logLoss: number | null;
}

export interface CalibrationBin {
  bin: string;
  n: number;
  avgForecast: number;
  actualRate: number;
}

export interface GroupRow {
  key: string;
  n: number;
  brier: number;
  hitRate: number;
}

export interface RecentResolved {
  id: number;
  question: string;
  probability: number;
  outcome: string;
  resolvedAt: string | null;
}

export interface TrackRecordStats {
  totals: TrackRecordTotals;
  calibration: CalibrationBin[];
  byCategory: GroupRow[];
  byHorizon: GroupRow[];
  recent: RecentResolved[];
  note: string;
}

export async function fetchTrackRecord(): Promise<TrackRecordStats> {
  const res = await fetch("/api/forecasts/stats");
  if (!res.ok) {
    throw new Error(`Track record request failed (${res.status})`);
  }
  return (await res.json()) as TrackRecordStats;
}
