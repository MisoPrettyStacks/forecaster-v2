import { ensureSchema } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { startResolverScheduler } from "./lib/resolverScheduler";

// Fresh deploys must not need a manual drizzle-kit push: apply the committed
// migrations before serving. Idempotent; failures are logged, not fatal.
await ensureSchema().catch((err) => {
  logger.error({ err }, "schema migration failed at boot");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startResolverScheduler();
});
