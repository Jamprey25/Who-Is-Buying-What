import Anthropic from "@anthropic-ai/sdk";
import { type PaymentType } from "./detectPaymentType";
import { type ExtractionResult } from "./validateExtractionResult";

const MODEL = "claude-sonnet-4-20250514";
const MAX_FILING_CHARS = 2_000;
const MAX_TOKENS = 80;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Pass as the `system` field in your Claude API call.
 * Pair with a user message built by buildDealSummaryUserMessage().
 */
export const DEAL_SUMMARY_SYSTEM_PROMPT = `
You write one-sentence executive summaries of M&A deals for a real-time dashboard.

OUTPUT RULES — violating any of these is a failure:
1. Return ONLY the sentence. No preamble, no explanation, no quotes around it.
2. Maximum 30 words.
3. Plain language. No jargon (do not write "synergies", "strategic fit", "accretive",
   "transformative", "landscape", "ecosystem", or similar filler).
4. Never open with "In a", "In an", "This deal", "This acquisition", or similar throat-clearing.

SENTENCE TEMPLATES:

When a deal value is provided:
  [Acquirer] acquires [Target] for [value] in [payment type] deal to [rationale].

When deal value is null or undisclosed:
  [Acquirer] acquires [Target] to [rationale].

FIELD RULES:
- [Acquirer] and [Target]: use the exact company names given to you.
- [value]: formatted as "$X billion" or "$X million" — never raw numbers.
- [payment type]: write "an all-cash", "an all-stock", or "a cash-and-stock".
  Omit this phrase entirely if payment type is UNKNOWN.
- [rationale]: a short verb phrase (3–6 words) inferred from the filing context,
  e.g. "expand its cloud infrastructure", "enter the European payments market",
  "add autonomous vehicle software". If context is insufficient, use
  "strengthen its market position".

EXAMPLES (do not copy these verbatim):
  Microsoft acquires Activision Blizzard for $69 billion in an all-cash deal to expand its gaming portfolio.
  Pfizer acquires Seagen for $43 billion in an all-cash deal to grow its oncology pipeline.
  Google acquires Wiz to strengthen its cloud security capabilities.
`.trim();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DealSummaryInput {
  acquirer: string;
  target: string;
  transactionValueUSD: number | null;
  paymentType: PaymentType;
  /** Raw filing excerpt (1–3 sentences) used to infer strategic rationale. */
  filingContext: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAYMENT_TYPE_PHRASE: Record<PaymentType, string | null> = {
  CASH: "an all-cash",
  STOCK: "an all-stock",
  MIXED: "a cash-and-stock",
  UNKNOWN: null,
};

function formatUsd(usd: number): string {
  if (usd >= 1e12) {
    return `$${+(usd / 1e12).toPrecision(3)} trillion`;
  }
  if (usd >= 1e9) {
    return `$${+(usd / 1e9).toPrecision(3)} billion`;
  }
  if (usd >= 1e6) {
    return `$${+(usd / 1e6).toPrecision(3)} million`;
  }
  return `$${usd.toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

/**
 * Returns the user-turn message to send alongside DEAL_SUMMARY_SYSTEM_PROMPT.
 *
 * @example
 * const messages = [
 *   { role: "user", content: buildDealSummaryUserMessage(input) },
 * ];
 * const response = await claude({ system: DEAL_SUMMARY_SYSTEM_PROMPT, messages });
 */
// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function isSingleSentence(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.includes("\n") &&
    trimmed.endsWith(".")
  );
}

// ---------------------------------------------------------------------------
// Fallback template
// ---------------------------------------------------------------------------

function buildFallback(extraction: ExtractionResult): string {
  const { acquirer, target, transactionValueUSD } = extraction;
  if (transactionValueUSD !== null) {
    return `${acquirer} acquires ${target} for ${formatUsd(transactionValueUSD)}.`;
  }
  return `${acquirer} acquires ${target}.`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Calls Claude to produce a one-sentence dashboard summary of an M&A deal.
 * Falls back to a plain template if the API fails or returns an invalid response.
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 */
export async function generateSummary(
  extraction: ExtractionResult,
  filingText: string
): Promise<string> {
  const client = new Anthropic();

  const filingExcerpt = filingText.slice(0, MAX_FILING_CHARS);

  const userMessage = buildDealSummaryUserMessage({
    acquirer: extraction.acquirer,
    target: extraction.target,
    transactionValueUSD: extraction.transactionValueUSD,
    paymentType: extraction.paymentType,
    filingContext: filingExcerpt,
  });

  let raw: string;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: DEAL_SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    raw = block.type === "text" ? block.text.trim() : "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[${new Date().toISOString()}] generateSummary: Claude API error — ${message}. Using fallback.`
    );
    return buildFallback(extraction);
  }

  if (!isSingleSentence(raw)) {
    console.warn(
      `[${new Date().toISOString()}] generateSummary: Response failed sentence validation ("${raw.slice(0, 80)}"). Using fallback.`
    );
    return buildFallback(extraction);
  }

  return raw;
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

export function buildDealSummaryUserMessage(input: DealSummaryInput): string {
  const { acquirer, target, transactionValueUSD, paymentType, filingContext } =
    input;

  const valueLabel =
    transactionValueUSD !== null ? formatUsd(transactionValueUSD) : "undisclosed";

  const paymentLabel = PAYMENT_TYPE_PHRASE[paymentType] ?? "unknown";

  return [
    "Generate the one-sentence executive summary using these facts:",
    "",
    `Acquirer: ${acquirer}`,
    `Target: ${target}`,
    `Transaction value: ${valueLabel}`,
    `Payment type: ${paymentLabel}`,
    "",
    "Filing context for rationale inference:",
    filingContext.trim(),
  ].join("\n");
}
