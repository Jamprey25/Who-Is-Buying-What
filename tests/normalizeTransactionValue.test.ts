import {
  normalizeTransactionValue,
} from "../src/normalizeTransactionValue";

describe("normalizeTransactionValue", () => {
  describe("null / undisclosed inputs", () => {
    it("returns null for null input", () => {
      expect(normalizeTransactionValue(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(normalizeTransactionValue("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(normalizeTransactionValue("   ")).toBeNull();
    });

    it('returns null for "undisclosed"', () => {
      expect(normalizeTransactionValue("undisclosed")).toBeNull();
    });

    it('returns null for "not disclosed"', () => {
      expect(normalizeTransactionValue("not disclosed")).toBeNull();
    });

    it('returns null for "N/A"', () => {
      expect(normalizeTransactionValue("N/A")).toBeNull();
    });

    it("returns null when no parseable number is found", () => {
      expect(normalizeTransactionValue("deal value pending")).toBeNull();
    });
  });

  describe("USD word-form multipliers", () => {
    it('parses "$1.2 billion"', () => {
      expect(normalizeTransactionValue("$1.2 billion")).toBe(1_200_000_000);
    });

    it('parses "$450 million"', () => {
      expect(normalizeTransactionValue("$450 million")).toBe(450_000_000);
    });

    it('parses "$2.5 trillion"', () => {
      expect(normalizeTransactionValue("$2.5 trillion")).toBe(2_500_000_000_000);
    });

    it('parses "$750 thousand"', () => {
      expect(normalizeTransactionValue("$750 thousand")).toBe(750_000);
    });
  });

  describe("USD abbreviated multipliers", () => {
    it('parses "$1.2B"', () => {
      expect(normalizeTransactionValue("$1.2B")).toBe(1_200_000_000);
    });

    it('parses "$450M"', () => {
      expect(normalizeTransactionValue("$450M")).toBe(450_000_000);
    });

    it('parses "$3T"', () => {
      expect(normalizeTransactionValue("$3T")).toBe(3_000_000_000_000);
    });

    it('parses "$500K"', () => {
      expect(normalizeTransactionValue("$500K")).toBe(500_000);
    });
  });

  describe("ranges (midpoint)", () => {
    it('parses "approximately $500M to $600M"', () => {
      expect(
        normalizeTransactionValue("approximately $500M to $600M")
      ).toBe(550_000_000);
    });

    it('parses "$1 billion to $1.5 billion"', () => {
      expect(
        normalizeTransactionValue("$1 billion to $1.5 billion")
      ).toBe(1_250_000_000);
    });

    it('parses "between $200M and $300M"', () => {
      expect(
        normalizeTransactionValue("between $200M and $300M")
      ).toBe(250_000_000);
    });
  });

  describe("non-USD currencies", () => {
    it("converts £800 million to USD at default GBP rate (1.27)", () => {
      expect(normalizeTransactionValue("£800 million")).toBe(
        800_000_000 * 1.27
      );
    });

    it("converts £800 million to USD at a custom GBP rate", () => {
      expect(
        normalizeTransactionValue("£800 million", {
          exchangeRates: { GBP: 1.30 },
        })
      ).toBe(800_000_000 * 1.30);
    });

    it("converts €500M to USD at default EUR rate (1.09)", () => {
      expect(normalizeTransactionValue("€500M")).toBeCloseTo(
        500_000_000 * 1.09,
        0
      );
    });
  });

  describe("number formatting edge cases", () => {
    it("handles comma-separated thousands: $1,200,000,000", () => {
      expect(normalizeTransactionValue("$1,200 million")).toBe(1_200_000_000);
    });

    it("handles leading text: 'valued at $3.5 billion'", () => {
      expect(normalizeTransactionValue("valued at $3.5 billion")).toBe(
        3_500_000_000
      );
    });
  });
});
