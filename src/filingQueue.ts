import { EventEmitter } from "events";
import Redis from "ioredis";

// ─── Domain type ─────────────────────────────────────────────────────────────

export interface FilingJob {
  accessionNumber: string;
  companyName: string;
  formType: string;
  filedAt: string;         // ISO 8601
  textContent: string;
  filingUrl: string;
}

// ─── Queue interface ──────────────────────────────────────────────────────────

export interface FilingQueue {
  /** Push one job onto the tail of the queue. */
  enqueue(job: FilingJob): Promise<void>;

  /**
   * Start a long-running consumer loop.
   * Calls handler for each dequeued job sequentially.
   * Resolves only when stop() is called or a fatal error occurs.
   */
  startWorker(handler: (job: FilingJob) => Promise<void>): Promise<void>;

  /** Signal the worker loop to drain and exit cleanly. */
  stop(): void;
}

// ─── 1. In-memory queue (local dev) ──────────────────────────────────────────

const IN_MEMORY_EVENT = "job";

export class InMemoryFilingQueue extends EventEmitter implements FilingQueue {
  private running = false;

  async enqueue(job: FilingJob): Promise<void> {
    // EventEmitter.emit is synchronous — wrap in setImmediate so enqueue
    // always returns before the handler runs, matching async queue semantics.
    setImmediate(() => {
      if (this.running) this.emit(IN_MEMORY_EVENT, job);
    });
  }

  startWorker(handler: (job: FilingJob) => Promise<void>): Promise<void> {
    this.running = true;

    return new Promise((resolve, reject) => {
      this.on(IN_MEMORY_EVENT, async (job: FilingJob) => {
        if (!this.running) return;
        try {
          await handler(job);
        } catch (err) {
          // Emit on "error" so callers can attach an error listener if needed;
          // log and continue so one bad job doesn't kill the worker.
          console.error("[InMemoryFilingQueue] Handler error:", err);
          this.emit("error", err);
        }
      });

      this.once("stop", () => {
        this.running = false;
        this.removeAllListeners(IN_MEMORY_EVENT);
        resolve();
      });

      this.once("fatal", (err: unknown) => {
        this.running = false;
        reject(err);
      });
    });
  }

  stop(): void {
    this.emit("stop");
  }
}

// ─── 2. Redis-backed queue (production) ──────────────────────────────────────

const REDIS_KEY = "filings:phase1";
const BRPOP_TIMEOUT_SECONDS = 5; // block at most 5s per poll iteration

export interface RedisQueueOptions {
  /** ioredis connection URL, e.g. "redis://localhost:6379" */
  url?: string;
  /** Override the list key (useful in tests) */
  queueKey?: string;
  /** Max ms to wait for a Redis op before timing out (default 10_000) */
  commandTimeoutMs?: number;
}

export class RedisFilingQueue implements FilingQueue {
  private readonly producer: Redis;
  private readonly consumer: Redis;
  private readonly key: string;
  private running = false;

  constructor(opts: RedisQueueOptions = {}) {
    const url = opts.url ?? process.env.REDIS_URL ?? "redis://localhost:6379";
    this.key = opts.queueKey ?? REDIS_KEY;
    const commandTimeout = opts.commandTimeoutMs ?? 10_000;

    // Separate connections for producer and consumer: BRPOP blocks the
    // consumer connection, so a single shared client would deadlock enqueue.
    const shared = {
      lazyConnect: true,
      commandTimeout,
      retryStrategy: (times: number) =>
        Math.min(1_000 * 2 ** times, 30_000),
    };

    this.producer = new Redis(url, shared);
    this.consumer = new Redis(url, shared);
  }

  async enqueue(job: FilingJob): Promise<void> {
    const payload = JSON.stringify(job);
    await this.producer.lpush(this.key, payload);
  }

  async startWorker(handler: (job: FilingJob) => Promise<void>): Promise<void> {
    this.running = true;

    await this.consumer.connect();

    while (this.running) {
      // BRPOP blocks until an element is available or the timeout expires.
      // Returns [key, value] or null on timeout.
      let result: [string, string] | null;

      try {
        result = await this.consumer.brpop(this.key, BRPOP_TIMEOUT_SECONDS) as
          | [string, string]
          | null;
      } catch (err) {
        if (!this.running) break; // stop() was called — clean exit
        console.error("[RedisFilingQueue] BRPOP error:", err);
        // Brief pause before retrying to avoid a tight error loop on
        // transient connection issues.
        await sleep(1_000);
        continue;
      }

      if (!result) continue; // timeout — loop and poll again

      const [, raw] = result;
      let job: FilingJob;

      try {
        job = parseJob(raw);
      } catch (err) {
        console.error(
          "[RedisFilingQueue] Failed to parse job payload — discarding:",
          raw,
          err
        );
        continue;
      }

      try {
        await handler(job);
      } catch (err) {
        console.error(
          `[RedisFilingQueue] Handler error for ${job.accessionNumber}:`,
          err
        );
        // Dead-letter the failed job so it isn't silently lost.
        await deadLetter(this.producer, this.key, job, err).catch((dlErr) =>
          console.error("[RedisFilingQueue] Dead-letter write failed:", dlErr)
        );
      }
    }

    await this.consumer.quit();
    await this.producer.quit();
  }

  stop(): void {
    this.running = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJob(raw: string): FilingJob {
  const parsed = JSON.parse(raw) as Partial<FilingJob>;

  if (
    typeof parsed.accessionNumber !== "string" ||
    typeof parsed.companyName !== "string" ||
    typeof parsed.formType !== "string" ||
    typeof parsed.filedAt !== "string" ||
    typeof parsed.textContent !== "string" ||
    typeof parsed.filingUrl !== "string"
  ) {
    throw new TypeError("Payload is missing required FilingJob fields");
  }

  return parsed as FilingJob;
}

async function deadLetter(
  client: Redis,
  sourceKey: string,
  job: FilingJob,
  error: unknown
): Promise<void> {
  const dlKey = `${sourceKey}:dead`;
  const entry = JSON.stringify({
    job,
    error: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString(),
  });
  await client.lpush(dlKey, entry);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
