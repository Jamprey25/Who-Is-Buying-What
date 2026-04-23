"use client";

import { useEffect, useRef, useState } from "react";
import { useAcquisitionFeed } from "../hooks/useAcquisitionFeed";
import type { PublicDealEvent } from "../secEdgarFeed";

// ─── Value formatter ──────────────────────────────────────────────────────────

function formatValue(usd: number | null): string {
  if (usd === null) return "Undisclosed";
  if (usd >= 1_000_000_000) {
    const b = usd / 1_000_000_000;
    return `$${b % 1 === 0 ? b.toFixed(0) : b.toFixed(1)}B`;
  }
  if (usd >= 1_000_000) {
    const m = usd / 1_000_000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  return `$${usd.toLocaleString()}`;
}

// ─── Fresh-ID tracker (drives the "New deal" badge) ──────────────────────────

function useFreshIds(deals: PublicDealEvent[], ttlMs: number): ReadonlySet<string> {
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const newIds: string[] = [];

    for (const deal of deals) {
      if (!seenRef.current.has(deal.id)) {
        seenRef.current.add(deal.id);
        newIds.push(deal.id);
      }
    }

    if (newIds.length === 0) return;

    setFreshIds((prev) => new Set([...prev, ...newIds]));

    const timers = newIds.map((id) =>
      setTimeout(() => {
        setFreshIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, ttlMs)
    );

    return () => timers.forEach(clearTimeout);
  }, [deals, ttlMs]);

  return freshIds;
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DealFeed() {
  const { deals, isConnected } = useAcquisitionFeed();
  const freshIds = useFreshIds(deals, 3_000);

  return (
    <section className="relative mx-auto max-w-2xl px-4 py-12 sm:py-16">
      {/* Header */}
      <header className="mb-10 sm:mb-12">
        <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-teal-500/20 bg-teal-500/5 px-3 py-1 text-xs font-medium tracking-wide text-teal-300/90 uppercase">
          <span className="h-1 w-1 rounded-full bg-teal-400 shadow-[0_0_8px_rgba(45,212,191,0.8)]" />
          SEC EDGAR
        </div>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              M&amp;A deal feed
            </h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400 sm:text-base">
              Material acquisitions as they hit the wire. Values shown when disclosed in the filing.
            </p>
          </div>

          <span
            className={[
              "inline-flex shrink-0 items-center gap-2 self-start rounded-full border px-3.5 py-1.5 text-sm font-medium",
              isConnected
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 shadow-[0_0_20px_-4px_rgba(52,211,153,0.35)]"
                : "border-slate-600/60 bg-slate-800/80 text-slate-400",
            ].join(" ")}
          >
            <span
              className={[
                "h-2 w-2 rounded-full",
                isConnected
                  ? "animate-pulse bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]"
                  : "bg-slate-500",
              ].join(" ")}
            />
            {isConnected ? "Live" : "Connecting…"}
          </span>
        </div>
      </header>

      {/* Empty state */}
      {deals.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-700/80 bg-slate-900/40 px-6 py-16 text-center backdrop-blur-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-slate-600/50 bg-slate-800/50">
            <span className="flex gap-1">
              <span className="h-2 w-2 animate-bounce rounded-full bg-teal-400/80 [animation-delay:-0.2s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-teal-400/80 [animation-delay:-0.1s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-teal-400/80" />
            </span>
          </div>
          <p className="text-base font-medium text-slate-300">Waiting for the next filing</p>
          <p className="mt-1 text-sm text-slate-500">
            New deals appear here as soon as the pipeline classifies them.
          </p>
        </div>
      )}

      {/* Deal list */}
      <ul className="space-y-4">
        {deals.map((deal) => (
          <li
            key={deal.id}
            className="animate-enter group rounded-2xl border border-slate-700/50 bg-slate-900/65 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.5)] backdrop-blur-md transition-[border-color,transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:border-teal-500/25 hover:shadow-[0_12px_40px_-12px_rgba(45,212,191,0.12)]"
          >
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              {/* Left: names + meta */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                  <span className="truncate text-base font-semibold text-white sm:text-lg">
                    {deal.acquirer}
                  </span>
                  <span
                    className="inline-flex items-center rounded-md border border-slate-600/50 bg-slate-800/60 px-1.5 py-0.5 text-xs font-medium text-teal-400/90"
                    aria-hidden
                  >
                    acquires
                  </span>
                  <span className="truncate text-base font-semibold text-white sm:text-lg">
                    {deal.target}
                  </span>

                  {freshIds.has(deal.id) && (
                    <span className="inline-flex items-center rounded-full bg-gradient-to-r from-teal-500/20 to-cyan-500/15 px-2.5 py-0.5 text-xs font-semibold text-teal-300 ring-1 ring-teal-400/30">
                      New
                    </span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-500">
                  <time dateTime={deal.announcedAt}>
                    {new Date(deal.announcedAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </time>
                  <a
                    href={deal.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-teal-400/90 transition-colors hover:text-teal-300"
                  >
                    SEC filing
                    <ExternalLinkIcon className="opacity-80" />
                  </a>
                </div>
              </div>

              {/* Right: value */}
              <div className="flex shrink-0 flex-col items-start gap-1 border-t border-slate-700/50 pt-4 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-6 sm:text-right">
                <span className="text-[10px] font-medium tracking-wider text-slate-500 uppercase">
                  Deal value
                </span>
                <span
                  className={[
                    "font-mono text-xl font-semibold tracking-tight tabular-nums sm:text-2xl",
                    deal.transactionValueUSD !== null ? "text-white" : "text-slate-500",
                  ].join(" ")}
                >
                  {formatValue(deal.transactionValueUSD)}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
