import axios from "axios";

const FMP_SEARCH_URL = "https://financialmodelingprep.com/api/v3/search";

const MAJOR_EXCHANGES = new Set([
  "NYSE",
  "NASDAQ",
  "AMEX",
  "NYSE ARCA",
  "NYSE MKT",
  "CBOE",
  "LSE",
  "TSX",
]);

const OTC_EXCHANGES = new Set([
  "OTC",
  "OTCBB",
  "OTCQB",
  "OTCQX",
  "PNK",
  "PINK",
  "OTC MARKETS",
  "OTC BULLETIN BOARD",
]);

export interface TickerResult {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
}

interface FmpSearchItem {
  symbol?: string;
  name?: string;
  stockExchange?: string;
  exchangeShortName?: string;
  currency?: string;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(
      /\b(inc|corp|co|ltd|llc|plc|group|holdings|technologies|tech|solutions)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeForMatch(value).split(" ").filter(Boolean));
}

function jaccardScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function prefixBonus(query: string, candidate: string): number {
  const q = normalizeForMatch(query);
  const c = normalizeForMatch(candidate);
  if (c.startsWith(q)) {
    return 0.2;
  }

  if (q.length >= 4 && c.includes(q.substring(0, 4))) {
    return 0.1;
  }

  return 0;
}

function isMajorExchange(exchange: string): boolean {
  return MAJOR_EXCHANGES.has(exchange.toUpperCase().trim());
}

function isOtcExchange(exchange: string): boolean {
  return OTC_EXCHANGES.has(exchange.toUpperCase().trim());
}

function scoredCandidates(
  items: FmpSearchItem[],
  query: string
): Array<{ item: FmpSearchItem; score: number }> {
  const queryTokens = tokenSet(query);

  return items
    .filter((item) => item.symbol && item.name)
    .map((item) => {
      const nameTokens = tokenSet(item.name!);
      const score =
        jaccardScore(queryTokens, nameTokens) + prefixBonus(query, item.name!);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
}

function pickBest(
  candidates: Array<{ item: FmpSearchItem; score: number }>
): FmpSearchItem | null {
  if (candidates.length === 0) {
    return null;
  }

  const topScore = candidates[0].score;
  const tied = candidates.filter(
    ({ score }) => Math.abs(score - topScore) < 0.05
  );

  const majorMatch = tied.find(({ item }) =>
    isMajorExchange(item.exchangeShortName ?? item.stockExchange ?? "")
  );
  if (majorMatch) {
    return majorMatch.item;
  }

  const nonOtc = tied.find(
    ({ item }) =>
      !isOtcExchange(item.exchangeShortName ?? item.stockExchange ?? "")
  );
  if (nonOtc) {
    return nonOtc.item;
  }

  return candidates[0].item;
}

export async function searchTicker(
  companyName: string
): Promise<TickerResult | null> {
  const apiKey = process.env.FMP_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("FMP_API_KEY environment variable is not set.");
  }

  const query = companyName.trim();
  if (!query) {
    return null;
  }

  let items: FmpSearchItem[];

  try {
    const response = await axios.get<FmpSearchItem[]>(FMP_SEARCH_URL, {
      timeout: 10_000,
      params: { query, limit: 5, apikey: apiKey },
      validateStatus: (status) => status >= 200 && status < 300,
    });
    items = Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      throw new Error(
        `FMP search request failed: HTTP ${status ?? error.message}`
      );
    }
    throw new Error("FMP search request failed: unknown network error");
  }

  const ranked = scoredCandidates(items, query);
  const best = pickBest(ranked);

  if (!best) {
    return null;
  }

  return {
    symbol: best.symbol!,
    name: best.name!,
    exchange: best.exchangeShortName ?? best.stockExchange ?? "",
    currency: best.currency ?? "",
  };
}
