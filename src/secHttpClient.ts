import axios, { AxiosError, AxiosResponse } from "axios";
import { withRetry, isRetryableError } from "./withRetry";

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
  responseType: "text" | "json" | "arraybuffer";
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

function pruneTimestamps(now: number): void {
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] >= 1_000) {
    requestTimestamps.shift();
  }
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
          Accept: "application/json, application/xml, text/html, text/plain, text/xml, */*",
        },
        responseType: item.responseType,
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


const SEC_RETRY_OPTIONS = {
  maxRetries: MAX_RETRIES,
  baseDelayMs: RETRY_BASE_DELAY_MS,
  maxDelayMs: RETRY_MAX_DELAY_MS,
  shouldRetry: isRetryableError,
};

export async function getRaw<T = unknown>(
  url: string,
  responseType: "text" | "json" | "arraybuffer" = "json"
): Promise<AxiosResponse<T>> {
  return withRetry(
    () => enqueueGet<T>(url, responseType),
    SEC_RETRY_OPTIONS
  );
}

export async function get<T = unknown>(url: string): Promise<T> {
  return withRetry(
    async () => {
      const response = await enqueueGet<T>(url, "json");
      return response.data;
    },
    SEC_RETRY_OPTIONS
  );
}
