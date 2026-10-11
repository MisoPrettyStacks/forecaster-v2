import { useParams } from "wouter";
import { useGetForecast } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Markdown } from "@/components/markdown";

export function ForecastDetail() {
  const params = useParams();
  const id = params.id ? parseInt(params.id, 10) : 0;
  
  const { data: forecast, isLoading, error } = useGetForecast(id);

  return (
    <Layout>
      <div className="p-8 max-w-4xl mx-auto">
        <div className="mb-8">
          <span className="chip-header shadow-none border-b-[3px]">
            HISTORICAL_RECORD :: {id || '???'}
          </span>
        </div>

        {isLoading ? (
          <div className="space-y-6">
            <div className="retro-card p-6 min-h-[100px] flex items-center">
              <div className="h-6 bg-muted w-3/4 rounded animate-pulse"></div>
            </div>
            <div className="retro-card p-8 min-h-[400px] space-y-4">
              <div className="h-4 bg-muted w-1/4 rounded animate-pulse mb-8"></div>
              <div className="h-4 bg-muted w-full rounded animate-pulse"></div>
              <div className="h-4 bg-muted w-full rounded animate-pulse"></div>
              <div className="h-4 bg-muted w-5/6 rounded animate-pulse"></div>
            </div>
          </div>
        ) : error || !forecast ? (
          <div className="retro-card p-8 bg-destructive/10">
            <h2 className="text-xl font-bold text-destructive mb-2">Error Loading Forecast</h2>
            <p className="font-mono text-sm">Could not retrieve record {id}.</p>
          </div>
        ) : (
          <div className="space-y-8 pb-20">
            <div className="retro-card p-6 md:p-8 bg-accent/5">
              <h1 className="text-2xl md:text-3xl font-black leading-tight tracking-tight">
                {forecast.question}
              </h1>
            </div>

            {(forecast.probability != null || forecast.outcome) && (
              <div className="retro-card p-6 md:p-8">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-4">
                  STRUCTURED_RECORD
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 font-mono text-sm">
                  <div>
                    <div className="text-muted-foreground text-[10px] uppercase">Probability</div>
                    <div className="text-2xl font-black">
                      {forecast.probability != null ? `${Math.round(forecast.probability * 100)}%` : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-[10px] uppercase">80% interval</div>
                    <div>
                      {forecast.ciLow != null && forecast.ciHigh != null
                        ? `${Math.round(forecast.ciLow * 100)}% – ${Math.round(forecast.ciHigh * 100)}%`
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-[10px] uppercase">Outcome</div>
                    <div className="uppercase">{forecast.outcome ?? "pending"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-[10px] uppercase">Resolve by</div>
                    <div>{forecast.resolveBy ? new Date(forecast.resolveBy).toLocaleString() : "—"}</div>
                  </div>
                </div>
                {forecast.resolutionCriteria && (
                  <p className="font-mono text-xs mt-4 text-muted-foreground">{forecast.resolutionCriteria}</p>
                )}
                <div className="font-mono text-[10px] text-muted-foreground mt-4">
                  {forecast.category ?? "general"} · {forecast.model ?? "model n/a"}
                </div>
              </div>
            )}

            <div className="retro-card p-6 md:p-10">
              <Markdown content={forecast.analysis} />
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}