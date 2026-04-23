/**
 * src/index.ts — Main pipeline entry point
 *
 * Starts the Next.js / Socket.io web server, then launches the 4-phase
 * M&A intelligence polling loop at a configurable interval (default 60 s).
 *
 * Pipeline phases per filing:
 *   Phase 1  Ingest   — EDGAR feed fetch, cursor management, form-type filter
 *   Phase 2  Extract  — LLM classification (Haiku) + entity extraction (Sonnet)
 *   Phase 3  Enrich   — Yahoo Finance tickers / market caps, fingerprint, news
 *   Phase 4  Distribute — PostgreSQL upsert, Socket.io broadcast, Discord/email
 */

import { randomUUID } from "node:crypto";

import pino from "pino";

// ─── Phase 1: Ingest ──────────────────────────────────────────────────────────
import { fetchCurrent8kFilings }       from "./secEdgarFeed";
import { filterNewFilings, setLastSeenId } from "./filingState";
import { filterFilingsByFormType }     from "./filterFilings";
import { getPrimaryDocumentUrl }       from "./edgarDocumentUrl";
import { fetchFilingContent }          from "./fetchFilingContent";
import { extractTextFromFiling }       from "./extractTextFromFiling";
import { preFilterFiling }             from "./preFilter";

// ─── Phase 2: Extract ─────────────────────────────────────────────────────────
import {
  classifyFiling,
  extractEntities,
  scoreConfidence,
} from "./extractionAgent";
import { generateSummary }             from "./dealSummaryPrompt";

// ─── Phase 3: Enrich ─────────────────────────────────────────────────────────
import {
  resolveTickerYahoo,
  fetchMarketCapYahoo,
  generateDealFingerprint,
  searchDealNews,
  mergeAmendment,
} from "./enrichmentAgent";
import { calculateDealMetrics }        from "./calculateDealMetrics";

// ─── Phase 4: Distribute ──────────────────────────────────────────────────────
import {
  upsertDeal,
  shouldAlert,
  recordAlert,
  sendDiscordAlert,
  broadcastNewAcquisition,
} from "./distributionAgent";

// ─── Scheduler ───────────────────────────────────────────────────────────────
import { createPollingScheduler }      from "./pollingScheduler";

// ─── Types ───────────────────────────────────────────────────────────────────
import type { PipelineDeal }           from "./pipelineTypes";
import type { TaggedFiling }           from "./filterFilings";

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: "who-is-buying-what", env: process.env.NODE_ENV ?? "development" },
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  },
  process.env.NODE_ENV === "production"
    ? undefined
    : pino.transport({
        targets: [{
          target: "pino-pretty",
          level: "trace",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        }],
      })
);

// ─── Startup warnings ─────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  log.error("ANTHROPIC_API_KEY is not set — LLM phases will fail");
}
if (!process.env.DATABASE_URL) {
  log.warn("DATABASE_URL is not set — deals will not be persisted to PostgreSQL");
}
if (!process.env.SERPAPI_KEY) {
  log.warn("SERPAPI_KEY is not set — news enrichment is disabled");
}
if (!process.env.DISCORD_WEBHOOK_URL) {
  log.info("DISCORD_WEBHOOK_URL not set — Discord alerts are disabled");
}

// ─── Core poll function ───────────────────────────────────────────────────────

async function runPipelinePoll(): Promise<void> {
  // ── Phase 1: Fetch & filter ─────────────────────────────────────────────────
  log.debug("Fetching EDGAR feed…");
  const allFilings = await fetchCurrent8kFilings();
  const newFilings  = filterNewFilings(allFilings);

  if (newFilings.length === 0) {
    log.info("No new filings since last cursor — skipping cycle (delete data/state.json to reprocess the feed window)");
    return;
  }

  // Advance the cursor immediately so a subsequent crash doesn't reprocess
  // the same batch.
  setLastSeenId(newFilings[0].accessionNumber);
  log.info({ count: newFilings.length }, "New filings detected");

  // Keep only 8-K and 8-K/A (with amendment tags); Form 4 are not routed
  // through the LLM pipeline.
  const tagged   = filterFilingsByFormType(newFilings);
  const eightKs  = tagged.filter(
    (f) => !f.isAmendment && f.formType.toUpperCase().replace(/^FORM\s+/, "") === "8-K"
  );
  const amendments = tagged.filter((f) => f.isAmendment);

  log.info(
    { eightKs: eightKs.length, amendments: amendments.length },
    "Queuing filings for LLM pipeline"
  );

  // Process originals first, then amendments (so mergeAmendment can find the
  // original record in the DB before trying to merge).
  for (const filing of [...eightKs, ...amendments]) {
    await processOneFiling(filing).catch((err: unknown) => {
      log.error(
        { err, accessionNumber: filing.accessionNumber, formType: filing.formType },
        "Failed to process filing — skipping"
      );
    });
  }
}

