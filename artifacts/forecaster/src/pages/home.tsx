import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListForecastsQueryKey,
  getGetForecastQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Markdown } from "@/components/markdown";
import { streamForecast } from "@/lib/streamForecast";

export function Home() {
  const [question, setQuestion] = useState("");
  const [streamedText, setStreamedText] = useState("");
  const [streamedQuestion, setStreamedQuestion] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [searches, setSearches] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  // Full reset back to the empty question form. Used when a stream ends
  // without navigating away (error, dropped connection, rate limit),
  // which would otherwise leave the page stuck with no way to retry.
  const handleReset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setQuestion("");
    setStreamedText("");
    setStreamedQuestion("");
    setSearches([]);
    setIsSearching(false);
    setIsStreaming(false);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || isStreaming) return;

    setError(null);
    setStreamedText("");
    setStreamedQuestion(q);
    setSearches([]);
    setIsSearching(false);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamForecast(
        q,
        (event) => {
          if (event.type === "chunk" && event.text) {
            setStreamedText((prev) => prev + event.text);
          } else if (event.type === "search_start") {
            setIsSearching(true);
          } else if (event.type === "search_query" && event.query) {
            setSearches((prev) =>
              prev.includes(event.query!) ? prev : [...prev, event.query!],
            );
          } else if (event.type === "search_done") {
            setIsSearching(false);
          } else if (event.type === "done" && event.id != null) {
            queryClient.invalidateQueries({
              queryKey: getListForecastsQueryKey(),
            });
            if (event.analysis && event.question && event.createdAt) {
              queryClient.setQueryData(getGetForecastQueryKey(event.id), {
                id: event.id,
                question: event.question,
                analysis: event.analysis,
                createdAt: event.createdAt,
                probability: event.probability ?? null,
                ciLow: event.ciLow ?? null,
                ciHigh: event.ciHigh ?? null,
                model: event.model ?? null,
                category: event.category ?? null,
                resolveBy: event.resolveBy ?? null,
                resolutionCriteria: event.resolutionCriteria ?? null,
                sources: (event.sources ?? null) as never,
              });
            }
            setLocation(`/forecast/${event.id}`);
          } else if (event.type === "error") {
            setError(event.message ?? "Forecast generation failed");
            setIsStreaming(false);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Network error");
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  return (
    <Layout>
      <div className="min-h-full flex flex-col items-center p-8">
        {!isStreaming && !streamedText ? (
          <div className="max-w-2xl w-full flex flex-col items-center justify-center min-h-[80vh]">
            <div className="relative mb-12 select-none group">
              <div className="absolute top-4 left-4 text-8xl opacity-20 filter grayscale">
                🔮
              </div>
              <div className="absolute top-2 left-2 text-8xl opacity-50 filter hue-rotate-180">
                🔮
              </div>
              <div className="relative text-8xl drop-shadow-[-4px_4px_0_rgba(0,0,0,1)] transition-transform group-hover:scale-105">
                🔮
              </div>
            </div>

            <h1 className="text-5xl md:text-6xl font-black tracking-tighter uppercase mb-4 text-center leading-none">
              MISOPRETTY'S
              <br />
              <span className="text-accent underline decoration-4 underline-offset-8">
                🔮, KINDA
              </span>
            </h1>

            <div className="mb-12 border-b-2 border-black border-dashed pb-4" />

            <form onSubmit={handleSubmit} className="w-full">
              <div className="bg-black text-white font-mono text-xs font-bold px-3 py-1 inline-block border-[3px] border-b-0 border-black relative top-[3px]">
                TARGET_QUERY_INPUT
              </div>
              <div className="retro-card p-6 flex flex-col mb-6">
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="e.g. Will AI models surpass human baseline on the MMLU-Pro benchmark before Jan 1, 2027?"
                  className="w-full bg-transparent font-sans text-lg lg:text-xl font-medium outline-none resize-none min-h-[120px] placeholder:text-muted-foreground/50"
                  autoFocus
                />
                <div className="flex justify-between items-end mt-4">
                  <div className="font-mono text-xs text-muted-foreground flex items-center gap-2">
                    <span className="text-primary blink">█</span> Must be
                    resolvable & specific
                  </div>
                </div>
              </div>

              {error && (
                <div className="mb-4 p-3 border-[3px] border-accent bg-accent/10 font-mono text-xs text-accent">
                  ERROR: {error}
                </div>
              )}

              <button
                type="submit"
                className="retro-btn w-full text-xl py-4"
                disabled={!question.trim()}
              >
                ▶ GENERATE FORECAST
              </button>
            </form>
          </div>
        ) : (
          <div className="max-w-3xl w-full mx-auto">
            <div className="mb-6 inline-flex items-center gap-2 bg-black text-white font-mono text-xs font-bold px-3 py-1.5 border-[3px] border-black">
              <span className="text-primary blink">●</span>
              {isStreaming ? "STREAMING_FORECAST" : "FINALIZING_RECORD"}
            </div>

            <div className="retro-card p-6 mb-6">
              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
                TARGET_QUERY
              </div>
              <h2 className="text-xl md:text-2xl font-black leading-tight">
                {streamedQuestion}
              </h2>
            </div>

            {(searches.length > 0 || isSearching) && (
              <div className="retro-card p-4 mb-6 bg-black text-primary">
                <div className="font-mono text-[10px] uppercase tracking-widest text-accent mb-2 flex items-center gap-2">
                  <span>WEB_SEARCH_LOG</span>
                  {isSearching && (
                    <span className="text-primary blink">● SEARCHING</span>
                  )}
                </div>
                <ul className="font-mono text-xs space-y-1">
                  {searches.map((q, i) => (
                    <li key={i} className="break-words">
                      <span className="text-accent">$</span>{" "}
                      <span className="text-primary">{q || "(formulating query…)"}</span>
                    </li>
                  ))}
                  {searches.length === 0 && isSearching && (
                    <li className="text-primary/70">Initializing search…</li>
                  )}
                </ul>
              </div>
            )}

            <div className="retro-card p-6 md:p-8">
              {streamedText ? (
                <Markdown content={streamedText} />
              ) : (
                <div className="font-mono text-sm text-muted-foreground">
                  {isSearching
                    ? "Gathering current data from the web…"
                    : "Compiling forecast…"}
                </div>
              )}
              {isStreaming && (
                <span className="inline-block w-3 h-5 bg-primary blink ml-1 align-middle" />
              )}
            </div>

            {error && (
              <div className="mt-6 p-3 border-[3px] border-accent bg-accent/10 font-mono text-xs text-accent">
                ERROR: {error}
              </div>
            )}

            {/* The stream ended but we're still here: the forecast didn't
                save/navigate. Give the user a way out instead of a dead page. */}
            {!isStreaming && (
              <button
                onClick={handleReset}
                className="retro-btn w-full mt-6 text-lg py-3"
              >
                ↺ START OVER
              </button>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
