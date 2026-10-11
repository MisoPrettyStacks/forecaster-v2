// Formal belief-state schema (BLF 3a, Murphy 2026, arXiv:2604.18576).
//
// The structured linguistic belief state — probability, evidence for/against,
// open questions, confidence — is the canonical inter-stage object. Stages
// produce and consume this shape; the pipeline persists it (plus V2
// extensions) in the forecast's belief_state column so the Track Record UI
// and any reader keep working.

export interface BeliefState {
  /** Canonical BLF fields (snake_case, inter-stage schema). */
  probability: number;
  evidence_for: string[];
  evidence_against: string[];
  open_questions: string[];
  confidence: number;
  /** V2 extensions. */
  ci_low: number;
  ci_high: number;
  anchor: { probability: number; source: string } | null;
  update_path: UpdatePathStep[];
  ensemble: {
    runs: Array<{ probability: number; ciLow: number; ciHigh: number; model: string; source: string }>;
    aggregate: number;
    aggregator: string;
    disagreement: number;
  };
  market_probability: number | null;
  // Back-compat camelCase mirrors (existing readers/UI).
  probabilityRaw?: number;
  evidenceFor?: string[];
  evidenceAgainst?: string[];
  openQuestions?: string[];
}

export interface UpdatePathStep {
  stage: string;
  probability: number;
  detail: string;
}

export function buildBeliefState(args: {
  probability: number;
  probabilityRaw: number;
  ciLow: number;
  ciHigh: number;
  confidence: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  openQuestions: string[];
  anchor: { probability: number; source: string } | null;
  updatePath: UpdatePathStep[];
  ensemble: BeliefState["ensemble"];
  marketProbability: number | null;
}): BeliefState {
  return {
    probability: args.probability,
    evidence_for: args.evidenceFor,
    evidence_against: args.evidenceAgainst,
    open_questions: args.openQuestions,
    confidence: args.confidence,
    ci_low: args.ciLow,
    ci_high: args.ciHigh,
    anchor: args.anchor,
    update_path: args.updatePath,
    ensemble: args.ensemble,
    market_probability: args.marketProbability,
    probabilityRaw: args.probabilityRaw,
    evidenceFor: args.evidenceFor,
    evidenceAgainst: args.evidenceAgainst,
    openQuestions: args.openQuestions,
  };
}
