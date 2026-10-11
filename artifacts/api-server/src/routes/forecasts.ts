import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, forecastsTable, type Forecast } from "@workspace/db";
import {
  CreateForecastBody,
  StreamForecastBody,
  GetForecastParams,
  DeleteForecastParams,
  ListForecastsResponse,
  GetForecastResponse,
  ResolveDueBody,
  ResolveDueResponse,
} from "@workspace/api-zod";
import { rateLimit, safeClientMessage } from "../lib/security";
import { runForecastPipeline, resolveDueForecasts } from "../lib/forecastPipeline";

const router: IRouter = Router();

// Generation endpoints call out to OpenRouter on every request, so cap them
// per IP to keep scripts from burning the API quota.
const createLimit = rateLimit("forecasts:create", 20);
const streamLimit = rateLimit("forecasts:stream", 20);
const resolveLimit = rateLimit("forecasts:resolve", 10);

function serializeForecast(row: Forecast) {
  return GetForecastResponse.parse({
    id: row.id,
    question: row.question,
    analysis: row.analysis,
    createdAt: row.createdAt.toISOString(),
    probability: row.probability ?? null,
    ciLow: row.ciLow ?? null,
    ciHigh: row.ciHigh ?? null,
    model: row.model ?? null,
    category: row.category ?? null,
    resolveBy: row.resolveBy ? row.resolveBy.toISOString() : null,
    resolutionCriteria: row.resolutionCriteria ?? null,
    outcome: row.outcome ?? null,
    sources: row.sources ?? null,
    beliefState: row.beliefState ?? null,
    beliefLog: row.beliefLog ?? null,
    audit: row.audit ?? null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  });
}

function serializeSummary(row: Forecast) {
  return {
    id: row.id,
    question: row.question,
    createdAt: row.createdAt.toISOString(),
    probability: row.probability ?? null,
    ciLow: row.ciLow ?? null,
    ciHigh: row.ciHigh ?? null,
    model: row.model ?? null,
    category: row.category ?? null,
    resolveBy: row.resolveBy ? row.resolveBy.toISOString() : null,
    outcome: row.outcome ?? null,
  };
}

