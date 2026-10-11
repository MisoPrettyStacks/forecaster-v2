# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### `forecaster` — Forecasting Engine ("MISOPRETTY'S 🔮, KINDA")

Retro-cyberpunk terminal-zine forecasting tool. Rebuilt as an original V2 forecasting engine.

- **Frontend**: `artifacts/forecaster` (React + Vite, wouter routing). Black sidebar with forecast history; white main area; magenta/lime palette; hard-shadow cards; JetBrains Mono UI chrome.
- **Backend routes**: `artifacts/api-server/src/routes/forecasts.ts` — `GET /forecasts` (list), `GET /forecasts/:id`, `POST /forecasts` (one-shot), `POST /forecasts/stream` (SSE — emits `start`/`chunk`/`search_start`/`search_done`/`done`/`error` events; persists on `done`), `DELETE /forecasts/:id`. Uses free OpenRouter models via `@workspace/integrations-openrouter` (live `:free` model discovery with automatic failover).
- **Web search**: Both endpoints enable OpenRouter's `web` grounding plugin (up to 5 results) so the model can look up current prices, news, scores, etc. before writing the analysis. The streaming endpoint surfaces search activity to the client via the `search_*` SSE events.
- **AI provider env**: `OPENROUTER_API_KEY` (required — free key at https://openrouter.ai/keys), `OPENROUTER_MODELS` (optional comma-separated override), `OPENROUTER_WEB_SEARCH` (default `true`).
- **SSE client**: `artifacts/forecaster/src/lib/streamForecast.ts` — fetches the streaming endpoint, parses SSE frames, and dispatches typed events. Used by the home page to render markdown live as it generates.
- **DB schema**: `lib/db/src/schema/forecasts.ts` — `id`, `question`, `analysis` (markdown), `createdAt`.
- **System prompt** (in `forecasts.ts`): produces strict markdown with sections — FORECAST ANALYSIS, QUESTION TRIAGE (Cloudlike/Goldilocks/Clocklike), CHAMP FRAMEWORK ANALYSIS, FINAL FORECAST, KEY UNCERTAINTIES. Uses `==phrase==` syntax for highlighted lime-green pills.
- **Markdown renderer**: `artifacts/forecaster/src/components/markdown.tsx` — adds contextual emojis to chip headers based on text (TRIAGE → 🔍, ANALYSIS → 🌐, etc.). System prompt deliberately omits emojis to avoid duplication.
- **API spec**: `lib/api-spec/openapi.yaml` defines `Forecast`, `ForecastSummary`, `ForecastInput`. Codegen produces React Query hooks (`useListForecasts`, `useGetForecast`, `useCreateForecast`) in `@workspace/api-client-react`.
