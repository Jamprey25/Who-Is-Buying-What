# TECHNICAL_INTERNAL.md — Who Is Buying What

> Engineering-focused deep-dive. Updated on every substantive logic change.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Layout](#2-repository-layout)
3. [Architecture & Data Flow](#3-architecture--data-flow)
4. [Module Reference](#4-module-reference)
   - [secHttpClient.ts](#41-sechttpclientts)
   - [secEdgarFeed.ts](#42-secedgarfeedts)
   - [filingState.ts](#43-filingstaters)
   - [filterFilings.ts](#44-filterfilingsts)
   - [pollingScheduler.ts](#45-pollingschedulerts)
5. [State Management](#5-state-management)
6. [Rate-Limit & Retry Strategy](#6-rate-limit--retry-strategy)
7. [News Relevance Scoring](#7-news-relevance-scoring)
8. [Configuration & Environment Variables](#8-configuration--environment-variables)
9. [Developer Tooling — Auto-Commit Daemon](#9-developer-tooling--auto-commit-daemon)
10. [Known Edge Cases & Gotchas](#10-known-edge-cases--gotchas)
    - [Frontend Hydration Contract](#10a-frontend-hydration-contract-nextjs-app-router)
    - [Dashboard UI](#10b-dashboard-ui-app--dealfeed)
11. [Dependency Rationale](#11-dependency-rationale)
12. [Pedagogical Notes](#12-pedagogical-notes)

---

## 1. Project Overview

**Who Is Buying What** is a real-time M&A intelligence pipeline. It polls the SEC EDGAR Atom feed for the latest Form 8-K (material events) and Form 4 (insider transactions) filings, deduplicates results against a persistent on-disk cursor, optionally enriches matches with news from SerpApi, and exposes typed TypeScript interfaces for a downstream dashboard or API layer to consume.

The system is intentionally stateless at the HTTP layer (no server process) and stateful only through a JSON cursor file (`data/state.json`).

---

## 2. Repository Layout

```
/
├── src/
│   ├── secHttpClient.ts      # Rate-limited, retry-aware HTTP layer for SEC
│   ├── secEdgarFeed.ts       # Atom feed fetch + parse + news enrichment
│   ├── filingState.ts        # Persistent cursor (last-seen accession number)
│   ├── filterFilings.ts      # Form-type allow-list filter
│   └── pollingScheduler.ts   # Generic non-overlapping interval scheduler
├── scripts/
│   └── auto-commit.sh        # Background auto-commit daemon (dev tooling)
├── docs/
│   └── TECHNICAL_INTERNAL.md # This file
├── .gitignore
├── package.json
└── README.md
```

`data/state.json` is created at runtime; it is not committed.

---

## 3. Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  pollingScheduler.ts                                                │
│  createPollingScheduler(pollFn, { intervalMs })                     │
│         │  fires every N ms (default 60s)                           │
│         │  skips tick if previous run still in-flight               │
│         ▼                                                           │
│  secEdgarFeed.ts  ──── fetchCurrent8kFilings()                      │
│         │  axios GET → SEC EDGAR Atom XML                           │
│         │  xml2js parse → []RSSEntry                                │
│         │  map → []EdgarFiling  (accessionNumber, cik, formType…)   │
│         ▼                                                           │
│  filterFilings.ts ──── filterFilingsByFormType(filings, allowlist)  │
│         │  normalises form types, keeps 8-K and Form 4 by default   │
│         ▼                                                           │
│  filingState.ts   ──── filterNewFilings(filings)                    │
│         │  reads data/state.json → lastSeenId                       │
│         │  slices array to filings newer than cursor                │
│         ▼                                                           │
│  (caller iterates new filings)                                      │
│         │                                                           │
│         ├──► secEdgarFeed.ts ─ searchDealNews(acquirer, target)     │
│         │       SerpApi Google News search, 7-day window            │
│         │       scoreNewsRelevance() → float [0, 1]                 │
│         │                                                           │
│         └──► filingState.ts ─ setLastSeenId(accessionNumber)        │
│                 writes data/state.json                              │
└─────────────────────────────────────────────────────────────────────┘
```

All external HTTP goes through `secHttpClient.get()`, which enforces
SEC EDGAR's published rate limit (≤ 10 req/s; the module caps at 8 for safety)
and retries transiently on 429/503.

---

## 4. Module Reference

### 4.1 `secHttpClient.ts`

**Purpose:** Single-entry-point HTTP client for all SEC EDGAR requests, enforcing rate limits and exponential-backoff retries.

**Public API:**

```ts
get<T = unknown>(url: string): Promise<T>
```

**Internals:**

| Symbol | Type | Role |
|--------|------|------|
| `requestQueue` | `QueuedRequest<unknown>[]` | In-memory FIFO queue of pending requests |
| `requestTimestamps` | `number[]` | Sliding 1-second window of completed requests |
| `drainTimer` | `NodeJS.Timeout \| null` | Single scheduled drain callback |
| `enqueueGet(url)` | `Promise<AxiosResponse<T>>` | Pushes a request onto the queue and kicks the drain |
| `drainQueue()` | `void` | Dequeues up to `MAX_REQUESTS_PER_SECOND` (8) entries per 1s window |
| `scheduleDrain()` | `void` | Schedules `drainQueue` immediately or after window resets |

**Retry logic:**

```
attempt 0..MAX_RETRIES (5):
  enqueueGet → Axios GET
  on 429 / 503:
    delay = Retry-After header (seconds or HTTP-date) ?? exponential(1s * 2^attempt, cap 30s)
    sleep(delay)
    attempt++
  on any other error → throw immediately
```

**Rate-limit enforcement mechanism:**

`requestTimestamps` stores the millisecond timestamps of each dispatched request. Before dequeuing, `pruneTimestamps` removes entries older than 1 000 ms. If `requestTimestamps.length >= MAX_REQUESTS_PER_SECOND`, `scheduleDrain` calculates the exact wait until the oldest entry expires and defers via `setTimeout`.

---

### 4.2 `secEdgarFeed.ts`

**Purpose:** Fetches the SEC EDGAR 8-K Atom feed, parses it into typed `EdgarFiling` objects, and optionally enriches them with news signals.

**Public exports:**

| Export | Signature | Notes |
|--------|-----------|-------|
| `fetchCurrent8kFilings` | `(url?) → Promise<EdgarFiling[]>` | Fetches up to 40 most-recent filings |
| `searchDealNews` | `(acquirer, target, filedAt) → Promise<NewsResult[]>` | Requires `SERPAPI_KEY`; silently returns `[]` if absent |
| `scoreNewsRelevance` | `(result, extraction, filedAt) → number` | Pure scoring function, returns `[0, 1]` |
| `extractFormType` | `(entry: RSSEntry) → string` | Exported for unit-testability |

**`fetchCurrent8kFilings` flow:**

1. `axios.get` with `Accept: application/atom+xml`, 15 s timeout, SEC-compliant `User-Agent`.
2. `xml2js.parseStringPromise` with `explicitArray: true` — all tag values become arrays; callers use the `text()` helper to safely unwrap `value?.[0]`.
3. Map each `RSSEntry` via five private extractors:
   - `extractFilingUrl` — prefers `rel="alternate"` link.
   - `extractAccessionNumber` — tries URL param → `entry.id` → summary fallback.
   - `extractCik` — tries URL param → parenthetical in title → summary fallback.
   - `extractFormType` — tries Atom `<category term>` → first uppercase token in title.
   - `extractCompanyName` — strips form-type prefix and CIK suffix from `<title>`.

**`scoreNewsRelevance` scoring breakdown:**

| Signal | Weight | Condition |
|--------|--------|-----------|
| Acquirer name in news title | +0.30 | Case-insensitive substring match |
| Target name in news title | +0.30 | Case-insensitive substring match |
| Publication within 1 day of filing | +0.20 | `|publishedAt − filedAt| ≤ 1d` |
| Publication within 3 days | +0.10 | `≤ 3d` |
| Publication within 7 days | +0.05 | `≤ 7d` |
| Trusted source (Reuters, Bloomberg, WSJ, PR Newswire) | +0.20 | Source field substring |
| Both slugs appear in URL | +0.10 | `url.includes(acquirerSlug) && url.includes(targetSlug)` |

Maximum possible raw score: 1.10. Clamped to `1.0` via `Math.min(1, score)`.

---

### 4.3 `filingState.ts`

**Purpose:** Maintains a persistent cursor — the `accessionNumber` of the most recently processed filing — so repeated polls never reprocess old data.

**Public API:**

| Export | Signature | Side Effects |
|--------|-----------|--------------|
| `getLastSeenId` | `() → string \| null` | Reads `data/state.json` |
| `setLastSeenId` | `(id: string) → void` | Writes `data/state.json`; throws on failure |
| `filterNewFilings` | `<T extends Filing>(filings: T[]) → T[]` | Pure filter driven by `getLastSeenId`; **generic** preserves caller's concrete type (e.g. `EdgarFiling`). |
| `Filing` | interface | `{ accessionNumber: string }` — minimum structural contract |

**Type Preservation (generic signature):** `filterNewFilings` is parameterised over `T extends Filing` so that passing in `EdgarFiling[]` returns `EdgarFiling[]`, not the narrower `Filing[]`. Before this change, downstream consumers like `filterFilingsByFormType` (which requires `formType`, `cik`, `filingUrl`, etc.) received type-erased values and failed to compile. The generic expresses exactly what the function needs (`accessionNumber` for cursor comparison) and preserves everything else the caller knows — the identity-preserving-generic pattern used by `Array.prototype.filter`.

**`filterNewFilings` algorithm:**

```
filings array (newest first, as returned by EDGAR)
    │
    ├─ if lastSeenId is null → return all filings (first run)
    │
    ├─ findIndex where accessionNumber === lastSeenId
    │
    ├─ if not found → return all (cursor window has expired; EDGAR only keeps 40)
    │
    └─ return filings.slice(0, lastSeenIndex)   // everything before the cursor
```

**State file schema (`data/state.json`):**

```json
{
  "lastSeenId": "0001234567-26-000123"
}
```

Reads are fully fault-tolerant: `ENOENT`, `SyntaxError`, invalid shape, and permission errors all fall through to `{ lastSeenId: null }` with a console warning rather than crashing.

---

### 4.4 `filterFilings.ts`

**Purpose:** Filters a raw filing list to only the form types the pipeline cares about. Default allowlist: `["8-K", "4"]`.

**Public API:**

```ts
filterFilingsByFormType(filings: Filing[], allowlist?: string[]): Filing[]
```

Normalization strips leading whitespace, uppercases, and removes a leading `FORM ` prefix — so `"form 8-k"`, `"8-K"`, and `" FORM 8-K "` all resolve to `"8-K"`.

The function logs a breakdown count (`8-K: N, Form 4: N`) to stdout on every call.

---

### 4.5 `pollingScheduler.ts`

**Purpose:** Generic non-overlapping interval scheduler. Ensures that if a `pollFn` takes longer than `intervalMs`, subsequent ticks are skipped rather than stacked.

**Public API:**

```ts
createPollingScheduler(pollFn: PollFn, options?: PollingSchedulerOptions): PollingScheduler
// returns { start(), stop() }
```

**Concurrency guard:**

```ts
if (isRunning) { log("Skipping poll: previous run still in progress."); return; }
isRunning = true;
try { await pollFn(); }
finally { isRunning = false; }
```

`isRunning` is a boolean closure variable. Because Node.js runs on a single-threaded event loop, this guard is safe without a mutex — no two microtask continuations can see `isRunning === false` simultaneously.

**Lifecycle:**

- `start()` fires `pollFn` immediately, then on every `intervalMs`.
- Calling `start()` again while running is a no-op.
- `stop()` calls `clearInterval` and logs; subsequent `start()` works normally.

---

## 5. State Management

The system has exactly one piece of mutable shared state:

| State | Location | Encoding | Lifecycle |
|-------|----------|----------|-----------|
| `lastSeenId` | `data/state.json` | UTF-8 JSON | Created on first `setLastSeenId` call; survives process restarts |

Everything else is ephemeral in-memory:

| State | Module | Notes |
|-------|--------|-------|
| `requestQueue` | `secHttpClient` | Module-level singleton; reset on process restart |
| `requestTimestamps` | `secHttpClient` | Sliding window; reset on restart |
| `isRunning` | `pollingScheduler` | Per-scheduler closure; reset on restart |

There is no database, no in-memory cache, and no shared mutable state across modules beyond the module-level `secHttpClient` queue.

---

## 6. Rate-Limit & Retry Strategy

SEC EDGAR publicly requires all automated clients to stay under **10 requests per second** and include a valid `User-Agent` with a contact email.

**Implementation approach — token-bucket-lite:**

Rather than a strict token-bucket (which requires a counter and a clock-tick refill), this implementation uses a sliding-window approach:

```
requestTimestamps = [t₁, t₂, ..., tₙ]   (timestamps of dispatched requests)

Before dispatching request:
  prune timestamps where now − tᵢ ≥ 1000 ms
  if |timestamps| < 8: dispatch immediately
  else: schedule drain after (1000 − (now − oldest_timestamp)) ms
```

This guarantees at most 8 requests are in-flight within any 1 000 ms window.

**Exponential backoff constants:**

| Constant | Value |
|----------|-------|
| `RETRY_BASE_DELAY_MS` | 1 000 ms |
| `RETRY_MAX_DELAY_MS` | 30 000 ms |
| `MAX_RETRIES` | 5 |

Delay formula: `min(1000 * 2^attempt, 30000)` — gives delays of 1s, 2s, 4s, 8s, 16s before the 5th and final attempt.

If the server provides a `Retry-After` header (seconds or HTTP-date), that value takes priority over exponential backoff, capped at `RETRY_MAX_DELAY_MS`.

---

## 7. News Relevance Scoring

`scoreNewsRelevance` is a linear additive scoring function, not a trained model. Weights are heuristic and should be tuned once ground-truth data is available.

**Inputs:**
- `result: NewsResult` — a news article (title, url, source, publishedAt)
- `extraction: ExtractionResult` — LLM-extracted `{ acquirer, target }` from the 8-K
- `filedAt: Date` — the SEC filing timestamp

**Slug generation** (`toSlug`): lowercases, replaces non-alphanumeric runs with `-`, trims leading/trailing dashes. This creates URL-comparable slugs for the URL-match bonus.

**Relative date parsing** (`parsePublishedAt`): SerpApi sometimes returns relative timestamps like `"3 hours ago"` instead of ISO dates. A regex extracts the number and unit, which are mapped to milliseconds and subtracted from `Date.now()`. Approximate units: month = 30 days, year = 365 days.

---

## 8. Configuration & Environment Variables

| Variable | Module | Required | Default | Purpose |
|----------|--------|----------|---------|---------|
| `SERPAPI_KEY` | `secEdgarFeed.ts` | No | — | SerpApi API key for news enrichment; feature disabled if absent |
| `SEC_CONTACT_EMAIL` | `secHttpClient.ts` | No | `sec-compliance@example.com` | Injected into `User-Agent`; validated against basic email regex |

No `.env` file is committed. Both variables are read from `process.env` at module load time.

---

## 9. Developer Tooling — Auto-Commit Daemon

`scripts/auto-commit.sh` is a background Bash daemon that periodically stages and commits all working-tree changes when a "big change" threshold is crossed.

**Threshold logic:**

```
changed_files  = git status --porcelain | line count
change_score   = (added + deleted lines from tracked files) + (untracked_file_count × 20)

commit if:  changed_files >= MIN_CHANGED_FILES (default 2)
         OR change_score  >= MIN_CHANGE_SCORE  (default 40)
```

**Tunable environment variables:**

| Variable | Default | Effect |
|----------|---------|--------|
| `AUTO_COMMIT_INTERVAL_SECONDS` | `20` | Poll frequency |
| `AUTO_COMMIT_MIN_CHANGED_FILES` | `2` | File count threshold |
| `AUTO_COMMIT_MIN_CHANGE_SCORE` | `40` | Line-delta + untracked score threshold |

**Process management:**

PID is written to `.git/auto-commit.pid`. A `trap EXIT` removes the PID file when the process exits cleanly. `is_running()` checks the PID file + `kill -0` to distinguish a live process from a stale file.

**npm shortcuts:**

```bash
npm run auto-commit:start
npm run auto-commit:stop
npm run auto-commit:status
```

---

## 4b. New Modules — Phases 2–4

### 4b.1 `extractionAgent.ts` (Phase 2)

| Export | Model | Description |
|--------|-------|-------------|
| `classifyFiling(text)` | `claude-haiku-4-5-20251001` | Returns `{ classification, confidence, reasoning }`. Falls back to `OTHER` on any API or Zod validation failure — never throws. |
| `extractEntities(text)` | `claude-sonnet-4-6` | Returns `EntityExtractionResult` validated with Zod. Throws on validation failure (caller decides whether to skip or retry). |
| `generateSummary` | `claude-sonnet-4-20250514` | Re-export from `dealSummaryPrompt.ts`. Returns ≤30-word sentence; falls back to a template string on API failure. |
| `scoreConfidence(extraction, classification)` | — | Adapts `FilingClassificationResult` → `ClassificationResult` and delegates to `scoreConfidence.ts`. Returns `{ overall, flags, requiresReview }`. |

**Prompt engineering notes:**
- Classification uses a `system` prompt with explicit category definitions and a strict JSON-only output constraint. Claude Haiku is chosen for cost/speed: the classification decision is binary and doesn't require the deeper reasoning of Sonnet.
- Entity extraction uses a `system` prompt that forbids invented data and requires `null` for unknowns. All LLM output is passed through `z.safeParse` before any field is read — raw Claude output is never trusted structurally.
- `MAX_TEXT_CHARS = 48_000` (≈ 12k tokens) prevents exceeding context windows while covering the typical 8-K body.

### 4b.2 `enrichmentAgent.ts` (Phase 3)

| Export | Description |
|--------|-------------|
| `resolveTickerYahoo(name)` | Hits `query2.finance.yahoo.com/v1/finance/search`. Prefers `quoteType === "EQUITY"` quotes. Never throws; returns `null` on error. |
| `fetchMarketCapYahoo(symbol)` | Hits `query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}?modules=summaryDetail`. Returns `{ marketCap, price, snapshotAt }`. Never throws; `marketCap` and `price` are `null` on error. |
| `generateDealFingerprint(input)` | SHA-256 of `normalised(acquirer) \| normalised(target) \| valueBucket \| year`. Value bucketing prevents minor revisions ($4.1B → $4.2B) from creating duplicate records. |
| `mergeAmendment(original, amendment)` | Folds non-null amendment fields into the original. Increments `amendmentCount`; sets `amendedAt` to the amendment's `announcedAt`. Never overwrites `id`, `fingerprint`, or original `announcedAt`. |
| `searchDealNews` | Re-export from `secEdgarFeed.ts`. |

**Why Yahoo Finance instead of FMP?**
Yahoo's unofficial search and quoteSummary endpoints are free and don't require an API key. They are undocumented but stable enough for best-effort enrichment. The entire lookup is wrapped in `try/catch` and yields `null` on failure — a missing ticker never blocks the pipeline.

**Fingerprint design:**
The hash intentionally uses a value *bucket* (not the exact value) and company name *normalisation* (strips legal suffixes like "Inc", "Corp"). This means:
- A $4.1B deal later revised to $4.2B → same fingerprint → UPDATE, not INSERT
- "Apple Inc." and "Apple" → same fingerprint
- Two unrelated $500M deals by the same acquirer in the same year → same bucket → this is a known false-collision risk mitigated by including the target name in the hash

### 4b.3 `distributionAgent.ts` (Phase 4)

| Export | Description |
|--------|-------------|
| `upsertDeal(deal)` | Two-query PostgreSQL upsert: SELECT → decide → INSERT or UPDATE. Returns `inserted \| updated \| skipped`. |
| `broadcastNewAcquisition` | Re-export from `server.ts`. Emits `new_acquisition` to all clients; additionally emits to `billion_dollar_club` room if `transactionValueUSD > $1B`. |
| `shouldAlert / recordAlert` | Re-export from `notificationConfig.ts`. Threshold gating + per-acquirer cooldown. |
| `sendDiscordAlert` | Re-export from `sendDiscordAlert.ts`. Colour-coded embed (green=CASH, blue=STOCK, purple=MIXED). Handles 429 with `withRetry`. |
| `sendEmailAlert` | Re-export from `sendEmailAlert.ts`. Resend SDK, HTML table layout. |

**Upsert decision matrix:**
```
fingerprint not in DB  → INSERT  → "inserted"
fingerprint in DB AND incoming confidence > stored
                       → UPDATE  → "updated"
fingerprint in DB AND incoming amendment_count > stored
                       → UPDATE  → "updated"
fingerprint in DB AND neither condition met
                       → no write → "skipped"
```
The two-query approach (not a single `ON CONFLICT ... WHERE`) gives explicit control over the skip decision and enables detailed logging of why a record was skipped.

**PostgreSQL pool:**
A `pg.Pool` singleton is lazily created on first call to `upsertDeal`. Pool size is capped at 5 connections — the pipeline is single-process and single-goroutine, so 5 is generous. The pool emits `error` events for idle client failures; these are logged but do not crash the process.

### 4b.4 `pipelineTypes.ts`

`PipelineDeal` extends `DealRecord` (from `secEdgarFeed.ts`) and promotes the optional `paymentType` and `dealSizeCategory` fields to required. This makes `PipelineDeal` a structural supertype of `DealRecord`, so it can be passed directly to all existing helpers (`shouldAlert`, `sendDiscordAlert`, `sendEmailAlert`, `broadcastNewAcquisition`) without any adapter.

### 4b.5 `src/index.ts`

The main pipeline entry point. When executed directly (`tsx src/index.ts`), it imports `server.ts` (which starts the Next.js + Socket.io server as a side effect) and waits 5 seconds before starting the polling scheduler (to let the HTTP server finish binding). When imported as a module, it exports `startPipeline()` and `stopPipeline()` for programmatic control.

---

## 10. Known Edge Cases & Gotchas

| # | Location | Scenario | Current Behaviour |
|---|----------|----------|-------------------|
| 1 | `filterNewFilings` | EDGAR's feed only returns the 40 most-recent filings. If `lastSeenId` is older than 40 filings, the cursor is never found — all 40 are reprocessed. | All 40 returned as "new". Consider adding a timestamp guard. |
| 2 | `secHttpClient` | `requestQueue` and `requestTimestamps` are module-level singletons. If `secHttpClient` is used from multiple independent polling loops, they share one rate-limit budget. | Correct behaviour (budget is global to the process), but surprising in tests. |
| 3 | `extractFormType` | If the Atom `<category>` element is absent and the `<title>` starts with a number (e.g., `"4 - Company Name (0001234)"`), the regex `\b([A-Z0-9]+...)\b` matches digits only — returning `"4"` correctly, but any title starting with a lowercase word returns `"UNKNOWN"`. | Acceptable; allowlist filtering downstream discards `UNKNOWN`. |
| 4 | `parsePublishedAt` | Month and year approximations (30d / 365d) will be wrong at boundaries. A news article "published 1 month ago" near a month boundary could be off by ±1–2 days. | Low impact: the 7-day news window means month/year articles are already excluded. |
| 5 | `pollingScheduler` | `start()` fires `pollFn` immediately and synchronously on the event loop. If `pollFn` is very fast and `stop()` is called between the immediate run and the first `setInterval` tick, the timer is still cleared correctly. | Safe; `timer` is null-guarded in `stop()`. |
| 6 | `setLastSeenId` | ~~Writes are not atomic~~ **Fixed**: uses `writeFileSync` to a `.tmp` file followed by `renameSync`. `renameSync` is atomic at the OS level on Linux/macOS (POSIX `rename(2)` is guaranteed atomic within the same filesystem). | State file is now crash-safe. |
| 7 | `classifyFiling` | Falls back to `{ classification: "OTHER", confidence: 0 }` on any Anthropic API error or Zod validation failure. This means a transient API outage causes all filings in that poll cycle to be silently classified as OTHER and skipped. | Acceptable for now; consider a retry queue for classification failures. |
| 8 | `generateDealFingerprint` | If the acquirer and target names are very short after normalisation (e.g., both are single-word acronyms with the same value bucket and year), hash collisions between unrelated deals become more likely. This is bounded: SHA-256 has 2^256 possible values; a collision between two real deals is astronomically unlikely. The concern is normalisation collisions (two companies that normalize to the same string). | Monitored by `logFingerprintCollision` in `pipelineLogger.ts`. |
| 9 | `resolveTickerYahoo` | Yahoo Finance's unofficial API has no documented rate limit, uptime SLA, or versioning contract. It can return 429 or change response shape without notice. | Both lookup functions are wrapped in `try/catch` and return `null` on failure — a missing ticker never blocks the pipeline. |
| 10 | `upsertDeal` | The two-query SELECT → INSERT/UPDATE has a TOCTOU race: if two pipeline instances run concurrently and both see "no existing row", both will attempt INSERT and one will get a `23505` (unique violation). | The `catch` block on `insertDeal` checks for error code `23505` and retries as an UPDATE. Safe for the current single-process architecture; a distributed lock would be needed if running multiple instances. |
| 11 | `extractTextFromFiling` | Cheerio v1.x removed `decodeEntities` from `CheerioOptions` (entities are always decoded) and stopped re-exporting DOM node types under the `cheerio` namespace. | Option omitted; DOM types (`Document`, `Element`, `Text`, `AnyNode`) imported directly from `domhandler` — the underlying parser library cheerio wraps. |
| 12 | `fetchFilingContent` | `response.headers[name]` from Axios is typed `string \| number \| boolean \| string[] \| AxiosHeaders \| null`, not just `string \| null`. A naive assignment to `string \| null` fails the type checker. | Narrowed via `typeof === "string"` guard before use. Non-string header values fall through to the `charset` default. |
| 13 | `app/layout.tsx` (frontend) | Browser extensions (Grammarly, LastPass, ColorZilla, …) inject DOM attributes onto `<body>` between HTML parse and React hydration. React sees a server/client mismatch on `<body>` and warns. | `<body suppressHydrationWarning>` in the root layout. Suppression is **shallow** — only the `<body>` element's own attributes are excluded; all children are hydration-validated normally. |

---

## 10a. Frontend Hydration Contract (Next.js App Router)

The Next.js 16 frontend in `app/` is rendered on the server (RSC + SSR) and hydrated on the client. The hydration pass walks the server-rendered HTML in lock-step with the live browser DOM and attaches React state/handlers at each node. When the two trees disagree on attributes, text, or structure, React emits a hydration warning and (in React 19) falls back to client-rendering the affected subtree.

**Legitimate-but-harmless mismatches we tolerate:**

| Source | Element Affected | Mitigation |
|--------|------------------|------------|
| Grammarly / browser extensions | `<body>` (adds `data-gr-*`, `data-new-gr-c-s-check-loaded`) | `suppressHydrationWarning` on `<body>` in `app/layout.tsx` |

**Anti-patterns we forbid (all produce unpatchable mismatches):**

- `typeof window !== "undefined"` branching inside a component body.
- `Date.now()`, `Math.random()`, `new Date().toLocaleString()` in render.
- Reading `localStorage` / `sessionStorage` during initial render.

If runtime-varying data is genuinely required, defer it to a `useEffect` after mount (accepting the cost of client-only content) rather than sprinkling `suppressHydrationWarning` across the tree — the flag is a last resort, not a workaround.

---

## 11. Dependency Rationale

| Package | Why Chosen | Alternatives Considered |
|---------|-----------|------------------------|
| `axios` | Mature, typed, supports `responseType`, `validateStatus`, timeout, and Axios-specific error detection (`isAxiosError`). Used for both SEC and SerpApi calls. | `node-fetch` / native `fetch` — less ergonomic error inspection; `got` — extra dependency with similar surface area. |
| `xml2js` | Parses SEC EDGAR Atom XML into a typed JS object tree with minimal config (`explicitArray: true` gives predictable array shapes). | `fast-xml-parser` — faster but less battle-tested for Atom feeds; `cheerio` — HTML-focused. |
| `@types/xml2js` | Provides TypeScript types for the `xml2js` API since the package ships no native types. | — |
| `@types/node` | Provides Node.js built-in types (`fs`, `path`, `NodeJS.ErrnoException`, `NodeJS.Timeout`). | — |

No runtime framework (Express, Fastify, etc.) is included because the current codebase is a library/pipeline layer, not a server.

---

## 12. Pedagogical Notes

### Rate Limiting as a Sliding Window

The `secHttpClient` implements a **sliding window counter** — one of the two classical rate-limiting algorithms (the other being the token bucket). Key CS insight: maintaining a list of event timestamps and pruning entries older than the window gives you an O(1)-amortised check with a small constant-size array (at most `MAX_REQUESTS_PER_SECOND` entries).

A token bucket refills at a fixed rate and allows short bursts up to capacity; the sliding window is stricter — it measures actual event density over a rolling interval. The SEC rate limit is a strict per-second cap, so the sliding window is the correct choice here.

### Non-Overlapping Polling with a Boolean Semaphore

`pollingScheduler` uses `isRunning` as a **binary semaphore**. In multi-threaded systems you'd need a mutex or atomic compare-and-swap to set this safely. In Node.js, the single-threaded event loop guarantees that no two callbacks execute concurrently — so a plain boolean is a valid, race-condition-free semaphore. This is a direct consequence of Node.js's cooperative (non-preemptive) concurrency model.

### Cursor-Based Deduplication

`filingState.ts` implements **cursor-based pagination** — a pattern used in large databases and data streams (e.g., Kafka consumer offsets, Postgres keyset pagination) to track progress without storing the full processed set. The cursor (the last accession number) is a monotonic identifier; slicing the array up to the cursor index runs in O(n) with zero memory overhead beyond the result slice.

### Additive Scoring Heuristics

`scoreNewsRelevance` is a hand-weighted linear classifier — not a trained model. This is a deliberate engineering tradeoff: interpretable, zero-latency, no training data required. The practical downside is that weights are fixed and may not generalize well. A future improvement could replace this with a logistic regression or lightweight embedding similarity once labelled ground-truth data is collected.

### LLM Output as an Untrusted Data Source

`extractEntities` treats every Claude response as **untrusted user input**. This is the same mental model you'd apply to SQL injection prevention: never assume the shape or content of the response. The Zod `safeParse` call is the type boundary — only validated data crosses it. If validation fails, the pipeline discards the filing rather than propagating malformed data downstream.

**Big-O for the extraction pipeline:**
- `classifyFiling`: O(n) network I/O where n = text length (dominated by HTTP roundtrip, not parsing). The Zod validation of a 3-field JSON object is O(1).
- `extractEntities`: Same asymptotic profile. The JSON parse itself is O(k) where k = response JSON length (always bounded by `max_tokens = 512`).

### SHA-256 Fingerprinting as a Bloom Filter Substitute

`generateDealFingerprint` uses a **cryptographic hash** (SHA-256) rather than a probabilistic Bloom filter. The trade-off: SHA-256 gives a 0% false-positive rate at the cost of O(n) storage in the DB (one row per unique fingerprint vs. a fixed-size Bloom filter). For the expected volume (hundreds of acquisitions per year, not millions), a unique index in PostgreSQL is strictly better — it's exact, inspectable, and supports `ON CONFLICT` upsert semantics natively.

### Structural Subtyping and the PipelineDeal Contract

`PipelineDeal extends DealRecord` is an example of **structural subtyping** (TypeScript's core type system). Because `PipelineDeal` has every field `DealRecord` has (plus more), any function that accepts `DealRecord` will also accept `PipelineDeal` without a cast. This is the Liskov Substitution Principle (LSP) applied at the type level: the subtype can appear wherever the supertype is expected without breaking callers.

### Identity-Preserving Generics (Type Preservation)

The signature `filterNewFilings<T extends Filing>(filings: T[]): T[]` demonstrates a subtle but powerful pattern: **identity-preserving generics**. Without the type parameter, returning `Filing[]` would force TypeScript to **widen** (erase) the caller's more specific type — dropping fields like `formType` and `cik` that `EdgarFiling` carries but base `Filing` does not.

This is exactly how `Array.prototype.filter<T>(...)` and `Array.prototype.map` can preserve concrete types across transformations. The constraint `extends Filing` captures the function's *structural contract* (the only field it needs is `accessionNumber`), while the type parameter `T` promises to return whatever shape came in — the opposite of type erasure.

**Mental model:** think of `T` as a *label* attached to the input that rides through the function body and re-emerges on the output. Without the label, TypeScript only knows "some Filing"; with it, TypeScript can prove "the same subtype of Filing you gave me." Contrast this with an untyped `any` escape hatch, which destroys information irrecoverably.

### Hydration as a Two-Tree Diff

React SSR hydration is conceptually a **two-tree reconciliation**: the server ships a string of HTML that the browser parses into a DOM tree, and React's client bundle walks its own virtual DOM alongside that live DOM, attaching listeners and state at each node. For the attach to be safe, the two trees must agree structurally and on meaningful attributes.

Three classes of mismatch exist:
1. **Deterministic server-client divergence** (e.g., `typeof window` branching) — always a bug; fix the code.
2. **Non-deterministic render output** (e.g., `Math.random()`, timestamps) — always a bug; defer to `useEffect`.
3. **External DOM mutation between parse and hydrate** (e.g., browser extensions) — *not* a bug in your code; this is the only case `suppressHydrationWarning` legitimately silences.

The React team deliberately made `suppressHydrationWarning` **shallow** (one-element deep) and **attribute-level only** — not a recursive opt-out — precisely so it can't mask bugs of type (1) and (2) inside your own components. Use it as an acknowledgement of external reality, never as a convenience.

**Big-O for hydration:** the diff is O(n) in the size of the rendered DOM tree. A hydration mismatch on `<body>` with `suppressHydrationWarning` costs one skipped attribute comparison — measurable only in microbenchmarks.

### Narrowing Library Types with Guards

Fix #2 (the Axios `content-type` header) is a lesson in **type narrowing via runtime guards**. Axios correctly types `response.headers[name]` as a broad union because HTTP headers can legally be repeated (`string[]`), have numeric defaults, or be normalised by Axios's own `AxiosHeaders` class. Casting to `string | null` is a lie; the `typeof === "string"` guard lets TypeScript's flow analysis narrow the type safely.

This is the same principle behind `if (value instanceof Error)`, `Array.isArray(x)`, and Zod's `safeParse` — three different syntaxes for the same idea: **use runtime evidence to shrink a type**. Never reach for `as` to paper over a union.

**Challenge:** Add a `dealPremiumPct` field to `PipelineDeal` that computes `(transactionValueUSD - targetMarketCap) / targetMarketCap * 100`. What should it be when either input is `null`? How would you propagate this to the Discord embed?
