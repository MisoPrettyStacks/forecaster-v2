CREATE TABLE IF NOT EXISTS "probe_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"lab" text NOT NULL,
	"question" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
