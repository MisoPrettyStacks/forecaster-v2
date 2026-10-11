import type { NextFunction, Request, Response } from "express";

/** Baseline security headers for every response. */
export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  // Render terminates TLS and manages HSTS itself.
  next();
}

interface Bucket {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 10 * 60 * 1000;
const buckets = new Map<string, Bucket>();

/**
 * Simple in-memory per-IP rate limiter (sliding window). Single-instance
 * friendly; prevents scripts from burning the OpenRouter key quota.
 */
export function rateLimit(name: string, maxPerWindow: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    // Opportunistic cleanup so the map can't grow unbounded.
    if (buckets.size > 5000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(key);
        }
      }
    }

    const key = `${name}:${req.ip ?? "unknown"}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > maxPerWindow) {
      res.status(429).json({ error: "Too many requests. Please slow down." });
      return;
    }
    next();
  };
}

const SAFE_MESSAGE_PREFIXES = [
  "OpenRouter",
  "No OpenRouter",
  "Empty analysis",
  "Failed to persist",
  "Failed to insert",
  "Forecast generation failed",
  "Invalid request",
];

/**
 * Only curated, non-sensitive messages may reach the client.
 * Database/driver errors can contain SQL or host details — never forward those.
 */
export function safeClientMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (
    message &&
    SAFE_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))
  ) {
    return message;
  }
  return "Forecast failed. Please try again.";
}
