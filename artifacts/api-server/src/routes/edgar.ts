import { Router, type IRouter } from "express";
import { rateLimit } from "../lib/security";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const edgarLimit = rateLimit("edgar-search:read", 120);

/**
 * GET /edgar-search?q=...&forms=... — pass-through to SEC EDGAR full-text
 * search for the alphaflowers research page. efts.sec.gov sends no CORS
 * headers, so browsers cannot call it directly; this route adds them.
 *
 * Read-only proxy of public filings data. Carries SEC's requested declared
 * User-Agent and briefly caches identical queries to stay gentle on SEC
 * fair-access limits (max 10 req/s; our traffic is a trickle of that).
 * This route is intentionally open (public data, costs nothing) — unlike
 * the quota-bearing forecast routes, which stay same-origin only.
 */
const cache = new Map<string, { at: number; body: string }>();
const CACHE_MS = 60_000;
const MAX_CACHE = 200;

router.get("/edgar-search", edgarLimit, async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
  const forms =
    typeof req.query.forms === "string" ? req.query.forms.slice(0, 60) : "";
  if (!q.trim()) {
    res.status(400).json({ error: "q required" });
    return;
  }
  const key = `${q}|${forms}`;
  const hitCache = cache.get(key);
  if (hitCache && Date.now() - hitCache.at < CACHE_MS) {
    res.type("json").send(hitCache.body);
    return;
  }
  const url = new URL("https://efts.sec.gov/LATEST/search-index");
  url.searchParams.set("q", q);
  url.searchParams.set("dateRange", "custom");
  url.searchParams.set("startdt", "2020-01-01");
  if (forms) url.searchParams.set("forms", forms);
  try {
    const upstream = await fetch(url, {
      headers: {
        // SEC rejects User-Agents containing raw URLs or "name/version"
        // patterns (403); a plain project identifier passes.
        "User-Agent": "MisoPrettyStacks Research (agentic-version-of-alphaflowers)",
        Accept: "application/json",
      },
    });
    if (!upstream.ok) {
      logger.warn({ status: upstream.status }, "EDGAR upstream not ok");
      res.status(502).json({ error: "EDGAR busy, try again shortly" });
      return;
    }
    const body = await upstream.text();
    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(key, { at: Date.now(), body });
    res.type("json").send(body);
  } catch (err) {
    logger.warn({ err }, "EDGAR upstream unreachable");
    res.status(502).json({ error: "EDGAR unreachable" });
  }
});

export default router;
