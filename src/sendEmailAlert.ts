import { Resend } from "resend";
import type { DealSizeCategory } from "./calculateDealMetrics";
import type { DealRecord } from "./secEdgarFeed";

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

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const CATEGORY_LABELS: Record<DealSizeCategory, string> = {
  TRANSFORMATIVE: "Transformative",
  MATERIAL:       "Material",
  BOLT_ON:        "Bolt-on",
  UNKNOWN:        "—",
};

// ─── Subject line ─────────────────────────────────────────────────────────────

function buildSubject(deal: DealRecord): string {
  return `🔔 ${deal.acquirer} acquires ${deal.target} for ${formatValueUSD(deal.transactionValueUSD)}`;
}

// ─── Plain-text fallback ──────────────────────────────────────────────────────

export function buildPlainText(deal: DealRecord): string {
  const dashboardUrl = process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://your-app.com/dashboard";
  const lines = [
    `M&A ALERT — ${formatDate(deal.announcedAt)}`,
    "=".repeat(50),
    "",
    `${deal.acquirer} acquires ${deal.target}`,
    "",
    `Deal Value    : ${formatValueUSD(deal.transactionValueUSD)}`,
    `Payment Type  : ${deal.paymentType ?? "Unknown"}`,
    `Category      : ${deal.dealSizeCategory ? CATEGORY_LABELS[deal.dealSizeCategory] : "Unknown"}`,
    `Filing Date   : ${formatDate(deal.announcedAt)}`,
    `Acquirer      : ${deal.acquirer}`,
    `Target        : ${deal.target}`,
    `Amendment #   : ${deal.amendmentCount}`,
    "",
    `SEC Filing    : ${deal.sourceUrl}`,
    `Dashboard     : ${dashboardUrl}`,
    "",
    "—",
    "You are receiving this alert from Who Is Buying What.",
    "Source: SEC EDGAR",
  ];
  return lines.join("\n");
}

// ─── HTML template ────────────────────────────────────────────────────────────

export function buildHtml(deal: DealRecord): string {
  const dashboardUrl = process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://your-app.com/dashboard";

  const category = deal.dealSizeCategory
    ? CATEGORY_LABELS[deal.dealSizeCategory]
    : "Unknown";

  const paymentType = deal.paymentType ?? "Unknown";

  // Accent colour mirrors the Discord embed colours for visual consistency.
  const accentColor =
    deal.paymentType === "CASH"  ? "#57F287" :
    deal.paymentType === "STOCK" ? "#5865F2" :
    deal.paymentType === "MIXED" ? "#9B59B6" :
                                   "#95A5A6";

  // Row helper — keeps the template readable without a loop.
  function row(label: string, value: string): string {
    return /* html */`
      <tr>
        <td style="padding:10px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;
                   font-size:13px;color:#6b7280;white-space:nowrap;width:1%;font-weight:600;">
          ${label}
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;
                   font-size:14px;color:#111827;">
          ${value}
        </td>
      </tr>`;
  }

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>M&amp;A Alert</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f3f4f6;padding:32px 0;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table width="600" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;width:100%;background:#ffffff;
                      border-radius:8px;overflow:hidden;
                      box-shadow:0 1px 3px rgba(0,0,0,.1);">

          <!-- Accent bar -->
          <tr>
            <td style="height:4px;background:${accentColor};font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid #e5e7eb;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <p style="margin:0 0 4px;font-size:11px;color:#6b7280;
                               text-transform:uppercase;letter-spacing:.08em;font-weight:600;">
                      M&amp;A Alert &bull; SEC EDGAR
                    </p>
                    <h1 style="margin:0;font-size:22px;font-weight:700;color:#111827;
                                line-height:1.3;">
                      ${escapeHtml(deal.acquirer)}&nbsp;acquires&nbsp;${escapeHtml(deal.target)}
                    </h1>
                    <p style="margin:6px 0 0;font-size:15px;color:#6b7280;">
                      ${formatDate(deal.announcedAt)}
                    </p>
                  </td>
                  <td align="right" valign="top" style="white-space:nowrap;">
                    <span style="display:inline-block;padding:6px 14px;
                                 background:${accentColor}20;border-radius:20px;
                                 font-size:15px;font-weight:700;color:#111827;">
                      ${formatValueUSD(deal.transactionValueUSD)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Detail table -->
          <tr>
            <td style="padding:0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${row("Acquirer",      escapeHtml(deal.acquirer))}
                ${row("Target",        escapeHtml(deal.target))}
                ${row("Deal Value",    formatValueUSD(deal.transactionValueUSD))}
                ${row("Payment Type",  paymentType)}
                ${row("Category",      category)}
                ${row("Filing Date",   formatDate(deal.announcedAt))}
                ${row("Amendment #",   String(deal.amendmentCount))}
              </table>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td align="center" style="padding:28px 32px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="border-radius:6px;background:#111827;">
                    <a href="${dashboardUrl}"
                       target="_blank"
                       style="display:inline-block;padding:12px 28px;
                              font-size:14px;font-weight:600;color:#ffffff;
                              text-decoration:none;border-radius:6px;
                              font-family:Arial,Helvetica,sans-serif;">
                      View on Dashboard &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:12px;color:#9ca3af;">
                    Source:&nbsp;
                    <a href="${escapeHtml(deal.sourceUrl)}" target="_blank"
                       style="color:#6b7280;text-decoration:underline;">
                      SEC EDGAR Filing
                    </a>
                  </td>
                  <td align="right" style="font-size:12px;color:#9ca3af;">
                    Who Is Buying What
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>
  <!-- /Outer wrapper -->

</body>
</html>`;
}

// ─── HTML escape (prevents XSS from company names in the template) ────────────

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function sendEmailAlert(
  deal: DealRecord,
  recipients: string[]
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY environment variable is not set.");
  }

  if (recipients.length === 0) {
    throw new Error("sendEmailAlert: recipients list must not be empty.");
  }

  const from = process.env.RESEND_FROM_ADDRESS?.trim() ?? "alerts@your-domain.com";

  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from,
    to: recipients,
    subject: buildSubject(deal),
    html: buildHtml(deal),
    text: buildPlainText(deal),
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }
}
