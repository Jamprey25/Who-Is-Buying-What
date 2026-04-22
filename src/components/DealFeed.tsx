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

// ─── Component ───────────────────────────────────────────────────────────────

export function DealFeed() {
  const { deals, isConnected } = useAcquisitionFeed();
  const freshIds = useFreshIds(deals, 3_000);

  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      {/* Header */}
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">M&amp;A Deal Feed</h1>

        <span
          className={[
            "flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium",
            isConnected
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500",
          ].join(" ")}
        >
          <span
            className={[
              "h-2 w-2 rounded-full",
              isConnected ? "animate-pulse bg-green-500" : "bg-gray-400",
            ].join(" ")}
          />
          {isConnected ? "Live" : "Connecting…"}
        </span>
      </header>

      {/* Empty state */}
      {deals.length === 0 && (
        <p className="py-20 text-center text-gray-400">
          Waiting for deals…
        </p>
      )}

      {/* Deal list */}
      <ul className="space-y-3">
        {deals.map((deal) => (
          <li
            key={deal.id}
            /*
             * animate-enter fires both keyframes simultaneously on DOM entry:
             *   slide-in  — opacity 0→1, translateY -10px→0  (0.3 s)
             *   flash     — background yellow→white           (2 s)
             * Because each deal gets a fresh key, the element is always new
             * to the DOM, so the animation runs exactly once per deal.
             */
            className="animate-enter overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
          >
            <div className="flex items-start justify-between gap-4 p-4">
              {/* Left: names + badge + date */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate font-semibold text-gray-900">
                    {deal.acquirer}
                  </span>
                  <span className="text-gray-400" aria-hidden>→</span>
                  <span className="truncate font-semibold text-gray-900">
                    {deal.target}
                  </span>

                  {/* Badge — present in DOM only while ID is fresh (≤ 3 s) */}
                  {freshIds.has(deal.id) && (
                    <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                      New deal
                    </span>
                  )}
                </div>

                <p className="mt-1 text-sm text-gray-400">
                  {new Date(deal.announcedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>

              {/* Right: value */}
              <div className="shrink-0 text-right">
                <span
                  className={[
                    "text-lg font-bold",
                    deal.transactionValueUSD !== null
                      ? "text-gray-900"
                      : "text-gray-400",
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
