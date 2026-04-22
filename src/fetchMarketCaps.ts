import axios from "axios";

const FMP_BASE = "https://financialmodelingprep.com/api/v3";

/*
 * WHY THIS SNAPSHOT MUST BE TAKEN AT FILING TIME, NOT DISPLAY TIME
 * ─────────────────────────────────────────────────────────────────
 * Market cap and share price are lagging indicators — they move continuously
 * and reflect information the market has already priced in. For M&A analysis
 * three numbers matter most:
 *
 *   1. Deal premium: (transactionValueUSD / targetMarketCap) - 1
 *      This only makes sense if targetMarketCap is the value *before* the deal
 *      was announced. On the day the deal is filed, the target's stock
 *      typically jumps 20-40% to the offer price. Capturing market cap at
 *      display time gives you a premium close to zero, which is meaningless.
 *
 *   2. Relative deal size: transactionValueUSD / acquirerMarketCap
 *      An acquirer that has fallen 30% since filing looks smaller now than it
 *      was at the time of commitment. The correct denominator is the acquirer's
 *      cap when they signed the deal, not today's cap.
 *
 *   3. Historical comparability: comparing 2019 and 2024 deals using today's
 *      market caps confounds deal economics with five years of market movement.
 *
 * The correct approach: call this function once, store the result in the DB
 * alongside the deal record, and never re-fetch it for display purposes.
 * If you need a "live" cap for portfolio monitoring that is a separate query
 * and a separate data field — do not overwrite the original snapshot.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketCapSnapshot {
  acquirerMarketCap: number | null;
  targetMarketCap: number | null;
  acquirerPrice: number | null;
  targetPrice: number | null;
  snapshotAt: Date;
}

// Shape of the relevant fields from FMP /v3/profile/{symbol}
interface FmpProfile {
  symbol?: string;
  price?: number | null;
  mktCap?: number | null;
  companyName?: string;
  currency?: string;
  exchange?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function fetchProfile(
  symbol: string,
  apiKey: string
): Promise<FmpProfile | null> {
  const url = `${FMP_BASE}/profile/${encodeURIComponent(symbol)}`;

  let data: unknown;
  try {
    const response = await axios.get<unknown>(url, {
      timeout: 10_000,
      params: { apikey: apiKey },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    data = response.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      // 404 means the symbol is unknown to FMP — not a transient error
      if (status === 404) return null;
      throw new Error(
        `FMP profile request failed for "${symbol}": HTTP ${status ?? err.message}`
      );
    }
    throw new Error(
      `FMP profile request failed for "${symbol}": unknown network error`
    );
  }

  // FMP wraps the result in a single-element array: [{ ...profile }]
  if (!Array.isArray(data) || data.length === 0) return null;

  const raw = data[0] as FmpProfile;

  // Treat zero market cap as absent — FMP sometimes returns 0 for illiquid
  // or delisted symbols rather than omitting the field
  if (typeof raw.mktCap === "number" && raw.mktCap === 0) {
    raw.mktCap = null;
  }
  if (typeof raw.price === "number" && raw.price === 0) {
    raw.price = null;
  }

  return raw;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

// ─── Exported function ────────────────────────────────────────────────────────

export async function fetchMarketCaps(
  acquirerSymbol: string,
  targetSymbol: string | "PRIVATE"
): Promise<MarketCapSnapshot> {
  const apiKey = process.env.FMP_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("FMP_API_KEY environment variable is not set");
  }

  const snapshotAt = new Date();

  // Private targets have no exchange listing — skip the API call entirely
  // and return nulls for their fields rather than making a pointless request.
  const [acquirerProfile, targetProfile] = await Promise.all([
    fetchProfile(acquirerSymbol, apiKey),
    targetSymbol === "PRIVATE" ? Promise.resolve(null) : fetchProfile(targetSymbol, apiKey),
  ]);

  return {
    acquirerMarketCap: toNumberOrNull(acquirerProfile?.mktCap),
    targetMarketCap: toNumberOrNull(targetProfile?.mktCap),
    acquirerPrice: toNumberOrNull(acquirerProfile?.price),
    targetPrice: toNumberOrNull(targetProfile?.price),
    snapshotAt,
  };
}
