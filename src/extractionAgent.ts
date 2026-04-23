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

import { z } from "zod";
import { logger } from "./pipelineLogger";
import { scoreConfidence as baseScoreConfidence } from "./scoreConfidence";
import type { ConfidenceScore } from "./scoreConfidence";
import {
  complete,
  resolvedProvider,
  anthropicFallbackExtractModel,
} from "./llmClient";
import { stripLlmJsonWrapper } from "./llmResponseParse";
import { hasMaSignals } from "./preFilter";

// ─── Re-export generateSummary for pipeline convenience ──────────────────────
export { generateSummary } from "./dealSummaryPrompt";

// ─── Truncation budget (tiered) ──────────────────────────────────────────────
//
// Different purposes need different context windows. Smaller windows →
// dramatically cheaper LLM calls (input tokens dominate cost for extraction).
//
//   classify — only needs the first few paragraphs to decide "M&A or not".
//   extract  — needs deal terms, payment type, closing date, parties.
//              These usually appear in the first ~20 KB (items 1.01/2.01),
//              before the exhibits.

const CLASSIFY_MAX_CHARS = 3_000;
const EXTRACT_MAX_CHARS  = 20_000;

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
 * Classifies a filing using the configured LLM provider (Anthropic or Ollama).
 * Falls back to { classification: "OTHER", confidence: 0, reasoning: "..." }
 * on any API or parse error so the pipeline can safely discard the filing
 * without crashing.
 *
 * Local models often emit valid JSON with wrong enum labels (e.g.
 * "Financial Information"). After strict Zod fails we apply a heuristic
 * mapper; when provider is Ollama and the filing text still contains
 * strong M&A keywords, we treat it as ACQUISITION so the pipeline can proceed.
 */
export async function classifyFiling(
  text: string
): Promise<FilingClassificationResult> {
  const truncated = text.slice(0, CLASSIFY_MAX_CHARS);

  try {
    const raw = await complete({
      purpose: "classify",
      system: CLASSIFICATION_SYSTEM,
      user: truncated,
      maxTokens: 256,
      json: true,
    });

    const stripped = stripLlmJsonWrapper(raw);
    let parsedObj: unknown;
    try {
      parsedObj = JSON.parse(stripped);
    } catch (parseErr) {
      logger.warn(
        { parseErr, rawPreview: raw.slice(0, 200) },
        "[classifyFiling] JSON.parse failed on model output"
      );
      return maybeOllamaKeywordFallback(truncated);
    }

    const strict = ClassificationSchema.safeParse(parsedObj);
    if (strict.success) return strict.data;

    const coerced = coerceClassificationFromObject(
      parsedObj,
      truncated,
      resolvedProvider("classify") === "ollama"
    );
    if (coerced) {
      logger.info(
        { coercedFrom: (parsedObj as { classification?: unknown })?.classification },
        "[classifyFiling] Applied loose classification coercion"
      );
      return coerced;
    }

    logger.warn(
      { validationErrors: strict.error.issues, rawPreview: raw.slice(0, 240) },
      "[classifyFiling] Zod validation failed — defaulting to OTHER"
    );
  } catch (err) {
    logger.error({ err }, "[classifyFiling] API or parse error — defaulting to OTHER");
  }

  return maybeOllamaKeywordFallback(truncated);
}

function parseConfidenceField(value: unknown): number {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return Math.min(1, Math.max(0, value));
  }
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s.includes("high")) return 0.85;
    if (s.includes("medium") || s.includes("moderate")) return 0.55;
    if (s.includes("low")) return 0.3;
    const n = Number.parseFloat(s.replace(/[^0-9.+-]/g, ""));
    if (!Number.isNaN(n)) return Math.min(1, Math.max(0, n));
  }
  return 0.5;
}

