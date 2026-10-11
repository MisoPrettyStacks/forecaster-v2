CREATE TABLE IF NOT EXISTS "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forecasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"analysis" text NOT NULL,
	"probability" double precision,
	"ci_low" double precision,
	"ci_high" double precision,
	"model" text,
	"category" text,
	"resolve_by" timestamp with time zone,
	"resolution_criteria" text,
	"outcome" text,
	"sources" jsonb,
	"belief_state" jsonb,
	"belief_log" jsonb,
	"audit" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Tolerant upgrade path for databases created before the structured-record
-- rebuild: add any missing columns without touching existing rows.
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "probability" double precision;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "ci_low" double precision;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "ci_high" double precision;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "model" text;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "resolve_by" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "resolution_criteria" text;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "outcome" text;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "sources" jsonb;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "belief_state" jsonb;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "belief_log" jsonb;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "audit" jsonb;
--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
