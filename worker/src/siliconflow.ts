import OpenAI from "openai";
import { DEFAULT_BASE_URL, type Env } from "./types";

/**
 * Thin wrapper around the official OpenAI SDK pointed at SiliconFlow's
 * OpenAI-compatible endpoint. The API key always comes from worker secrets,
 * never from the frontend or bundled code.
 */
export function createClient(env: Env): OpenAI {
  return new OpenAI({
    apiKey: env.SILICONFLOW_API_KEY,
    baseURL: env.SILICONFLOW_BASE_URL ?? DEFAULT_BASE_URL,
    // Workers have one shot per request; do not retry on top of platform retries.
    maxRetries: 0,
    timeout: 120_000,
  });
}

/**
 * Build the content array for a multimodal message. The original image is
 * passed through as a data URL so Qwen3-VL can reason over pixels — never
 * downgraded to OCR text.
 */
export function visionContent(
  text: string,
  image?: string
): OpenAI.Chat.ChatCompletionContentPart[] {
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text }];
  if (image) {
    parts.push({ type: "image_url", image_url: { url: image } });
  }
  return parts;
}

/** One delta from the streaming completion, forwarded to the SSE pipeline. */
export type StreamDelta =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
  | {
      kind: "debug";
      round: number;
      finishReason: string | null;
      reasoning: string;
      content: string;
      toolCalls: ToolCallParts[];
    }
  | {
      kind: "tool_call";
      requestId: string;
      toolCallId: string;
      name: string;
      args: string;
      executor: "server" | "browser";
    }
  | {
      kind: "tool_result";
      requestId: string;
      toolCallId: string;
      name: string;
      ok: boolean;
      output: string;
    };

export interface ToolCallParts {
  id: string;
  name: string;
  args: string;
}

/** Everything collected from one streaming round (one model call). */
export interface RoundResult {
  reasoning: string;
  content: string;
  toolCalls: ToolCallParts[];
  finishReason: string | null;
}

/**
 * Extract both reasoning and content deltas from a streaming completion.
 * Reasoning (the model's raw chain-of-thought) is forwarded live so the
 * frontend can show the thinking process as it happens. Tool-call fragments
 * are accumulated (providers split them across chunks) and returned as the
 * round result when the stream ends.
 */
export async function* streamRound(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
): AsyncGenerator<StreamDelta, RoundResult, unknown> {
  let emitted = false;
  let reasoning = "";
  let content = "";
  let finishReason: string | null = null;
  const calls = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  try {
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta as OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
        reasoning_content?: string;
        tool_calls?: {
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      };
      if (
        delta?.reasoning_content &&
        typeof delta.reasoning_content === "string"
      ) {
        emitted = true;
        reasoning += delta.reasoning_content;
        yield { kind: "reasoning", text: delta.reasoning_content };
      }
      if (delta?.content && typeof delta.content === "string") {
        emitted = true;
        content += delta.content;
        yield { kind: "content", text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        emitted = true;
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id += tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
  } catch (err) {
    // SiliconFlow sometimes closes the SSE socket without a clean EOF after
    // the final chunk. If we already received content (or a tool call), the
    // round is complete — treat the premature close as a normal end.
    if (!emitted) throw err;
    console.warn(
      "[stream] connection closed prematurely after content:",
      (err as Error).message
    );
  }
  return {
    reasoning,
    content,
    toolCalls: [...calls.values()].filter((c) => c.name !== ""),
    finishReason,
  };
}
