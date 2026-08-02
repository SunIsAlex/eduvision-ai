/**
 * In-flight bridge between the Worker and the browser for browser-executed
 * tools. The Worker pauses the SSE stream on a tool call, the browser runs the
 * code and POSTs the result to /api/tool/result, which resolves this promise.
 *
 * EdgeOne deployments use a bound KV namespace so the POST may land on a
 * different isolate. Local development falls back to the in-memory bridge.
 */

import type { ToolResult } from "./tools";

interface PendingTool {
  resolve: (result: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingTool>();
const WAIT_TIMEOUT_MS = 90_000;
type ToolResultStore = NonNullable<import("./types").Env["TOOL_RESULTS"]>;

function key(requestId: string, toolCallId: string): string {
  return `tool_${requestId}_${toolCallId}`.replace(/[^A-Za-z0-9_]/g, "_");
}

export function awaitBrowserToolResult(
  requestId: string,
  toolCallId: string,
  store?: ToolResultStore
): Promise<ToolResult> | ReturnType<typeof waitForStoredResult> {
  if (store) return waitForStoredResult(store, key(requestId, toolCallId));
  return new Promise<ToolResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(key(requestId, toolCallId));
      resolve({ ok: false, output: "浏览器端工具执行超时，未能返回结果。" });
    }, WAIT_TIMEOUT_MS);
    pending.set(key(requestId, toolCallId), { resolve, timer });
  });
}

async function waitForStoredResult(store: ToolResultStore, resultKey: string): Promise<ToolResult> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await store.get(resultKey);
    if (value) {
      await store.delete(resultKey);
      return JSON.parse(value) as ToolResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ok: false, output: "浏览器端工具执行超时，未能返回结果。" };
}

/** Returns false when no stream is waiting for this tool call. */
export async function deliverBrowserToolResult(
  requestId: string,
  toolCallId: string,
  result: ToolResult,
  store?: ToolResultStore
): Promise<boolean> {
  if (store) {
    await store.put(key(requestId, toolCallId), JSON.stringify(result));
    return true;
  }
  const p = pending.get(key(requestId, toolCallId));
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(key(requestId, toolCallId));
  p.resolve(result);
  return true;
}
