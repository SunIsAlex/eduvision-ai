import { DEFAULT_BASE_URL, type Env } from "./types";
import { createOpenAIStream } from "./openai";

export type ContentBlock = Record<string, unknown> & { type: string };
export type MessageParam = { role: "user" | "assistant"; content: string | ContentBlock[] };
export type ImageBlockParam = ContentBlock;
export type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
export type MessageCreateParamsStreaming = Record<string, unknown> & {
  model: string; max_tokens: number; stream: true; messages: MessageParam[]; tools: Tool[];
};
export type RawMessageStreamEvent = Record<string, any> & { type: string };

/** Minimal fetch-based Anthropic client, compatible with pure V8 edge runtimes. */
export function createClient(env: Env) {
  const baseURL = (env.API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return {
    messages: {
      async create(params: MessageCreateParamsStreaming): Promise<AsyncIterable<RawMessageStreamEvent>> {
        if (!params.model.toLowerCase().startsWith("claude")) {
          return createOpenAIStream(env, params);
        }
        const response = await fetch(`${baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(params),
        });
        if (!response.ok) {
          throw new Error(`Anthropic API ${response.status}: ${(await response.text()).slice(0, 500)}`);
        }
        if (!response.body) throw new Error("Anthropic API 未返回数据流");
        return parseSse(response.body);
      },
    },
  };
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<RawMessageStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        yield JSON.parse(data) as RawMessageStreamEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type StreamDelta =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
  | { kind: "debug"; round: number; finishReason: string | null; reasoning: string; content: string; toolCalls: ToolCallParts[] }
  | { kind: "tool_call"; requestId: string; toolCallId: string; name: string; args: string; executor: "server" | "browser" }
  | { kind: "tool_result"; requestId: string; toolCallId: string; name: string; ok: boolean; output: string };

export interface ToolCallParts { id: string; name: string; args: string }
export interface RoundResult {
  reasoning: string; content: string; toolCalls: ToolCallParts[];
  finishReason: string | null; assistantContent: ContentBlock[];
}

export async function* streamRound(stream: AsyncIterable<RawMessageStreamEvent>): AsyncGenerator<StreamDelta, RoundResult, unknown> {
  let reasoning = "", content = "", finishReason: string | null = null, emitted = false;
  const blocks = new Map<number, ContentBlock>(), toolJson = new Map<number, string>();
  const thinkingText = new Map<number, string>(), thinkingSignature = new Map<number, string>();
  try {
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        blocks.set(event.index, event.content_block);
        if (event.content_block.type === "tool_use") toolJson.set(event.index, "");
        if (event.content_block.type === "thinking") { thinkingText.set(event.index, ""); thinkingSignature.set(event.index, ""); }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") { emitted = true; content += delta.text; yield { kind: "content", text: delta.text }; }
        else if (delta.type === "thinking_delta") { emitted = true; reasoning += delta.thinking; thinkingText.set(event.index, (thinkingText.get(event.index) ?? "") + delta.thinking); yield { kind: "reasoning", text: delta.thinking }; }
        else if (delta.type === "signature_delta") thinkingSignature.set(event.index, (thinkingSignature.get(event.index) ?? "") + delta.signature);
        else if (delta.type === "input_json_delta") { emitted = true; toolJson.set(event.index, (toolJson.get(event.index) ?? "") + delta.partial_json); }
      } else if (event.type === "message_delta") finishReason = event.delta.stop_reason;
    }
  } catch (err) { if (!emitted) throw err; console.warn("[stream] connection closed after partial response:", (err as Error).message); }

  const assistantContent = [...blocks.entries()].sort(([a], [b]) => a - b).map(([index, block]) => {
    if (block.type === "text") return { ...block, text: content };
    if (block.type === "tool_use") { const raw = toolJson.get(index) ?? "{}"; let input: unknown; try { input = JSON.parse(raw); } catch { input = { raw }; } return { ...block, input }; }
    if (block.type === "thinking") return { ...block, thinking: thinkingText.get(index) ?? "", signature: thinkingSignature.get(index) ?? "" };
    return block;
  });
  if (content && !assistantContent.some((block) => block.type === "text")) assistantContent.unshift({ type: "text", text: content });
  const toolCalls = assistantContent.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), args: JSON.stringify(b.input) }));
  return { reasoning, content, toolCalls, finishReason, assistantContent };
}
