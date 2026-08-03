import { DEFAULT_BASE_URL, type Env } from "./types";
import type {
  ContentBlock,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
} from "./anthropic";
import { queuedPooledFetch } from "./upstream";

type OpenAIMessage = Record<string, unknown>;

function messageText(blocks: ContentBlock[]): string {
  return blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
}

function toOpenAIMessages(messages: MessageParam[]): OpenAIMessage[] {
  const output: OpenAIMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      output.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content;
    if (message.role === "assistant") {
      const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block) => ({
        id: String(block.id),
        type: "function",
        function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) },
      }));
      output.push({
        role: "assistant",
        content: messageText(blocks) || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const toolResults = blocks.filter((block) => block.type === "tool_result");
    for (const block of toolResults) {
      output.push({
        role: "tool",
        tool_call_id: String(block.tool_use_id),
        content: String(block.content ?? ""),
      });
    }
    const ordinary = blocks.filter((block) => block.type !== "tool_result");
    if (ordinary.length) {
      output.push({
        role: "user",
        content: ordinary.map((block) => {
          if (block.type === "image") {
            const source = block.source as Record<string, unknown> | undefined;
            const url = source?.type === "base64"
              ? `data:${String(source.media_type)};base64,${String(source.data)}`
              : String(source?.url ?? "");
            return { type: "image_url", image_url: { url } };
          }
          return { type: "text", text: String(block.text ?? "") };
        }),
      });
    }
  }
  return output;
}

/** OpenAI-compatible streaming adapter which emits the internal Anthropic-shaped events. */
export async function createOpenAIStream(
  env: Env,
  params: MessageCreateParamsStreaming
): Promise<AsyncIterable<RawMessageStreamEvent>> {
  const baseURL = (env.API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const summarizedThinking = Boolean(params.thinking);
  const supportsReasoningEffort = /^(?:gpt-|o\d|codex)/i.test(params.model);
  const system = String(params.system ?? "") + (summarizedThinking
    ? "\n\n当前已开启思考摘要。你必须严格按以下顺序输出：先输出 <reasoning_summary>，接着用 1～3 句写给学生看的简短思路摘要，再输出 </reasoning_summary>，最后输出正常答案。摘要只写关键方法和检查点，不写内部自我对话，不重复完整解答。标签必须原样输出且不得放入 Markdown 代码块。"
    : "");
  const body = {
    model: params.model,
    stream: true,
    max_tokens: params.max_tokens,
    messages: [
      { role: "system", content: system },
      ...toOpenAIMessages(params.messages),
    ],
    tools: params.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    })),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(supportsReasoningEffort
      ? { reasoning_effort: summarizedThinking ? "low" : "none" }
      : {}),
    ...(params.tool_choice && (params.tool_choice as Record<string, unknown>).type === "tool"
      ? {
          tool_choice: {
            type: "function",
            function: { name: String((params.tool_choice as Record<string, unknown>).name) },
          },
        }
      : {}),
  };
  const { response, release } = await queuedPooledFetch(env, `${baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } finally {
      release();
    }
    throw new Error(`OpenAI API ${response.status}: ${detail}`);
  }
  if (!response.body) {
    release();
    throw new Error("OpenAI API 未返回数据流");
  }
  return translateOpenAIStream(response.body, summarizedThinking, release);
}

const SUMMARY_OPEN = "<reasoning_summary>";
const SUMMARY_CLOSE = "</reasoning_summary>";

async function* translateOpenAIStream(
  body: ReadableStream<Uint8Array>,
  summarizedThinking: boolean,
  release: () => void
): AsyncGenerator<RawMessageStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textStarted = false;
  let reasoningStarted = false;
  let finishReason: string | null = null;
  const startedTools = new Set<number>();
  let summaryMode: "awaiting" | "summary" | "answer" = summarizedThinking ? "awaiting" : "answer";
  let summaryBuffer = "";

  function* emitContent(text: string): Generator<RawMessageStreamEvent> {
    if (!text) return;
    if (!textStarted) {
      textStarted = true;
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
    }
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  }

  function* emitReasoning(text: string): Generator<RawMessageStreamEvent> {
    if (!text) return;
    if (!reasoningStarted) {
      reasoningStarted = true;
      yield { type: "content_block_start", index: 1000, content_block: { type: "thinking" } };
    }
    yield { type: "content_block_delta", index: 1000, delta: { type: "thinking_delta", thinking: text } };
  }

  function* routeContent(text: string): Generator<RawMessageStreamEvent> {
    summaryBuffer += text;
    for (;;) {
      if (summaryMode === "answer") {
        const output = summaryBuffer;
        summaryBuffer = "";
        yield* emitContent(output);
        return;
      }
      if (summaryMode === "awaiting") {
        const marker = summaryBuffer.indexOf(SUMMARY_OPEN);
        if (marker < 0) return;
        summaryBuffer = summaryBuffer.slice(marker + SUMMARY_OPEN.length);
        summaryMode = "summary";
        continue;
      }
      const marker = summaryBuffer.indexOf(SUMMARY_CLOSE);
      if (marker >= 0) {
        yield* emitReasoning(summaryBuffer.slice(0, marker).trimStart());
        summaryBuffer = summaryBuffer.slice(marker + SUMMARY_CLOSE.length).replace(/^\s+/, "");
        summaryMode = "answer";
        continue;
      }
      const safeLength = summaryBuffer.length - SUMMARY_CLOSE.length + 1;
      if (safeLength > 0) {
        yield* emitReasoning(summaryBuffer.slice(0, safeLength));
        summaryBuffer = summaryBuffer.slice(safeLength);
      }
      return;
    }
  }
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
        const chunk = JSON.parse(data) as Record<string, any>;
        if (chunk.error) throw new Error(`OpenAI stream error: ${JSON.stringify(chunk.error).slice(0, 500)}`);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          if (!reasoningStarted) {
            reasoningStarted = true;
            yield { type: "content_block_start", index: 1000, content_block: { type: "thinking" } };
          }
          yield { type: "content_block_delta", index: 1000, delta: { type: "thinking_delta", thinking: reasoning } };
        }
        if (typeof delta.content === "string" && delta.content) {
          yield* routeContent(delta.content);
        }
        for (const toolCall of delta.tool_calls ?? []) {
          const index = Number(toolCall.index ?? 0) + 1;
          if (!startedTools.has(index)) {
            startedTools.add(index);
            yield {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: String(toolCall.id ?? `call_${crypto.randomUUID()}`),
                name: String(toolCall.function?.name ?? ""),
                input: {},
              },
            };
          }
          if (toolCall.function?.arguments) {
            yield {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: String(toolCall.function.arguments) },
            };
          }
        }
        if (choice.finish_reason) finishReason = String(choice.finish_reason);
      }
    }
  } finally {
    reader.releaseLock();
    release();
  }
  if (summaryBuffer) {
    const finalSummaryMode = summaryMode as string;
    if (finalSummaryMode === "awaiting") yield* emitContent(summaryBuffer);
    else if (finalSummaryMode === "summary") yield* emitReasoning(summaryBuffer);
    else yield* emitContent(summaryBuffer);
  }
  yield { type: "message_delta", delta: { stop_reason: finishReason } };
}
