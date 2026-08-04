/**
 * In-flight bridge between the backend and browser for browser-executed
 * tools. The backend pauses the SSE stream on a tool call, the browser runs the
 * code and POSTs the result to /api/tool/result, which resolves this promise.
 *
 * The VPS runs one Node process, so an in-memory map correlates the paused
 * SSE request with the browser's result POST.
 */

import type { ToolResult } from "./tools";

interface PendingTool {
  resolve: (result: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Abort wiring so a stopped request releases its pending wait immediately. */
  abort?: { signal: AbortSignal; listener: () => void };
}

const pending = new Map<string, PendingTool>();
const WAIT_TIMEOUT_MS = 90_000;

function key(requestId: string, toolCallId: string): string {
  return `tool_${requestId}_${toolCallId}`.replace(/[^A-Za-z0-9_]/g, "_");
}

export function awaitBrowserToolResult(
  requestId: string,
  toolCallId: string,
  signal?: AbortSignal
): Promise<ToolResult> {
  const entryKey = key(requestId, toolCallId);
  return new Promise<ToolResult>((resolve) => {
    const onAbort = () => {
      const p = pending.get(entryKey);
      if (!p) return;
      clearTimeout(p.timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(entryKey);
      resolve({ ok: false, output: "请求已取消。" });
    };
    const timer = setTimeout(() => {
      const p = pending.get(entryKey);
      if (!p) return;
      if (p.abort) p.abort.signal.removeEventListener("abort", p.abort.listener);
      pending.delete(entryKey);
      resolve({ ok: false, output: "浏览器端工具执行超时，未能返回结果。" });
    }, WAIT_TIMEOUT_MS);
    pending.set(entryKey, {
      resolve,
      timer,
      abort: signal ? { signal, listener: onAbort } : undefined,
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Returns false when no stream is waiting for this tool call. */
export async function deliverBrowserToolResult(
  requestId: string,
  toolCallId: string,
  result: ToolResult
): Promise<boolean> {
  const p = pending.get(key(requestId, toolCallId));
  if (!p) return false;
  clearTimeout(p.timer);
  if (p.abort) p.abort.signal.removeEventListener("abort", p.abort.listener);
  pending.delete(key(requestId, toolCallId));
  p.resolve(result);
  return true;
}

/** Resolve every pending wait belonging to a request (e.g. the client aborted). */
export function cancelBrowserToolWaits(requestId: string): void {
  const prefix = key(requestId, "");
  for (const [entryKey, p] of [...pending]) {
    if (!entryKey.startsWith(prefix)) continue;
    clearTimeout(p.timer);
    if (p.abort) p.abort.signal.removeEventListener("abort", p.abort.listener);
    pending.delete(entryKey);
    p.resolve({ ok: false, output: "请求已取消。" });
  }
}
