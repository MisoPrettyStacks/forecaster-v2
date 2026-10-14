/**
 * SQLite database connection with git-based persistence.
 * 
 * The database file lives at DATA_DIR/forecasts.db (default: ./data/forecasts.db).
 * After writes, the file is committed and pushed to the repo so data survives
 * Render's ephemeral filesystem.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import * as schema from "./sqlite-schema";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "forecasts.db");

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize SQLite
const sqlite = new Database(DB_PATH);
// Enable WAL mode for better concurrent access
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// Create tables if they don't exist
export function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      analysis TEXT NOT NULL,
      probability REAL,
      ci_low REAL,
      ci_high REAL,
      model TEXT,
      category TEXT,
      resolve_by INTEGER,
      resolution_criteria TEXT,
      outcome TEXT,
      sources TEXT,
      belief_state TEXT,
      belief_log TEXT,
      audit TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS aggregator_weights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      weights TEXT NOT NULL,
      intercept REAL NOT NULL,
      feature_mean TEXT NOT NULL,
      feature_std TEXT NOT NULL,
      lambda REAL NOT NULL,
      n_samples INTEGER NOT NULL,
      loo_log_loss REAL,
      trained_at INTEGER NOT NULL,
      method TEXT NOT NULL DEFAULT 'logistic-loo'
    )`,
    `CREATE TABLE IF NOT EXISTS calibration_params (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slope REAL NOT NULL,
      category_intercepts TEXT NOT NULL,
      n_samples INTEGER NOT NULL,
      trained_at INTEGER NOT NULL,
      method TEXT NOT NULL DEFAULT 'hierarchical-platt'
    )`,
    `CREATE TABLE IF NOT EXISTS source_trust (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family TEXT NOT NULL,
      category TEXT NOT NULL,
      horizon TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 1,
      beta REAL NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS probe_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab TEXT NOT NULL,
      question TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    )`,
  ];
  
  for (const sql of statements) {
    sqlite.exec(sql);
  }
}

// Git-based persistence: commit and push the DB file
let syncPending = false;
let syncTimer: NodeJS.Timeout | null = null;

export function scheduleGitSync() {
  if (syncTimer) return; // Already scheduled
  
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncToGit().catch((err) => {
      console.error("[git-sync] Failed:", err.message);
    });
  }, 30000); // Sync 30s after last write (debounced)
}

export async function syncToGit(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("[git-sync] GITHUB_TOKEN not set, skipping git sync");
    return;
  }

  try {
    const cwd = process.cwd();
    
    // Checkpoint the WAL file to ensure all data is in the main DB file
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    
    // Configure git
    execSync('git config user.name "MisoPrettyStacks"', { cwd, stdio: "pipe" });
    execSync('git config user.email "noreply@github.com"', { cwd, stdio: "pipe" });
    
    // Add the DB file
    execSync(`git add "${DB_PATH}"`, { cwd, stdio: "pipe" });
    
    // Check if there are changes
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    if (!status.trim()) {
      console.log("[git-sync] No changes to sync");
      return;
    }
    
    // Commit and push
    const timestamp = new Date().toISOString();
    execSync(`git commit -m "data: sync forecasts.db ${timestamp}"`, { cwd, stdio: "pipe" });
    
    // Set remote URL with token
    const repo = process.env.GITHUB_REPO || "MisoPrettyStacks/forecaster-v2";
    execSync(`git remote set-url origin https://${token}@github.com/${repo}.git`, { cwd, stdio: "pipe" });
    
    execSync("git push origin main", { cwd, stdio: "pipe", timeout: 30000 });
    console.log("[git-sync] Successfully synced to git");
    
  } catch (err: any) {
    console.error("[git-sync] Error:", err.message);
    throw err;
  }
}

// Initialize schema on import
ensureSchema();

export * from "./sqlite-schema";
