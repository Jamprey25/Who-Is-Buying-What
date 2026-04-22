/**
 * src/preFilter.ts — Zero-cost keyword pre-filter for 8-K filings.
 *
 * Cheap local regex/string scan that categorises a filing as:
 *   CANDIDATE_MA   — contains explicit M&A vocabulary. Proceed to LLM.
 *   DEFINITELY_NOT — looks like earnings/governance/dividend boilerplate,
 *                    and has NO M&A signals. Skip without paying for Haiku.
 *   UNCERTAIN      — no strong signal either way. Safer to run through
 *                    the LLM than discard (conservative default).
 *
 * This is the first level of a three-tier cost cascade:
 *     regex (free)  →  Haiku (cheap)  →  Haiku/Sonnet (expensive)
 *
 * Design principles:
 *   - Positive signals dominate: a single strong hit flips the verdict
 *     to CANDIDATE_MA regardless of how many negative signals are present
 *     (M&A filings frequently include earnings language alongside the deal).
 *   - Negative signals only fire in the ABSENCE of positives.
 *   - Case-insensitive substring match on the first 8 KB of the filing —
 *     M&A vocabulary almost always appears in the Item heading or first
 *     paragraph.
 */

export type PreFilterVerdict =
  | "CANDIDATE_MA"
  | "DEFINITELY_NOT"
  | "UNCERTAIN";

// Strong positive signals — any match ⇒ CANDIDATE_MA.
// Kept deliberately narrow to minimise false positives.
const POSITIVE_SIGNALS: RegExp[] = [
  /\bacquisition\b/i,
  /\bacquire[ds]?\b/i,
  /\bacquiring\b/i,
  /\bmerger\b/i,
  /\bmerge[ds]?\b/i,
  /\bbusiness combination\b/i,
  /\bdefinitive agreement\b/i,
  /\bpurchase agreement\b/i,
  /\bstock purchase\b/i,
  /\basset purchase\b/i,
  /\bplan of merger\b/i,
  /\bletter of intent\b/i,
  /\btender offer\b/i,
  // Item headings that strongly imply M&A context
  /item 1\.01/i,
  /item 2\.01/i,
];

// Strong negative signals — fire ONLY if no positive signals are present.
// Tuned to reject the most common non-M&A 8-K archetypes.
const NEGATIVE_SIGNALS: RegExp[] = [
  /quarterly report/i,
  /annual report/i,
  /earnings release/i,
  /earnings results/i,
  /\bappointment of\b/i,
  /\bresignation of\b/i,
  /\bretirement of\b/i,
  /\bdividend (?:declaration|announcement)\b/i,
  /\bdeclares .{0,40}dividend\b/i,
  /investor (?:day|conference)/i,
  /share repurchase (?:program|authorization)/i,
];

const SCAN_WINDOW_CHARS = 8_000;

export function preFilterFiling(text: string): PreFilterVerdict {
  if (!text || !text.trim()) return "UNCERTAIN";

  const head = text.slice(0, SCAN_WINDOW_CHARS);

  for (const pattern of POSITIVE_SIGNALS) {
    if (pattern.test(head)) return "CANDIDATE_MA";
  }

  for (const pattern of NEGATIVE_SIGNALS) {
    if (pattern.test(head)) return "DEFINITELY_NOT";
  }

  return "UNCERTAIN";
}
