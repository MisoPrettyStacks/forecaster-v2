import express, { type Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { securityHeaders } from "./lib/security";

const app: Express = express();

// Don't advertise the stack.
app.disable("x-powered-by");
// Behind Render's proxy — needed so req.ip is the real client IP.
app.set("trust proxy", 1);

app.use(securityHeaders);
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// The frontend is served same-origin, so cross-origin access stays off
// unless explicitly enabled. This keeps other sites from calling the API
// from browsers and burning the OpenRouter quota.
if (process.env.ALLOWED_ORIGIN) {
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));
}
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the built frontend (artifacts/forecaster/dist/public) when present so
// one service hosts both the UI and the API. /api routes are mounted above and
// take precedence; everything else falls back to index.html for SPA routing.
const frontendDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../forecaster/dist/public",
);
app.use(express.static(frontendDist));
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    next();
    return;
  }
  res.sendFile(path.join(frontendDist, "index.html"), (err) => {
    if (err) {
      next();
    }
  });
});

// Final error handler: log everything server-side, but never leak stack
// traces or internal messages (SQL, hosts, driver details) to clients.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    req.log?.error({ err }, "Unhandled error");
    const name =
      typeof err === "object" && err !== null && "name" in err
        ? String((err as { name: unknown }).name)
        : "";
    if (name === "ZodError") {
      res.status(400).json({ error: "Invalid request." });
      return;
    }
    res.status(500).json({ error: "Something went wrong." });
  },
);

export default app;
