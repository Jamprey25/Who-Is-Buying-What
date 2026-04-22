import axios from "axios";
import { FilingFetchError } from "./fetchFilingContent";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterMs: 500,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

function exponentialDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterMs: number
): number {
  const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return exp + jitter(jitterMs);
}

// Reads Retry-After header from axios errors and converts to ms.
// Returns null if not present or unparseable.
function retryAfterMs(error: unknown, maxDelayMs: number): number | null {
  if (!axios.isAxiosError(error)) return null;
  const header = error.response?.headers?.["retry-after"];
  if (!header || typeof header !== "string") return null;

  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, maxDelayMs);
  }

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), maxDelayMs));
  }

  return null;
}

export function isRetryableError(error: unknown): boolean {
  // Network-level failures (ECONNRESET, ETIMEDOUT, no response, etc.)
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;

    // No response at all → network error
    if (!status) return true;

    // 429 Too Many Requests, 5xx server errors
    if (status === 429 || (status >= 500 && status <= 599)) return true;

    // 4xx client errors (404, 400, 401, 403) are not retryable —
    // retrying won't change the outcome.
    return false;
  }

  // FilingFetchError wraps HTTP status — apply same rules
  if (error instanceof FilingFetchError) {
    const s = error.statusCode;
    return s === 429 || (s >= 500 && s <= 599);
  }

  // Unknown errors (e.g. JSON parse failure, type errors) are not retryable.
  return false;
}

function defaultOnRetry(
  error: unknown,
  attempt: number,
  delayMs: number
): void {
  const message =
    axios.isAxiosError(error)
      ? `HTTP ${error.response?.status ?? "no response"}: ${error.message}`
      : error instanceof Error
      ? error.message
      : String(error);

  console.warn(
    `[withRetry] Attempt ${attempt} failed (${message}). Retrying in ${delayMs}ms…`
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitterMs = options.jitterMs ?? DEFAULTS.jitterMs;
  const shouldRetry = options.shouldRetry ?? isRetryableError;
  const onRetry = options.onRetry ?? defaultOnRetry;

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      const canRetry = attempt < maxRetries && shouldRetry(error, attempt);

      if (!canRetry) throw error;

      // Honour server's Retry-After directive if present, otherwise use
      // exponential backoff with jitter.
      const delayMs =
        retryAfterMs(error, maxDelayMs) ??
        exponentialDelay(attempt, baseDelayMs, maxDelayMs, jitterMs);

      onRetry(error, attempt + 1, delayMs);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
