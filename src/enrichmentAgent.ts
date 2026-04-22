/**
 * Phase 3 — Validation & Enrichment Agent
 *
 * Responsible for:
 *   1. resolveTickerYahoo   — map company name → exchange symbol (Yahoo Finance)
 *   2. fetchMarketCapYahoo  — fetch market cap + price snapshot (Yahoo Finance)
 *   3. generateDealFingerprint — stable SHA-256 dedup hash
 *   4. mergeAmendment       — fold an 8-K/A into an existing PipelineDeal
 *   5. searchDealNews       — re-exported from secEdgarFeed for convenience
 */

import { createHash } from "node:crypto";
import axios from "axios";
import { logger } from "./pipelineLogger";
import type { PipelineDeal } from "./pipelineTypes";

// ─── Re-export for pipeline convenience ──────────────────────────────────────
export { searchDealNews } from "./secEdgarFeed";

// ─── Yahoo Finance endpoints ─────────────────────────────────────────────────

const YAHOO_SEARCH_URL =
  "https://query2.finance.yahoo.com/v1/finance/search";
const YAHOO_QUOTE_SUMMARY_URL =
  "https://query2.finance.yahoo.com/v10/finance/quoteSummary";

// ─── resolveTickerYahoo ───────────────────────────────────────────────────────

export interface YahooTickerResult {
  symbol: string;
  name: string;
  exchange: string;
}

interface YahooSearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  quoteType?: string;
}

interface YahooSearchResponse {
  quotes?: YahooSearchQuote[];
}

/**
 * Searches Yahoo Finance for a company name and returns the best equity match.
 * Returns null (and logs a warning) on any network or parse error.
 * Never throws.
 */
