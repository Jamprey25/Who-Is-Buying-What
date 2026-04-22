/**
 * src/ollamaClient.ts — HTTP client for a local Ollama instance.
 *
 * Talks to http://localhost:11434/api/chat (default Ollama server port).
 * Uses JSON mode (`format: "json"`) when the caller requests it so that
 * classify/extract prompts reliably produce parseable output.
 *
 * Ollama response shape (stream=false):
 *   {
 *     "message": { "role": "assistant", "content": "..." },
 *     "done": true,
 *     ...
 *   }
 */

import axios, { AxiosError } from "axios";

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export interface OllamaCompleteParams {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  json: boolean;
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
}

export async function ollamaComplete(
  params: OllamaCompleteParams
): Promise<string> {
  const body: Record<string, unknown> = {
    model: params.model,
    stream: false,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
    options: {
      num_predict: params.maxTokens,
      // Low temperature for structured extraction; small models drift otherwise.
      temperature: 0.2,
    },
  };

  if (params.json) body.format = "json";

  try {
    const response = await axios.post<OllamaChatResponse>(
      `${OLLAMA_BASE_URL}/api/chat`,
      body,
      {
        timeout: 120_000,
        headers: { "Content-Type": "application/json" },
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );

    const content = response.data.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `[ollamaComplete] missing message.content in response: ${JSON.stringify(response.data).slice(0, 200)}`
      );
    }
    return content.trim();
  } catch (err) {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      const detail =
        err.response?.data && typeof err.response.data === "object"
          ? JSON.stringify(err.response.data).slice(0, 200)
          : err.message;
      throw new Error(
        `[ollamaComplete] ${status ?? "network"} error calling ${OLLAMA_BASE_URL}/api/chat: ${detail}`
      );
    }
    throw err;
  }
}
