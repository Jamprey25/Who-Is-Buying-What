const DEFAULT_ALLOWLIST = ["8-K", "4"] as const;

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
  const countForm4 = filtered.filter(
    (filing) => normalizeFormType(filing.formType) === "4"
  ).length;

  console.log(
    `Filtered ${filings.length} filings, kept ${filtered.length} (8-K: ${count8K}, Form 4: ${countForm4})`
  );

  return filtered;
}
