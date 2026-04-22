import { type ExtractionResult } from "./validateExtractionResult";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Output from a deal classifier (e.g. "is this actually an M&A event?"). */
export interface ClassificationResult {
  /** Primary label, e.g. "MA_DEAL" | "ASSET_SALE" | "JV" | "UNKNOWN" */
  label: string;
  /** Model confidence in [0, 1]. */
  confidence: number;
}

export interface ConfidenceScore {
  /** Aggregate score in [0, 1]. */
  overall: number;
  /** Human-readable explanation for each applied penalty. */
  flags: string[];
  /** True when overall < REVIEW_THRESHOLD — route to manual review queue. */
  requiresReview: boolean;
}

// ---------------------------------------------------------------------------
// Penalty table
// ---------------------------------------------------------------------------

interface Penalty {
  deduction: number;
  flag: string;
  applies: (e: ExtractionResult, c: ClassificationResult) => boolean;
}

const REVIEW_THRESHOLD = 0.6;

const PENALTIES: readonly Penalty[] = [
  {
    deduction: 0.25,
    flag: "acquirer validation failed: acquirer field is missing or empty",
    applies: (e) => !e.acquirer.trim(),
  },
  {
    deduction: 0.2,
    flag: "transaction value is null: deal size unknown",
    applies: (e) => e.transactionValueUSD === null,
  },
  {
    deduction: 0.2,
    flag: "classification confidence below 0.8: deal type uncertain",
    applies: (_e, c) => c.confidence < 0.8,
  },
  {
    deduction: 0.15,
    flag: 'target name contains "assets" or "division": may be partial asset sale',
    applies: (e) => /\b(assets|division)\b/i.test(e.target),
  },
  {
    deduction: 0.1,
    flag: "payment type is UNKNOWN: consideration structure unclear",
    applies: (e) => e.paymentType === "UNKNOWN",
  },
] as const;

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export function scoreConfidence(
  extraction: ExtractionResult,
  classification: ClassificationResult,
): ConfidenceScore {
  const flags: string[] = [];
  let deduction = 0;

  for (const penalty of PENALTIES) {
    if (penalty.applies(extraction, classification)) {
      deduction += penalty.deduction;
      flags.push(penalty.flag);
    }
  }

  const overall = Math.max(0, Math.min(1, 1 - deduction));

  return {
    overall: Math.round(overall * 100) / 100,
    flags,
    requiresReview: overall < REVIEW_THRESHOLD,
  };
}
