// Provider-routing chat facade for the forecasting pipeline.
//
// Free-only by design. When GEMINI_API_KEY is set (Google AI Studio, free, no
// card), every agent call goes to Gemini — web-search calls use Gemini's
// built-in Google Search grounding, which bills nothing on the free tier,
// unlike OpenRouter's web plugin (the cause of the HTTP 402s that froze
// resolution: the plugin charges even with free models, so a zero balance
// refuses every searching call). Without a Gemini key we fall back to
// OpenRouter's free models, and if Gemini itself fails (quota, transport)
// we try OpenRouter before giving up.

import type { ChatOptions, ChatResult } from "@workspace/integrations-openrouter";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export function aiProvider(): "gemini" | "openrouter" {
  return process.env["GEMINI_API_KEY"] ? "gemini" : "openrouter";
}

function geminiModels(): string[] {
  const override = process.env["GEMINI_MODELS"] ?? process.env["GEMINI_MODEL"];
  if (override) {
    return override
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
}

/** Model ids the ensemble can pin for diversity. Mirrors the OpenRouter contract. */
export async function resolveModels(): Promise<string[]> {
  if (aiProvider() === "gemini") return geminiModels();
  const or = await import("@workspace/integrations-openrouter");
  return or.resolveModels();
}

export async function complete(opts: ChatOptions): Promise<ChatResult> {
  if (aiProvider() !== "gemini") {
    const or = await import("@workspace/integrations-openrouter");
    return or.complete(opts);
  }
  try {
    return await geminiComplete(opts);
  } catch (err) {
    // Gemini quota/transport failure: try the OpenRouter free models before
    // surfacing the error. (Searching calls may still 402 there at a zero
    // balance — that is exactly what the original error will then say.)
    try {
      const or = await import("@workspace/integrations-openrouter");
      return await or.complete(opts);
    } catch {
      throw err;
    }
  }
}

interface GeminiPart {
  text?: string;
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
}

async function geminiComplete(opts: ChatOptions): Promise<ChatResult> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  // Ensemble members pin OpenRouter ids for diversity; under Gemini, pin
  // only Gemini ids and let the model rotation + temperature do the work.
  const models =
    opts.model && opts.model.startsWith("gemini") ? [opts.model] : geminiModels();
  const wantSearch = opts.webSearch ?? false;
  let lastError: unknown = null;

  for (const model of models) {
    for (const withSearch of wantSearch ? [true, false] : [false]) {
      let res: Response;
      try {
        res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
          method: "POST",
          headers: {
            "x-goog-api-key": key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: opts.system }] },
            contents: [{ role: "user", parts: [{ text: opts.user }] }],
            generationConfig: {
              maxOutputTokens: opts.maxTokens ?? 3000,
              // Deterministic JSON matters more than deliberation here; the
              // pipeline's own agents supply the reasoning structure.
              thinkingConfig: { thinkingBudget: 0 },
              ...(opts.temperature != null && Number.isFinite(opts.temperature)
                ? { temperature: opts.temperature }
                : {}),
            },
            ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
          }),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Google rejected the API key (HTTP ${res.status}). Check GEMINI_API_KEY — get a free key at https://aistudio.google.com/apikey.`,
        );
      }
      if (res.ok) {
        const body = (await res.json()) as GeminiResponse;
        const parts = body.candidates?.[0]?.content?.parts ?? [];
        const text = parts.map((p) => p.text ?? "").join("");
        if (!text) {
          lastError = new Error(`Gemini ${model} returned no text.`);
          break;
        }
        return { text, model };
      }
      lastError = new Error(`Gemini ${model} failed: HTTP ${res.status}`);
      if (res.status === 400 && withSearch) {
        continue; // model/endpoint won't take grounding — retry ungrounded
      }
      if (!(res.status === 429 || res.status >= 500)) {
        throw lastError;
      }
      break; // quota or server error: next model
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All Gemini models failed.");
}
