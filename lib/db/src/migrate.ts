import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./index";

/**
 * Apply committed migrations (lib/db/drizzle) at server boot, so deploys
 * need no manual drizzle-kit push. Idempotent; failures are logged by the
 * caller and boot continues (the stream endpoint tolerates persistence
 * problems by design).
 */
export async function ensureSchema(): Promise<void> {
  const candidates = [
    path.resolve(process.cwd(), "lib/db/drizzle"),
    path.resolve(process.cwd(), "../../lib/db/drizzle"),
    path.resolve(process.cwd(), "../lib/db/drizzle"),
  ];
  const folder = candidates.find((c) => fs.existsSync(path.join(c, "meta/_journal.json")));
  if (!folder) {
    console.warn(`[db] migrations folder not found (looked in ${candidates.join(", ")}) — skipping`);
    return;
  }
  await migrate(db, { migrationsFolder: folder });
  console.log(`[db] schema migrations applied from ${folder}`);
}
