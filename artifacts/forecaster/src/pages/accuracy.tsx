import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { fetchTrackRecord, type GroupRow } from "@/lib/trackRecord";

const pct = (x: number | null | undefined) =>
  x == null ? "—" : `${(x * 100).toFixed(1)}%`;
const signedPct = (x: number | null | undefined) =>
  x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const fixed4 = (x: number | null | undefined) =>
  x == null ? "—" : x.toFixed(4);

/** Bins/groups below this many settled forecasts are mostly noise. */
const PROVISIONAL_N = 30;

function GroupTable({ title, rows }: { title: string; rows: GroupRow[] }) {
  return (
    <div className="retro-card p-6">
      <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-4">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground">NOTHING_SETTLED_YET</p>
      ) : (
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="text-left text-muted-foreground uppercase">
              <th className="pb-2 pr-2 font-medium">Group</th>
              <th className="pb-2 pr-2 font-medium text-right">n</th>
              <th className="pb-2 pr-2 font-medium text-right">Brier</th>
              <th className="pb-2 font-medium text-right">Hit rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={`border-t border-dashed border-black/30 ${
                  r.n < PROVISIONAL_N ? "text-muted-foreground" : ""
                }`}
              >
                <td className="py-2 pr-2 break-words">
                  {r.key}
                  {r.n < PROVISIONAL_N && (
                    <span className="ml-2 inline-block bg-muted text-muted-foreground font-mono text-[9px] px-1 py-0.5 uppercase tracking-wider border border-black">
                      provisional
                    </span>
                  )}
                </td>
                <td className="py-2 pr-2 text-right">{r.n}</td>
                <td className="py-2 pr-2 text-right">{r.brier.toFixed(4)}</td>
                <td className="py-2 text-right">{pct(r.hitRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Accuracy() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["track-record"],
    queryFn: fetchTrackRecord,
    refetchInterval: 5 * 60 * 1000,
  });

  return (
    <Layout>
      <div className="p-8 max-w-4xl mx-auto">
        <div className="mb-8">
          <span className="chip-header shadow-none border-b-[3px]">
            TRACK_RECORD :: ACCURACY
          </span>
          <p className="font-mono text-xs text-muted-foreground uppercase tracking-widest">
            Every settled forecast, scored properly. No cherry-picking.
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-6">
            <div className="retro-card p-6 min-h-[100px] flex items-center">
              <div className="h-6 bg-muted w-3/4 rounded animate-pulse"></div>
            </div>
            <div className="retro-card p-8 min-h-[300px] space-y-4">
              <div className="h-4 bg-muted w-1/4 rounded animate-pulse mb-8"></div>
              <div className="h-4 bg-muted w-full rounded animate-pulse"></div>
              <div className="h-4 bg-muted w-full rounded animate-pulse"></div>
              <div className="h-4 bg-muted w-5/6 rounded animate-pulse"></div>
            </div>
          </div>
        ) : error || !data ? (
          <div className="retro-card p-8 bg-destructive/10">
            <h2 className="text-xl font-bold text-destructive mb-2">
              Error Loading Track Record
            </h2>
            <p className="font-mono text-sm">Could not retrieve accuracy stats.</p>
          </div>
        ) : (
          <div className="space-y-8 pb-20">
            {/* Headline cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="retro-card p-5">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
                  Settled forecasts
                </div>
                <div className="text-3xl font-black">{data.totals.resolved}</div>
                <div className="font-mono text-[10px] text-muted-foreground mt-2">
                  of {data.totals.issued} issued · {data.totals.pending} pending ·{" "}
                  {data.totals.ambiguous} ambiguous
                </div>
              </div>
              <div className="retro-card p-5">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
                  Hit rate
                </div>
                <div className="text-3xl font-black">{pct(data.totals.hitRate)}</div>
                <div className="font-mono text-[10px] text-muted-foreground mt-2">
                  just guessing the usual answer would land{" "}
                  {pct(data.totals.majorityRate)}
                </div>
              </div>
              <div className="retro-card p-5">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
                  Brier score
                </div>
                <div className="text-3xl font-black">{fixed4(data.totals.brier)}</div>
                <div className="font-mono text-[10px] text-muted-foreground mt-2">
                  a coin flip scores 0.2500 · skill{" "}
                  {signedPct(data.totals.skillVsCoinFlip)}
                </div>
              </div>
              <div className="retro-card p-5">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
                  Log loss
                </div>
                <div className="text-3xl font-black">{fixed4(data.totals.logLoss)}</div>
                <div className="font-mono text-[10px] text-muted-foreground mt-2">
                  a coin flip scores 0.6931 (lower is better)
                </div>
              </div>
            </div>

            {data.totals.resolved === 0 ? (
              <div className="retro-card p-8">
                <h2 className="font-mono text-sm font-bold uppercase tracking-widest mb-2">
                  NO_SETTLED_FORECASTS_YET
                </h2>
                <p className="font-mono text-sm text-muted-foreground">
                  Nothing has come due yet. Forecasts land here once their deadlines
                  pass and the resolver checks what actually happened — the desk
                  settles them on its own timer, so this page fills itself in.
                </p>
              </div>
            ) : (
              <>
                {/* Calibration */}
                <div className="retro-card p-6 md:p-8">
                  <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-1">
                    CALIBRATION
                  </div>
                  <p className="font-mono text-xs text-muted-foreground mb-4">
                    When it says X%, does it happen about X% of the time?
                  </p>
                  <table className="w-full font-mono text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground uppercase">
                        <th className="pb-2 pr-2 font-medium">Predicted</th>
                        <th className="pb-2 pr-2 font-medium text-right">n</th>
                        <th className="pb-2 pr-2 font-medium text-right">Avg forecast</th>
                        <th className="pb-2 font-medium text-right">Actually happened</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.calibration.map((b) => (
                        <tr
                          key={b.bin}
                          className={`border-t border-dashed border-black/30 ${
                            b.n === 0 || b.n < PROVISIONAL_N
                              ? "text-muted-foreground"
                              : ""
                          }`}
                        >
                          <td className="py-2 pr-2">
                            {b.bin}
                            {b.n > 0 && b.n < PROVISIONAL_N && (
                              <span className="ml-2 inline-block bg-muted text-muted-foreground font-mono text-[9px] px-1 py-0.5 uppercase tracking-wider border border-black">
                                provisional
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-2 text-right">{b.n}</td>
                          <td className="py-2 pr-2 text-right">
                            {b.n ? pct(b.avgForecast) : "—"}
                          </td>
                          <td className="py-2 text-right">
                            {b.n ? pct(b.actualRate) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="font-mono text-[10px] text-muted-foreground mt-4">
                    Bins under {PROVISIONAL_N} settled forecasts are provisional — a
                    clean diagonal built on a handful of rows is luck, not calibration.
                  </p>
                </div>

                {/* Breakdowns */}
                <div className="grid gap-6 md:grid-cols-2">
                  <GroupTable title="BY CATEGORY" rows={data.byCategory} />
                  <GroupTable title="BY TIMEFRAME" rows={data.byHorizon} />
                </div>

                {/* Recently settled */}
                <div className="retro-card p-6 md:p-8">
                  <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-4">
                    RECENTLY SETTLED
                  </div>
                  <div className="space-y-4">
                    {data.recent.map((r) => {
                      const saidYes = r.probability >= 0.5;
                      const hit = saidYes === (r.outcome === "yes");
                      return (
                        <Link key={r.id} href={`/forecast/${r.id}`}>
                          <div className="flex items-start justify-between gap-4 border-t border-dashed border-black/30 pt-3 cursor-pointer first:border-t-0 first:pt-0">
                            <div className="min-w-0">
                              <div className="font-sans font-bold text-sm leading-tight line-clamp-2">
                                {r.question}
                              </div>
                              <div className="font-mono text-[10px] text-muted-foreground mt-1">
                                said {pct(r.probability)}
                                {r.resolvedAt
                                  ? ` · settled ${new Date(r.resolvedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                                  : ""}
                              </div>
                            </div>
                            <span
                              className={`flex-shrink-0 font-mono text-[10px] font-bold px-2 py-1 border-2 border-black uppercase ${
                                hit ? "bg-black text-primary" : "bg-black text-accent"
                              }`}
                            >
                              {r.outcome} {hit ? "✓ hit" : "✗ miss"}
                            </span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {/* Honest note, verbatim from the stats endpoint */}
            <div className="retro-card p-6 md:p-8 bg-accent/5">
              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest mb-3">
                HOW TO READ THIS
              </div>
              <p className="font-mono text-sm leading-relaxed">{data.note}</p>
              <p className="font-mono text-[10px] text-muted-foreground mt-4">
                Brier and log loss are proper scoring rules measured against a
                constant-50% forecaster. Forecasts the resolver marks ambiguous are
                excluded from scoring.
              </p>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
