CREATE TABLE IF NOT EXISTS "aggregator_weights" (
	"id" serial PRIMARY KEY NOT NULL,
	"weights" jsonb NOT NULL,
	"intercept" double precision NOT NULL,
	"feature_mean" jsonb NOT NULL,
	"feature_std" jsonb NOT NULL,
	"lambda" double precision NOT NULL,
	"n_samples" integer NOT NULL,
	"loo_log_loss" double precision,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text DEFAULT 'logistic-loo' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calibration_params" (
	"id" serial PRIMARY KEY NOT NULL,
	"slope" double precision NOT NULL,
	"category_intercepts" jsonb NOT NULL,
	"n_samples" integer NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text DEFAULT 'hierarchical-platt' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_trust" (
	"id" serial PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"category" text NOT NULL,
	"horizon" text NOT NULL,
	"alpha" double precision DEFAULT 1 NOT NULL,
	"beta" double precision DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_trust_family_category_horizon_idx" ON "source_trust" USING btree ("family","category","horizon");
