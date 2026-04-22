import pino, { Logger, TransportTargetOptions } from "pino";

// ─── Event payload types ──────────────────────────────────────────────────────

export interface DealInsertedPayload {
  fingerprint: string;
  accessionNumber: string;
  acquirer: string;
  target: string;
}

export interface AmendmentMergedPayload {
  fingerprint: string;
  originalAccession: string;
  amendmentAccession: string;
  fieldsUpdated: string[];
}

export interface DuplicateSkippedPayload {
  fingerprint: string;
  skippedAccession: string;
  existingConfidence: number | null;
  incomingConfidence: number | null;
}

export interface FingerprintCollisionPayload {
  fingerprint: string;
  deal1: { accessionNumber: string; acquirer: string; target: string };
  deal2: { accessionNumber: string; acquirer: string; target: string };
}

// ─── Logger factory ───────────────────────────────────────────────────────────

function buildTransport(): TransportTargetOptions[] | undefined {
  if (process.env.NODE_ENV === "production") {
    return undefined; // pino writes newline-delimited JSON directly to stdout
  }

  // Development: pretty-print with colour, timestamps, and log level labels.
  // pino-pretty runs in a worker thread so it never blocks the event loop.
  return [
    {
      target: "pino-pretty",
      level: "trace",
      options: {
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
        messageKey: "msg",
        levelFirst: true,
        // Keep nested objects readable — do not collapse to one line
        singleLine: false,
      },
    },
  ];
}

function createBaseLogger(): Logger {
  const transport = buildTransport();

  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",

      // Consistent timestamp across all log lines
      timestamp: pino.stdTimeFunctions.isoTime,

      // Bound context present on every log line
      base: {
        service: "who-is-buying-what",
        env: process.env.NODE_ENV ?? "development",
      },

      // Serialize native Error objects into a structured { type, message, stack }
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },

      // Redact secrets that should never appear in logs
      redact: {
        paths: ["*.apiKey", "*.password", "*.secret", "*.token", "authorization"],
        censor: "[REDACTED]",
      },
    },
    transport ? pino.transport({ targets: transport }) : undefined
  );
}

// Singleton — one logger instance for the process lifetime
const baseLogger = createBaseLogger();

// ─── Typed child loggers ──────────────────────────────────────────────────────

// Each child inherits the base config and adds a fixed `module` binding,
// so every log line carries its origin without the caller repeating it.
const dedupeLogger = baseLogger.child({ module: "dedupe" });
const amendLogger = baseLogger.child({ module: "amendment" });

// ─── Pipeline event helpers ───────────────────────────────────────────────────

export function logDealInserted(payload: DealInsertedPayload): void {
  dedupeLogger.info(
    {
      event: "deal_inserted",
      fingerprint: payload.fingerprint,
      accessionNumber: payload.accessionNumber,
      acquirer: payload.acquirer,
      target: payload.target,
    },
    "New deal inserted"
  );
}

export function logAmendmentMerged(payload: AmendmentMergedPayload): void {
  amendLogger.info(
    {
      event: "amendment_merged",
      fingerprint: payload.fingerprint,
      originalAccession: payload.originalAccession,
      amendmentAccession: payload.amendmentAccession,
      fieldsUpdated: payload.fieldsUpdated,
      fieldsUpdatedCount: payload.fieldsUpdated.length,
    },
    `Amendment merged (${payload.fieldsUpdated.length} field${payload.fieldsUpdated.length === 1 ? "" : "s"} updated)`
  );
}

export function logDuplicateSkipped(payload: DuplicateSkippedPayload): void {
  dedupeLogger.warn(
    {
      event: "duplicate_skipped",
      fingerprint: payload.fingerprint,
      skippedAccession: payload.skippedAccession,
      existingConfidence: payload.existingConfidence,
      incomingConfidence: payload.incomingConfidence,
    },
    "Duplicate skipped — incoming confidence does not exceed stored value"
  );
}

export function logFingerprintCollision(
  payload: FingerprintCollisionPayload
): void {
  // A collision means two structurally different deals hashed to the same
  // fingerprint. This is a data integrity defect — page an engineer.
  dedupeLogger.error(
    {
      event: "fingerprint_collision",
      fingerprint: payload.fingerprint,
      deal1: payload.deal1,
      deal2: payload.deal2,
    },
    "FINGERPRINT COLLISION — two distinct deals share the same hash"
  );
}

// ─── Generic escape hatch ─────────────────────────────────────────────────────

// Expose the base logger for one-off logging outside the pipeline events.
// Callers should prefer the typed helpers above for all pipeline events.
export { baseLogger as logger };
