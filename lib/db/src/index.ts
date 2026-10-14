/**
 * Database module - SQLite with git-based persistence.
 * Replaces PostgreSQL to avoid requiring a separate database service.
 */
export * from "./sqlite";
export { ensureSchema, scheduleGitSync, syncToGit } from "./sqlite";
