/**
 * Phase 2 — Extraction Agent
 *
 * Responsible for:
 *   1. classifyFiling   — is this filing an M&A event? (Claude Haiku)
 *   2. extractEntities  — who acquired whom, for how much? (Claude Sonnet)
 *   3. generateSummary  — one-sentence executive summary (re-exported from
 *                         dealSummaryPrompt; Claude Sonnet)
 *   4. scoreConfidence  — aggregate quality score with penalty flags
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { logger } from "./pipelineLogger";
import { scoreConfidence as baseScoreConfidence } from "./scoreConfidence";
import type { ConfidenceScore } from "./scoreConfidence";

// ─── Re-export generateSummary for pipeline convenience ──────────────────────
export { generateSummary } from "./dealSummaryPrompt";

// ─── Model constants ─────────────────────────────────────────────────────────

const HAIKU_MODEL  = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";

// Maximum chars of filing text sent to the LLM (≈ 12 k tokens at ~4 chars/token)
const MAX_TEXT_CHARS = 48_000;

// ─── Classification ───────────────────────────────────────────────────────────

export type FilingClassification = "ACQUISITION" | "MATERIAL_AGREEMENT" | "OTHER";

export interface FilingClassificationResult {
  classification: FilingClassification;
  /** Model confidence in [0, 1]. */
  confidence: number;
  /** One-sentence reasoning from the model. */
  reasoning: string;
}

const ClassificationSchema = z.object({
  classification: z.enum(["ACQUISITION", "MATERIAL_AGREEMENT", "OTHER"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
});

const CLASSIFICATION_SYSTEM = `\
You are an expert M&A analyst.  Your task is to classify an SEC 8-K filing into
one of three categories based solely on its text content.

Categories:
  ACQUISITION       — the filing discloses that the company is acquiring, or has
                      agreed to acquire, another company or substantially all of
                      its assets.
  MATERIAL_AGREEMENT — the filing discloses a material definitive agreement
                       (licensing, partnership, joint-venture, credit facility)
                       that is NOT a full acquisition.
  OTHER             — all other 8-K items (earnings, leadership changes,
                      dividends, investor day announcements, etc.).

Output ONLY a single-line JSON object with exactly these keys:
  { "classification": "<ACQUISITION|MATERIAL_AGREEMENT|OTHER>",
    "confidence": <0.00–1.00>,
    "reasoning": "<one sentence>" }

No preamble, no markdown, no explanation outside the JSON.`.trim();

/**
 * Classifies a filing using Claude Haiku.
 * Falls back to { classification: "OTHER", confidence: 0, reasoning: "..." }
 * on any API or parse error so the pipeline can safely discard the filing
 * without crashing.
 */
export async function classifyFiling(
  text: string
): Promise<FilingClassificationResult> {
  const client = new Anthropic();
  const truncated = text.slice(0, MAX_TEXT_CHARS);

  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 256,
      system: CLASSIFICATION_SYSTEM,
      messages: [{ role: "user", content: truncated }],
    });

    const block = response.content[0];
    const raw = block.type === "text" ? block.text.trim() : "";

    const parsed = ClassificationSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return parsed.data;
    }

    logger.warn(
      { validationErrors: parsed.error.issues, raw },
      "[classifyFiling] Zod validation failed — defaulting to OTHER"
    );
  } catch (err) {
    logger.error({ err }, "[classifyFiling] API or parse error — defaulting to OTHER");
  }

  return { classification: "OTHER", confidence: 0, reasoning: "classification failed" };
}

// ─── Entity Extraction ────────────────────────────────────────────────────────

const EntitySchema = z.object({
  acquirer: z
    .string()
    .min(1, "acquirer must be a non-empty string"),
  target: z
    .string()
    .min(1, "target must be a non-empty string"),
  transactionValueUSD: z
    .number()
    .positive("transactionValueUSD must be positive")
    .nullable(),
  transactionValueRaw: z
    .string()
    .nullable(),
  paymentType: z.enum(["CASH", "STOCK", "MIXED", "UNKNOWN"]),
  closingDate: z
    .string()
    .regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/)
    .nullable(),
  isAssetPurchase: z.boolean(),
});

export type EntityExtractionResult = z.infer<typeof EntitySchema>;

const EXTRACTION_SYSTEM = `\
You are an expert M&A analyst.  Extract deal entities from the SEC 8-K filing
text provided by the user.

Output ONLY a single-line JSON object with exactly these keys:
{
  "acquirer":            "<full legal name of the acquiring company>",
  "target":             "<full legal name of the target company or assets>",
  "transactionValueUSD": <total deal value in US dollars as a number, or null if undisclosed>,
  "transactionValueRaw": "<verbatim value string from the filing, e.g. '$4.2 billion', or null>",
  "paymentType":        "<CASH | STOCK | MIXED | UNKNOWN>",
  "closingDate":        "<expected closing date as YYYY-MM-DD, or null if not stated>",
  "isAssetPurchase":    <true if this is an asset purchase rather than a stock/entity purchase>
}

Rules:
- Use the full legal company name (not ticker symbol or brand name) for acquirer and target.
- transactionValueUSD must be a plain number (e.g. 4200000000), never a string.
- paymentType: CASH if consideration is entirely cash; STOCK if entirely equity;
  MIXED if both; UNKNOWN if the filing is silent on consideration structure.
- isAssetPurchase: true only if the filing explicitly describes purchasing assets
  rather than acquiring the entity itself.
- Do not invent information — use null for any field not clearly stated.

No preamble, no markdown, no explanation outside the JSON.`.trim();

/**
 * Extracts deal entities from filing text using Claude Sonnet.
 * Throws if the API call fails or the response fails Zod validation.
 * Callers should catch and handle gracefully (e.g. skip the filing).
 */
export async function extractEntities(
  text: string
): Promise<EntityExtractionResult> {
  const client = new Anthropic();
  const truncated = text.slice(0, MAX_TEXT_CHARS);

  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 512,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: "user", content: truncated }],
  });

  const block = response.content[0];
  const raw = block.type === "text" ? block.text.trim() : "";

  const parsed = EntitySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(e => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new Error(`[extractEntities] Zod validation failed — ${issues}`);
  }

  return parsed.data;
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

/**
 * Adapts the pipeline-specific FilingClassificationResult to the generic
 * ClassificationResult expected by scoreConfidence.ts, then delegates.
 */
export function scoreConfidence(
  extraction: EntityExtractionResult,
  classification: FilingClassificationResult
): ConfidenceScore {
  return baseScoreConfidence(extraction, {
    label: classification.classification,
    confidence: classification.confidence,
  });
}

export type { ConfidenceScore };
