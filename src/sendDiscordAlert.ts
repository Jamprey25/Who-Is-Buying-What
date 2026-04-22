import axios from "axios";
import type { DealSizeCategory } from "./calculateDealMetrics";
import type { PaymentType } from "./detectPaymentType";
import type { DealRecord } from "./secEdgarFeed";
import { searchTicker } from "./tickerSearch";
import { isRetryableError, withRetry } from "./withRetry";

// ─── Discord embed types ──────────────────────────────────────────────────────

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  /** Makes the title a clickable hyperlink. */
  url: string;
  color: number;
  thumbnail: { url: string };
  fields: DiscordEmbedField[];
  footer: { text: string };
  /** ISO-8601 — Discord renders this as a localised relative timestamp. */
  timestamp: string;
}

interface DiscordWebhookPayload {
  embeds: [DiscordEmbed];
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Discord integer colors (0xRRGGBB)
const PAYMENT_TYPE_COLORS: Record<PaymentType, number> = {
  CASH:    0x57f287, // green
  STOCK:   0x5865f2, // Discord blurple / blue
  MIXED:   0x9b59b6, // purple
  UNKNOWN: 0x95a5a6, // gray
};

const DEFAULT_COLOR = 0x95a5a6;

const FINANCE_THUMBNAIL_URL =
  "https://cdn-icons-png.flaticon.com/512/2830/2830284.png";

const CATEGORY_LABELS: Record<DealSizeCategory, string> = {
  TRANSFORMATIVE: "🔴 Transformative",
  MATERIAL:       "🟡 Material",
  BOLT_ON:        "🟢 Bolt-on",
  UNKNOWN:        "—",
};

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatValueUSD(usd: number | null): string {
  if (usd === null) return "Undisclosed";
  if (usd >= 1_000_000_000) {
    const b = usd / 1_000_000_000;
    return `$${b % 1 === 0 ? b.toFixed(0) : b.toFixed(1)}B`;
  }
  if (usd >= 1_000_000) {
    const m = usd / 1_000_000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  return `$${usd.toLocaleString()}`;
}

function formatFilingDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ─── Ticker lookup (best-effort; never throws) ────────────────────────────────

async function tryGetTicker(companyName: string): Promise<string | null> {
  try {
    const result = await searchTicker(companyName);
    return result?.symbol ?? null;
  } catch {
    return null;
  }
}

// ─── Embed builder (exported for unit-testing without HTTP) ──────────────────

export interface EmbedOptions {
  acquirerTicker: string | null;
  /** null means the target is private or ticker lookup failed. */
  targetTicker: string | null;
}

export function buildEmbed(deal: DealRecord, opts: EmbedOptions): DiscordEmbed {
  const color = deal.paymentType
    ? (PAYMENT_TYPE_COLORS[deal.paymentType] ?? DEFAULT_COLOR)
    : DEFAULT_COLOR;

  const acquirerLabel = opts.acquirerTicker
    ? `${deal.acquirer} (${opts.acquirerTicker})`
    : deal.acquirer;

  const targetLabel = opts.targetTicker
    ? `${deal.target} (${opts.targetTicker})`
    : `${deal.target} (Private)`;

  const categoryLabel =
    deal.dealSizeCategory ? CATEGORY_LABELS[deal.dealSizeCategory] : "—";

  const paymentLabel = deal.paymentType ?? "Unknown";

  const title = [
    deal.acquirer,
    "acquires",
    deal.target,
    "for",
    formatValueUSD(deal.transactionValueUSD),
  ].join(" ");

  return {
    title,
    url: deal.sourceUrl,
    color,
    thumbnail: { url: FINANCE_THUMBNAIL_URL },
    fields: [
      { name: "Acquirer",      value: acquirerLabel,                        inline: true  },
      { name: "Target",        value: targetLabel,                          inline: true  },
      { name: "Deal Value",    value: formatValueUSD(deal.transactionValueUSD), inline: true  },
      { name: "Category",      value: categoryLabel,                        inline: true  },
      { name: "Payment Type",  value: paymentLabel,                         inline: true  },
      { name: "Filing Date",   value: formatFilingDate(deal.announcedAt),   inline: true  },
    ],
    footer: { text: "Source: SEC EDGAR  •  " + deal.sourceUrl },
    timestamp: deal.announcedAt.toISOString(),
  };
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function sendDiscordAlert(deal: DealRecord): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL environment variable is not set.");
  }

  // Ticker lookups run in parallel; failures are silenced — a missing ticker
  // should never prevent the alert from being sent.
  const [acquirerTicker, targetTicker] = await Promise.all([
    tryGetTicker(deal.acquirer),
    tryGetTicker(deal.target),
  ]);

  const payload: DiscordWebhookPayload = {
    embeds: [buildEmbed(deal, { acquirerTicker, targetTicker })],
  };

  await withRetry(
    () =>
      axios.post(webhookUrl, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 10_000,
        validateStatus: (status) => status >= 200 && status < 300,
      }),
    {
      maxRetries: 4,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      shouldRetry: isRetryableError,
      onRetry: (_, attempt, delayMs) => {
        console.warn(
          `[sendDiscordAlert] attempt ${attempt} failed — retrying in ${delayMs}ms`,
          { dealId: deal.id, acquirer: deal.acquirer }
        );
      },
    }
  );
}
