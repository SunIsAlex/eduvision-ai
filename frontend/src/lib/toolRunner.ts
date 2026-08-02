/**
 * Browser-side tool execution. Both current tools run locally in the user's
 * browser — calculator uses a lazily-loaded hardened mathjs, javascript runs
 * in a Web Worker (no DOM/page access). The result is POSTed back to the
 * Worker, which feeds it to the model and keeps streaming. 风险自负.
 */
import type { ToolResult } from "./types";

const JS_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 20_000;

export async function runTool(tool: { name: string; args: string }): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tool.args) as Record<string, unknown>;
  } catch {
    return { ok: false, output: "工具参数解析失败" };
  }

  switch (tool.name) {
    case "calculator": {
      // mathjs is split into its own chunk and only loaded when first needed.
      const { calc } = await import("./calc");
      try {
        return { ok: true, output: calc(String(args.expression ?? "")) };
      } catch (err) {
        return { ok: false, output: `工具执行失败：${(err as Error).message}` };
      }
    }
    case "javascript":
      return runJavaScript(String(args.code ?? ""));
    default:
      return { ok: false, output: `未知工具：${tool.name}` };
  }
}

/**
 * Execute model-generated JavaScript in a Web Worker. The worker has no DOM
 * access; fetch/importScripts are additionally stubbed out, console.log is
 * captured, and a hard timeout terminates runaway loops. The user accepts the
 * residual risk — this is their own browser.
 */
export function runJavaScript(code: string): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const shim = `
      const __safe = (v) => {
        try {
          if (typeof v === "object" && v !== null) return JSON.stringify(v);
          return String(v);
        } catch {
          return Object.prototype.toString.call(v);
        }
      };
      self.console.log = (...args) => {
        self.postMessage({ type: "log", text: args.map(__safe).join(" ") });
      };
      self.fetch = () => { throw new Error("网络访问已禁用"); };
      self.XMLHttpRequest = undefined;
      self.importScripts = () => { throw new Error("importScripts 已禁用"); };
      (() => {
        try {
          (() => {
            ${code}
          })();
        } catch (err) {
          self.postMessage({ type: "error", text: String((err && err.message) || err) });
          return;
        }
        self.postMessage({ type: "done" });
      })();
    `;

    const url = URL.createObjectURL(new Blob([shim], { type: "text/javascript" }));
    const worker = new Worker(url);
    let out = "";
    let settled = false;

    const finish = (ok: boolean, output: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      const text = output.trim();
      resolve({ ok, output: ok && !text ? "(无输出)" : text });
    };

    const timer = setTimeout(
      () => finish(false, `执行超时（超过 ${JS_TIMEOUT_MS / 1000} 秒）`),
      JS_TIMEOUT_MS
    );

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; text?: string };
      if (msg.type === "log") {
        out = (out + (msg.text ?? "") + "\n").slice(0, MAX_OUTPUT);
      } else if (msg.type === "error") {
        finish(false, msg.text ?? "代码执行出错");
      } else if (msg.type === "done") {
        finish(true, out);
      }
    };
    worker.onerror = (e) => finish(false, e.message || "代码执行出错");
  });
}
