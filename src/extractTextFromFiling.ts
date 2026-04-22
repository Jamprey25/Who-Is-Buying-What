import * as cheerio from "cheerio";

// ~4 chars per token for English-heavy legal text; 12,000 tokens × 4 = 48,000.
const MAX_CHARS = 48_000;

// Block-level HTML elements whose boundaries should produce a newline in the
// extracted text so paragraph structure is preserved.
const BLOCK_ELEMENTS = new Set([
  "p", "div", "section", "article", "header", "footer", "main",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "dt", "dd",
  "tr", "td", "th",
  "blockquote", "pre", "figure", "figcaption",
  "address", "aside",
]);

// Inline XBRL elements whose text content should still be extracted — only the
// wrapper tags are stripped.
const XBRL_INLINE_PASSTHROUGH = new Set([
  "ix:nonnumeric",
  "ix:nonfraction",
  "ix:continuation",
  "ix:header",
  "ix:hidden",
  "xbrl",
]);

// Elements that should be removed entirely including all their content.
const REMOVE_ENTIRELY = new Set([
  "script", "style", "noscript", "svg", "canvas", "iframe",
  "head", "meta", "link", "object", "embed",
  // XBRL schema and reference blocks carry no human-readable text.
  "ix:references", "ix:resources", "xbrli:xbrl",
  "link:schemaref", "xbrldi:explicitmember",
]);

function shouldRemoveEntirely(tagName: string): boolean {
  return REMOVE_ENTIRELY.has(tagName.toLowerCase());
}

function isXbrlInlinePassthrough(tagName: string): boolean {
  return XBRL_INLINE_PASSTHROUGH.has(tagName.toLowerCase());
}

function isBlockElement(tagName: string): boolean {
  return BLOCK_ELEMENTS.has(tagName.toLowerCase());
}

// Recursively walk the DOM and collect text tokens.
// Inserting "\n" sentinels at block element boundaries means we never need a
// second pass to reconstruct paragraph structure.
function collectText(
  $: cheerio.CheerioAPI,
  node: cheerio.AnyNode,
  tokens: string[]
): void {
  if (node.type === "text") {
    const text = (node as cheerio.Text).data ?? "";
    // Normalize internal whitespace in text nodes; outer collapse happens later.
    const normalized = text.replace(/[\t\r\f\v ]+/g, " ");
    if (normalized.trim()) {
      tokens.push(normalized);
    }
    return;
  }

  if (node.type !== "tag") return;

  const el = node as cheerio.Element;
  const tag = el.tagName?.toLowerCase() ?? "";

  if (shouldRemoveEntirely(tag)) return;

  // For passthrough XBRL wrappers, descend without emitting block boundaries.
  if (isXbrlInlinePassthrough(tag)) {
    for (const child of el.children ?? []) {
      collectText($, child, tokens);
    }
    return;
  }

  const isBlock = isBlockElement(tag);
  if (isBlock) tokens.push("\n");

  for (const child of el.children ?? []) {
    collectText($, child, tokens);
  }

  if (isBlock) tokens.push("\n");
}

function collapseWhitespace(raw: string): string {
  return (
    raw
      // Collapse runs of spaces (not newlines) down to one space.
      .replace(/[^\S\n]+/g, " ")
      // Collapse 3+ consecutive newlines into exactly 2 (one blank line max).
      .replace(/\n{3,}/g, "\n\n")
      // Strip lines that are only whitespace.
      .replace(/^ +$/gm, "")
      .trim()
  );
}

export function extractTextFromFiling(html: string): string {
  if (!html || !html.trim()) return "";

  const $ = cheerio.load(html, {
    // xmlMode: false preserves HTML5 parsing semantics (void elements, etc.).
    xmlMode: false,
    // Decode HTML entities automatically.
    decodeEntities: true,
  });

  const tokens: string[] = [];
  const root = $.root().get(0);

  if (root) {
    for (const child of (root as cheerio.Element).children ?? []) {
      collectText($, child, tokens);
    }
  }

  const joined = tokens.join("");
  const collapsed = collapseWhitespace(joined);

  // Truncate at the nearest newline boundary before MAX_CHARS to avoid cutting
  // mid-sentence while still respecting the token budget.
  if (collapsed.length <= MAX_CHARS) return collapsed;

  const cutPoint = collapsed.lastIndexOf("\n", MAX_CHARS);
  const truncateAt = cutPoint > MAX_CHARS * 0.9 ? cutPoint : MAX_CHARS;

  return collapsed.slice(0, truncateAt).trimEnd();
}
