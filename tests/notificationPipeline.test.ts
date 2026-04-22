import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ─── Mock ioredis ─────────────────────────────────────────────────────────────
//
// vi.mock is hoisted before imports so AlertDeduplicator picks up FakeRedis
// when it calls `new Redis(...)` in its constructor.
//
vi.mock("ioredis", () => {
  class FakePipeline {
    private store: Map<string, string>;
    private ops: Array<() => void> = [];

    constructor(store: Map<string, string>) {
      this.store = store;
    }

    // Accept the full ioredis SET signature: key, value, exMode?, ttl?
    set(key: string, value: string, ..._rest: unknown[]): this {
      this.ops.push(() => { this.store.set(key, value); });
      return this;
    }

    async exec(): Promise<Array<[null, string]>> {
      this.ops.forEach((op) => op());
      return this.ops.map(() => [null, "OK"]);
    }
  }

  class FakeRedis {
    // Each AlertDeduplicator instance gets its own isolated store.
    private store = new Map<string, string>();

    // Called by AlertDeduplicator to attach an error handler.
    on(_event: string, _handler: () => void): this {
      return this;
    }

    async exists(...keys: string[]): Promise<number> {
      return keys.filter((k) => this.store.has(k)).length;
    }

    async set(key: string, value: string, ..._rest: unknown[]): Promise<string> {
      this.store.set(key, value);
      return "OK";
    }

    pipeline(): FakePipeline {
      return new FakePipeline(this.store);
    }

    async quit(): Promise<string> {
      return "OK";
    }
  }

  return { default: FakeRedis };
});

// ─── Imports (after vi.mock so ioredis is already replaced) ───────────────────

import type { NotificationConfig } from "../src/notificationConfig";
import { shouldAlert } from "../src/notificationConfig";
import { AlertDeduplicator } from "../src/alertDeduplicator";
import { sendDiscordAlert } from "../src/sendDiscordAlert";
import type { DealRecord } from "../src/secEdgarFeed";

// ─── MSW: Discord webhook interceptor ────────────────────────────────────────

const WEBHOOK_URL =
  "https://discord.com/api/webhooks/000000000000000000/test-token";

let webhookCallCount = 0;
let lastWebhookBody: unknown = null;

const server = setupServer(
  http.post(WEBHOOK_URL, async ({ request }) => {
    webhookCallCount++;
    lastWebhookBody = await request.json();
    return HttpResponse.json({ id: "1234567890" }, { status: 200 });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterAll(() => server.close());

// ─── Fixture ──────────────────────────────────────────────────────────────────

const baseDeal: DealRecord = {
  id: "deal-e2e-001",
  fingerprint: "fp-e2e-001",
  acquirer: "Alpha Corp",
  target: "Beta Industries",
  announcedAt: new Date("2025-01-15T10:00:00Z"),
  sourceUrl:
    "https://www.sec.gov/Archives/edgar/data/123456/000123456025000001/0001234560-25-000001-index.htm",
  transactionValueUSD: 2_500_000_000,
  amendmentCount: 0,
  flags: [],
  createdAt: new Date("2025-01-15T10:05:00Z"),
  updatedAt: new Date("2025-01-15T10:05:00Z"),
  paymentType: "CASH",
  dealSizeCategory: "TRANSFORMATIVE",
};

const baseConfig: NotificationConfig = {
  minDealValueUSD: 1_000_000_000,
  alertOnPaymentTypes: ["CASH", "STOCK", "MIXED"],
  alertOnDealCategories: ["TRANSFORMATIVE", "MATERIAL"],
  mutedAcquirers: [],
  cooldownMinutes: 0, // disable in-process cooldown so it doesn't interfere
};

// ─── Pipeline helper ──────────────────────────────────────────────────────────
//
// Mirrors the real call site:
//   shouldAlert (threshold + muted check)
//     → deduplicator.shouldSendAlert (fingerprint + acquirer cooldown)
//       → sendDiscordAlert (HTTP to webhook)
//         → deduplicator.markAlertSent (stamp the fingerprint)
//
async function runPipeline(
  deal: DealRecord,
  config: NotificationConfig,
  dedup: AlertDeduplicator
): Promise<"fired" | "threshold" | "dedup"> {
  if (!shouldAlert(deal, config)) return "threshold";
  if (!(await dedup.shouldSendAlert(deal.fingerprint, deal.acquirer))) return "dedup";
  await sendDiscordAlert(deal);
  await dedup.markAlertSent(deal.fingerprint, deal.acquirer);
  return "fired";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Notification pipeline — end to end", () => {
  beforeEach(() => {
    webhookCallCount = 0;
    lastWebhookBody = null;
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK_URL;
    // Ensure no FMP key so searchTicker throws and tryGetTicker returns null
    // (keeps ticker fields absent without any outbound HTTP traffic).
    delete process.env.FMP_API_KEY;
  });

  afterEach(() => {
    server.resetHandlers();
    delete process.env.DISCORD_WEBHOOK_URL;
  });

  // ── 1 ───────────────────────────────────────────────────────────────────────

  it("$2.5B CASH/TRANSFORMATIVE deal triggers a Discord alert", async () => {
    const dedup = new AlertDeduplicator();

    const result = await runPipeline(baseDeal, baseConfig, dedup);

    expect(result).toBe("fired");
    expect(webhookCallCount).toBe(1);

    // Spot-check the embed payload that reached Discord.
    expect(lastWebhookBody).toMatchObject({
      embeds: [
        expect.objectContaining({
          title: expect.stringContaining("Alpha Corp"),
          color: 0x57f287, // CASH green
          fields: expect.arrayContaining([
            expect.objectContaining({ name: "Deal Value", value: "$2.5B" }),
            expect.objectContaining({ name: "Payment Type", value: "CASH" }),
          ]),
        }),
      ],
    });

    await dedup.disconnect();
  });

  // ── 2 ───────────────────────────────────────────────────────────────────────

  it("same fingerprint does not trigger a second alert (dedup)", async () => {
    const dedup = new AlertDeduplicator();

    const first = await runPipeline(baseDeal, baseConfig, dedup);
    const second = await runPipeline(baseDeal, baseConfig, dedup);

    expect(first).toBe("fired");
    expect(second).toBe("dedup");
    // Webhook was called exactly once despite two pipeline runs.
    expect(webhookCallCount).toBe(1);

    await dedup.disconnect();
  });

  // ── 3 ───────────────────────────────────────────────────────────────────────

  it("$500M deal does not trigger (below $1B threshold)", async () => {
    const smallDeal: DealRecord = {
      ...baseDeal,
      id: "deal-e2e-small",
      fingerprint: "fp-e2e-small",
      transactionValueUSD: 500_000_000,
    };
    const dedup = new AlertDeduplicator();

    const result = await runPipeline(smallDeal, baseConfig, dedup);

    expect(result).toBe("threshold");
    expect(webhookCallCount).toBe(0);

    await dedup.disconnect();
  });

  // ── 4 ───────────────────────────────────────────────────────────────────────

  it("muted acquirer does not trigger", async () => {
    const mutedConfig: NotificationConfig = {
      ...baseConfig,
      // shouldAlert lowercases before comparing — match is case-insensitive.
      mutedAcquirers: ["alpha corp"],
    };
    const dedup = new AlertDeduplicator();

    const result = await runPipeline(baseDeal, mutedConfig, dedup);

    expect(result).toBe("threshold"); // shouldAlert returns false → "threshold" branch
    expect(webhookCallCount).toBe(0);

    await dedup.disconnect();
  });
});
