import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per method/IP probe caught by the public lab chats on the XRP labs
 * site ("DENIED AND LOGGED"). Written by POST /api/probe-log, readable only
 * with the PROBE_ADMIN_TOKEN. This is the owner's security log for their own
 * pages — best effort by design (a probe sent by browser fetch can be
 * blocked; IPs may be VPNs or shared NATs).
 */
export const probeLogsTable = pgTable("probe_logs", {
  id: serial("id").primaryKey(),
  lab: text("lab").notNull(),
  question: text("question").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
