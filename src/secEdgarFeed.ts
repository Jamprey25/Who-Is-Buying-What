import axios from "axios";
import { parseStringPromise } from "xml2js";

const SEC_EDGAR_8K_ATOM_URL =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=40&output=atom";

export interface EdgarFiling {
  accessionNumber: string;
  formType: string;
  filedAt: Date;
  companyName: string;
  cik: string;
  filingUrl: string;
}

export interface NewsResult {
  title: string;
  url: string;
  source: string;
  publishedAt: Date;
}

export interface ExtractionResult {
  acquirer: string;
  target: string;
}

interface AtomLink {
  $?: {
    href?: string;
    rel?: string;
  };
}

interface AtomCategory {
  $?: {
    term?: string;
  };
}

export interface RSSEntry {
  id?: string[];
  title?: string[];
  updated?: string[];
  published?: string[];
  link?: AtomLink[];
  category?: AtomCategory[];
  summary?: string[];
}

interface AtomFeed {
  feed?: {
    entry?: RSSEntry[];
  };
}

interface SerpApiNewsSource {
  name?: string;
}

interface SerpApiNewsItem {
  title?: string;
  link?: string;
  source?: SerpApiNewsSource;
  date?: string;
}

interface SerpApiNewsResponse {
  news_results?: SerpApiNewsItem[];
}

function text(value?: string[]): string {
  return value?.[0]?.trim() ?? "";
}

function extractAccessionNumber(entry: RSSEntry, filingUrl: string): string {
  const fromUrl = filingUrl.match(/[?&]accession_number=([0-9-]+)/i)?.[1];
  if (fromUrl) {
    return fromUrl;
  }

  const fromId = text(entry.id).match(/accession-number=([0-9-]+)/i)?.[1];
  if (fromId) {
    return fromId;
  }

  const fromSummary = text(entry.summary).match(/AccNo:\s*([0-9-]+)/i)?.[1];
  if (fromSummary) {
    return fromSummary;
  }

  return "";
}

function extractCik(entry: RSSEntry, filingUrl: string): string {
  const fromUrl = filingUrl.match(/[?&]CIK=([0-9]+)/i)?.[1];
  if (fromUrl) {
    return fromUrl;
  }

  const fromTitle = text(entry.title).match(/\(0*([0-9]{4,10})\)/)?.[1];
  if (fromTitle) {
    return fromTitle;
  }

  const fromSummary = text(entry.summary).match(/CIK:\s*([0-9]+)/i)?.[1];
  if (fromSummary) {
    return fromSummary;
  }

  return "";
}

export function extractFormType(entry: RSSEntry): string {
  const fromCategory = entry.category?.find((category) => category.$?.term?.trim())?.$?.term?.trim();
  if (fromCategory) {
    return fromCategory;
  }

  const titleValue = text(entry.title);
  const fromTitle = titleValue.match(/\b([A-Z0-9]+(?:-[A-Z0-9]+)?)\b/)?.[1];
  if (fromTitle) {
    return fromTitle;
  }

  return "UNKNOWN";
}

function extractCompanyName(entry: RSSEntry): string {
  const titleValue = text(entry.title);
  if (!titleValue) {
    return "";
  }

  const withoutPrefix = titleValue.replace(/^[A-Z0-9-]+\s*-\s*/, "");
  return withoutPrefix.replace(/\s*\(0*[0-9]{4,10}\).*$/, "").trim();
}

