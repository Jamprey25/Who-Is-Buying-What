import Redis from "ioredis";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface AlertDeduplicatorOptions {
  /** ioredis connection URL (default: REDIS_URL env var or redis://localhost:6379) */
  redisUrl?: string;
  /** How long to suppress repeat alerts for the same acquirer (default: 1 hour) */
  cooldownMs?: number;
  /** How long to remember a sent fingerprint (default: 7 days) */
  fingerprintTtlMs?: number;
}

// ─── In-memory store (fallback when Redis is unavailable) ────────────────────

interface MemoryEntry {
  expiresAt: number; // ms since epoch
}

class InMemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, ttlMs: number): void {
    this.entries.set(key, { expiresAt: Date.now() + ttlMs });
  }
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

const PREFIX_SENT     = "alerts:sent:";
const PREFIX_COOLDOWN = "alerts:cooldown:";

function sentKey(fingerprint: string): string {
  return `${PREFIX_SENT}${fingerprint}`;
}

function cooldownKey(acquirer: string): string {
  return `${PREFIX_COOLDOWN}${acquirer.trim().toLowerCase()}`;
}

// ─── AlertDeduplicator ───────────────────────────────────────────────────────

export class AlertDeduplicator {
  private redis: Redis | null;
  private fallback: InMemoryStore | null = null;
  private readonly cooldownMs: number;
  private readonly fingerprintTtlMs: number;
  // Guards against logging the fallback warning on every failed call.
  private fallbackWarningLogged = false;

  constructor(opts: AlertDeduplicatorOptions = {}) {
    const url =
      opts.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379";

    this.cooldownMs      = opts.cooldownMs      ?? 60 * 60 * 1_000;       // 1 hour
    this.fingerprintTtlMs = opts.fingerprintTtlMs ?? 7 * 24 * 60 * 60 * 1_000; // 7 days

    this.redis = new Redis(url, {
      lazyConnect: true,
      // Mirror the same back-off strategy used in filingQueue.ts.
      retryStrategy: (times: number) => Math.min(1_000 * 2 ** times, 30_000),
    });

    // Capture connection-level errors so Node doesn't crash on unhandled
    // rejection; the per-command try/catch handles the actual fallback switch.
    this.redis.on("error", () => {
      // Intentionally silent here — we log once inside _useFallback().
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns false (suppress) when either:
   *   1. The fingerprint has been marked as sent within its TTL window, OR
   *   2. acquirer is supplied and its per-acquirer cooldown is still active.
   *
   * @param fingerprint  Unique deal identifier (DealRecord.fingerprint)
   * @param acquirer     Optional company name for per-acquirer cooldown
   */
  async shouldSendAlert(
    fingerprint: string,
    acquirer?: string
  ): Promise<boolean> {
    if (this.fallback) {
      return this._memoryShouldSend(fingerprint, acquirer);
    }

    try {
      const keys = acquirer
        ? [sentKey(fingerprint), cooldownKey(acquirer)]
        : [sentKey(fingerprint)];

      // Single round-trip: EXISTS accepts multiple keys and returns a count.
      const redis = this.redis!;
      const hits = await redis.exists(...(keys as [string, ...string[]]));
      return hits === 0;
    } catch (err) {
      this._useFallback(err);
      return this._memoryShouldSend(fingerprint, acquirer);
    }
  }

  /**
   * Records that an alert was sent so future calls to shouldSendAlert() suppress
   * duplicates. Call this AFTER the alert has been successfully dispatched.
   *
   * @param fingerprint  Unique deal identifier (DealRecord.fingerprint)
   * @param acquirer     Optional company name — starts the per-acquirer cooldown
   */
  async markAlertSent(
    fingerprint: string,
    acquirer?: string
  ): Promise<void> {
    if (this.fallback) {
      this._memoryMark(fingerprint, acquirer);
      return;
    }

    try {
      const redis = this.redis!;
      const fingerprintTtlSec = Math.ceil(this.fingerprintTtlMs / 1_000);

      if (acquirer) {
        const cooldownTtlSec = Math.ceil(this.cooldownMs / 1_000);

        // Pipeline both writes in one round-trip.
        await redis
          .pipeline()
          .set(sentKey(fingerprint), "1", "EX", fingerprintTtlSec)
          .set(cooldownKey(acquirer), "1", "EX", cooldownTtlSec)
          .exec();
      } else {
        await redis.set(sentKey(fingerprint), "1", "EX", fingerprintTtlSec);
      }
    } catch (err) {
      this._useFallback(err);
      this._memoryMark(fingerprint, acquirer);
    }
  }

  /** Cleanly close the Redis connection. Safe to call when using fallback. */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {
        // quit() can throw if the connection was never established.
      });
      this.redis = null;
    }
  }

  // ─── Fallback switch ─────────────────────────────────────────────────────────

  private _useFallback(err: unknown): void {
    if (!this.fallbackWarningLogged) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[AlertDeduplicator] Redis unavailable (${message}). ` +
        "Falling back to in-memory deduplication. " +
        "State will not persist across restarts."
      );
      this.fallbackWarningLogged = true;
    }
    this.fallback = this.fallback ?? new InMemoryStore();
  }

  // ─── In-memory implementations ───────────────────────────────────────────────

  private _memoryShouldSend(
    fingerprint: string,
    acquirer?: string
  ): boolean {
    const store = this.fallback!;
    if (store.has(sentKey(fingerprint))) return false;
    if (acquirer && store.has(cooldownKey(acquirer))) return false;
    return true;
  }

  private _memoryMark(fingerprint: string, acquirer?: string): void {
    const store = this.fallback!;
    store.set(sentKey(fingerprint), this.fingerprintTtlMs);
    if (acquirer) {
      store.set(cooldownKey(acquirer), this.cooldownMs);
    }
  }
}