function coerceClassificationFromObject(
  obj: unknown,
  filingText: string,
  isOllama: boolean
): FilingClassificationResult | null {
  if (typeof obj !== "object" || obj === null) return null;

  const rec = obj as Record<string, unknown>;
  const labelRaw = String(rec.classification ?? rec.category ?? "").trim();
  const reasoning = String(rec.reasoning ?? rec.reason ?? rec.explanation ?? "").trim() || "model output";
  const confidence = parseConfidenceField(rec.confidence);

  const blob = `${labelRaw} ${reasoning}`.toUpperCase();

  const exact = labelRaw.toUpperCase().replace(/\s+/g, "_");
  if (exact === "ACQUISITION" || exact === "MATERIAL_AGREEMENT" || exact === "OTHER") {
    return {
      classification: exact as FilingClassification,
      confidence,
      reasoning,
    };
  }

  if (
    /\b(ACQUISITION|MERGER|ACQUIRE|ACQUIRING|BUSINESS COMBINATION|PURCHASE AGREEMENT|STOCK PURCHASE|ASSET PURCHASE|PLAN OF MERGER|TENDER OFFER)\b/.test(
      blob
    )
  ) {
    return { classification: "ACQUISITION", confidence, reasoning };
  }

  if (
    /\b(MATERIAL\s+AGREEMENT|MATERIAL_AGREEMENT|JOINT\s+VENTURE|CREDIT\s+FACILITY|LICENSE\s+AGREEMENT)\b/.test(
      blob
    ) &&
    !/\b(MERGER|ACQUISITION|ACQUIRE)\b/.test(blob)
  ) {
    return { classification: "MATERIAL_AGREEMENT", confidence, reasoning };
  }

  if (isOllama && hasMaSignals(filingText)) {
    return {
      classification: "ACQUISITION",
      confidence: Math.min(0.6, confidence),
      reasoning: `${reasoning} (ollama: non-schema label "${labelRaw}"; filing text contains M&A keywords)`,
    };
  }

  return null;
}

function maybeOllamaKeywordFallback(filingText: string): FilingClassificationResult {
  if (resolvedProvider("classify") === "ollama" && hasMaSignals(filingText)) {
    return {
      classification: "ACQUISITION",
      confidence: 0.55,
      reasoning:
        "ollama fallback: model output was not parseable as strict JSON schema; filing text contains M&A keywords",
    };
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
  const truncated = text.slice(0, EXTRACT_MAX_CHARS);

  // Primary pass — default provider/model from llmClient (usually Haiku
  // or local Ollama, both ~15× cheaper than Sonnet).
  const primary = await complete({
    purpose: "extract",
    system: EXTRACTION_SYSTEM,
    user: truncated,
    maxTokens: 512,
    json: true,
  });

  const firstAttempt = tryParseEntity(primary);
  if (firstAttempt.success) return firstAttempt.data;

  // Ollama: one cheap retry — small models occasionally truncate JSON mid-stream.
  if (resolvedProvider("extract") === "ollama") {
    logger.warn(
      { firstAttemptErrors: firstAttempt.issues, rawPreview: primary.slice(0, 200) },
      "[extractEntities] First parse failed — retrying Ollama once"
    );
    const secondRaw = await complete({
      purpose: "extract",
      system: EXTRACTION_SYSTEM,
      user: truncated,
      maxTokens: 512,
      json: true,
    });
    const secondAttempt = tryParseEntity(secondRaw);
    if (secondAttempt.success) return secondAttempt.data;

    throw new Error(
      `[extractEntities] Ollama extraction failed after retry — ${secondAttempt.issues}`
    );
  }

  // Anthropic-only: on validation failure, retry once with Sonnet.
  // Small models occasionally produce slightly malformed JSON on edge cases;
  // the Sonnet retry costs ~$0.04 but only fires for the 5-10% of filings
  // Haiku botches, keeping the amortised cost near Haiku's.
  const provider = resolvedProvider("extract");
  if (provider === "anthropic") {
    logger.warn(
      { firstAttemptErrors: firstAttempt.issues, rawPreview: primary.slice(0, 240) },
      "[extractEntities] Primary extraction failed Zod — retrying with fallback model"
    );

    const retry = await complete({
      purpose: "extract",
      system: EXTRACTION_SYSTEM,
      user: truncated,
      maxTokens: 512,
      json: true,
      modelOverride: anthropicFallbackExtractModel(),
    });

    const retryAttempt = tryParseEntity(retry);
    if (retryAttempt.success) return retryAttempt.data;

    throw new Error(
      `[extractEntities] Both primary and fallback extraction failed Zod — ${retryAttempt.issues}`
    );
  }

  throw new Error(
    `[extractEntities] Zod validation failed — ${firstAttempt.issues}`
  );
}

type EntityParseAttempt =
  | { success: true; data: EntityExtractionResult }
  | { success: false; issues: string };

function tryParseEntity(raw: string): EntityParseAttempt {
  const cleaned = stripLlmJsonWrapper(raw);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, issues: `JSON.parse failed: ${msg}` };
  }

  const parsed = EntitySchema.safeParse(json);
  if (parsed.success) return { success: true, data: parsed.data };

  const issues = parsed.error.issues
    .map((e) => `${e.path.join(".")}: ${e.message}`)
    .join("; ");
  return { success: false, issues };
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
