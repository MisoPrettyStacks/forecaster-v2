// Chat completions against OpenRouter's OpenAI-compatible API, with automatic
// failover across free models. Tries each model in order; a 404 (retired
// model), 429 (rate limit) or 5xx moves to the next one. A 401 (bad key) fails
// fast so a misconfigured key is obvious immediately.

import {
  OPENROUTER_BASE_URL,
  openrouterHeaders,
} from "./client";
import { resolveModels } from "./models";

export interface ChatOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** Enable OpenRouter's web-search grounding plugin. Default true. */
  webSearch?: boolean;
  /** Pin one model instead of walking the failover list (ensemble diversity). */
  model?: string;
  /** Sampling temperature override. */
  temperature?: number;
}

export interface ChatResult {
  text: string;
  model: string;
}

function buildBody(model: string, opts: ChatOptions, stream: boolean, withWebSearch: boolean) {
  const webSearch = opts.webSearch ?? process.env["OPENROUTER_WEB_SEARCH"] !== "false";
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    max_tokens: opts.maxTokens ?? 8192,
    stream,
  };
  if (webSearch && withWebSearch) {
    body["plugins"] = [{ id: "web", max_results: 5 }];
  }
  if (opts.temperature != null && Number.isFinite(opts.temperature)) {
    body["temperature"] = opts.temperature;
  }
  return body;
}

function isRetryableStatus(status: number): boolean {
  return status === 404 || status === 429 || status >= 500;
}

async function postChat(
  model: string,
  opts: ChatOptions,
  stream: boolean,
  withWebSearch: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: openrouterHeaders(),
    body: JSON.stringify(buildBody(model, opts, stream, withWebSearch)),
    signal,
  });
}

function failFastMessage(status: number): string {
  if (status === 401) {
    return "OpenRouter rejected the API key (HTTP 401). Check OPENROUTER_API_KEY — get a free one at https://openrouter.ai/keys.";
  }
  return `OpenRouter request failed: HTTP ${status}`;
}

/** Non-streaming completion. Returns the full text and the model that answered. */
export async function complete(opts: ChatOptions): Promise<ChatResult> {
  const models = opts.model ? [opts.model] : await resolveModels();
  if (models.length === 0) {
    throw new Error("No OpenRouter models available to try.");
  }
  let lastError: unknown = null;

  for (const model of models) {
    for (const withWebSearch of [true, false]) {
      let res: Response;
      try {
        // Flat timeout: non-streaming has no first-token signal, so bound
        // the whole attempt and fail over on expiry.
        res = await postChat(
          model,
          opts,
          false,
          withWebSearch,
          AbortSignal.timeout(180_000),
        );
      } catch (err) {
        lastError = err;
        continue;
      }
      if (res.status === 401) {
        throw new Error(failFastMessage(401));
      }
      if (res.ok) {
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = body.choices?.[0]?.message?.content ?? "";
        return { text, model };
      }
      lastError = new Error(`Model ${model} failed: HTTP ${res.status}`);
      // A 400 with the web plugin on may just mean the model rejects the
      // plugin — retry the same model without it before moving on.
      if (res.status === 400 && withWebSearch) {
        continue;
      }
      if (!isRetryableStatus(res.status)) {
        throw lastError;
      }
      break; // next model
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All OpenRouter models failed.");
}

export interface StreamOptions extends ChatOptions {
  onToken: (text: string) => void;
  onSearchStart?: () => void;
  onSearchDone?: () => void;
}

/**
 * Streaming completion. Calls onToken for each text delta and returns the
 * model that answered. Fails over to the next model only before the first
 * token arrives — once streaming starts, the model is committed.
 */
export async function streamComplete(opts: StreamOptions): Promise<{ model: string }> {
  const models = opts.model ? [opts.model] : await resolveModels();
  if (models.length === 0) {
    throw new Error("No OpenRouter models available to try.");
  }
  let lastError: unknown = null;

  for (const model of models) {
    for (const withWebSearch of [true, false]) {
      let res: Response;
      // Free-tier models sometimes hang instead of failing. Bound the wait
      // for the first token; once tokens flow the timer is cleared so slow
      // (but alive) models can finish long analyses.
      const ctrl = new AbortController();
      const firstTokenTimer = setTimeout(() => {
        ctrl.abort(new Error(`Model ${model} timed out before streaming.`));
      }, 60_000);
      try {
        res = await postChat(model, opts, true, withWebSearch, ctrl.signal);
      } catch (err) {
        clearTimeout(firstTokenTimer);
        lastError = err;
        continue;
      }
      if (res.status === 401) {
        clearTimeout(firstTokenTimer);
        throw new Error(failFastMessage(401));
      }
      if (!res.ok) {
        clearTimeout(firstTokenTimer);
        lastError = new Error(`Model ${model} failed: HTTP ${res.status}`);
        if (res.status === 400 && withWebSearch) {
          continue; // retry same model without the web plugin
        }
        if (!isRetryableStatus(res.status)) {
          throw lastError;
        }
        break; // next model
      }
      if (!res.body) {
        clearTimeout(firstTokenTimer);
        lastError = new Error(`Model ${model} returned no response body.`);
        break;
      }
      try {
        let firstToken = true;
        await consumeSseStream(res.body, (text) => {
          if (firstToken) {
            firstToken = false;
            clearTimeout(firstTokenTimer);
          }
          opts.onToken(text);
        });
        opts.onSearchDone?.();
        return { model };
      } catch (err) {
        lastError = err;
        break; // mid-stream failure: do not fail over, surface the error
      } finally {
        clearTimeout(firstTokenTimer);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All OpenRouter models failed.");
}

/** Parse an OpenAI-style SSE stream, forwarding text deltas to onToken. */
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onToken: (text: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      let event: {
        choices?: Array<{ delta?: { content?: string } }>;
        error?: { message?: string };
      };
      try {
        event = JSON.parse(payload) as typeof event;
      } catch {
        continue; // ignore malformed frames
      }
      if (event.error?.message) {
        throw new Error(`OpenRouter stream error: ${event.error.message}`);
      }
      const content = event.choices?.[0]?.delta?.content;
      if (content) {
        onToken(content);
      }
    }
  }
}
