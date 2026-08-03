import { streamAnswer } from "./reasoning";
import { resolveModel, type ChatRequest, type Env } from "./types";

/** SSE event shapes sent to the browser. */
export interface StreamEvent {
  event:
    | "thinking"
    | "reasoning"
    | "ocr"
    | "answer"
    | "tool_call"
    | "tool_result"
    | "debug"
    | "done"
    | "error";
  data: string;
}

/** One user-visible status message emitted while the pipeline runs. */
function thinking(text: string): StreamEvent {
  return { event: "thinking", data: JSON.stringify({ text }) };
}

function error(text: string): StreamEvent {
  return { event: "error", data: JSON.stringify({ text }) };
}

function done(model: string): StreamEvent {
  return { event: "done", data: JSON.stringify({ pipeline: "multimodal", model }) };
}

/**
 * Multimodal reasoning pipeline. Provider reasoning, when present, is forwarded as
 * `reasoning` events (rendered live in the UI); the final answer streams as
 * `answer` events. Every upstream failure is converted into an error event so
 * the chat UI always gets a terminal message.
 */
export async function* runPipeline(
  env: Env,
  request: ChatRequest
): AsyncGenerator<StreamEvent, void, unknown> {
  if (!env.API_KEY) {
    yield error("服务端未配置 API_KEY，请联系管理员。");
    return;
  }
  if (!request.image && !request.question?.trim()) {
    yield error("请上传题目图片或输入题目文字。");
    return;
  }

  const model = request.model?.trim() || resolveModel(env.API_MODEL);
  yield thinking(
    request.thinking === true
      ? request.image
        ? "模型正在阅读图片并深度思考…"
        : "模型正在深度思考…"
      : request.image
        ? "模型正在阅读图片并分析题目…"
        : "模型正在分析题目…"
  );

  let emittedContent = false;
  try {
    const gen = streamAnswer(env, {
      question: request.question ?? "",
      image: request.image,
      history: request.history,
      model,
      requestId: request.requestId,
      thinking: request.thinking === true,
    });
    try {
      for await (const delta of gen) {
        if (delta.kind === "reasoning") {
          // Forward Anthropic summarized-thinking deltas live. These are not
          // the model's private/raw chain of thought.
          yield { event: "reasoning", data: JSON.stringify({ text: delta.text }) };
        } else if (delta.kind === "content") {
          emittedContent = true;
          yield { event: "answer", data: JSON.stringify({ text: delta.text }) };
        } else if (delta.kind === "tool_call") {
          yield {
            event: "tool_call",
            data: JSON.stringify({
              requestId: delta.requestId,
              toolCallId: delta.toolCallId,
              name: delta.name,
              args: delta.args,
              executor: delta.executor,
            }),
          };
        } else if (delta.kind === "tool_result") {
          yield {
            event: "tool_result",
            data: JSON.stringify({
              toolCallId: delta.toolCallId,
              name: delta.name,
              ok: delta.ok,
              output: delta.output,
            }),
          };
        } else if (delta.kind === "debug") {
          yield {
            event: "debug",
            data: JSON.stringify({
              round: delta.round,
              finishReason: delta.finishReason,
              reasoning: delta.reasoning,
              content: delta.content,
              toolCalls: delta.toolCalls,
            }),
          };
        }
      }
    } catch (err) {
      // Defensive: if answer content was already streamed, surface it as a
      // successful completion instead of failing after the fact.
      if (emittedContent) {
        console.warn("[stream] generator error after content:", err);
        yield done(model);
        return;
      }
      throw err;
    }
    if (!emittedContent) {
      yield error("模型未返回内容，请重试。");
      return;
    }
    yield done(model);
  } catch (err) {
    console.error("[stream] failed:", err);
    yield error("生成解答时出错，请稍后重试。");
  }
}
