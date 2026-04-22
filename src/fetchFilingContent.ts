import { getRaw } from "./secHttpClient";

export class FilingFetchError extends Error {
  readonly url: string;
  readonly statusCode: number;
  readonly statusText: string;
  readonly contentType: string | null;

  constructor(opts: {
    url: string;
    statusCode: number;
    statusText: string;
    contentType: string | null;
  }) {
    super(
      `Failed to fetch filing at ${opts.url}: HTTP ${opts.statusCode} ${opts.statusText}`
    );
    this.name = "FilingFetchError";
    this.url = opts.url;
    this.statusCode = opts.statusCode;
    this.statusText = opts.statusText;
    this.contentType = opts.contentType;
    Object.setPrototypeOf(this, FilingFetchError.prototype);
  }
}

// Extracts charset from Content-Type headers such as:
//   "text/html; charset=windows-1252"
//   "text/plain; charset=UTF-8"
// Returns null if no charset directive is present.
function parseCharset(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = contentType.match(/charset\s*=\s*([^\s;]+)/i);
  return match ? match[1].trim() : null;
}

function isSupportedTextType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return (
    lower.startsWith("text/html") ||
    lower.startsWith("text/plain") ||
    lower.startsWith("application/xml") ||
    lower.startsWith("text/xml")
  );
}

export async function fetchFilingContent(url: string): Promise<string> {
  if (!url || !url.trim()) {
    throw new TypeError("[fetchFilingContent] url must be a non-empty string");
  }

  const response = await getRaw<string>(url, "text");

  const status = response.status;
  const rawContentType: string | null =
    response.headers?.["content-type"] ?? null;

  if (status < 200 || status >= 300) {
    throw new FilingFetchError({
      url,
      statusCode: status,
      statusText: response.statusText ?? String(status),
      contentType: rawContentType,
    });
  }

  const charset = parseCharset(rawContentType) ?? "utf-8";

  // axios responseType:"text" always decodes via its own default (UTF-8).
  // For filings with a non-UTF-8 charset declaration we re-decode from the
  // raw buffer using the TextDecoder API.
  //
  // Most SEC filings are UTF-8 or windows-1252; TextDecoder accepts both
  // (and silently replaces unmappable bytes with U+FFFD rather than throwing).
  const normalizedCharset = charset.toLowerCase();
  if (
    normalizedCharset !== "utf-8" &&
    normalizedCharset !== "utf8" &&
    typeof response.data === "string" &&
    isSupportedTextType(rawContentType)
  ) {
    try {
      const decoder = new TextDecoder(charset, { fatal: false });
      const encoded = new TextEncoder().encode(response.data);
      return decoder.decode(encoded);
    } catch {
      console.warn(
        `[fetchFilingContent] Unknown charset "${charset}" for ${url}; using raw axios text`
      );
    }
  }

  if (typeof response.data !== "string") {
    throw new FilingFetchError({
      url,
      statusCode: status,
      statusText: "Non-text response body",
      contentType: rawContentType,
    });
  }

  return response.data;
}
