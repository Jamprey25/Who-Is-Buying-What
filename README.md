# Who Is Buying What

> Real-time M&A intelligence — SEC EDGAR → AI extraction → live dashboard

Financial intelligence shouldn't require a $20k Bloomberg subscription. This system acts as a 24/7 digital scout: it polls SEC EDGAR the moment new 8-K filings land, uses Claude to classify and extract deal entities, enriches them with market data, deduplicates, persists to PostgreSQL, and pushes live updates to a Next.js dashboard via Socket.io — all within seconds of publication.

---

## Features

- **Real-time feed** — polls SEC EDGAR Atom feed every 60 s (configurable)
- **AI classification** — Claude Haiku filters noise; Claude Sonnet extracts acquirer, target, value, payment type
- **Deduplication** — SHA-256 fingerprint prevents double-counting of the same deal
- **8-K/A amendments** — tagged and merged into the original record instead of creating a new row
- **Ticker & market cap** — Yahoo Finance (free, no API key) for snapshot market data
- **News corroboration** — SerpAPI (optional) cross-checks each deal against Google News
- **PostgreSQL persistence** — idempotent upsert with confidence-based update gating
- **Live dashboard** — Socket.io `new_acquisition` events; `billion_dollar_club` room for >$1B deals; dark-themed UI with per-row SEC filing links
- **Alerts** — Discord webhooks (colour-coded by payment type) + Resend HTML email

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in env vars
cp .env.example .env   # edit the values (see Environment Variables below)

# 3. Run the database migration
psql $DATABASE_URL -f migrations/001_create_acquisitions.sql

# 4. Start the full application (web server + polling pipeline)
npm run dev            # uses src/server.ts (Next.js dev mode)
# — OR —
tsx src/index.ts       # starts server + pipeline together
```

---

## Environment Variables

All variables are read at startup. Required ones will cause the process to exit or the relevant phase to error; optional ones degrade gracefully with a log warning.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Claude API key. Haiku for classification, Sonnet for extraction & summarisation. |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/dbname` |
| `SEC_CONTACT_EMAIL` | Recommended | `sec-compliance@example.com` | Shown in the `User-Agent` header sent to SEC.gov. EDGAR requires a valid contact email. |
| `SERPAPI_KEY` | No | — | SerpAPI key for Google News cross-check. If absent, `corroborationUrl` is always `null`. |
| `DISCORD_WEBHOOK_URL` | No | — | Discord webhook URL. If absent, Discord alerts are silently skipped. |
| `RESEND_API_KEY` | No | — | Resend API key for HTML email alerts. |
| `RESEND_FROM_ADDRESS` | No | `alerts@your-domain.com` | Sender address for email alerts. |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection for alert deduplication cooldown. Falls back to in-memory `Map`. |
| `POLL_INTERVAL_MS` | No | `60000` | Milliseconds between EDGAR feed polls. |
| `MIN_DEAL_VALUE_USD` | No | `1000000000` | Minimum USD value to trigger Discord/email alerts (default $1B). |
| `NOTIFICATION_ALERT_ON_PAYMENT_TYPES` | No | `CASH,STOCK,MIXED` | Comma-separated payment types that trigger alerts. |
| `NOTIFICATION_ALERT_ON_DEAL_CATEGORIES` | No | `TRANSFORMATIVE` | Comma-separated deal size categories that trigger alerts (`TRANSFORMATIVE`, `MATERIAL`). |
| `NOTIFICATION_MUTED_ACQUIRERS` | No | — | Comma-separated acquirer names (case-insensitive) to permanently silence. |
| `NOTIFICATION_COOLDOWN_MINUTES` | No | `60` | Suppress repeat alerts for the same acquirer within this window. |
| `LOG_LEVEL` | No | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`). |
| `NODE_ENV` | No | `development` | `production` switches to JSON log output; `development` uses pino-pretty. |
| `PORT` | No | `3000` | HTTP server port. |
| `HOST` | No | `localhost` | HTTP server bind address. |
| `FRONTEND_ORIGIN` | No | `http://localhost:3000` | CORS allowed origin for Socket.io. |
| `NEXT_PUBLIC_DASHBOARD_URL` | No | `https://your-app.com/dashboard` | Dashboard URL embedded in email alert CTA button. |

