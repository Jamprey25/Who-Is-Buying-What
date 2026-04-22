import { DealRecord } from "./secEdgarFeed";
import { MarketCapSnapshot } from "./fetchMarketCaps";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DealSizeCategory = "BOLT_ON" | "MATERIAL" | "TRANSFORMATIVE" | "UNKNOWN";

export interface DealMetrics {
  dealSizeVsAcquirerMarketCap: number | null;
  dealSizeCategory: DealSizeCategory;
  premiumEstimate: number | null;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const BOLT_ON_MAX = 0.05;     // < 5 %   of acquirer market cap
const MATERIAL_MAX = 0.25;    // 5 – 25 %

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Guards against division by zero, negative denominators, and non-finite
 * results that can arise from FMP returning 0 for illiquid/delisted symbols
 * (even after the zero-to-null normalisation in fetchMarketCaps, a caller
 * could supply a snapshot from another source).
 */
function safeDivide(numerator: number, denominator: number): number | null {
  if (!isFinite(numerator) || !isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  const result = numerator / denominator;
  return isFinite(result) ? result : null;
}

function categorizeDealSize(ratio: number | null): DealSizeCategory {
  if (ratio === null) return "UNKNOWN";
  if (ratio < BOLT_ON_MAX) return "BOLT_ON";
  if (ratio < MATERIAL_MAX) return "MATERIAL";
  return "TRANSFORMATIVE";
}

// ─── Exported function ────────────────────────────────────────────────────────

export function calculateDealMetrics(
  deal: DealRecord,
  marketCaps: MarketCapSnapshot
): DealMetrics {
  const dealValue = deal.transactionValueUSD ?? null;
  const acquirerCap = marketCaps.acquirerMarketCap;
  const targetCap = marketCaps.targetMarketCap;

  // ── Deal size relative to acquirer ────────────────────────────────────────
  // Both inputs must be present and positive for a meaningful ratio.
  const dealSizeVsAcquirerMarketCap =
    dealValue !== null && acquirerCap !== null
      ? safeDivide(dealValue, acquirerCap)
      : null;

  // ── Deal size category ────────────────────────────────────────────────────
  const dealSizeCategory = categorizeDealSize(dealSizeVsAcquirerMarketCap);

  // ── Premium estimate ──────────────────────────────────────────────────────
  // (dealValue − targetMarketCap) / targetMarketCap
  //
  // A positive premium means the acquirer paid more than the market believed
  // the target was worth before the announcement — the standard "control
  // premium" concept. A negative value would indicate a distressed sale.
  // Null when either input is missing (e.g. private target).
  const premiumEstimate =
    dealValue !== null && targetCap !== null
      ? safeDivide(dealValue - targetCap, targetCap)
      : null;

  return {
    dealSizeVsAcquirerMarketCap,
    dealSizeCategory,
    premiumEstimate,
  };
}
