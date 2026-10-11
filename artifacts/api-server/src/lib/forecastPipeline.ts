// Agentic forecast pipeline — V2.
//
// Step 0 (foundations): every forecast is produced as structured JSON first
// (probability, interval, category, resolve_by, criteria, sources). The
// markdown analysis is rendered from that JSON for the UI — clients never
// scrape numbers back out of markdown.
//
// V2 stage order (AuditForecast scaffold, Cao et al. 2026):
//   0. planner decomposes the question
//   1. ANCHOR — a quantitative baseline (market price, else the category's
//      empirical base rate, else 0.5) is fixed BEFORE any LLM research runs
//   2. research agents do model-guided retrieval: evidence that would move
//      the anchor up or down, reranked by the Bayesian source-trust memory
//   3. the ensemble forecasts from the shared evidence
//   4. aggregation — learned logistic aggregator (Douven 2026) when trained,
//      else disagreement-regime-aware weighting (median vs Gibbs), else the
//      legacy median/logit-mean
//   5. supervisor returns situational factors as odds multipliers; they are
//      applied MECHANICALLY in odds space (never free-form synthesis)
//   6. hierarchical Platt calibration (shared slope + per-category offsets)
//   7. auditor emits the explicit intermediate objects
//      (anchor → ensemble → updates → calibrated) as the audit trail
// Step 4 (resolution) lives at the bottom: resolveDueForecasts().

import { and, asc, isNotNull, isNull, lte, eq } from "drizzle-orm";
import { db, forecastsTable, type ForecastSource } from "@workspace/db";
import { complete, resolveModels } from "./aiClient";
import { aggregateEnsemble } from "./learnedAggregator";
import { calibrate, calibrateV2 } from "./hierarchicalCalibration";
import { buildBeliefState, type UpdatePathStep } from "./beliefState";
import { rerankSourcesByTrust, recordSourceOutcomes } from "./sourceTrust";
import { categoryBaseRate, horizonBucket } from "@workspace/db";

export interface ForecastOptions {
  resolveBy?: Date;
  resolutionCriteria?: string;
  category?: string;
}

export interface PipelineEvent {
  type: "stage" | "search_start" | "search_query" | "search_done";
  stage?: string;
  message?: string;
  query?: string;
  model?: string;
}

export interface StructuredForecast {
  analysis: string;
  probability: number;
  ciLow: number;
  ciHigh: number;
  model: string;
  category: string | null;
  resolveBy: Date | null;
  resolutionCriteria: string | null;
  sources: ForecastSource[];
  beliefState: Record<string, unknown>;
  beliefLog: Array<Record<string, unknown>>;
  audit: Record<string, unknown>;
}

interface Plan {
  category: string;
  resolveBy: Date | null;
  resolutionCriteria: string;
  subQuestions: string[];
  openQuestions: string[];
}

interface EvidenceItem extends ForecastSource {
  stance?: "for" | "against" | "neutral";
}

interface ResearchNote {
  question: string;
  summary: string;
  evidence: EvidenceItem[];
}

interface EnsembleRun {
  probability: number;
  ciLow: number;
  ciHigh: number;
  rationale: string;
  uncertainties: string[];
  model: string;
  source: "ensemble" | "market";
}

interface SituationalFactor {
  description: string;
  oddsMultiplier: number;
  rationale: string;
}

