/**
 * src/llmCache.ts — Filesystem-backed LLM response cache.
 *
 * Keyed by sha256(provider|model|system|user|maxTokens|json).
 * Entries live forever: the key encodes every input that could change
 * the output, so a stale entry is by construction impossible — changing
 * any of those inputs produces a different hash and therefore a different
 * file.
 *
 * Opt-in via LLM_CACHE=1. Disabled by default so production never writes
 * unbounded disk state.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = path.resolve(process.cwd(), ".cache", "llm");

export interface CacheKeyInput {
  provider: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  json: boolean;
}

export function cacheEnabled(): boolean {
  return process.env.LLM_CACHE === "1" || process.env.LLM_CACHE === "true";
}

export function cacheKey(input: CacheKeyInput): string {
  const payload = JSON.stringify({
    p: input.provider,
    m: input.model,
    s: input.system,
    u: input.user,
    t: input.maxTokens,
    j: input.json,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

export function readCache(key: string): string | null {
  try {
    const raw = fs.readFileSync(cachePath(key), "utf-8");
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === "string" ? parsed.value : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Corrupt cache entry → treat as miss; don't crash the pipeline.
    return null;
  }
}

export function writeCache(key: string, value: string): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const body = JSON.stringify({
      key,
      value,
      createdAt: new Date().toISOString(),
    });
    const tmp = cachePath(key) + ".tmp";
    fs.writeFileSync(tmp, body, "utf-8");
    fs.renameSync(tmp, cachePath(key));
  } catch {
    // Cache writes are best-effort; never fail the pipeline on cache errors.
  }
}
