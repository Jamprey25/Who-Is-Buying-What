/**
 * src/anthropicClient.ts — Thin wrapper around the Anthropic SDK.
 *
 * Exposes a single `complete(...)` function returning raw text so the
 * higher-level llmClient can treat it interchangeably with the Ollama
 * provider.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface AnthropicCompleteParams {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

let cached: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cached) cached = new Anthropic();
  return cached;
}

export async function anthropicComplete(
  params: AnthropicCompleteParams
): Promise<string> {
  const client = getClient();
  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
  });

  const block = response.content[0];
  return block && block.type === "text" ? block.text.trim() : "";
}