const clamp01 = (x: number) => Math.min(0.99, Math.max(0.01, x));
const logit = (p: number) => Math.log(clamp01(p) / (1 - clamp01(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const pct = (p: number) => `${Math.round(p * 100)}%`;
const clampMult = (m: number) => Math.min(4, Math.max(0.25, m));

function envInt(name: string, dflt: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asStringArray(v: unknown, cap = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, cap);
}
function asSources(v: unknown, cap = 8): EvidenceItem[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const item: EvidenceItem = {
      title: asString(r.title) ?? undefined,
      url: asString(r.url) ?? undefined,
      publisher: asString(r.publisher) ?? undefined,
      date: asString(r.date) ?? undefined,
      claim: asString(r.claim) ?? undefined,
      note: asString(r.note) ?? undefined,
      stance:
        r.stance === "for" || r.stance === "against" || r.stance === "neutral"
          ? r.stance
          : undefined,
    };
    if (item.title || item.url || item.claim) out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}
function asFactors(v: unknown, cap = 6): SituationalFactor[] {
  if (!Array.isArray(v)) return [];
  const out: SituationalFactor[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const m = asNumber(r.oddsMultiplier);
    const description = asString(r.description);
    if (m == null || !description) continue;
    out.push({
      description,
      oddsMultiplier: clampMult(m),
      rationale: asString(r.rationale) ?? "",
    });
    if (out.length >= cap) break;
  }
  return out;
}

/** One JSON-returning agent call. Throws on transport/parse failure. */
async function jsonAgent(opts: {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  webSearch?: boolean;
  maxTokens?: number;
}): Promise<{ data: Record<string, unknown>; model: string }> {
  const { text, model } = await complete({
    system: opts.system,
    user: opts.user,
    model: opts.model,
    temperature: opts.temperature,
    webSearch: opts.webSearch ?? false,
    maxTokens: opts.maxTokens ?? 3000,
  });
  const data = parseJsonObject(text);
  if (!data) throw new Error("Agent did not return JSON");
  return { data, model };
}

const JSON_ONLY =
  "Return ONLY a JSON object matching the requested shape. No markdown fences, no prose outside the JSON. Probabilities are numbers between 0 and 1 (not percents). Dates are ISO 8601 UTC.";

async function planQuestion(
  question: string,
  opts: ForecastOptions,
  now: Date,
): Promise<Plan> {
  const fallback: Plan = {
    category: opts.category ?? "general",
    resolveBy: opts.resolveBy ?? null,
    resolutionCriteria:
      opts.resolutionCriteria ??
      "Resolve YES if the event described in the question has clearly happened by resolve_by, based on a cited public source; otherwise NO. If credible sources conflict or the event is not yet determinable, mark AMBIGUOUS.",
    subQuestions: [question],
    openQuestions: [],
  };
  try {
    const { data } = await jsonAgent({
      system: `You are the planning agent of a forecasting system. ${JSON_ONLY}`,
      user: `Current UTC time: ${now.toISOString()}.
Question: ${question}
${opts.resolveBy ? `User-supplied resolve_by: ${opts.resolveBy.toISOString()}` : ""}
${opts.resolutionCriteria ? `User-supplied resolution criteria: ${opts.resolutionCriteria}` : ""}
${opts.category ? `User-supplied category: ${opts.category}` : ""}

Decompose this into a forecast plan. Return:
{"category": string, "resolveBy": ISO date or null, "resolutionCriteria": string,
 "subQuestions": [2-4 specific research questions whose answers most reduce uncertainty],
 "openQuestions": [what would change the forecast]}
Infer resolveBy from the question when it names a horizon (e.g. "in 15 minutes" means now + 15 minutes).`,
      webSearch: false,
      maxTokens: 1200,
      temperature: 0.2,
    });
    const resolveByRaw = asString(data.resolveBy);
    const parsedDate = resolveByRaw ? new Date(resolveByRaw) : null;
    return {
      category: opts.category ?? asString(data.category) ?? fallback.category,
      resolveBy:
        opts.resolveBy ?? (parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate : null),
      resolutionCriteria:
        opts.resolutionCriteria ?? asString(data.resolutionCriteria) ?? fallback.resolutionCriteria,
      subQuestions: asStringArray(data.subQuestions, 4).length
        ? asStringArray(data.subQuestions, 4)
        : fallback.subQuestions,
      openQuestions: asStringArray(data.openQuestions, 5),
    };
  } catch {
    return fallback;
  }
}

async function researchAgent(
  subQuestion: string,
  parentQuestion: string,
  now: Date,
  anchor: { probability: number; source: string } | null,
): Promise<ResearchNote> {
  try {
    const { data } = await jsonAgent({
      system: `You are a research agent in a forecasting system. Use web search. Prefer the most recent credible sources; ignore stale pages when fresher reporting exists. ${JSON_ONLY}`,
      user: `Current UTC time: ${now.toISOString()}.
Forecast question: ${parentQuestion}
Research sub-question: ${subQuestion}
${anchor ? `Current quantitative anchor: ${anchor.probability.toFixed(3)} (from ${anchor.source}). Find evidence that would move this anchor UP or DOWN, and say which direction each item pushes it.` : ""}
STRICT point-in-time rule: cite ONLY sources published at or before ${now.toISOString()}. Never cite anything newer.

Return:
{"summary": string,
 "evidence": [{"claim": string, "title": string, "url": string, "publisher": string,
               "date": ISO date of the source, "stance": "for"|"against"|"neutral"}]}
"for" means the evidence supports YES on the forecast question. Cite only sources you actually found.`,
      webSearch: true,
      maxTokens: 2500,
      temperature: 0.2,
    });
    // Strict point-in-time filter against the pipeline start: drop evidence
    // dated after the forecast began (or implausibly in the future).
    const evidence = asSources(data.evidence, 6).filter((e) => {
      if (!e.date) return true;
      const t = Date.parse(e.date);
      return !Number.isFinite(t) || t <= now.getTime();
    });
    return {
      question: subQuestion,
      summary: asString(data.summary) ?? "",
      evidence,
    };
  } catch {
    return { question: subQuestion, summary: "", evidence: [] };
  }
}

async function marketAgent(question: string, plan: Plan, now: Date): Promise<EnsembleRun | null> {
  try {
    const { data } = await jsonAgent({
      system: `You are the market-price agent in a forecasting system. Use web search. Prediction-market and exchange prices are evidence, not ground truth. ${JSON_ONLY}`,
      user: `Current UTC time: ${now.toISOString()}.
Question: ${question}
Resolution criteria: ${plan.resolutionCriteria}

Look for a directly relevant market price (Polymarket, Kalshi, Metaculus, or an exchange-implied probability) for this exact question or a close proxy. Return:
{"marketProbability": number or null,
 "markets": [{"title": string, "url": string, "publisher": string, "date": string, "claim": string}]}
Return null when no relevant market exists. Do not invent a price.`,
      webSearch: true,
      maxTokens: 1500,
      temperature: 0.1,
    });
    const p = asNumber(data.marketProbability);
    if (p == null) return null;
    return {
      probability: clamp01(p),
      ciLow: clamp01(p - 0.05),
      ciHigh: clamp01(p + 0.05),
      rationale: "Market-price member (treated as one ensemble vote, not an anchor).",
      uncertainties: [],
      model: "market",
      source: "market",
    };
  } catch {
    return null;
  }
}

function evidenceDigest(notes: ResearchNote[]): string {
  const lines: string[] = [];
  for (const n of notes) {
    if (n.summary) lines.push(`- ${n.question}: ${n.summary}`);
    for (const e of n.evidence) {
      lines.push(
        `  * [${e.stance ?? "neutral"}] ${e.claim ?? e.title ?? ""} (${e.publisher ?? "source"}, ${e.date ?? "n.d."}) ${e.url ?? ""}`,
      );
    }
  }
  return lines.join("\n").slice(0, 7000) || "(no web evidence gathered)";
}

async function forecastRun(
  question: string,
  plan: Plan,
  notes: ResearchNote[],
  model: string | undefined,
  temperature: number,
): Promise<EnsembleRun> {
  const { data, model: used } = await jsonAgent({
    system: `You are one forecaster in a diverse ensemble. Be calibrated and base-rate driven. You get shared research evidence; reason independently. ${JSON_ONLY}`,
    user: `Question: ${question}
Category: ${plan.category}
Resolution criteria: ${plan.resolutionCriteria}
Resolve by: ${plan.resolveBy ? plan.resolveBy.toISOString() : "unspecified"}

Research evidence:
${evidenceDigest(notes)}

Return:
{"probability": number, "ciLow": number, "ciHigh": number,
 "rationale": string, "uncertainties": [string]}`,
    model,
    temperature,
    webSearch: false,
    maxTokens: 1800,
  });
  const p = asNumber(data.probability);
  if (p == null) throw new Error("Ensemble run returned no probability");
  const lo = asNumber(data.ciLow);
  const hi = asNumber(data.ciHigh);
  return {
    probability: clamp01(p),
    ciLow: clamp01(lo ?? p - 0.1),
    ciHigh: clamp01(hi ?? p + 0.1),
    rationale: asString(data.rationale) ?? "",
    uncertainties: asStringArray(data.uncertainties, 4),
    model: used,
    source: "ensemble",
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Re-exported legacy calibration (kept for back-compat). */
export { calibrate };

async function auditForecast(input: {
  probability: number;
  ciLow: number;
  ciHigh: number;
  resolveBy: Date | null;
  sources: ForecastSource[];
  updatePath: UpdatePathStep[];
  now: Date;
}): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  let passed = true;
  if (!(input.probability >= 0 && input.probability <= 1)) {
    passed = false;
    warnings.push("probability outside [0,1] — clamped");
  }
  if (input.ciLow > input.probability || input.ciHigh < input.probability) {
    warnings.push("interval did not contain the point estimate — widened");
  }
  if (input.resolveBy && input.resolveBy.getTime() < input.now.getTime() - 60_000) {
    warnings.push("resolve_by is in the past");
  }
  const futureCutoff = input.now.getTime();
  for (const s of input.sources) {
    if (s.date) {
      const t = Date.parse(s.date);
      if (Number.isFinite(t) && t > futureCutoff) warnings.push(`source dated in the future: ${s.title ?? s.url ?? "?"}`);
    }
  }
  // Explicit intermediate objects (AuditForecast): anchor → ensemble →
  // situational updates → calibrated final, emitted as the audit trail.
  const updatePath = input.updatePath.map((s) => ({ ...s }));
  // Claim support: fetch up to 3 cited pages and check keyword overlap with
  // the claim. Fetch failures are warnings, not hard failures (paywalls etc.).
  let checked = 0;
  let supported = 0;
  for (const s of input.sources.filter((x) => x.url && x.claim).slice(0, 3)) {
    checked++;
    try {
      const res = await fetch(s.url as string, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "text/html, text/plain" },
      });
      if (!res.ok) {
        warnings.push(`source not fetchable (HTTP ${res.status}): ${s.url}`);
        continue;
      }
      const html = (await res.text()).slice(0, 200_000);
      const textContent = html.replace(/<[^>]+>/g, " ").toLowerCase();
      const tokens = (s.claim as string)
        .toLowerCase()
        .split(/[^a-z0-9%$]+/)
        .filter((w) => w.length > 3);
      const hits = tokens.filter((w) => textContent.includes(w)).length;
      if (tokens.length && hits / tokens.length >= 0.2) supported++;
      else warnings.push(`claim weakly supported by cited page: ${s.url}`);
    } catch {
      warnings.push(`source fetch failed: ${s.url}`);
    }
  }
  return {
    passed,
    warnings,
    sourcesChecked: checked,
    sourcesSupported: supported,
    updatePath,
    updatePathNote: "each step records its probability so the trail is auditable end-to-end",
    checkedAt: input.now.toISOString(),
  };
}

function composeAnalysis(args: {
  question: string;
  category: string | null;
  probability: number;
  ciLow: number;
  ciHigh: number;
  rationale: string;
  uncertainties: string[];
  sources: ForecastSource[];
  resolveBy: Date | null;
  resolutionCriteria: string | null;
  anchor: { probability: number; source: string } | null;
  updatePath: UpdatePathStep[];
}): string {
  const lines: string[] = [];
  lines.push(`## FORECAST ANALYSIS: ${args.question.toUpperCase()}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("### QUESTION TRIAGE");
  lines.push("");
  lines.push(`**Classification: ${args.category ?? "general"}**`);
  if (args.resolveBy) lines.push(`\nResolve by: ${args.resolveBy.toISOString()}`);
  if (args.resolutionCriteria) lines.push(`\nResolution criteria: ${args.resolutionCriteria}`);
  if (args.anchor) {
    lines.push("");
    lines.push(`**Anchor:** ${pct(args.anchor.probability)} (from ${args.anchor.source}) — all updates below move mechanically from this baseline.`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("### FINAL FORECAST");
  lines.push("");
  lines.push(`**Probability: ==${pct(args.probability)}==**`);
  lines.push("");
  lines.push(
    `${args.rationale || "See the structured record for the full evidence trail."} ==80% confidence interval: ${pct(args.ciLow)} – ${pct(args.ciHigh)}==.`,
  );
  if (args.updatePath.length) {
    lines.push("");
    lines.push("### UPDATE PATH (audit trail)");
    lines.push("");
    for (const s of args.updatePath) {
      lines.push(`- **${s.stage}** → ${pct(s.probability)} — ${s.detail}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("### KEY UNCERTAINTIES");
  lines.push("");
  for (const u of args.uncertainties.slice(0, 5)) lines.push(`> ==${u}==`);
  if (!args.uncertainties.length) lines.push("> ==No dominant uncertainty identified== — the record will tell.");
  if (args.sources.length) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("### SOURCES");
    lines.push("");
    for (const s of args.sources.slice(0, 8)) {
      const label = s.title ?? s.claim ?? s.url ?? "source";
      lines.push(s.url ? `> [${label}](${s.url})${s.date ? ` — ${s.date}` : ""}` : `> ${label}`);
    }
  }
  return lines.join("\n");
}

export async function runForecastPipeline(
  question: string,
  opts: ForecastOptions,
  onProgress?: (e: PipelineEvent) => void,
): Promise<StructuredForecast> {
  const now = new Date();
  const beliefLog: Array<Record<string, unknown>> = [];
  const updatePath: UpdatePathStep[] = [];
  const log = (stage: string, probability: number | null, reason: string) =>
    beliefLog.push({ at: new Date().toISOString(), stage, probability, reason });
  const track = (stage: string, probability: number, detail: string) =>
    updatePath.push({ stage, probability, detail });

  onProgress?.({ type: "stage", stage: "planner", message: "Decomposing the question" });
  const plan = await planQuestion(question, opts, now);
  log("planner", null, `category=${plan.category}; ${plan.subQuestions.length} sub-questions`);

  // V2 — ANCHOR (AuditForecast): fix a quantitative baseline BEFORE research.
  onProgress?.({ type: "stage", stage: "anchor", message: "Fixing the quantitative baseline" });
  const marketRun = await marketAgent(question, plan, now).catch(() => null);
  const baseRate = await categoryBaseRate(plan.category).catch(() => 0.5);
  const anchor = marketRun
    ? { probability: marketRun.probability, source: "market-price" as const }
    : baseRate !== 0.5
      ? { probability: baseRate, source: "category-base-rate" as const }
      : { probability: 0.5, source: "uninformative-0.5" as const };
  log("anchor", anchor.probability, `baseline=${anchor.probability.toFixed(3)} from ${anchor.source}`);
  track("anchor", anchor.probability, `quantitative baseline from ${anchor.source}`);

  // V2 — model-guided retrieval: research moves the anchor up/down.
  onProgress?.({ type: "search_start", query: question });
  const maxResearch = envInt("FORECAST_RESEARCH_QUESTIONS", 3, 1, 4);
  const notes: ResearchNote[] = [];
  for (const sq of plan.subQuestions.slice(0, maxResearch)) {
    onProgress?.({ type: "search_query", query: sq });
    notes.push(await researchAgent(sq, question, now, anchor));
  }
  onProgress?.({ type: "search_done" });
  const horizon = horizonBucket(now, plan.resolveBy);
  const researchSources = await rerankSourcesByTrust(
    notes.flatMap((n) => n.evidence),
    plan.category,
    horizon,
  ).catch(() => notes.flatMap((n) => n.evidence));
  log("research", null, `${researchSources.length} cited items from ${notes.length} research agents (trust-reranked)`);

  onProgress?.({ type: "stage", stage: "ensemble", message: "Running the ensemble" });
  const models = await resolveModels().catch(() => [] as string[]);
  const runCount = envInt("FORECAST_ENSEMBLE_RUNS", 5, 1, 7);
  const temps = [0.2, 0.45, 0.7, 0.35, 0.55, 0.3, 0.6];
  const runs: EnsembleRun[] = [];
  for (let i = 0; i < runCount; i++) {
    const model = models.length ? models[i % models.length] : undefined;
    try {
      runs.push(await forecastRun(question, plan, notes, model, temps[i % temps.length]));
    } catch {
      // A failed run abstains; the ensemble proceeds with who answered.
    }
  }
  if (marketRun) runs.push(marketRun);
  if (!runs.length) throw new Error("Forecast generation failed: no ensemble run answered");

  // V2 — aggregation: learned logistic > regime-aware > legacy.
  const agg = await aggregateEnsemble(
    runs.map((r) => ({ probability: r.probability, model: r.model, source: r.source })),
  ).catch(() => null);
  const probs = runs.map((r) => r.probability);
  const med = median(probs);
  const ensembleP = agg?.probability ?? med;
  const disagreement = agg?.disagreement ?? (probs.length ? Math.max(...probs) - Math.min(...probs) : 0);
  log(
    "ensemble",
    ensembleP,
    `${runs.length} runs; ${agg ? `${agg.method} (${agg.detail})` : "legacy median"}; disagreement=${disagreement.toFixed(3)}`,
  );
  track(
    "ensemble",
    ensembleP,
    agg ? `${agg.method}: ${agg.detail}` : "legacy median aggregation",
  );

  // Supervisor: reconcile via MECHANICAL odds-space updates (AuditForecast).
  // The supervisor returns situational factors as odds multipliers on the
  // anchor; the ensemble's deviation from the anchor is folded in as one
  // more capped factor. Nothing is free-form synthesized.
  onProgress?.({ type: "stage", stage: "supervisor", message: "Supervisor reconciling the ensemble" });
  let finalP = ensembleP;
  let finalLo = median(runs.map((r) => r.ciLow));
  let finalHi = median(runs.map((r) => r.ciHigh));
  let rationale = runs.find((r) => Math.abs(r.probability - med) === Math.min(...probs.map((p) => Math.abs(p - med))))?.rationale ?? "";
  let uncertainties = [...new Set(runs.flatMap((r) => r.uncertainties))].slice(0, 5);
  let finalModel = runs[0].model;
  const factors: SituationalFactor[] = [];
  try {
    const supervisorModel = process.env.FORECAST_SUPERVISOR_MODEL || models[0];
    const review = await jsonAgent({
      system: `You are the supervisor agent of a forecasting ensemble. You spot disagreements and decide what targeted research would resolve them. ${JSON_ONLY}`,
      user: `Question: ${question}
Ensemble runs (probability, interval, model, why):
${runs.map((r) => `- ${r.probability.toFixed(3)} [${r.ciLow.toFixed(3)}, ${r.ciHigh.toFixed(3)}] ${r.model}: ${r.rationale}`).join("\n")}
Median ${med.toFixed(3)}, disagreement ${disagreement.toFixed(3)}.

Return:
{"disagreements": [string], "targetedQuestions": [up to 2 research questions that would most reduce the disagreement]}`,
      model: supervisorModel,
      temperature: 0.2,
      webSearch: false,
      maxTokens: 1500,
    });
    const targeted = asStringArray(review.data.targetedQuestions, 2);
    if (disagreement > 0.15) {
      for (const tq of targeted) {
        onProgress?.({ type: "search_query", query: tq });
        const extra = await researchAgent(tq, question, now, anchor);
        notes.push(extra);
      }
    }
    const final = await jsonAgent({
      system: `You are the supervisor agent of a forecasting ensemble. You NEVER set the final probability directly — you return situational factors as odds multipliers on a fixed anchor, applied mechanically. An odds multiplier of 2.0 doubles the odds of YES; 0.5 halves them. Keep every multiplier within [0.25, 4.0]; use 1.0 for "no update". ${JSON_ONLY}`,
      user: `Question: ${question}
Resolution criteria: ${plan.resolutionCriteria}
Quantitative anchor: ${anchor.probability.toFixed(3)} (from ${anchor.source}) — your factors multiply THIS anchor's odds.
Ensemble aggregate: ${ensembleP.toFixed(3)} via ${agg?.method ?? "median"} (disagreement ${disagreement.toFixed(3)}).
Ensemble runs:
${runs.map((r) => `- ${r.probability.toFixed(3)} [${r.ciLow.toFixed(3)}, ${r.ciHigh.toFixed(3)}] ${r.model}: ${r.rationale}`).join("\n")}
Evidence:
${evidenceDigest(notes)}

Return:
{"factors": [{"description": string, "oddsMultiplier": number, "rationale": string}],
 "rationale": string, "uncertainties": [string]}
Factors are situational adjustments the ensemble/evidence justify AGAINST the anchor. At most 6.`,
      model: supervisorModel,
      temperature: 0.2,
      webSearch: false,
      maxTokens: 2000,
    });
    factors.push(...asFactors(final.data.factors, 6));
    rationale = asString(final.data.rationale) ?? rationale;
    uncertainties = asStringArray(final.data.uncertainties, 5).length
      ? asStringArray(final.data.uncertainties, 5)
      : uncertainties;
    finalModel = final.model;
  } catch {
    // Supervisor unreachable: anchor + ensemble factor stand.
  }
  // Mechanical application in odds space (AuditForecast): the ensemble's own
  // deviation from the anchor is one more capped factor.
  const ensembleFactor: SituationalFactor = {
    description: `ensemble aggregate (${agg?.method ?? "median"})`,
    oddsMultiplier: clampMult(
      (ensembleP / (1 - ensembleP)) / (anchor.probability / (1 - anchor.probability)),
    ),
    rationale: agg?.detail ?? "legacy median",
  };
  const allFactors = [...factors, ensembleFactor];
  let logShift = allFactors.reduce((a, f) => a + Math.log(f.oddsMultiplier), 0);
  logShift = Math.min(2.5, Math.max(-2.5, logShift)); // hard cap on total move
  finalP = clamp01(sigmoid(logit(anchor.probability) + logShift));
  log(
    "supervisor",
    finalP,
    `mechanical odds update: anchor=${anchor.probability.toFixed(3)} x ${allFactors.length} factors (log-shift=${logShift.toFixed(3)})`,
  );
  track(
    "supervisor",
    finalP,
    allFactors.map((f) => `${f.description} x${f.oddsMultiplier.toFixed(2)}`).join("; "),
  );
  // Disagreement is an uncertainty signal: never report an interval narrower
  // than the ensemble spread deserves.
  const widen = disagreement / 2;
  finalLo = clamp01(Math.min(finalLo, finalP - widen));
  finalHi = clamp01(Math.max(finalHi, finalP + widen));
  if (finalLo > finalP) finalLo = finalP;
  if (finalHi < finalP) finalHi = finalP;

  // V2 — hierarchical Platt calibration (Murphy BLF).
  const calibratedP = await calibrateV2(finalP, plan.category).catch(() => calibrate(finalP));
  const calibratedLo = await calibrateV2(finalLo, plan.category).catch(() => calibrate(finalLo));
  const calibratedHi = await calibrateV2(finalHi, plan.category).catch(() => calibrate(finalHi));
  log("calibration", calibratedP, `hierarchical Platt (category=${plan.category}) from ${finalP.toFixed(3)}`);
  track("calibration", calibratedP, `hierarchical Platt scaling, category=${plan.category}`);

  const sources: ForecastSource[] = [...researchSources]
    .filter((s, i, arr) => arr.findIndex((x) => (x.url ?? x.title) === (s.url ?? s.title)) === i)
    .slice(0, 12)
    .map(({ stance, ...rest }) => rest);

  const confidence = Math.min(
    0.95,
    Math.max(0.1, 0.3 + 0.35 * (1 - disagreement) + Math.min(0.25, sources.length * 0.03)),
  );
  const evidenceFor = researchSources.filter((s) => s.stance === "for").map((s) => s.claim ?? s.title ?? "").filter(Boolean);
  const evidenceAgainst = researchSources.filter((s) => s.stance === "against").map((s) => s.claim ?? s.title ?? "").filter(Boolean);
  const openQuestions = [...plan.openQuestions, ...uncertainties].slice(0, 6);
  const beliefState = buildBeliefState({
    probability: calibratedP,
    probabilityRaw: finalP,
    ciLow: calibratedLo,
    ciHigh: calibratedHi,
    confidence,
    evidenceFor,
    evidenceAgainst,
    openQuestions,
    anchor,
    updatePath,
    ensemble: {
      runs: runs.map((r) => ({ probability: r.probability, ciLow: r.ciLow, ciHigh: r.ciHigh, model: r.model, source: r.source })),
      aggregate: ensembleP,
      aggregator: agg?.method ?? "median",
      disagreement,
    },
    marketProbability: marketRun ? marketRun.probability : null,
  });

  const audit = await auditForecast({
    probability: calibratedP,
    ciLow: calibratedLo,
    ciHigh: calibratedHi,
    resolveBy: plan.resolveBy,
    sources,
    updatePath,
    now: new Date(),
  });
  log("auditor", calibratedP, `passed=${String(audit.passed)} warnings=${(audit.warnings as string[]).length}`);

  const analysis = composeAnalysis({
    question,
    category: plan.category,
    probability: calibratedP,
    ciLow: calibratedLo,
    ciHigh: calibratedHi,
    rationale,
    uncertainties,
    sources,
    resolveBy: plan.resolveBy,
    resolutionCriteria: plan.resolutionCriteria,
    anchor,
    updatePath,
  });

  return {
    analysis,
    probability: calibratedP,
    ciLow: calibratedLo,
    ciHigh: calibratedHi,
    model: finalModel,
    category: plan.category,
    resolveBy: plan.resolveBy,
    resolutionCriteria: plan.resolutionCriteria,
    sources,
    beliefState: beliefState as unknown as Record<string, unknown>,
    beliefLog,
    audit,
  };
}

// ---------------- Step 4: resolution agent ----------------

/**
 * Deterministic settlement for "Will XRP be above/below $<threshold> at
 * <time>?" questions: the answer is a public price, not an opinion, so no
 * AI call (and no API credit) is needed. Uses the open of the first
 * 1-minute Coinbase candle at/after the deadline. Returns null for any
 * other question shape, or when the candle can't be fetched, so the caller
 * falls back to the resolution agent.
 */
async function resolveXrpThreshold(
  question: string,
  resolveBy: Date | null,
): Promise<{ outcome: "yes" | "no"; source: ForecastSource } | null> {
  if (!resolveBy) return null;
  const m = /will xrp be (above|below) \$([0-9]+(?:\.[0-9]+)?)/i.exec(question);
  if (!m) return null;
  const direction = (m[1] ?? "").toLowerCase();
  const threshold = Number(m[2]);
  if (!direction || !Number.isFinite(threshold)) return null;
  const start = new Date(resolveBy.getTime() - 60_000).toISOString();
  const end = new Date(resolveBy.getTime() + 120_000).toISOString();
  const url = `https://api.exchange.coinbase.com/products/XRP-USD/candles?start=${start}&end=${end}&granularity=60`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  // Candle rows: [time(s), low, high, open, close, volume], newest first.
  const candles = (await res.json()) as number[][];
  const candle = candles
    .filter((c) => typeof c[0] === "number" && c[0] * 1000 >= resolveBy.getTime())
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))[0];
  const price = candle?.[3];
  if (typeof price !== "number") return null;
  const above = price > threshold;
  const outcome = direction === "above" ? (above ? "yes" : "no") : above ? "no" : "yes";
  return {
    outcome,
    source: {
      title: "Coinbase Exchange XRP-USD 1-minute candles",
      url,
      publisher: "Coinbase",
      date: resolveBy.toISOString(),
      claim: `XRP opened at $${price} in the first minute at/after the deadline (threshold $${threshold}, asked "${direction}"). Settled deterministically — no AI call.`,
    },
  };
}

