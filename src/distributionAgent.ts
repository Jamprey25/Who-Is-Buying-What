/**
 * Phase 4 — Distribution Agent
 *
 * Responsible for:
 *   1. upsertDeal            — idempotent PostgreSQL write with skip/update logic
 *   2. broadcastNewAcquisition — Socket.io real-time push (re-export + adapter)
 *   3. shouldAlert / recordAlert — threshold gating (re-export)
 *   4. sendDiscordAlert      — webhook embed (re-export)
 *   5. sendEmailAlert        — Resend HTML email (re-export)
 */

import { Pool } from "pg";
import { logger, logDealInserted, logDuplicateSkipped, logAmendmentMerged } from "./pipelineLogger";
import type { PipelineDeal } from "./pipelineTypes";

// ─── Re-exports ───────────────────────────────────────────────────────────────
export { broadcastNewAcquisition } from "./server";
export { shouldAlert, recordAlert }   from "./notificationConfig";
export { sendDiscordAlert }            from "./sendDiscordAlert";
export { sendEmailAlert }              from "./sendEmailAlert";

// ─── PostgreSQL connection pool ───────────────────────────────────────────────

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL environment variable is not set. " +
        "PostgreSQL persistence is unavailable."
      );
    }
    _pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on("error", (err) => {
      logger.error({ err }, "[distributionAgent] Idle PostgreSQL client error");
    });
  }
  return _pool;
}

/** Replace the pool singleton — for test isolation only. */
export function _resetForTests(): void {
  if (_pool) {
    void _pool.end().catch(() => undefined);
    _pool = null;
  }
}

// ─── upsertDeal ───────────────────────────────────────────────────────────────

export interface UpsertResult {
  action: "inserted" | "updated" | "skipped";
}

/**
 * Writes a PipelineDeal to the `acquisitions` table.
 *
 * Decision logic:
 *   • No existing row with this fingerprint  → INSERT  → "inserted"
 *   • Existing row with LOWER extraction confidence OR smaller amendment_count
 *     → UPDATE  → "updated"
 *   • Existing row with SAME OR HIGHER confidence and >= amendment count
 *     → skip write  → "skipped"
 *
 * The two-query approach (SELECT then INSERT/UPDATE) is safe here because
 * the pipeline is single-process; the rare TOCTOU race is handled by catching
 * the unique-violation error code 23505 and retrying as an update.
 */
export async function upsertDeal(deal: PipelineDeal): Promise<UpsertResult> {
  const pool = getPool();

  // 1. Check for an existing record
  const existing = await pool.query<{
    id: string;
    extraction_confidence: number;
    amendment_count: number;
  }>(
    `SELECT id, extraction_confidence, amendment_count
       FROM acquisitions
      WHERE fingerprint = $1`,
    [deal.fingerprint]
  );

  if (existing.rowCount === 0) {
    // 2a. Fresh insert
    try {
      await insertDeal(pool, deal);
      logDealInserted({
        fingerprint: deal.fingerprint,
        accessionNumber: deal.accessionNumber,
        acquirer: deal.acquirer,
        target: deal.target,
      });
      return { action: "inserted" };
    } catch (err: unknown) {
      // Unique violation — another process inserted concurrently; fall through to update
      const pgErr = err as { code?: string };
      if (pgErr.code !== "23505") throw err;
      logger.warn(
        { fingerprint: deal.fingerprint },
        "[upsertDeal] Concurrent insert race; retrying as update"
      );
    }
  }

  const row = existing.rows[0];

  // 2b. Decide whether to update or skip
  const shouldUpdate =
    deal.extractionConfidence > (row?.extraction_confidence ?? 0) ||
    deal.amendmentCount > (row?.amendment_count ?? 0);

  if (!shouldUpdate) {
    logDuplicateSkipped({
      fingerprint: deal.fingerprint,
      skippedAccession: deal.accessionNumber,
      existingConfidence: row?.extraction_confidence ?? null,
      incomingConfidence: deal.extractionConfidence,
    });
    return { action: "skipped" };
  }

  // 2c. Update
  await updateDeal(pool, deal);

  logAmendmentMerged({
    fingerprint: deal.fingerprint,
    originalAccession: row?.id ?? "",
    amendmentAccession: deal.accessionNumber,
    fieldsUpdated: ["executive_summary", "extraction_confidence", "flags",
                    "amended_at", "amendment_count", "updated_at"],
  });

  return { action: "updated" };
}

// ─── SQL helpers ──────────────────────────────────────────────────────────────

async function insertDeal(pool: Pool, d: PipelineDeal): Promise<void> {
  await pool.query(
    `INSERT INTO acquisitions (
       id, fingerprint, accession_number, source_filings,
       acquirer, acquirer_ticker, acquirer_market_cap,
       target, target_ticker, target_market_cap, target_is_private,
       transaction_value_usd, transaction_value_raw,
       payment_type, deal_size_category,
       executive_summary, classification_confidence, extraction_confidence,
       corroboration_url, flags, requires_review,
       filed_at, amended_at, amendment_count,
       created_at, updated_at
     ) VALUES (
       $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,  $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23, $24, $25, $26
     )`,
    buildParams(d)
  );
}

async function updateDeal(pool: Pool, d: PipelineDeal): Promise<void> {
  await pool.query(
    `UPDATE acquisitions SET
       source_filings            = $4,
       acquirer_ticker           = $6,
       acquirer_market_cap       = $7,
       target_ticker             = $9,
       target_market_cap         = $10,
       target_is_private         = $11,
       transaction_value_usd     = $12,
       transaction_value_raw     = $13,
       payment_type              = $14,
       deal_size_category        = $15,
       executive_summary         = $16,
       classification_confidence = $17,
       extraction_confidence     = $18,
       corroboration_url         = $19,
       flags                     = $20,
       requires_review           = $21,
       amended_at                = $23,
       amendment_count           = $24,
       updated_at                = $26
     WHERE fingerprint = $2`,
    buildParams(d)
  );
}

function buildParams(d: PipelineDeal): unknown[] {
  return [
    /* $1  */ d.id,
    /* $2  */ d.fingerprint,
    /* $3  */ d.accessionNumber,
    /* $4  */ d.sourceFilings,
    /* $5  */ d.acquirer,
    /* $6  */ d.acquirerTicker,
    /* $7  */ d.acquirerMarketCap !== null ? Math.round(d.acquirerMarketCap) : null,
    /* $8  */ d.target,
    /* $9  */ d.targetTicker,
    /* $10 */ d.targetMarketCap  !== null ? Math.round(d.targetMarketCap)  : null,
    /* $11 */ d.targetIsPrivate,
    /* $12 */ d.transactionValueUSD !== null ? Math.round(d.transactionValueUSD) : null,
    /* $13 */ d.transactionValueRaw,
    /* $14 */ d.paymentType,
    /* $15 */ d.dealSizeCategory,
    /* $16 */ d.executiveSummary,
    /* $17 */ d.classificationConfidence,
    /* $18 */ d.extractionConfidence,
    /* $19 */ d.corroborationUrl,
    /* $20 */ d.flags,
    /* $21 */ d.requiresReview,
    /* $22 */ d.announcedAt,
    /* $23 */ d.amendedAt,
    /* $24 */ d.amendmentCount,
    /* $25 */ d.createdAt,
    /* $26 */ d.updatedAt,
  ];
}
