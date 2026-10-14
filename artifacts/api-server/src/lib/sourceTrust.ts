// V2 source-trust memory (Zhao & Welsch 2026, arXiv:2605.31201).
//
// "Learning where to retrieve can be as important as learning how to read":
// the 5 forecasting models stay frozen; instead we maintain a Bayesian
// beta-binomial trust memory per (source-family × category × horizon),
// updated from matured resolution outcomes, and rerank web-search sources
// by demonstrated predictive utility rather than textual relevance.

import { and, eq } from "drizzle-orm";
import { db, sourceTrustTable, type ForecastSource } from "@workspace/db";
import { scheduleGitSync } from "@workspace/db";
import { horizonBucket } from "@workspace/db";

export type SourceFamily =
  | "prediction_market"
  | "wire"
  | "news"
  | "government"
  | "academic"
  | "blog"
  | "other";

const MARKET_HOSTS = [
  "polymarket.com",
  "kalshi.com",
  "metaculus.com",
  "predictit.org",
  "manifold.markets",
];
const WIRE_HOSTS = [
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "cnbc.com",
  "bbc.com",
  "bbc.co.uk",
];

/** Classify a cited URL into a source family for the trust memory. */
export function sourceFamily(url: string | undefined): SourceFamily {
  if (!url) return "other";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (MARKET_HOSTS.some((h) => host.endsWith(h))) return "prediction_market";
  if (WIRE_HOSTS.some((h) => host.endsWith(h))) return "wire";
  if (host.endsWith(".gov") || host.endsWith(".gov.uk") || host.endsWith(".europa.eu"))
    return "government";
  if (
    host.endsWith(".edu") ||
    host.includes("arxiv") ||
    host.includes("scholar") ||
    host.includes("nature.com") ||
    host.includes("science.org")
  )
    return "academic";
  if (
    host.includes("blog") ||
    host.includes("substack") ||
    host.includes("medium.com") ||
    host.includes("x.com") ||
    host.includes("twitter.com") ||
    host.includes("reddit.com")
  )
    return "blog";
  return "news";
}

export function trustScore(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

async function getTrust(
  family: SourceFamily,
  category: string,
  horizon: string,
): Promise<number> {
  try {
    const rows = await db
      .select()
      .from(sourceTrustTable)
      .where(
        and(
          eq(sourceTrustTable.family, family),
          eq(sourceTrustTable.category, category),
          eq(sourceTrustTable.horizon, horizon),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (!r) return 0.5;
    return trustScore(r.alpha, r.beta);
  } catch {
    return 0.5;
  }
}

/**
 * Rerank cited sources by demonstrated predictive utility (trust), keeping
 * the original order as a tiebreak. Trust lookups are best-effort.
 */
export async function rerankSourcesByTrust<T extends ForecastSource>(
  sources: T[],
  category: string,
  horizon: string,
): Promise<T[]> {
  const scored = await Promise.all(
    sources.map(async (s, i) => ({
      s,
      i,
      trust: await getTrust(sourceFamily(s.url), category, horizon),
    })),
  );
  return scored
    .sort((a, b) => b.trust - a.trust || a.i - b.i)
    .map((x) => x.s);
}

/**
 * Record matured outcomes into the trust memory. `correct` = the forecast
 * came out on the side it favored (p>=0.5 and yes, or p<0.5 and no).
 * Called from the resolution path for every cited source family.
 */
export async function recordSourceOutcomes(args: {
  sources: ForecastSource[];
  probability: number | null;
  outcome: "yes" | "no";
  category: string | null;
  horizon: string;
}): Promise<void> {
  const { sources, probability, outcome, category, horizon } = args;
  if (probability == null) return;
  const correct =
    (outcome === "yes" && probability >= 0.5) || (outcome === "no" && probability < 0.5);
  const families = new Set<SourceFamily>();
  for (const s of sources) families.add(sourceFamily(s.url));
  const cat = category ?? "general";
  for (const family of families) {
    try {
      const rows = await db
        .select()
        .from(sourceTrustTable)
        .where(
          and(
            eq(sourceTrustTable.family, family),
            eq(sourceTrustTable.category, cat),
            eq(sourceTrustTable.horizon, horizon),
          ),
        )
        .limit(1);
      const r = rows[0];
      if (r) {
        await db
          .update(sourceTrustTable)
          .set({
            alpha: r.alpha + (correct ? 1 : 0),
            beta: r.beta + (correct ? 0 : 1),
            updatedAt: new Date(),
          })
          .where(eq(sourceTrustTable.id, r.id));
      } else {
        await db.insert(sourceTrustTable).values({
          family,
          category: cat,
          horizon,
          alpha: 1 + (correct ? 1 : 0),
          beta: 1 + (correct ? 0 : 1),
        });
    scheduleGitSync();
      }
    } catch {
      // trust memory is advisory — never break resolution
    }
  }
}

export { horizonBucket };