export async function resolveTickerYahoo(
  companyName: string
): Promise<YahooTickerResult | null> {
  const query = companyName.trim();
  if (!query) return null;

  try {
    const response = await axios.get<YahooSearchResponse>(YAHOO_SEARCH_URL, {
      timeout: 8_000,
      params: { q: query, quotesCount: 5, newsCount: 0, listsCount: 0 },
      headers: {
        // Yahoo occasionally rejects requests without a browser-like UA.
        "User-Agent":
          "Mozilla/5.0 (compatible; who-is-buying-what/1.0; +https://github.com)",
      },
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const quotes = response.data.quotes ?? [];

    // Prefer EQUITY quotes; fall back to the first result if none found.
    const equity =
      quotes.find((q) => q.quoteType === "EQUITY" && q.symbol) ??
      quotes.find((q) => q.symbol);

    if (!equity?.symbol) return null;

    return {
      symbol: equity.symbol,
      name: equity.longname ?? equity.shortname ?? equity.symbol,
      exchange: equity.exchange ?? "",
    };
  } catch (err) {
    logger.warn(
      { err, companyName },
      "[resolveTickerYahoo] lookup failed — returning null"
    );
    return null;
  }
}

// ─── fetchMarketCapYahoo ─────────────────────────────────────────────────────

export interface YahooMarketCapResult {
  marketCap: number | null;
  price: number | null;
  snapshotAt: Date;
}

interface YahooSummaryDetail {
  marketCap?: { raw?: number };
  regularMarketPrice?: { raw?: number };
}

interface YahooQuoteSummaryResult {
  summaryDetail?: YahooSummaryDetail;
}

interface YahooQuoteSummaryResponse {
  quoteSummary?: {
    result?: YahooQuoteSummaryResult[] | null;
    error?: unknown;
  };
}

/**
 * Fetches a point-in-time market cap and price from Yahoo Finance.
 * Both fields may be null if the symbol is not found or data is unavailable.
 * Never throws.
 */
export async function fetchMarketCapYahoo(
  symbol: string
): Promise<YahooMarketCapResult> {
  const snapshotAt = new Date();
  const nullResult: YahooMarketCapResult = { marketCap: null, price: null, snapshotAt };

  if (!symbol.trim()) return nullResult;

  try {
    const url = `${YAHOO_QUOTE_SUMMARY_URL}/${encodeURIComponent(symbol)}`;
    const response = await axios.get<YahooQuoteSummaryResponse>(url, {
      timeout: 8_000,
      params: { modules: "summaryDetail" },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; who-is-buying-what/1.0; +https://github.com)",
      },
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const result = response.data.quoteSummary?.result?.[0];
    if (!result) return nullResult;

    const detail = result.summaryDetail;
    const marketCap  = toPositiveNumberOrNull(detail?.marketCap?.raw);
    const price      = toPositiveNumberOrNull(detail?.regularMarketPrice?.raw);

    return { marketCap, price, snapshotAt };
  } catch (err) {
    logger.warn(
      { err, symbol },
      "[fetchMarketCapYahoo] lookup failed — returning null"
    );
    return nullResult;
  }
}

function toPositiveNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return isFinite(n) && n > 0 ? n : null;
}

// ─── generateDealFingerprint ─────────────────────────────────────────────────

export interface FingerprintInput {
  acquirer: string;
  target: string;
  transactionValueUSD: number | null;
  filedAt: Date;
}

/**
 * Produces a stable SHA-256 fingerprint for deduplication.
 *
 * Components (all normalised to remove punctuation/case variation):
 *   • acquirer name
 *   • target name
 *   • value bucket — bucketed to the nearest order of magnitude so minor
 *     revisions (e.g. "$4.1B" updated to "$4.2B") do not create a new record
 *   • filing year — two deals in different years should never merge
 *
 * Bucket thresholds:
 *   ≥ 10 B  →  "10B+"
 *   ≥ 1 B   →  "1B-10B"
 *   ≥ 100 M →  "100M-1B"
 *   ≥ 10 M  →  "10M-100M"
 *   > 0     →  "sub-10M"
 *   null    →  "unknown"
 */
export function generateDealFingerprint(input: FingerprintInput): string {
  const normalizedAcquirer = normalizeForHash(input.acquirer);
  const normalizedTarget   = normalizeForHash(input.target);
  const valueBucket        = toValueBucket(input.transactionValueUSD);
  const year               = String(input.filedAt.getUTCFullYear());

  const hashInput = `${normalizedAcquirer}|${normalizedTarget}|${valueBucket}|${year}`;
  return createHash("sha256").update(hashInput, "utf8").digest("hex");
}

function normalizeForHash(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(inc|corp|co|ltd|llc|plc|group|holdings|technologies|tech|solutions|company|the)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function toValueBucket(usd: number | null): string {
  if (usd === null || usd <= 0) return "unknown";
  if (usd >= 10_000_000_000)  return "10B+";
  if (usd >= 1_000_000_000)   return "1B-10B";
  if (usd >= 100_000_000)     return "100M-1B";
  if (usd >= 10_000_000)      return "10M-100M";
  return "sub-10M";
}

// ─── mergeAmendment ──────────────────────────────────────────────────────────

/**
 * Folds an 8-K/A amendment into an existing PipelineDeal record.
 *
 * Rules:
 *   - id, fingerprint, announcedAt (original filedAt) are NEVER overwritten.
 *   - amendmentCount is incremented.
 *   - amendedAt is set to the amendment's announcedAt.
 *   - sourceFilings is unioned (amendment accession added if not present).
 *   - All other non-null amendment fields overwrite the original.
 *   - flags are merged (union).
 */
export function mergeAmendment(
  original: PipelineDeal,
  amendment: Partial<PipelineDeal>
): PipelineDeal {
  const merged: PipelineDeal = { ...original };

  // Merge mutable scalar fields — only overwrite when the amendment has a
  // defined, non-empty value.
  const scalarFields: Array<keyof PipelineDeal> = [
    "acquirer", "target", "transactionValueUSD", "transactionValueRaw",
    "paymentType", "dealSizeCategory", "executiveSummary",
    "classificationConfidence", "extractionConfidence",
    "corroborationUrl", "acquirerTicker", "acquirerMarketCap",
    "targetTicker", "targetMarketCap", "targetIsPrivate",
    "requiresReview",
  ];

  for (const field of scalarFields) {
    const incoming = amendment[field];
    if (incoming !== undefined && incoming !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[field] = incoming;
    }
  }

  // Merge source accession numbers
  if (amendment.accessionNumber) {
    merged.sourceFilings = [
      ...new Set([...original.sourceFilings, amendment.accessionNumber]),
    ];
  }

  // Merge flags (union, deduped)
  if (amendment.flags && amendment.flags.length > 0) {
    merged.flags = [...new Set([...original.flags, ...amendment.flags])];
  }

  // Increment amendment counter; record the amendment timestamp
  merged.amendmentCount = original.amendmentCount + 1;
  merged.amendedAt = amendment.announcedAt ?? new Date();

  // Always refresh updatedAt
  merged.updatedAt = new Date();

  return merged;
}
