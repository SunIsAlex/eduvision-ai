import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_BASE_URL, type Env } from "./types";

export function createClient(env: Env): Anthropic {
  return new Anthropic({
    apiKey: env.API_KEY,
    baseURL: env.API_URL ?? DEFAULT_BASE_URL,
    maxRetries: 1,
    timeout: 120_000,
  });
}

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

export interface RoundResult {
  reasoning: string;
  content: string;
  toolCalls: ToolCallParts[];
  finishReason: string | null;
  assistantContent: Anthropic.Messages.ContentBlock[];
}

/** Convert Anthropic's native Messages SSE stream to the app's provider-neutral deltas. */
export async function* streamRound(
  stream: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>
): AsyncGenerator<StreamDelta, RoundResult, unknown> {
  let reasoning = "";
  let content = "";
  let finishReason: string | null = null;
  let emitted = false;
  const blocks = new Map<number, Anthropic.Messages.ContentBlock>();
  const toolJson = new Map<number, string>();
  const thinkingText = new Map<number, string>();
  const thinkingSignature = new Map<number, string>();

  try {
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        blocks.set(event.index, event.content_block);
        if (event.content_block.type === "tool_use") toolJson.set(event.index, "");
        if (event.content_block.type === "thinking") {
          thinkingText.set(event.index, "");
          thinkingSignature.set(event.index, "");
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          emitted = true;
          content += delta.text;
          yield { kind: "content", text: delta.text };
        } else if (delta.type === "thinking_delta") {
          emitted = true;
          reasoning += delta.thinking;
          thinkingText.set(event.index, (thinkingText.get(event.index) ?? "") + delta.thinking);
          yield { kind: "reasoning", text: delta.thinking };
        } else if (delta.type === "signature_delta") {
          thinkingSignature.set(
            event.index,
            (thinkingSignature.get(event.index) ?? "") + delta.signature
          );
        } else if (delta.type === "input_json_delta") {
          emitted = true;
          toolJson.set(event.index, (toolJson.get(event.index) ?? "") + delta.partial_json);
        }
      } else if (event.type === "message_delta") {
        finishReason = event.delta.stop_reason;
      }
    }
  } catch (err) {
    if (!emitted) throw err;
    console.warn("[stream] connection closed after partial response:", (err as Error).message);
  }

  const assistantContent = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, block]) => {
      if (block.type === "text") return { ...block, text: block.text + (index === 0 ? content : "") };
      if (block.type === "tool_use") {
        const raw = toolJson.get(index) ?? "{}";
        let input: unknown = {};
        try { input = JSON.parse(raw); } catch { input = { raw }; }
        return { ...block, input };
      }
      if (block.type === "thinking") {
        return {
          ...block,
          thinking: thinkingText.get(index) ?? block.thinking,
          signature: thinkingSignature.get(index) ?? block.signature,
        };
      }
      return block;
    });

  // Text block starts are empty in streaming responses; ensure the accumulated text is retained.
  const textBlock = assistantContent.find((block) => block.type === "text");
  if (textBlock?.type === "text") textBlock.text = content;
  else if (content) assistantContent.unshift({ type: "text", text: content, citations: null });

  const toolCalls = assistantContent
    .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, args: JSON.stringify(block.input) }));

  return { reasoning, content, toolCalls, finishReason, assistantContent };
}