function extractFilingUrl(entry: RSSEntry): string {
  const candidate =
    entry.link?.find((link) => link.$?.rel === "alternate")?.$?.href ??
    entry.link?.[0]?.$?.href ??
    "";
  return candidate.trim();
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DEAL_NEWS_WINDOW_DAYS = 7;
const TIER_ONE_DAYS = 1;
const TIER_TWO_DAYS = 3;
const TIER_THREE_DAYS = 7;
const HIGH_CONFIDENCE_SOURCES = ["reuters", "bloomberg", "wsj", "pr newswire"];

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function toSlug(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function scoreNewsRelevance(
  result: NewsResult,
  extraction: ExtractionResult,
  filedAt: Date
): number {
  let score = 0;

  const title = normalizeText(result.title);
  const acquirer = normalizeText(extraction.acquirer);
  const target = normalizeText(extraction.target);

  if (acquirer && title.includes(acquirer)) {
    score += 0.3;
  }

  if (target && title.includes(target)) {
    score += 0.3;
  }

  const filedAtMs = filedAt.getTime();
  const publishedAtMs = result.publishedAt.getTime();
  if (!Number.isNaN(filedAtMs) && !Number.isNaN(publishedAtMs)) {
    const daysDiff = Math.abs(publishedAtMs - filedAtMs) / DAY_IN_MS;
    if (daysDiff <= TIER_ONE_DAYS) {
      score += 0.2;
    } else if (daysDiff <= TIER_TWO_DAYS) {
      score += 0.1;
    } else if (daysDiff <= TIER_THREE_DAYS) {
      score += 0.05;
    }
  }

  const source = normalizeText(result.source);
  if (HIGH_CONFIDENCE_SOURCES.some((trustedSource) => source.includes(trustedSource))) {
    score += 0.2;
  }

  const acquirerSlug = toSlug(extraction.acquirer);
  const targetSlug = toSlug(extraction.target);
  const url = normalizeText(result.url);
  if (acquirerSlug && targetSlug && url.includes(acquirerSlug) && url.includes(targetSlug)) {
    score += 0.1;
  }

  return Math.min(1, score);
}

function parsePublishedAt(rawDate: string | undefined): Date | null {
  if (!rawDate?.trim()) {
    return null;
  }

  const value = rawDate.trim();
  const asAbsoluteDate = new Date(value);
  if (!Number.isNaN(asAbsoluteDate.getTime())) {
    return asAbsoluteDate;
  }

  const relativeMatch = value.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (!relativeMatch) {
    return null;
  }

  const amount = Number.parseInt(relativeMatch[1], 10);
  const unit = relativeMatch[2].toLowerCase();
  const now = Date.now();

  const unitToMs: Record<string, number> = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: DAY_IN_MS,
    week: 7 * DAY_IN_MS,
    month: 30 * DAY_IN_MS,
    year: 365 * DAY_IN_MS,
  };

  const unitMs = unitToMs[unit];
  if (!unitMs) {
    return null;
  }

  return new Date(now - amount * unitMs);
}

export async function searchDealNews(
  acquirer: string,
  target: string,
  filedAt: Date
): Promise<NewsResult[]> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return [];
  }

  const query = `"${acquirer}" AND "${target}" AND ("acquires" OR "acquisition" OR "merger")`;
  const windowMs = DEAL_NEWS_WINDOW_DAYS * DAY_IN_MS;
  const filedAtMs = filedAt.getTime();
  if (Number.isNaN(filedAtMs)) {
    return [];
  }

  try {
    const response = await axios.get<SerpApiNewsResponse>("https://serpapi.com/search.json", {
      timeout: 10_000,
      params: {
        engine: "google_news",
        q: query,
        api_key: apiKey,
        hl: "en",
        gl: "us",
        num: 10,
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const results = response.data.news_results ?? [];

    return results
      .map((item): NewsResult | null => {
        const publishedAt = parsePublishedAt(item.date);
        if (!publishedAt || !item.title || !item.link) {
          return null;
        }

        const diffMs = Math.abs(publishedAt.getTime() - filedAtMs);
        if (diffMs > windowMs) {
          return null;
        }

        return {
          title: item.title,
          url: item.link,
          source: item.source?.name?.trim() || "Unknown",
          publishedAt,
        };
      })
      .filter((item): item is NewsResult => item !== null)
      .slice(0, 3);
  } catch {
    return [];
  }
}

export async function fetchCurrent8kFilings(
  url: string = SEC_EDGAR_8K_ATOM_URL
): Promise<EdgarFiling[]> {
  let xml: string;

  try {
    const response = await axios.get<string>(url, {
      timeout: 15_000,
      headers: {
        Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
        "User-Agent": "who-is-buying-what/1.0 (contact: dev@example.com)",
      },
      responseType: "text",
      validateStatus: (status) => status >= 200 && status < 300,
    });
    xml = response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const statusText = error.response?.statusText;
      const detail = status
        ? `status ${status}${statusText ? ` ${statusText}` : ""}`
        : error.message;
      throw new Error(`Failed to fetch SEC EDGAR feed: ${detail}`);
    }
    throw new Error("Failed to fetch SEC EDGAR feed: unknown network error");
  }

  let parsed: AtomFeed;
  try {
    parsed = (await parseStringPromise(xml, {
      explicitArray: true,
      trim: true,
    })) as AtomFeed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse SEC EDGAR feed XML: ${message}`);
  }

  const entries = parsed.feed?.entry ?? [];

  return entries.map((entry) => {
    const filingUrl = extractFilingUrl(entry);
    const updatedText = text(entry.updated) || text(entry.published);
    const filedAt = new Date(updatedText || 0);

    return {
      accessionNumber: extractAccessionNumber(entry, filingUrl),
      formType: extractFormType(entry),
      filedAt,
      companyName: extractCompanyName(entry),
      cik: extractCik(entry, filingUrl),
      filingUrl,
    };
  });
}