type ForecastRow = typeof forecastsTable.$inferSelect;

/** Persist one resolution (shared by the deterministic and agent paths). */
async function applyResolution(
  row: ForecastRow,
  finalOutcome: string,
  resolutionSource: ForecastSource | null,
): Promise<void> {
  const prevLog = Array.isArray(row.beliefLog) ? row.beliefLog : [];
  const prevSources = Array.isArray(row.sources) ? row.sources : [];
  const prevState =
    row.beliefState && typeof row.beliefState === "object" ? row.beliefState : {};
  await db
    .update(forecastsTable)
    .set({
      outcome: finalOutcome,
      resolvedAt: new Date(),
      sources: resolutionSource ? [...prevSources, resolutionSource] : prevSources,
      beliefState: {
        ...prevState,
        outcome: finalOutcome,
        resolvedAt: new Date().toISOString(),
      },
      beliefLog: [
        ...prevLog,
        {
          at: new Date().toISOString(),
          stage: "resolution",
          probability:
            typeof prevState.probability === "number" ? prevState.probability : null,
          reason: `outcome=${finalOutcome}${resolutionSource?.url ? ` source=${resolutionSource.url}` : ""}`,
        },
      ],
    })
    .where(eq(forecastsTable.id, row.id));

  // V2 — feed the matured outcome back into the Bayesian source-trust memory.
  if (finalOutcome === "yes" || finalOutcome === "no") {
    const prob =
      typeof prevState.probability === "number" ? (prevState.probability as number) : null;
    const cat = typeof row.category === "string" && row.category ? row.category : "general";
    await recordSourceOutcomes({
      sources: [...prevSources, ...(resolutionSource ? [resolutionSource] : [])].map((s) => ({
        url: (s as { url?: string }).url,
      })),
      probability: prob,
      outcome: finalOutcome,
      category: cat,
      horizon: horizonBucket(row.createdAt ?? new Date(), row.resolveBy),
    }).catch(() => undefined);
  }
}

