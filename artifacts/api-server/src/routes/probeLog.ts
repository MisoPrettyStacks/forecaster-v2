import { Router, type IRouter, text as textBody } from "express";
import { desc } from "drizzle-orm";
import { db, probeLogsTable } from "@workspace/db";
import { rateLimit } from "../lib/security";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const probeLimit = rateLimit("probe-log:write", 60);

/**
 * POST /probe-log — the silent ping from the public lab chats.
 * The page sends it no-cors as text/plain (no preflight, fire-and-forget),
 * so accept any content type as raw text and parse defensively. Always 204:
 * the chat must never learn whether the log landed.
 */
router.post(
  "/probe-log",
  probeLimit,
  textBody({ type: () => true, limit: "4kb" }),
  async (req, res) => {
    res.status(204).end();
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
      const lab = String(body.lab ?? "").slice(0, 40);
      const question = String(body.q ?? "").slice(0, 300);
      if (!lab || !question) return;
      const forwarded = req.headers["x-forwarded-for"];
      const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim()
        ?? req.socket?.remoteAddress
        ?? null;
      const userAgent = String(req.headers["user-agent"] ?? "").slice(0, 240) || null;
      await db.insert(probeLogsTable).values({ lab, question, ip, userAgent });
    } catch (err) {
      logger.warn({ err }, "probe log insert failed");
    }
  },
);

/**
 * GET /probe-log — owner's view of the log. Requires PROBE_ADMIN_TOKEN
 * (set in the service env) presented as x-admin-token; without the env var
 * or a matching header the route pretends not to exist.
 */
router.get("/probe-log", async (req, res, next) => {
  try {
    const expected = process.env.PROBE_ADMIN_TOKEN;
    if (!expected || req.headers["x-admin-token"] !== expected) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const rows = await db
      .select()
      .from(probeLogsTable)
      .orderBy(desc(probeLogsTable.createdAt))
      .limit(200);
    res.json({
      count: rows.length,
      probes: rows.map((r) => ({
        at: r.createdAt.toISOString(),
        lab: r.lab,
        question: r.question,
        ip: r.ip,
        userAgent: r.userAgent,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
