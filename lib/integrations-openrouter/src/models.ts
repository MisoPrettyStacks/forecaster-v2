// Free-model discovery and ordering for OpenRouter.
//
// Free model IDs on OpenRouter rotate without warning, so we never hard-code a
// single model. Instead we fetch the live catalogue, keep the `:free` chat
// models, and try them in preference order until one answers.

import { OPENROUTER_BASE_URL, openrouterHeaders } from "./client";

interface OpenRouterModel {
  id: string;
}

// Models that are not text generators — never pick these for a forecast.
const NON_CHAT_PATTERNS =
  /safety|moderation|guard|embed|tts|transcribe|whisper|realtime|\bocr\b|image|veo|lyria|reward/i;

// Preferred free models, best first for long structured analysis. This list is
// only a preference — anything not currently offered is skipped automatically.
const PREFERRED_FREE_MODELS: string[] = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "thinkingmachines/inkling:free",
  "nvidia/nemotron-3.5-lightning:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "qwen/qwen3.8-27b:free",
  "thinkingmachines/inkling-small:free",
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "openai/gpt-oss-20b:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "dots-studio/dots-3-note-preview:free",
];

let cachedFreeModels: string[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Live list of free chat-model IDs from the OpenRouter catalogue (cached). */
export async function fetchFreeModelIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedFreeModels && now - cachedAt < CACHE_TTL_MS) {
    return cachedFreeModels;
  }
  const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
    headers: openrouterHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to list OpenRouter models: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data: OpenRouterModel[] };
  const ids = body.data
    .map((m) => m.id)
    .filter((id) => id.endsWith(":free") && !NON_CHAT_PATTERNS.test(id));
  cachedFreeModels = ids;
  cachedAt = now;
  return ids;
}

/**
 * Ordered model list to try. `OPENROUTER_MODELS` (comma-separated) overrides
 * everything. Otherwise: preferred models that are actually live right now,
 * then any other live free model as a last resort.
 */
export async function resolveModels(): Promise<string[]> {
  const override = process.env["OPENROUTER_MODELS"];
  if (override) {
    return override
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  let live: string[];
  try {
    live = await fetchFreeModelIds();
  } catch {
    // Catalogue unreachable — fall back to the preference list blind.
    return [...PREFERRED_FREE_MODELS];
  }
  const liveSet = new Set(live);
  const preferred = PREFERRED_FREE_MODELS.filter((id) => liveSet.has(id));
  const rest = live.filter((id) => !preferred.includes(id));
  return [...preferred, ...rest];
}
