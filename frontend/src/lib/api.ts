import type { ApiMessage, ModelOption } from "./types";
import { runTool } from "./toolRunner";

export interface StreamCallbacks {
  onDebug?: (event: string, data: Record<string, unknown>) => void;
  onOcr: (delta: string) => void;
  onThinking: (text: string) => void;
  onReasoning: (delta: string) => void;
  onAnswer: (delta: string) => void;
  onToolCall: (tool: {
    toolCallId: string;
    name: string;
    args: string;
    executor: "server" | "browser";
  }) => void;
  onToolResult: (result: {
    toolCallId: string;
    name: string;
    ok: boolean;
    output: string;
  }) => void;
  onDone: (payload: { pipeline: string; model: string }) => void;
  onError: (text: string) => void;
}

/**
 * POST to /api/chat/stream and consume the SSE stream event by event.
 * Aborts cleanly when `signal` fires (e.g. user hits "stop").
 */
export async function streamChat(
  request: {
    requestId: string;
    image?: string;
    question?: string;
    history: ApiMessage[];
    thinking?: boolean;
    model?: string;
  },
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });

  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      // keep default message
    }
    callbacks.onError(msg);
    return;
  }
  if (!res.body) {
    callbacks.onError("服务端未返回数据流");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let paintDeltas = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = await handleFrame(frame, callbacks, { requestId: request.requestId, signal });
        // One fetch chunk can contain many SSE deltas. Yield a paint frame so
        // React does not batch the whole chunk into one visible text jump.
        if ((event === "answer" || event === "reasoning") && ++paintDeltas % 4 === 0) {
          await new Promise<void>((resolve) => {
            if (document.hidden) window.setTimeout(resolve, 0);
            else requestAnimationFrame(() => resolve());
          });
        }
      }
    }
    if (buffer.trim()) {
      await handleFrame(buffer, callbacks, { requestId: request.requestId, signal });
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
}

export async function fetchModels(): Promise<{
  models: ModelOption[];
  defaultModel: string;
}> {
  const response = await fetch("/api/models", { cache: "no-store" });
  if (!response.ok) throw new Error(`模型列表加载失败（${response.status}）`);
  const body = (await response.json()) as {
    models?: ModelOption[];
    defaultModel?: string;
  };
  if (!Array.isArray(body.models) || typeof body.defaultModel !== "string") {
    throw new Error("模型列表格式无效");
  }
  return { models: body.models, defaultModel: body.defaultModel };
}

async function handleFrame(
  frame: string,
  cb: StreamCallbacks,
  ctx: { requestId: string; signal?: AbortSignal }
): Promise<string> {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const data = dataLines.join("\n");
  if (!data) return event;

  try {
    const parsed = JSON.parse(data) as {
      text?: string;
      pipeline?: string;
      model?: string;
      requestId?: string;
      toolCallId?: string;
      name?: string;
      args?: string;
      executor?: string;
      ok?: boolean;
      output?: string;
    };
    cb.onDebug?.(event, parsed as Record<string, unknown>);
    switch (event) {
      case "thinking":
        if (parsed.text) cb.onThinking(parsed.text);
        break;
      case "answer":
        if (parsed.text) cb.onAnswer(parsed.text);
        break;
      case "ocr":
        if (parsed.text) cb.onOcr(parsed.text);
        break;
      case "reasoning":
        if (parsed.text) cb.onReasoning(parsed.text);
        break;
      case "tool_call": {
        const toolCallId = parsed.toolCallId ?? "";
        const name = parsed.name ?? "";
        const args = parsed.args ?? "{}";
        const executor = parsed.executor === "server" ? "server" : "browser";
        cb.onToolCall({ toolCallId, name, args, executor });
        // Server tools report their result on this same SSE stream. Only
        // browser tools need local execution and a result POST.
        if (executor === "server") break;
        // Do not await here: one SSE frame may contain several independent
        // browser tools, which should start together rather than serialize.
        void executeAndDeliverBrowserTool({ toolCallId, name, args }, cb, ctx);
        break;
      }
      case "tool_result": {
        cb.onToolResult({
          toolCallId: parsed.toolCallId ?? "",
          name: parsed.name ?? "",
          ok: parsed.ok !== false,
          output: parsed.output ?? "",
        });
        break;
      }
      case "done":
        cb.onDone({ pipeline: parsed.pipeline ?? "", model: parsed.model ?? "" });
        break;
      case "error":
        cb.onError(parsed.text ?? "未知错误");
        break;
    }
  } catch {
    // ignore malformed frames
  }
  return event;
}

async function executeAndDeliverBrowserTool(
  tool: { toolCallId: string; name: string; args: string },
  cb: StreamCallbacks,
  ctx: { requestId: string; signal?: AbortSignal }
): Promise<void> {
  const result = await runTool({ name: tool.name, args: tool.args });
  cb.onToolResult({
    toolCallId: tool.toolCallId,
    name: tool.name,
    ok: result.ok,
    output: result.output,
  });
  try {
    const response = await fetch("/api/tool/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: ctx.requestId,
        toolCallId: tool.toolCallId,
        ok: result.ok,
        output: result.output,
      }),
      signal: ctx.signal,
    });
    if (!response.ok) console.warn("[tool] result delivery failed:", response.status);
  } catch (error) {
    // The backend wait will time out and continue with an error result.
    console.warn("[tool] result delivery error:", (error as Error).message);
  }
}

/** Upload an image and receive its compressed data URL. */
export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(`上传失败（${res.status}）`);
  const data = (await res.json()) as { url: string };
  return data.url;
}
