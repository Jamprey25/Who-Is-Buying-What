import axios, { AxiosError, AxiosResponse } from "axios";

const MAX_REQUESTS_PER_SECOND = 8;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const MAX_RETRIES = 5;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_CONTACT_EMAIL = "sec-compliance@example.com";
const CONTACT_EMAIL = resolveContactEmail();
const USER_AGENT = `who-is-buying-what/1.0 (${CONTACT_EMAIL})`;

interface QueuedRequest<T> {
  url: string;
  resolve: (response: AxiosResponse<T>) => void;
  reject: (error: unknown) => void;
}

const requestTimestamps: number[] = [];
const requestQueue: QueuedRequest<unknown>[] = [];
let drainTimer: NodeJS.Timeout | null = null;

function resolveContactEmail(): string {
  const configuredEmail = process.env.SEC_CONTACT_EMAIL?.trim();
  if (configuredEmail && EMAIL_PATTERN.test(configuredEmail)) {
    return configuredEmail;
  }

  return DEFAULT_CONTACT_EMAIL;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneTimestamps(now: number): void {
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] >= 1_000) {
    requestTimestamps.shift();
  }
}

function parseRetryAfterMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, RETRY_MAX_DELAY_MS);
  }

  const retryDateMs = Date.parse(value);
  if (Number.isNaN(retryDateMs)) {
    return null;
  }

  return Math.max(0, Math.min(retryDateMs - Date.now(), RETRY_MAX_DELAY_MS));
}

function scheduleDrain(): void {
  if (drainTimer) {
    return;
  }

  const now = Date.now();
  pruneTimestamps(now);

  if (requestQueue.length === 0) {
    return;
  }

  if (requestTimestamps.length < MAX_REQUESTS_PER_SECOND) {
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drainQueue();
    }, 0);
    return;
  }

  const oldest = requestTimestamps[0];
  const waitMs = Math.max(1, 1_000 - (now - oldest));
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainQueue();
  }, waitMs);
}

function drainQueue(): void {
  const now = Date.now();
  pruneTimestamps(now);

  while (
    requestQueue.length > 0 &&
    requestTimestamps.length < MAX_REQUESTS_PER_SECOND
  ) {
    const item = requestQueue.shift();
    if (!item) {
      break;
    }

    requestTimestamps.push(Date.now());
    axios
      .get(item.url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, application/xml, text/xml, */*",
        },
        timeout: 15_000,
      })
      .then((response) => {
        item.resolve(response);
      })
      .catch((error: unknown) => {
        item.reject(error);
      });
  }

  scheduleDrain();
}

function enqueueGet<T>(
  url: string,
  responseType: "text" | "json" | "arraybuffer" = "json"
): Promise<AxiosResponse<T>> {
  return new Promise((resolve, reject) => {
    requestQueue.push({
      url,
      responseType,
      resolve: resolve as (response: AxiosResponse<unknown>) => void,
      reject,
    });
    scheduleDrain();
  });
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 503;
}

function toErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    if (status) {
      return `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
    }
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

export async function getRaw<T = unknown>(
  url: string,
  responseType: "text" | "json" | "arraybuffer" = "json"
): Promise<AxiosResponse<T>> {
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await enqueueGet<T>(url, responseType);
      return response;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const canRetry = isRetryableStatus(status) && attempt < MAX_RETRIES;

      if (!canRetry) {
        throw new Error(`SEC request failed for ${url}: ${toErrorMessage(error)}`);
      }

      const retryAfterHeader = axiosError.response?.headers?.["retry-after"];
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      const exponentialDelayMs = Math.min(
        RETRY_BASE_DELAY_MS * 2 ** attempt,
        RETRY_MAX_DELAY_MS
      );
      const delayMs = retryAfterMs ?? exponentialDelayMs;

      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw new Error(`SEC request failed for ${url}: retry budget exhausted.`);
}

export async function get<T = unknown>(url: string): Promise<T> {
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await enqueueGet<T>(url);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const canRetry = isRetryableStatus(status) && attempt < MAX_RETRIES;

      if (!canRetry) {
        throw new Error(`SEC request failed for ${url}: ${toErrorMessage(error)}`);
      }

      const retryAfterHeader = axiosError.response?.headers?.["retry-after"];
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      const exponentialDelayMs = Math.min(
        RETRY_BASE_DELAY_MS * 2 ** attempt,
        RETRY_MAX_DELAY_MS
      );
      const delayMs = retryAfterMs ?? exponentialDelayMs;

      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw new Error(`SEC request failed for ${url}: retry budget exhausted.`);
}
