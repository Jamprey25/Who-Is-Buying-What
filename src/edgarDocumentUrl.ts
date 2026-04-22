import * as cheerio from "cheerio";
import { get } from "./secHttpClient";

const EDGAR_BASE = "https://www.sec.gov";

// EDGAR accession numbers contain dashes when used in URLs but are stored
// without them in filing metadata. We normalize both forms here.
function normalizeAccession(raw: string): string {
  return raw.replace(/-/g, "");
}

function buildIndexUrl(cik: string, accessionNumber: string): string {
  const paddedCik = cik.replace(/^0+/, "").padStart(10, "0");
  const dashedAccession = accessionNumber
    .replace(/-/g, "")
    .replace(/^(\d{10})(\d{2})(\d{6})$/, "$1-$2-$3");

  return `${EDGAR_BASE}/Archives/edgar/data/${paddedCik}/${dashedAccession}-index.htm`;
}

function isTargetDocument(type: string, href: string): boolean {
  const normalizedType = type.trim().toUpperCase();
  const normalizedHref = href.trim().toLowerCase();

  // Accept both bare "8-K" and amendment "8-K/A" as primary document types.
  const isEightK =
    normalizedType === "8-K" ||
    normalizedType === "8-K/A";

  const hasValidExtension =
    normalizedHref.endsWith(".htm") ||
    normalizedHref.endsWith(".html") ||
    normalizedHref.endsWith(".txt");

  return isEightK && hasValidExtension;
}

export async function getPrimaryDocumentUrl(
  accessionNumber: string,
  cik: string
): Promise<string> {
  if (!accessionNumber || !cik) {
    throw new Error(
      `[getPrimaryDocumentUrl] accessionNumber and cik are required (got: "${accessionNumber}", "${cik}")`
    );
  }

  const normalizedAccession = normalizeAccession(accessionNumber);
  const indexUrl = buildIndexUrl(cik, normalizedAccession);

  const html = await get<string>(indexUrl);

  const $ = cheerio.load(html);

  // EDGAR index pages use a consistent table with headers:
  // Seq | Description | Document | Type | Size
  // We scan every row and match on the Type column.
  let primaryHref: string | null = null;

  $("table tr").each((_i, row) => {
    if (primaryHref) return; // already found

    const cells = $(row).find("td");
    if (cells.length < 4) return;

    const typeCell = $(cells[3]).text().trim();
    const linkEl = $(cells[2]).find("a");
    const href = linkEl.attr("href")?.trim() ?? "";

    if (href && isTargetDocument(typeCell, href)) {
      primaryHref = href;
    }
  });

  if (!primaryHref) {
    throw new Error(
      `[getPrimaryDocumentUrl] No primary 8-K document found in index: ${indexUrl}`
    );
  }

  // EDGAR hrefs are always root-relative ("/Archives/edgar/data/...")
  const absoluteUrl = primaryHref.startsWith("http")
    ? primaryHref
    : `${EDGAR_BASE}${primaryHref}`;

  return absoluteUrl;
}
