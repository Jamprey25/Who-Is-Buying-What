const DEFAULT_ALLOWLIST = ["8-K", "8-K/A", "4", "4/A"] as const;

export interface Filing {
  accessionNumber: string;
  formType: string;
  filedAt: Date;
  companyName: string;
  cik: string;
  filingUrl: string;
}

function normalizeFormType(value: string): string {
  return value.trim().toUpperCase().replace(/^FORM\s+/, "");
}

export function filterFilingsByFormType(
  filings: Filing[],
  allowlist: string[] = [...DEFAULT_ALLOWLIST]
): Filing[] {
  const normalizedAllowlist = new Set(allowlist.map(normalizeFormType));

  const filtered = filings.filter((filing) =>
    normalizedAllowlist.has(normalizeFormType(filing.formType))
  );

  const count8K = filtered.filter(
    (filing) => normalizeFormType(filing.formType) === "8-K"
  ).length;
  const count8KA = filtered.filter(
    (filing) => normalizeFormType(filing.formType) === "8-K/A"
  ).length;
  const countForm4 = filtered.filter(
    (filing) => normalizeFormType(filing.formType) === "4"
  ).length;
  const countForm4A = filtered.filter(
    (filing) => normalizeFormType(filing.formType) === "4/A"
  ).length;

  console.log(
    `Filtered ${filings.length} filings, kept ${filtered.length} (8-K: ${count8K}, 8-K/A: ${count8KA}, Form 4: ${countForm4}, Form 4/A: ${countForm4A})`
  );

  return filtered;
}
