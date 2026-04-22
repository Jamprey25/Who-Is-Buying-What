export type CurrencyCode = "GBP" | "EUR" | "JPY" | "CAD" | "AUD";

export interface NormalizationOptions {
  /** Override default USD exchange rates for non-USD currencies. */
  exchangeRates?: Partial<Record<CurrencyCode, number>>;
}

const DEFAULT_RATES: Record<CurrencyCode, number> = {
  GBP: 1.27,
  EUR: 1.09,
  JPY: 0.0067,
  CAD: 0.74,
  AUD: 0.65,
};

const SYMBOL_TO_CURRENCY: Record<string, CurrencyCode | "USD"> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
};

// Word-form and abbreviated multipliers, ordered longest-first to avoid
// "million" being shadowed by a shorter "m" match.
const MULTIPLIER_MAP: Array<[RegExp, number]> = [
  [/\btrillion\b/i, 1e12],
  [/\bbillion\b/i, 1e9],
  [/\bmillion\b/i, 1e6],
  [/\bthousand\b/i, 1e3],
  [/\bt\b/i, 1e12],
  [/\bb\b/i, 1e9],
  [/\bm\b/i, 1e6],
  [/\bk\b/i, 1e3],
];

const NULL_TERMS = /\b(undisclosed|not\s+disclosed|unknown|tbd|n\/a|not\s+available)\b/i;

// Matches an optional currency symbol, a decimal number, and an optional multiplier word/letter.
// E.g.: "$1.2 billion", "£800M", "500 million"
const AMOUNT_PATTERN =
  /([£$€¥])?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(trillion|billion|million|thousand|[tbmk])\b/gi;

interface ParsedAmount {
  raw: number;
  currency: CurrencyCode | "USD";
}

function resolveMultiplier(suffix: string): number {
  for (const [pattern, value] of MULTIPLIER_MAP) {
    if (pattern.test(suffix)) {
      return value;
    }
  }
  return 1;
}

function stripCommas(value: string): string {
  return value.replace(/,/g, "");
}

function parseAmounts(input: string): ParsedAmount[] {
  const results: ParsedAmount[] = [];
  let match: RegExpExecArray | null;

  AMOUNT_PATTERN.lastIndex = 0;

  while ((match = AMOUNT_PATTERN.exec(input)) !== null) {
    const [, symbol, digits, suffix] = match;
    const raw = parseFloat(stripCommas(digits)) * resolveMultiplier(suffix ?? "");
    const currency =
      (symbol ? SYMBOL_TO_CURRENCY[symbol] : undefined) ?? "USD";
    results.push({ raw, currency });
  }

  return results;
}

function toUsd(
  amount: ParsedAmount,
  rates: Record<CurrencyCode, number>
): number {
  if (amount.currency === "USD") {
    return amount.raw;
  }

  const rate = rates[amount.currency] ?? DEFAULT_RATES[amount.currency] ?? 1;
  return amount.raw * rate;
}

export function normalizeTransactionValue(
  raw: string | null,
  options: NormalizationOptions = {}
): number | null {
  if (!raw || !raw.trim()) {
    return null;
  }

  if (NULL_TERMS.test(raw)) {
    return null;
  }

  const rates: Record<CurrencyCode, number> = {
    ...DEFAULT_RATES,
    ...options.exchangeRates,
  };

  const amounts = parseAmounts(raw);

  if (amounts.length === 0) {
    return null;
  }

  if (amounts.length === 1) {
    return toUsd(amounts[0], rates);
  }

  // Range: take midpoint using the first two parsed amounts.
  const lo = toUsd(amounts[0], rates);
  const hi = toUsd(amounts[1], rates);
  return (lo + hi) / 2;
}
