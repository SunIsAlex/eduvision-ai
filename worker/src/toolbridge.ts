/**
 * In-flight bridge between the Worker and the browser for browser-executed
 * tools. The Worker pauses the SSE stream on a tool call, the browser runs the
 * code and POSTs the result to /api/tool/result, which resolves this promise.
 *
 * Note: state lives in memory per isolate. That is fine for the Node dev
 * server and for single-isolate deployments; on multi-isolate Cloudflare
 * accounts a Durable Object (or a stateless continue endpoint) would be the
 * next step.
 */

import type { ToolResult } from "./tools";

interface PendingTool {
  resolve: (result: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingTool>();
const WAIT_TIMEOUT_MS = 90_000;

function key(requestId: string, toolCallId: string): string {
  return `${requestId}:${toolCallId}`;
}

export function awaitBrowserToolResult(
  requestId: string,
  toolCallId: string
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(key(requestId, toolCallId));
      resolve({ ok: false, output: "浏览器端工具执行超时，未能返回结果。" });
    }, WAIT_TIMEOUT_MS);
    pending.set(key(requestId, toolCallId), { resolve, timer });
  });
}

/** Returns false when no stream is waiting for this tool call. */
export function deliverBrowserToolResult(
  requestId: string,
  toolCallId: string,
  result: ToolResult
): boolean {
  const p = pending.get(key(requestId, toolCallId));
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(key(requestId, toolCallId));
  p.resolve(result);
  return true;
}
