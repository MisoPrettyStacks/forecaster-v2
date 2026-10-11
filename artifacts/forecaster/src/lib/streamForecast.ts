export interface ForecastStreamEvent {
  type:
    | "start"
    | "chunk"
    | "done"
    | "error"
    | "search_start"
    | "search_query"
    | "search_done"
    | "stage";
  text?: string;
  question?: string;
  query?: string;
  id?: number | null;
  persisted?: boolean;
  analysis?: string;
  createdAt?: string;
  message?: string;
  stage?: string;
  probability?: number | null;
  ciLow?: number | null;
  ciHigh?: number | null;
  model?: string | null;
  category?: string | null;
  resolveBy?: string | null;
  resolutionCriteria?: string | null;
  sources?: Array<Record<string, unknown>> | null;
}

export async function streamForecast(
  question: string,
  onEvent: (event: ForecastStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  const url = `${baseUrl}/api/forecasts/stream`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ question }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Stream request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx = buffer.indexOf("\n\n");
    while (sepIdx !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      let eventType = "message";
      let dataStr = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }

      if (dataStr) {
        try {
          const parsed = JSON.parse(dataStr);
          onEvent({ type: eventType as ForecastStreamEvent["type"], ...parsed });
        } catch {
          // ignore malformed event
        }
      }

      sepIdx = buffer.indexOf("\n\n");
    }
  }
}