export async function resolveDueForecasts(limit = 5): Promise<{
  checked: number;
  resolved: number;
  ambiguous: number;
  skipped: number;
  results: Array<{ id: number; outcome: string | null; source?: ForecastSource | null; reason?: string }>;
}> {
  const now = new Date();
  const due = await db
    .select()
    .from(forecastsTable)
    .where(
      and(
        isNull(forecastsTable.outcome),
        isNotNull(forecastsTable.resolveBy),
        lte(forecastsTable.resolveBy, now),
      ),
    )
    .orderBy(asc(forecastsTable.resolveBy))
    .limit(Math.min(25, Math.max(1, limit)));

  const results: Array<{ id: number; outcome: string | null; source?: ForecastSource | null; reason?: string }> = [];
  let resolved = 0;
  let ambiguous = 0;
  let skipped = 0;

  for (const row of due) {
    try {
      // XRP threshold questions settle from the real price — free and instant.
      const det = await resolveXrpThreshold(row.question, row.resolveBy).catch(
        () => null,
      );
      if (det) {
        await applyResolution(row, det.outcome, det.source);
        resolved++;
        results.push({ id: row.id, outcome: det.outcome, source: det.source });
        continue;
      }
      const { data } = await jsonAgent({
        system: `You are the resolution agent of a forecasting system. Use web search to find what actually happened. ${JSON_ONLY}`,
        user: `Current UTC time: ${new Date().toISOString()}.
Question: ${row.question}
Resolution criteria: ${row.resolutionCriteria ?? "(infer from the question)"}
Resolve by: ${row.resolveBy ? row.resolveBy.toISOString() : "unspecified"}

Find the outcome from a credible public source. Return:
{"outcome": "yes"|"no"|"ambiguous",
 "source": {"title": string, "url": string, "publisher": string, "date": string, "claim": string},
 "rationale": string}
Use "ambiguous" when credible sources conflict or the outcome is not yet determinable. Never guess an outcome without a source.`,
        webSearch: true,
        maxTokens: 1800,
        temperature: 0.1,
      });
      const outcomeRaw = asString(data.outcome);
      const outcome =
        outcomeRaw === "yes" || outcomeRaw === "no" || outcomeRaw === "ambiguous" ? outcomeRaw : "ambiguous";
      const sourceList = asSources([data.source], 1);
      const source = sourceList[0] ?? null;
      const finalOutcome = outcome !== "ambiguous" && !source?.url ? "ambiguous" : outcome;
      const resolutionSource: ForecastSource | null = source
        ? { ...source, note: `Resolution (${finalOutcome}): ${asString(data.rationale) ?? ""}`.slice(0, 500) }
        : null;

      await applyResolution(row, finalOutcome, resolutionSource);

      if (finalOutcome === "ambiguous") ambiguous++;
      else resolved++;
      results.push({ id: row.id, outcome: finalOutcome, source: resolutionSource });
    } catch (e) {
      skipped++;
      results.push({
        id: row.id,
        outcome: null,
        reason: e instanceof Error ? e.message.slice(0, 160) : "resolution failed",
      });
    }
  }

  return { checked: due.length, resolved, ambiguous, skipped, results };
}