// ─── Single-filing pipeline ───────────────────────────────────────────────────

async function processOneFiling(filing: TaggedFiling): Promise<void> {
  const { accessionNumber, cik, formType, filedAt, companyName, filingUrl, isAmendment } = filing;
  const filingLabel = `${formType} ${accessionNumber} (${companyName})`;

  log.info({ accessionNumber, formType, isAmendment }, `Processing ${filingLabel}`);

  // ── Phase 1: Fetch document text ─────────────────────────────────────────────
  let primaryUrl: string;
  try {
    primaryUrl = await getPrimaryDocumentUrl(accessionNumber, cik);
  } catch (err) {
    log.warn({ err, accessionNumber }, "Could not resolve primary document URL — skipping");
    return;
  }

  const html = await fetchFilingContent(primaryUrl);
  const text  = extractTextFromFiling(html);

  if (!text.trim()) {
    log.warn({ accessionNumber }, "Empty text extracted from filing — skipping");
    return;
  }

  // ── Phase 2a-pre: Keyword pre-filter (zero-cost) ─────────────────────────────
  // Discards obvious non-M&A filings (earnings, governance, dividends) before
  // paying for any LLM call. Amendments bypass this gate so they can always
  // merge into their original deal record.
  const preVerdict = preFilterFiling(text);
  if (preVerdict === "DEFINITELY_NOT" && !isAmendment) {
    log.info(
      { accessionNumber, preVerdict },
      "Pre-filter rejected filing — skipping LLM pipeline"
    );
    return;
  }
  log.debug({ accessionNumber, preVerdict }, "Pre-filter verdict");

  // ── Phase 2a: Classify ───────────────────────────────────────────────────────
  const classification = await classifyFiling(text);
  log.debug(
    { classification: classification.classification, confidence: classification.confidence },
    "Filing classified"
  );

  if (classification.classification === "OTHER" && !isAmendment) {
    log.info({ accessionNumber }, "Non-M&A filing — skipping");
    return;
  }

  // ── Phase 2b: Extract entities ───────────────────────────────────────────────
  let entities;
  try {
    entities = await extractEntities(text);
  } catch (err) {
    log.error({ err, accessionNumber }, "Entity extraction failed — skipping");
    return;
  }

  // ── Phase 2c: Summary + confidence ───────────────────────────────────────────
  const summary    = await generateSummary(entities, text);
  const confidence = scoreConfidence(entities, classification);

  log.debug(
    { overall: confidence.overall, flags: confidence.flags },
    "Confidence scored"
  );

  // ── Phase 3: Enrich ──────────────────────────────────────────────────────────
  const [acquirerTickerResult, targetTickerResult] = await Promise.all([
    resolveTickerYahoo(entities.acquirer),
    resolveTickerYahoo(entities.target),
  ]);

  const [acquirerMktCap, targetMktCap] = await Promise.all([
    acquirerTickerResult ? fetchMarketCapYahoo(acquirerTickerResult.symbol) : Promise.resolve(null),
    targetTickerResult   ? fetchMarketCapYahoo(targetTickerResult.symbol)   : Promise.resolve(null),
  ]);

  const newsResults     = await searchDealNews(entities.acquirer, entities.target, filedAt);
  const corroborationUrl = newsResults[0]?.url ?? null;

  // ── Phase 3: Build PipelineDeal ───────────────────────────────────────────────
  const now = new Date();
  const fingerprint = generateDealFingerprint({
    acquirer: entities.acquirer,
    target: entities.target,
    transactionValueUSD: entities.transactionValueUSD,
    filedAt,
  });

  const dealSizeCategory = (() => {
    if (!acquirerMktCap?.marketCap) return "UNKNOWN" as const;
    return calculateDealMetrics(
      {
        id: "", fingerprint, acquirer: entities.acquirer, target: entities.target,
        announcedAt: filedAt, sourceUrl: filingUrl, transactionValueUSD: entities.transactionValueUSD,
        amendmentCount: 0, flags: [], createdAt: now, updatedAt: now,
      },
      {
        acquirerMarketCap: acquirerMktCap.marketCap,
        targetMarketCap: targetMktCap?.marketCap ?? null,
        acquirerPrice: acquirerMktCap.price,
        targetPrice: targetMktCap?.price ?? null,
        snapshotAt: now,
      }
    ).dealSizeCategory;
  })();

  const deal: PipelineDeal = {
    // Identity
    id:                    randomUUID(),
    fingerprint,
    accessionNumber,
    sourceFilings:         [accessionNumber],
    // Core deal data
    acquirer:              entities.acquirer,
    acquirerTicker:        acquirerTickerResult?.symbol ?? null,
    acquirerMarketCap:     acquirerMktCap?.marketCap ?? null,
    target:                entities.target,
    targetTicker:          targetTickerResult?.symbol ?? null,
    targetMarketCap:       targetMktCap?.marketCap ?? null,
    targetIsPrivate:       !targetTickerResult,
    transactionValueUSD:   entities.transactionValueUSD,
    transactionValueRaw:   entities.transactionValueRaw,
    paymentType:           entities.paymentType,
    dealSizeCategory,
    // Analysis
    executiveSummary:           summary,
    classificationConfidence:   classification.confidence,
    extractionConfidence:       confidence.overall,
    corroborationUrl,
    flags:                      confidence.flags,
    requiresReview:             confidence.requiresReview,
    // Filing metadata (DealRecord-compatible)
    announcedAt:           filedAt,
    sourceUrl:             filingUrl,
    amendmentCount:        isAmendment ? 1 : 0,
    amendedAt:             isAmendment ? filedAt : null,
    createdAt:             now,
    updatedAt:             now,
  };

  // If this is an amendment, ask enrichmentAgent to fold it into the existing record
  let finalDeal = deal;
  if (isAmendment) {
    // mergeAmendment handles the case where the original doesn't exist yet
    // (first time we see this company/deal) by just using deal as-is with count 1.
    finalDeal = mergeAmendment({ ...deal, amendmentCount: 0, amendedAt: null }, deal);
  }

  // ── Phase 4: Persist ──────────────────────────────────────────────────────────
  let upsertResult: Awaited<ReturnType<typeof upsertDeal>> | null = null;
  try {
    upsertResult = await upsertDeal(finalDeal);
    log.info(
      { action: upsertResult.action, fingerprint, acquirer: entities.acquirer },
      "Deal upserted"
    );
  } catch (err) {
    log.error({ err, accessionNumber }, "DB upsert failed — continuing to broadcast");
  }

  if (upsertResult?.action === "skipped") {
    log.debug({ fingerprint }, "Duplicate deal skipped — not broadcasting");
    return;
  }

  // ── Phase 4: Broadcast ────────────────────────────────────────────────────────
  try {
    broadcastNewAcquisition(finalDeal);
  } catch (err) {
    // Socket.io may not be initialised when running the pipeline standalone.
    log.warn({ err }, "Socket.io broadcast failed (server not ready?)");
  }

  // ── Phase 4: Alerts ───────────────────────────────────────────────────────────
  if (shouldAlert(finalDeal)) {
    if (process.env.DISCORD_WEBHOOK_URL) {
      try {
        await sendDiscordAlert(finalDeal);
        recordAlert(finalDeal);
        log.info({ acquirer: entities.acquirer }, "Discord alert sent");
      } catch (err) {
        log.error({ err }, "Discord alert failed");
      }
    }
  }
}

// ─── Scheduler bootstrap ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);

export const scheduler = createPollingScheduler(runPipelinePoll, {
  intervalMs: POLL_INTERVAL_MS,
  logger: (msg) => log.debug(msg),
  onError: (err) => log.error({ err }, "Unhandled poll cycle error"),
});

/**
 * Exported so server.ts or test suites can call startPipeline() after the
 * HTTP server is ready.
 */
export function startPipeline(): void {
  log.info({ pollIntervalMs: POLL_INTERVAL_MS }, "M&A pipeline starting");
  scheduler.start();
}

export function stopPipeline(): void {
  scheduler.stop();
  log.info("M&A pipeline stopped");
}

// ─── Standalone entry (tsx src/index.ts) ─────────────────────────────────────

// When this file is executed directly (not imported), start the web server and
// kick off the polling pipeline together.
if (require.main === module) {
  // Importing server.ts causes the Next.js + Socket.io server to start as a
  // side effect. We then delay the first poll by 5 s to let the HTTP server
  // finish binding before broadcastNewAcquisition() is called.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./server");

  setTimeout(() => {
    startPipeline();
  }, 5_000);
}
