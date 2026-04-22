import type { DealSizeCategory } from "./calculateDealMetrics";
import type { PaymentType } from "./detectPaymentType";
import type { DealRecord } from "./secEdgarFeed";

/**
 * A fully-enriched M&A deal record produced by the 4-phase pipeline.
 *
 * Extends DealRecord so it can be passed directly to existing helpers such as
 * broadcastNewAcquisition(), shouldAlert(), sendDiscordAlert(), and
 * sendEmailAlert() without any adapter layer.
 *
 * Field-to-column mapping (for distributionAgent.upsertDeal):
 *   id                    → id (UUID PK)
 *   fingerprint           → fingerprint (UNIQUE)
 *   accessionNumber       → accession_number
 *   sourceFilings         → source_filings
 *   acquirer              → acquirer
 *   acquirerTicker        → acquirer_ticker
 *   acquirerMarketCap     → acquirer_market_cap
 *   target                → target
 *   targetTicker          → target_ticker
 *   targetMarketCap       → target_market_cap
 *   targetIsPrivate       → target_is_private
 *   transactionValueUSD   → transaction_value_usd
 *   transactionValueRaw   → transaction_value_raw
 *   paymentType           → payment_type
 *   dealSizeCategory      → deal_size_category
 *   executiveSummary      → executive_summary
 *   classificationConf.   → classification_confidence
 *   extractionConfidence  → extraction_confidence
 *   corroborationUrl      → corroboration_url
 *   flags                 → flags
 *   requiresReview        → requires_review
 *   announcedAt           → filed_at  (same concept)
 *   amendedAt             → amended_at
 *   amendmentCount        → amendment_count
 *   createdAt             → created_at
 *   updatedAt             → updated_at
 */
export interface PipelineDeal
  extends Omit<DealRecord, "paymentType" | "dealSizeCategory"> {
  // Phase-1 fields (filing metadata)
  accessionNumber: string;
  /** All accession numbers contributing to this record (original + amendments). */
  sourceFilings: string[];

  // Phase-2 fields (extraction agent)
  paymentType: PaymentType;          // promoted from optional to required
  executiveSummary: string;
  classificationConfidence: number;  // [0, 1]
  extractionConfidence: number;      // [0, 1]

  // Phase-3 fields (enrichment agent)
  acquirerTicker: string | null;
  acquirerMarketCap: number | null;  // snapshot at filing time (USD)
  targetTicker: string | null;
  targetMarketCap: number | null;    // snapshot at filing time (USD)
  targetIsPrivate: boolean;
  transactionValueRaw: string | null;
  corroborationUrl: string | null;

  // Phase-4 / quality fields
  dealSizeCategory: DealSizeCategory; // promoted from optional to required
  requiresReview: boolean;
  amendedAt: Date | null;
}
