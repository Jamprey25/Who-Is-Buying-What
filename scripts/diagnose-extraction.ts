import { fetchCurrent8kFilings } from "../src/secEdgarFeed";
import { getPrimaryDocumentUrl } from "../src/edgarDocumentUrl";
import { fetchFilingContent } from "../src/fetchFilingContent";
import { extractTextFromFiling } from "../src/extractTextFromFiling";

async function main() {
  const filings = await fetchCurrent8kFilings();
  const filing = filings.find((f) => /^8-K$/i.test(f.formType.replace(/^FORM\s+/i, "").trim()));
  if (!filing) {
    console.log("No plain 8-K in feed");
    return;
  }

  console.log("Testing filing:", {
    accession: filing.accessionNumber,
    company: filing.companyName,
    cik: filing.cik,
    filingUrl: filing.filingUrl,
  });

  const primaryUrl = await getPrimaryDocumentUrl(filing.accessionNumber, filing.cik);
  console.log("Primary document URL:", primaryUrl);

  const raw = await fetchFilingContent(primaryUrl);
  console.log("Fetched bytes:", raw.length);
  console.log("First 400 chars:\n", raw.slice(0, 400));
  console.log("...");
  console.log("Last 200 chars:\n", raw.slice(-200));

  const text = extractTextFromFiling(raw);
  console.log("\nExtracted text length:", text.length);
  console.log("First 400 chars of extracted:\n", text.slice(0, 400));
}

main().catch((e) => {
  console.error("Diagnostic failed:", e);
  process.exit(1);
});
