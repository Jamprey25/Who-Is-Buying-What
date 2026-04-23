import { DealFeed } from "../src/components/DealFeed";

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden">
      {/* Ambient background */}
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        aria-hidden
      >
        <div className="absolute inset-0 bg-slate-950" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,rgba(45,212,191,0.14),transparent_55%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_100%_50%,rgba(99,102,241,0.08),transparent_45%)]" />
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage: `linear-gradient(rgba(148,163,184,0.06) 1px, transparent 1px),
              linear-gradient(90deg, rgba(148,163,184,0.06) 1px, transparent 1px)`,
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <DealFeed />
    </main>
  );
}