router.get("/forecasts", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(forecastsTable)
      .orderBy(desc(forecastsTable.createdAt));
    const data = ListForecastsResponse.parse(rows.map(serializeSummary));
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Resolution agent sweep. A scheduled job (e.g. GitHub Actions cron) pings
// this; when RESOLVER_TOKEN is set, the ping must carry it.
router.post("/forecasts/resolve-due", resolveLimit, async (req, res, next) => {
  try {
    const token = process.env.RESOLVER_TOKEN;
    if (token && req.header("x-resolver-token") !== token) {
      res.status(401).json({ error: "Invalid resolver token." });
      return;
    }
    const body = ResolveDueBody.parse(req.body ?? {});
    const result = await resolveDueForecasts(body.limit ?? 5);
    res.json(ResolveDueResponse.parse(result));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /forecasts/stats — the forecaster's track record.
 * Proper scoring rules against a constant-0.5 / no-skill benchmark, a
 * calibration table (bins with real counts — a pretty diagonal on 12 rows is
 * noise, and the page says so), and breakdowns by category and horizon.
 * Registered BEFORE /forecasts/:id so "stats" is never parsed as an id.
 */
router.get("/forecasts/stats", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(forecastsTable)
      .orderBy(desc(forecastsTable.createdAt))
      .limit(5000);

    const scored = rows.filter(
      (r): r is typeof r & { probability: number } =>
        typeof r.probability === "number" && (r.outcome === "yes" || r.outcome === "no"),
    );
    const ambiguous = rows.filter((r) => r.outcome === "ambiguous").length;
    const pending = rows.filter((r) => r.outcome == null).length;

    const n = scored.length;
    let brier = 0;
    let logLoss = 0;
    let hits = 0;
    let yesCount = 0;
    for (const r of scored) {
      const y = r.outcome === "yes" ? 1 : 0;
      yesCount += y;
      const p = Math.min(0.999, Math.max(0.001, r.probability));
      brier += (p - y) ** 2;
      logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      if ((p >= 0.5) === (y === 1)) hits += 1;
    }
    const baseRate = n ? yesCount / n : null;
    const benchBrier = 0.25; // constant-0.5 forecaster
    const climatologyBrier = baseRate == null ? null : baseRate * (1 - baseRate);

    const bins = Array.from({ length: 5 }, (_, i) => ({
      bin: `${i * 20}–${(i + 1) * 20}%`,
      n: 0,
      avgForecast: 0,
      actualRate: 0,
    }));
    for (const r of scored) {
      const idx = Math.min(4, Math.floor(r.probability * 5));
      bins[idx].n += 1;
      bins[idx].avgForecast += r.probability;
      bins[idx].actualRate += r.outcome === "yes" ? 1 : 0;
    }
    for (const b of bins) {
      if (b.n) {
        b.avgForecast = Math.round((b.avgForecast / b.n) * 1000) / 1000;
        b.actualRate = Math.round((b.actualRate / b.n) * 1000) / 1000;
      }
    }

    const group = (keyOf: (r: (typeof scored)[number]) => string) => {
      const map = new Map<string, { n: number; brier: number; hits: number }>();
      for (const r of scored) {
        const k = keyOf(r);
        const g = map.get(k) ?? { n: 0, brier: 0, hits: 0 };
        const y = r.outcome === "yes" ? 1 : 0;
        g.n += 1;
        g.brier += (r.probability - y) ** 2;
        if ((r.probability >= 0.5) === (y === 1)) g.hits += 1;
        map.set(k, g);
      }
      return [...map.entries()]
        .map(([key, g]) => ({
          key,
          n: g.n,
          brier: Math.round((g.brier / g.n) * 10000) / 10000,
          hitRate: Math.round((g.hits / g.n) * 1000) / 1000,
        }))
        .sort((a, b) => b.n - a.n);
    };

    const byCategory = group((r) => r.category ?? "uncategorized");
    const byHorizon = group((r) => {
      if (!r.resolveBy) return "no deadline";
      const hours = (r.resolveBy.getTime() - r.createdAt.getTime()) / 3600_000;
      if (hours < 2) return "minutes–2h";
      if (hours < 48) return "~1 day";
      if (hours < 24 * 14) return "~1 week";
      return "~1 month+";
    });

    const recent = scored.slice(0, 12).map((r) => ({
      id: r.id,
      question: r.question,
      probability: r.probability,
      outcome: r.outcome,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    }));

    res.json({
      totals: {
        issued: rows.length,
        resolved: n,
        ambiguous,
        pending,
        hitRate: n ? Math.round((hits / n) * 1000) / 1000 : null,
        majorityRate: baseRate == null ? null : Math.round(Math.max(baseRate, 1 - baseRate) * 1000) / 1000,
        brier: n ? Math.round((brier / n) * 10000) / 10000 : null,
        skillVsCoinFlip: n ? Math.round((1 - brier / n / benchBrier) * 1000) / 1000 : null,
        skillVsBaseRate: n && climatologyBrier ? Math.round((1 - brier / n / climatologyBrier) * 1000) / 1000 : null,
        logLoss: n ? Math.round((logLoss / n) * 10000) / 10000 : null,
      },
      calibration: bins,
      byCategory,
      byHorizon,
      recent,
      note:
        n < 30
          ? "Too early to judge: under ~30 settled forecasts these numbers are mostly noise. A real edge looks like hit rates of 51–53% and Brier skill of +1–3% sustained over hundreds."
          : "A real edge looks like hit rates of 51–53% and Brier skill of +1–3% sustained over hundreds of settled forecasts. Much better than that usually means leakage, not genius.",
    });
  } catch (err) {
    next(err);
  }
});

router.get("/forecasts/:id", async (req, res, next) => {
  try {
    const { id } = GetForecastParams.parse({ id: Number(req.params.id) });
    const [row] = await db
      .select()
      .from(forecastsTable)
      .where(eq(forecastsTable.id, id))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Forecast not found" });
      return;
    }
    res.json(serializeForecast(row));
  } catch (err) {
    next(err);
  }
});

router.delete("/forecasts/:id", async (req, res, next) => {
  try {
    const { id } = DeleteForecastParams.parse({ id: Number(req.params.id) });
    const result = await db
      .delete(forecastsTable)
      .where(eq(forecastsTable.id, id))
      .returning({ id: forecastsTable.id });
    if (result.length === 0) {
      res.status(404).json({ error: "Forecast not found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/forecasts", createLimit, async (req, res, next) => {
  try {
    const input = CreateForecastBody.parse(req.body);
    const structured = await runForecastPipeline(input.question, {
      resolveBy: input.resolveBy,
      resolutionCriteria: input.resolutionCriteria,
      category: input.category,
    });

    const [row] = await db
      .insert(forecastsTable)
      .values({
        question: input.question,
        analysis: structured.analysis,
        probability: structured.probability,
        ciLow: structured.ciLow,
        ciHigh: structured.ciHigh,
        model: structured.model,
        category: structured.category,
        resolveBy: structured.resolveBy,
        resolutionCriteria: structured.resolutionCriteria,
        sources: structured.sources,
        beliefState: structured.beliefState,
        beliefLog: structured.beliefLog,
        audit: structured.audit,
      })
      .returning();

    if (!row) {
      throw new Error("Failed to insert forecast");
    }

    res.status(201).json(serializeForecast(row));
  } catch (err) {
    req.log.error({ err }, "Failed to create forecast");
    next(err);
  }
});

router.post("/forecasts/stream", streamLimit, async (req, res, next) => {
  try {
    const input = StreamForecastBody.parse(req.body);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent("start", { question: input.question });

    try {
      const structured = await runForecastPipeline(
        input.question,
        {
          resolveBy: input.resolveBy,
          resolutionCriteria: input.resolutionCriteria,
          category: input.category,
        },
        (e) => {
          if (e.type === "search_start") sendEvent("search_start", { query: input.question });
          else if (e.type === "search_query") sendEvent("search_query", { query: e.query ?? "" });
          else if (e.type === "search_done") sendEvent("search_done", {});
          else sendEvent("stage", { stage: e.stage ?? "", message: e.message ?? "" });
        },
      );

      // The full answer text goes out before persistence, so a database
      // failure can never eat a completed forecast.
      sendEvent("chunk", { text: structured.analysis });

      let row: Forecast | undefined;
      try {
        const inserted = await db
          .insert(forecastsTable)
          .values({
            question: input.question,
            analysis: structured.analysis,
            probability: structured.probability,
            ciLow: structured.ciLow,
            ciHigh: structured.ciHigh,
            model: structured.model,
            category: structured.category,
            resolveBy: structured.resolveBy,
            resolutionCriteria: structured.resolutionCriteria,
            sources: structured.sources,
            beliefState: structured.beliefState,
            beliefLog: structured.beliefLog,
            audit: structured.audit,
          })
          .returning();
        row = inserted[0];
      } catch (persistErr) {
        req.log.error({ err: persistErr }, "Forecast persistence failed");
      }

      sendEvent("done", {
        id: row ? row.id : null,
        persisted: !!row,
        question: input.question,
        analysis: structured.analysis,
        createdAt: row ? row.createdAt.toISOString() : new Date().toISOString(),
        probability: structured.probability,
        ciLow: structured.ciLow,
        ciHigh: structured.ciHigh,
        model: structured.model,
        category: structured.category,
        resolveBy: structured.resolveBy ? structured.resolveBy.toISOString() : null,
        resolutionCriteria: structured.resolutionCriteria,
        sources: structured.sources,
      });
    } catch (streamErr) {
      req.log.error({ err: streamErr }, "Stream forecast failed");
      // Never forward raw error text: DB/driver messages can contain SQL
      // or host details. Only curated messages reach the client.
      sendEvent("error", { message: safeClientMessage(streamErr) });
    } finally {
      res.end();
    }
  } catch (err) {
    next(err);
  }
});

export default router;
