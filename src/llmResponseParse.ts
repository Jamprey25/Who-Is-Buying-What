/**
 * src/llmResponseParse.ts — Normalise LLM output before JSON.parse.
 *
 * Small local models (Ollama) sometimes wrap JSON in markdown fences or
 * prepend a one-line preamble despite JSON mode. This module strips those
 * artefacts so downstream Zod validation sees a clean object.
 */

/**
 * Removes ```json … ``` fences, generic ``` … ``` blocks, and leading
 * "Here is the JSON:" style chatter before the first `{` or `[`.
 */
export function stripLlmJsonWrapper(raw: string): string {
  let s = raw.trim();

  // ```json ... ``` or ``` ... ```
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/im.exec(s);
  if (fence) s = fence[1].trim();

  // First JSON object or array in the string
  const objStart = s.search(/[{[]/);
  if (objStart > 0) s = s.slice(objStart);

  return s.trim();
}
