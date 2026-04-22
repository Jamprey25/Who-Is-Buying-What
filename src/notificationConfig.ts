import type { DealSizeCategory } from "./calculateDealMetrics";
import type { PaymentType } from "./detectPaymentType";
import type { DealRecord } from "./secEdgarFeed";

// ─── Domain subsets ───────────────────────────────────────────────────────────

/** Payment types that make sense as alert targets (UNKNOWN is excluded). */
export type AlertPaymentType = Exclude<PaymentType, "UNKNOWN">;

/** Deal size categories that make sense as alert targets. */
export type AlertDealCategory = Extract<DealSizeCategory, "TRANSFORMATIVE" | "MATERIAL">;

// ─── Config shape ─────────────────────────────────────────────────────────────

export interface NotificationConfig {
  /** Alert only when transactionValueUSD meets or exceeds this. */
  minDealValueUSD: number;
  /** Alert only when the deal's payment type is in this set. */
  alertOnPaymentTypes: AlertPaymentType[];
  /** Alert only when the deal's size category is in this set. */
  alertOnDealCategories: AlertDealCategory[];
  /** Acquirer names (case-insensitive) that are permanently silenced. */
  mutedAcquirers: string[];
  /** Suppress repeat alerts for the same acquirer within this window. */
  cooldownMinutes: number;
}

// ─── Allowed values (used for validation during parsing) ─────────────────────

const ALERT_PAYMENT_TYPES: readonly AlertPaymentType[] = ["CASH", "STOCK", "MIXED"];
const ALERT_DEAL_CATEGORIES: readonly AlertDealCategory[] = ["TRANSFORMATIVE", "MATERIAL"];

// ─── Parsing helpers ──────────────────────────────────────────────────────────

function parsePositiveNumber(raw: string | undefined, defaultValue: number): number {
  if (!raw?.trim()) return defaultValue;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseEnumArray<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  defaultValue: T[]
): T[] {
  if (!raw?.trim()) return defaultValue;
  const allowedSet = new Set<string>(allowed);
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase() as T)
    .filter((v) => allowedSet.has(v));
  return parsed.length > 0 ? parsed : defaultValue;
}

function parseStringArray(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function loadNotificationConfig(): NotificationConfig {
  return {
    minDealValueUSD: parsePositiveNumber(
      process.env.NOTIFICATION_MIN_DEAL_VALUE_USD,
      1_000_000_000
    ),

    alertOnPaymentTypes: parseEnumArray<AlertPaymentType>(
      process.env.NOTIFICATION_ALERT_ON_PAYMENT_TYPES,
      ALERT_PAYMENT_TYPES,
      [...ALERT_PAYMENT_TYPES]
    ),

    alertOnDealCategories: parseEnumArray<AlertDealCategory>(
      process.env.NOTIFICATION_ALERT_ON_DEAL_CATEGORIES,
      ALERT_DEAL_CATEGORIES,
      ["TRANSFORMATIVE"]
    ),

    mutedAcquirers: parseStringArray(process.env.NOTIFICATION_MUTED_ACQUIRERS),

    cooldownMinutes: parsePositiveNumber(
      process.env.NOTIFICATION_COOLDOWN_MINUTES,
      60
    ),
  };
}

/** Singleton loaded once at module initialisation time. */
export const notificationConfig: NotificationConfig = loadNotificationConfig();

// ─── Cooldown tracker ─────────────────────────────────────────────────────────

/** acquirer (lowercased) → timestamp of last recorded alert (ms since epoch) */
const lastAlertedAt = new Map<string, number>();

/**
 * Records that an alert was sent for this deal's acquirer.
 * Must be called by the caller after the alert is successfully dispatched.
 */
export function recordAlert(deal: DealRecord): void {
  lastAlertedAt.set(deal.acquirer.trim().toLowerCase(), Date.now());
}

// ─── shouldAlert ──────────────────────────────────────────────────────────────

/**
 * Pure predicate — returns true when all notification thresholds pass.
 * Does NOT record the alert; call recordAlert() after dispatching.
 */
export function shouldAlert(
  deal: DealRecord,
  config: NotificationConfig = notificationConfig
): boolean {
  // 1. Deal value must be present and meet the minimum threshold.
  if (
    deal.transactionValueUSD === null ||
    deal.transactionValueUSD < config.minDealValueUSD
  ) {
    return false;
  }

  // 2. Payment type filter — skipped when paymentType has not been extracted yet.
  if (
    deal.paymentType !== undefined &&
    deal.paymentType !== "UNKNOWN" &&
    !(config.alertOnPaymentTypes as string[]).includes(deal.paymentType)
  ) {
    return false;
  }

  // 3. Deal category filter — skipped when category has not been calculated yet.
  if (
    deal.dealSizeCategory !== undefined &&
    deal.dealSizeCategory !== "UNKNOWN" &&
    deal.dealSizeCategory !== "BOLT_ON" &&
    !(config.alertOnDealCategories as string[]).includes(deal.dealSizeCategory)
  ) {
    return false;
  }

  // 4. Muted acquirers (case-insensitive).
  const acquirerKey = deal.acquirer.trim().toLowerCase();
  if (config.mutedAcquirers.includes(acquirerKey)) {
    return false;
  }

  // 5. Cooldown — suppress repeat alerts for the same acquirer.
  const lastMs = lastAlertedAt.get(acquirerKey);
  if (lastMs !== undefined) {
    const elapsedMinutes = (Date.now() - lastMs) / 60_000;
    if (elapsedMinutes < config.cooldownMinutes) {
      return false;
    }
  }

  return true;
}