---

## Project Structure

```
src/
├── index.ts              # Combined entry point (server + pipeline)
├── server.ts             # Next.js + Socket.io web server
│
│  Phase 1 — Ingest
├── secHttpClient.ts      # Rate-limited (8 req/s), retry-aware HTTP client for SEC
├── secEdgarFeed.ts       # EDGAR Atom feed fetch/parse + SerpAPI news search
├── filingState.ts        # Persistent cursor in data/state.json (atomic writes)
├── filterFilings.ts      # Form-type allow-list + 8-K/A amendment tagging
├── pollingScheduler.ts   # Non-overlapping interval scheduler with onError callback
│
│  Phase 2 — Extract
├── extractionAgent.ts    # classifyFiling (Haiku) + extractEntities (Sonnet) + scoreConfidence
├── dealSummaryPrompt.ts  # generateSummary — one-sentence executive summary (Sonnet)
│
│  Phase 3 — Enrich
├── enrichmentAgent.ts    # Yahoo Finance ticker/market-cap, SHA-256 fingerprint, mergeAmendment
├── calculateDealMetrics.ts  # dealSizeCategory (BOLT_ON / MATERIAL / TRANSFORMATIVE)
│
│  Phase 4 — Distribute
├── distributionAgent.ts  # upsertDeal (PostgreSQL), re-exports for broadcast/alert/email
├── sendDiscordAlert.ts   # Discord embed builder + webhook POST with 429 retry
├── sendEmailAlert.ts     # Resend HTML email template
│
│  Shared utilities
├── pipelineTypes.ts      # PipelineDeal — the canonical deal record type
├── pipelineLogger.ts     # Pino structured logger + typed pipeline-event helpers
├── alertDeduplicator.ts  # Redis-backed (or in-memory) alert deduplication
├── notificationConfig.ts # shouldAlert() threshold gating
├── validateExtractionResult.ts  # Zod schema for LLM extraction output
├── scoreConfidence.ts    # Penalty-based extraction confidence scoring
├── detectPaymentType.ts  # Regex-based CASH/STOCK/MIXED heuristic
├── normalizeTransactionValue.ts # Multi-currency → USD value parser
├── withRetry.ts          # Exponential backoff + Retry-After header support
├── fetchFilingContent.ts # HTTP fetch + charset-aware text decoding
├── extractTextFromFiling.ts  # HTML → plain text (Cheerio DOM walk)
├── edgarDocumentUrl.ts   # EDGAR index page scraper for primary doc URL
└── fetchMarketCaps.ts    # FMP market cap fetcher (legacy; Yahoo preferred)

migrations/
└── 001_create_acquisitions.sql  # PostgreSQL schema + indexes + updated_at trigger
```

---

## Architecture Overview

```
SEC EDGAR Atom Feed (poll every 60s)
        │
        ▼
  Phase 1: Ingest
  filterNewFilings → filterFilingsByFormType
  (cursor-based dedup; 8-K/A tagged isAmendment=true)
        │
        ▼ for each 8-K / 8-K/A
  Phase 2: Extract (LLM)
  classifyFiling (Haiku) → skip if OTHER
  extractEntities (Sonnet + Zod) → EntityExtractionResult
  generateSummary (Sonnet) → ≤30-word sentence
  scoreConfidence → { overall, flags, requiresReview }
        │
        ▼
  Phase 3: Enrich
  resolveTickerYahoo × 2 (acquirer + target)
  fetchMarketCapYahoo × 2 → snapshotAt market caps
  searchDealNews (SerpAPI, optional) → corroborationUrl
  generateDealFingerprint (SHA-256 of normalised key fields)
  calculateDealMetrics → dealSizeCategory
        │
        ▼
  Phase 4: Distribute
  upsertDeal (PostgreSQL ON CONFLICT) → inserted | updated | skipped
  broadcastNewAcquisition (Socket.io) → new_acquisition event
  shouldAlert → sendDiscordAlert / sendEmailAlert (if threshold met)
```
