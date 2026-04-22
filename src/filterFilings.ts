const DEFAULT_ALLOWLIST = ["8-K", "4"] as const;

/** The raw shape expected by the filter function. */
export interface Filing {
  accessionNumber: string;
  formType: string;
  filedAt: Date;
  companyName: string;
  cik: string;
  filingUrl: string;
}

/**
 * Output shape returned by filterFilingsByFormType.
 * The isAmendment flag is true for any "/A" variant (e.g. 8-K/A, 10-K/A).
 * Downstream agents use this to route amendments through mergeAmendment()
 * instead of inserting a fresh record.
 */
export interface TaggedFiling extends Filing {
  isAmendment: boolean;
}

function normalizeFormType(value: string): string {
  return value.trim().toUpperCase().replace(/^FORM\s+/, "");
}

/**
 * Strips the /A amendment suffix so "8-K/A" compares equal to "8-K"
 * in the allowlist. This ensures amendments are never silently dropped.
 */
function baseFormType(normalized: string): string {
  return normalized.replace(/\/A$/, "");
}

export function filterFilingsByFormType(
  filings: Filing[],
  allowlist: string[] = [...DEFAULT_ALLOWLIST]
): TaggedFiling[] {
  const normalizedAllowlist = new Set(allowlist.map(normalizeFormType));
  const result: TaggedFiling[] = [];

  for (const filing of filings) {
    const normalized = normalizeFormType(filing.formType);
    const base = baseFormType(normalized);
    const isAmendment = normalized.endsWith("/A");

    if (normalizedAllowlist.has(base)) {
      result.push({ ...filing, isAmendment });
    }
  }

  const count8K  = result.filter(f => !f.isAmendment && baseFormType(normalizeFormType(f.formType)) === "8-K").length;
  const count8KA = result.filter(f => f.isAmendment).length;
  const count4   = result.filter(f => baseFormType(normalizeFormType(f.formType)) === "4" && !f.isAmendment).length;

  console.log(
    `Filtered ${filings.length} filings → kept ${result.length} ` +
    `(8-K: ${count8K}, 8-K/A: ${count8KA}, Form 4: ${count4})`
  );

  return result;
}
