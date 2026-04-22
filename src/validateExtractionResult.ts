import { z } from "zod";
import { type PaymentType } from "./detectPaymentType";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

export const ExtractionResultSchema = z.object({
  acquirer: z.string().min(1, "acquirer must be a non-empty string"),
  target: z.string().min(1, "target must be a non-empty string"),
  transactionValueUSD: z
    .number()
    .positive("transactionValueUSD must be a positive number")
    .nullable(),
  paymentType: z.enum(["CASH", "STOCK", "MIXED", "UNKNOWN"] as const satisfies readonly [PaymentType, ...PaymentType[]]),
  closingDate: z
    .string()
    .regex(ISO_DATE_RE, "closingDate must be an ISO date string (YYYY-MM-DD)")
    .nullable(),
  isAssetPurchase: z.boolean(),
});

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

/** A fully-validated M&A extraction. */
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/** Returned when validation fails — preserves raw data for manual review. */
export interface InvalidExtractionResult {
  isValid: false;
  errors: Array<{ field: string; message: string }>;
  raw: unknown;
}

export type ExtractionValidationResult =
  | (ExtractionResult & { isValid: true })
  | InvalidExtractionResult;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export function validateExtractionResult(
  raw: unknown
): ExtractionValidationResult {
  const result = ExtractionResultSchema.safeParse(raw);

  if (result.success) {
    return { ...result.data, isValid: true };
  }

  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

  for (const { field, message } of errors) {
    console.error(
      `[${new Date().toISOString()}] ExtractionResult validation failed — ${field}: ${message}`
    );
  }

  return { isValid: false, errors, raw };
}
