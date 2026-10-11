import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListForecasts,
  useDeleteForecast,
  getListForecastsQueryKey,
} from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: forecasts, isLoading } = useListForecasts();
  const queryClient = useQueryClient();
  const deleteForecast = useDeleteForecast();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // "+ NEW FORECAST" must always escape the current view — even when the
  // stream died mid-flight and left Home in a stuck state. A nested
  // <button> inside wouter's <Link> doesn't reliably navigate on mobile
  // browsers, so navigate programmatically instead.
  const handleNewForecast = () => {
    setSidebarOpen(false);
    if (location === "/") {
      window.location.reload();
    } else {
      setLocation("/");
    }
  };

  const handleDelete = (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm("Delete this forecast record?")) return;

    deleteForecast.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListForecastsQueryKey(),
          });
          if (location === `/forecast/${id}`) {
            setLocation("/");
          }
        },
      },
    );
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Mobile backdrop: tap anywhere outside to close */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar: off-canvas drawer on mobile, fixed panel on desktop */}
      <div
        className={`fixed md:static inset-y-0 left-0 z-40 w-[300px] max-w-[85vw] flex-shrink-0 bg-sidebar text-sidebar-foreground border-r-[3px] border-black flex flex-col relative transform transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } md:translate-x-0`}
      >
        <div className="absolute inset-0 scanlines opacity-50 z-0"></div>

        <div className="p-6 relative z-10 flex flex-col h-full">
          {/* Close button: mobile only */}
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
            className="md:hidden absolute top-4 right-4 bg-black text-accent border-2 border-black font-mono text-xs font-bold px-2 py-1 leading-none"
          >
            ✕
          </button>

          {/* Logo */}
          <div className="flex items-center gap-3 mb-8">
            <span
              className="text-2xl"
              style={{
                textShadow: "2px 2px 0 #FF00CC, -1px -1px 0 #39FF14",
              }}
            >
              🔮
            </span>
            <span className="font-mono text-accent font-bold tracking-widest uppercase">
              Forecast Engine
            </span>
          </div>

          {/* CTA */}
          <button
            onClick={handleNewForecast}
            className="retro-btn w-full mb-4"
            data-testid="button-new-forecast"
          >
            + NEW FORECAST
          </button>

          {/* Nav */}
          <Link href="/accuracy" onClick={() => setSidebarOpen(false)}>
            <span
              className={`block w-full mb-8 text-center font-mono font-bold tracking-wider px-6 py-3 border-[3px] border-black cursor-pointer hover:translate-y-[2px] hover:translate-x-[2px] transition-transform ${
                location === "/accuracy"
                  ? "bg-black text-primary"
                  : "bg-background text-foreground"
              }`}
              style={{ boxShadow: "4px 4px 0 0 #000" }}
              data-testid="link-track-record"
            >
              ▸ TRACK RECORD
            </span>
          </Link>

          <div className="font-mono text-xs font-bold tracking-widest text-muted-foreground mb-4">
            FORECAST_HISTORY
          </div>

          {/* History List */}
          <div className="flex-1 overflow-y-auto pr-2 space-y-4 -mr-2">
            {isLoading ? (
              <div className="animate-pulse space-y-4">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-20 bg-sidebar-border border-[3px] border-black rounded-sm"
                  />
                ))}
              </div>
            ) : forecasts?.length === 0 ? (
              <div className="font-mono text-xs text-muted-foreground/60 border-2 border-dashed border-muted-foreground/30 p-4 text-center">
                NO_RECORDS_YET
              </div>
            ) : (
              forecasts?.map((f) => {
                const isActive = location === `/forecast/${f.id}`;
                const date = new Date(f.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                });

                return (
                  <Link
                    key={f.id}
                    href={`/forecast/${f.id}`}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <div
                      className={`block bg-background text-foreground border-[3px] border-black p-3 relative cursor-pointer group hover:translate-y-[2px] hover:translate-x-[2px] transition-transform ${
                        isActive ? "translate-x-[2px] translate-y-[2px]" : ""
                      }`}
                      style={{
                        boxShadow: isActive
                          ? "2px 2px 0 0 #39FF14"
                          : "4px 4px 0 0 #39FF14",
                      }}
                      data-testid={`link-forecast-${f.id}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="inline-block bg-muted text-muted-foreground font-mono text-[10px] px-1.5 py-0.5 uppercase tracking-wider border border-black">
                          {date}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleDelete(e, f.id)}
                          aria-label="Delete forecast"
                          title="Delete forecast"
                          disabled={
                            deleteForecast.isPending &&
                            deleteForecast.variables?.id === f.id
                          }
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity bg-black text-accent hover:bg-accent hover:text-black border-2 border-black font-mono text-[10px] font-bold px-1.5 py-0.5 leading-none disabled:opacity-50"
                          data-testid={`button-delete-${f.id}`}
                        >
                          ✕
                        </button>
                      </div>
                      <h3 className="font-sans font-bold text-sm leading-tight line-clamp-2">
                        {f.question}
                      </h3>
                      {f.probability != null && (
                        <div className="font-mono text-[10px] mt-2 text-muted-foreground uppercase">
                          {Math.round(f.probability * 100)}%
                          {f.outcome ? ` · ${f.outcome}` : " · pending"}
                        </div>
                      )}

                      {isActive && (
                        <div className="absolute right-[-3px] top-[-3px] bottom-[-3px] w-[6px] bg-primary border-y-[3px] border-r-[3px] border-black z-10" />
                      )}
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto relative min-w-0">
        {/* Mobile top bar with hamburger */}
        <div className="md:hidden sticky top-0 z-20 flex items-center gap-3 px-3 py-2.5 bg-background border-b-[3px] border-black">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="retro-btn px-3 py-1.5 font-mono font-bold"
          >
            ☰
          </button>
          <span className="font-mono text-accent font-bold tracking-widest uppercase text-sm">
            🔮 Forecast Engine
          </span>
          <Link href="/accuracy" className="ml-auto">
            <span className="font-mono text-[10px] font-bold tracking-widest uppercase border-2 border-black bg-black text-primary px-2 py-1">
              Track Record
            </span>
          </Link>
        </div>
        {children}
      </div>
    </div>
  );
}
