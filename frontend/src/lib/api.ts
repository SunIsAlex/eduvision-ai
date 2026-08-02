import type { ApiMessage } from "./types";
import { runTool } from "./toolRunner";

export interface StreamCallbacks {
  onDebug?: (event: string, data: Record<string, unknown>) => void;
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

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        await handleFrame(frame, callbacks, { requestId: request.requestId, signal });
      }
    }
    if (buffer.trim()) {
      await handleFrame(buffer, callbacks, { requestId: request.requestId, signal });
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
}

async function handleFrame(
  frame: string,
  cb: StreamCallbacks,
  ctx: { requestId: string; signal?: AbortSignal }
): Promise<void> {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const data = dataLines.join("\n");
  if (!data) return;

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
      case "reasoning":
        if (parsed.text) cb.onReasoning(parsed.text);
        break;
      case "tool_call": {
        const toolCallId = parsed.toolCallId ?? "";
        const name = parsed.name ?? "";
        const args = parsed.args ?? "{}";
        const executor = parsed.executor === "server" ? "server" : "browser";
        cb.onToolCall({ toolCallId, name, args, executor });
        // Every tool currently runs in the browser: execute locally, then POST
        // the result back so the paused SSE stream can continue.
        const result = await runTool({ name, args });
        cb.onToolResult({ toolCallId, name, ok: result.ok, output: result.output });
        try {
          const res = await fetch("/api/tool/result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requestId: ctx.requestId,
              toolCallId,
              ok: result.ok,
              output: result.output,
            }),
            signal: ctx.signal,
          });
          if (!res.ok) {
            console.warn("[tool] result delivery failed:", res.status);
          }
        } catch (err) {
          // Worker-side wait will time out and continue with an error result.
          console.warn("[tool] result delivery error:", (err as Error).message);
        }
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
}

/** Upload an image; returns a data URL (dev fallback) or /media/ URL (R2). */
export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(`上传失败（${res.status}）`);
  const data = (await res.json()) as { url: string };
  return data.url;
}
