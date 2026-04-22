/**
 * src/llmClient.ts — Provider-agnostic LLM gateway with optional disk cache.
 *
 * Strategy pattern: callers declare a `purpose` (classify | extract | summary)
 * and the gateway decides provider + model based on environment variables.
 *
 * Env vars:
 *   LLM_PROVIDER              Default provider ("anthropic" | "ollama"). Default: "anthropic".
 *   CLASSIFY_PROVIDER         Overrides LLM_PROVIDER for purpose="classify".
 *   EXTRACT_PROVIDER          Overrides LLM_PROVIDER for purpose="extract".
 *   SUMMARY_PROVIDER          Overrides LLM_PROVIDER for purpose="summary".
 *   LLM_CACHE                 "1" enables disk cache. Default: off.
 *   OLLAMA_MODEL              Model name passed to Ollama. Default: "llama3.2:3b".
 *   ANTHROPIC_CLASSIFY_MODEL  Default: "claude-haiku-4-5-20251001"
 *   ANTHROPIC_EXTRACT_MODEL   Default: "claude-haiku-4-5-20251001"
 *   ANTHROPIC_SUMMARY_MODEL   Default: "claude-haiku-4-5-20251001"
 *   ANTHROPIC_EXTRACT_FALLBACK_MODEL  Used on Zod retry. Default: "claude-sonnet-4-6"
 */

import { anthropicComplete } from "./anthropicClient";
import { ollamaComplete } from "./ollamaClient";
import {
  cacheEnabled,
  cacheKey,
  readCache,
  writeCache,
} from "./llmCache";

export type LLMProvider = "anthropic" | "ollama";
export type LLMPurpose = "classify" | "extract" | "summary";

export interface CompleteParams {
  purpose: LLMPurpose;
  system: string;
  user: string;
  maxTokens: number;
  /** Request JSON-mode output (only enforced by Ollama; Anthropic obeys via prompt). */
  json?: boolean;
  /** Override the provider chosen by env. */
  providerOverride?: LLMProvider;
  /** Override the model chosen by env. */
  modelOverride?: string;
}

const ANTHROPIC_DEFAULTS: Record<LLMPurpose, string> = {
  classify: "claude-haiku-4-5-20251001",
  extract: "claude-haiku-4-5-20251001",
  summary: "claude-haiku-4-5-20251001",
};

const ANTHROPIC_ENV_KEYS: Record<LLMPurpose, string> = {
  classify: "ANTHROPIC_CLASSIFY_MODEL",
  extract: "ANTHROPIC_EXTRACT_MODEL",
  summary: "ANTHROPIC_SUMMARY_MODEL",
};

const PURPOSE_PROVIDER_KEYS: Record<LLMPurpose, string> = {
  classify: "CLASSIFY_PROVIDER",
  extract: "EXTRACT_PROVIDER",
  summary: "SUMMARY_PROVIDER",
};

function resolveProvider(purpose: LLMPurpose, override?: LLMProvider): LLMProvider {
  if (override) return override;
  const perPurpose = process.env[PURPOSE_PROVIDER_KEYS[purpose]];
  const fallback = process.env.LLM_PROVIDER;
  const raw = (perPurpose ?? fallback ?? "anthropic").toLowerCase();
  if (raw === "ollama") return "ollama";
  return "anthropic";
}

function resolveModel(
  provider: LLMProvider,
  purpose: LLMPurpose,
  override?: string
): string {
  if (override) return override;
  if (provider === "ollama") {
    return process.env.OLLAMA_MODEL ?? "llama3.2:3b";
  }
  return (
    process.env[ANTHROPIC_ENV_KEYS[purpose]] ?? ANTHROPIC_DEFAULTS[purpose]
  );
}

/**
 * Single entry point for all LLM calls in the pipeline.
 * Transparently consults the disk cache when LLM_CACHE=1.
 */
export async function complete(params: CompleteParams): Promise<string> {
  const provider = resolveProvider(params.purpose, params.providerOverride);
  const model = resolveModel(provider, params.purpose, params.modelOverride);
  const json = params.json ?? false;

  const key = cacheKey({
    provider,
    model,
    system: params.system,
    user: params.user,
    maxTokens: params.maxTokens,
    json,
  });

  if (cacheEnabled()) {
    const hit = readCache(key);
    if (hit !== null) return hit;
  }

  const text =
    provider === "ollama"
      ? await ollamaComplete({
          model,
          system: params.system,
          user: params.user,
          maxTokens: params.maxTokens,
          json,
        })
      : await anthropicComplete({
          model,
          system: params.system,
          user: params.user,
          maxTokens: params.maxTokens,
        });

  if (cacheEnabled()) writeCache(key, text);
  return text;
}

/**
 * Returns the model name that WOULD be used for a given purpose,
 * without making any API call. Useful for logging & fallback logic.
 */
export function resolvedProvider(purpose: LLMPurpose): LLMProvider {
  return resolveProvider(purpose);
}

export function anthropicFallbackExtractModel(): string {
  return (
    process.env.ANTHROPIC_EXTRACT_FALLBACK_MODEL ?? "claude-sonnet-4-6"
  );
}
