export type PaymentType = "CASH" | "STOCK" | "MIXED" | "UNKNOWN";

export interface PaymentTypeResult {
  paymentType: PaymentType;
  /** true when the result is a heuristic best-guess with weak or ambiguous evidence */
  lowConfidence: boolean;
}

// ---------------------------------------------------------------------------
// Claude prompt snippet
// ---------------------------------------------------------------------------

/**
 * Insert filing text at {{FILING_TEXT}} before sending.
 *
 * Claude must return ONLY valid JSON matching:
 *   { "paymentType": "CASH" | "STOCK" | "MIXED" | "UNKNOWN" }
 */
export const PAYMENT_TYPE_PROMPT = `
You are an expert M&A analyst reading SEC filing text. Your task is to determine
the payment / consideration type for the described transaction.

Classify the transaction as exactly one of:
  CASH  — consideration is entirely cash
  STOCK — consideration is entirely equity / stock
  MIXED — consideration is a combination of cash and stock
  UNKNOWN — the filing does not make the payment structure clear

Rules:
- "all-cash transaction", "cash consideration", "cash per share",
  "paid in cash", "cash merger" → CASH
- "shares of common stock", "stock-for-stock", "all-stock",
  "exchange ratio" (with no cash language nearby) → STOCK
- "combination of cash and stock", "cash and stock consideration",
  "cash and shares", "mix of cash and stock",
  exchange ratio language alongside a cash amount → MIXED
- If the text is ambiguous or silent on consideration type → UNKNOWN

Respond with ONLY a JSON object on a single line, no explanation:
{"paymentType":"CASH"}

Filing text:
{{FILING_TEXT}}
`.trim();

// ---------------------------------------------------------------------------
// Regex signal tables
// ---------------------------------------------------------------------------

interface SignalPattern {
  pattern: RegExp;
  /** how many "votes" a single match contributes */
  weight: number;
}

const CASH_SIGNALS: SignalPattern[] = [
  { pattern: /\ball[- ]cash\b/i, weight: 3 },
  { pattern: /\bcash\s+(?:consideration|merger|acquisition)\b/i, weight: 3 },
  { pattern: /\bcash\s+per\s+share\b/i, weight: 2 },
  { pattern: /\bpaid\s+in\s+cash\b/i, weight: 2 },
  { pattern: /\bcash\s+purchase\s+price\b/i, weight: 2 },
  { pattern: /\bcash\s+payment\b/i, weight: 1 },
];

const STOCK_SIGNALS: SignalPattern[] = [
  { pattern: /\ball[- ]stock\b/i, weight: 3 },
  { pattern: /\bstock[- ]for[- ]stock\b/i, weight: 3 },
  { pattern: /\bshares\s+of\s+(?:common\s+)?stock\b/i, weight: 2 },
  { pattern: /\bexchange\s+ratio\b/i, weight: 2 },
  { pattern: /\bstock\s+consideration\b/i, weight: 2 },
  { pattern: /\bshare\s+consideration\b/i, weight: 2 },
  { pattern: /\bequity\s+consideration\b/i, weight: 1 },
];

const MIXED_SIGNALS: SignalPattern[] = [
  { pattern: /\bcombination\s+of\s+cash\s+and\s+(?:stock|shares)\b/i, weight: 4 },
  { pattern: /\bcash\s+and\s+(?:stock|share)\s+consideration\b/i, weight: 4 },
  { pattern: /\bcash\s+and\s+shares\b/i, weight: 3 },
  { pattern: /\bmix(?:ture)?\s+of\s+cash\s+and\b/i, weight: 3 },
  { pattern: /\bcash\s+(?:and|or)\s+stock\b/i, weight: 2 },
  { pattern: /\bpart\s+cash[,\s]+part\s+(?:stock|shares)\b/i, weight: 3 },
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function score(text: string, signals: SignalPattern[]): number {
  return signals.reduce((total, { pattern, weight }) => {
    const matches = text.match(new RegExp(pattern.source, pattern.flags + "g"));
    return total + (matches ? matches.length * weight : 0);
  }, 0);
}

const HIGH_CONFIDENCE_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Exported heuristic
// ---------------------------------------------------------------------------

/**
 * Regex-based fallback used when Claude returns UNKNOWN or is unavailable.
 *
 * Always sets `lowConfidence: true` unless multiple strong signals agree
 * (score ≥ HIGH_CONFIDENCE_THRESHOLD with no competing category close behind).
 */
export function detectPaymentType(text: string): PaymentTypeResult {
  if (!text || !text.trim()) {
    return { paymentType: "UNKNOWN", lowConfidence: true };
  }

  const mixedScore = score(text, MIXED_SIGNALS);
  const cashScore = score(text, CASH_SIGNALS);
  const stockScore = score(text, STOCK_SIGNALS);

  // Explicit mixed language wins outright.
  if (mixedScore > 0) {
    return {
      paymentType: "MIXED",
      lowConfidence: mixedScore < HIGH_CONFIDENCE_THRESHOLD,
    };
  }

  // Both cash and stock signals present but no explicit mixed phrasing →
  // treat as MIXED with low confidence (writer may have omitted explicit label).
  if (cashScore > 0 && stockScore > 0) {
    return { paymentType: "MIXED", lowConfidence: true };
  }

  if (cashScore > 0) {
    return {
      paymentType: "CASH",
      lowConfidence: cashScore < HIGH_CONFIDENCE_THRESHOLD,
    };
  }

  if (stockScore > 0) {
    return {
      paymentType: "STOCK",
      lowConfidence: stockScore < HIGH_CONFIDENCE_THRESHOLD,
    };
  }

  return { paymentType: "UNKNOWN", lowConfidence: true };
}
