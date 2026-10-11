import { Layout } from "@/components/layout";

export default function NotFound() {
  return (
    <Layout>
      <div className="min-h-full flex items-center justify-center p-8">
        <div className="retro-card p-12 max-w-lg w-full text-center bg-accent/5">
          <div className="text-6xl font-black mb-6" style={{ textShadow: "4px 4px 0 #39FF14" }}>404</div>
          <h1 className="text-2xl font-bold font-mono tracking-widest mb-4">RECORD_NOT_FOUND</h1>
          <p className="text-muted-foreground font-mono mb-8">
            The target query or historical record you requested does not exist in the current timeline.
          </p>
          <a href="/">
            <button className="retro-btn w-full">
              RETURN TO TERMINAL
            </button>
          </a>
        </div>
      </div>
    </Layout>
  );
}