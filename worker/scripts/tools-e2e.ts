/**
 * End-to-end protocol test: consumes the SSE stream like the frontend does,
 * and on `tool_call` executes the tool locally (simulating the browser) and
 * POSTs the result back to /api/tool/result.
 */
import vm from "node:vm";
import { calc } from "../../frontend/src/lib/calc.ts";

const BASE = "http://localhost:8787";

function runJsCapture(code: string): { ok: boolean; output: string } {
  const logs: string[] = [];
  const context = {
    console: { log: (...a: unknown[]) => logs.push(a.map(String).join(" ")) },
    BigInt,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Date,
    RegExp,
    Set,
    Map,
    Infinity,
    NaN,
    undefined,
    fetch: () => {
      throw new Error("网络不可用");
    },
  };
  try {
    vm.runInNewContext(code, context, { timeout: 5000 });
    return { ok: true, output: logs.join("\n") || "(无输出)" };
  } catch (e) {
    return { ok: false, output: String((e as Error).message ?? e) };
  }
}

async function postResult(requestId: string, toolCallId: string, result: { ok: boolean; output: string }) {
  const res = await fetch(`${BASE}/api/tool/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, toolCallId, ok: result.ok, output: result.output }),
  });
  console.log("  → POST /api/tool/result:", res.status, (await res.text()).slice(0, 80));
}

function summarize(p: Record<string, unknown>): string {
  if (p.text !== undefined) return String(p.text).slice(0, 80);
  if (p.name !== undefined) return `${p.name} args=${String(p.args).slice(0, 120)}`;
  return JSON.stringify(p).slice(0, 120);
}

async function runScenario(label: string, question: string) {
  console.log(`\n===== ${label} =====`);
  const requestId = crypto.randomUUID();
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, question }),
  });
  if (!res.ok || !res.body) {
    console.log("stream failed:", res.status, await res.text());
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let reasoningLen = 0;
  let reasoningLastPrint = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join("\n");
      if (!data) continue;
      const parsed = JSON.parse(data) as Record<string, any>;
      if (event === "answer") answer += String(parsed.text ?? "");
      if (event === "reasoning") {
        reasoningLen += String(parsed.text ?? "").length;
        if (reasoningLen - reasoningLastPrint > 1000) {
          reasoningLastPrint = reasoningLen;
          console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] reasoning…(total ${reasoningLen})`);
        }
        continue;
      }
      console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${event}: ${summarize(parsed)}`);
      if (event === "tool_call") {
        const args = JSON.parse(String(parsed.args ?? "{}")) as Record<string, string>;
        let result: { ok: boolean; output: string };
        if (parsed.name === "calculator") {
          try {
            result = { ok: true, output: calc(String(args.expression ?? "")) };
          } catch (e) {
            result = { ok: false, output: (e as Error).message };
          }
        } else if (parsed.name === "javascript") {
          result = runJsCapture(String(args.code ?? ""));
        } else {
          result = { ok: false, output: "未知工具" };
        }
        console.log(`  → browser executes ${parsed.name}: ${result.output.slice(0, 200)}`);
        await postResult(requestId, String(parsed.toolCallId), result);
      }
      if (event === "done" || event === "error") {
        console.log(`reasoning total: ${reasoningLen} chars`);
        console.log(`answer(${answer.length} chars): ${answer.slice(0, 300)}`);
        return;
      }
    }
  }
}

await runScenario(
  "calculator",
  "请用 calculator 工具计算 123*456 等于多少，然后把结果告诉我。"
);

await runScenario(
  "javascript",
  "请用 javascript 工具写代码，枚举两个骰子点数和为 7 的所有组合，统计共有多少种，并告诉我结果。"
);

await runScenario(
  "ln",
  "请用 calculator 工具计算 ln(100) 的值（自然对数），然后把结果告诉我。"
);

await runScenario(
  "quadratic",
  "解方程 x²-5x+6=0，并说明使用了什么方法。请用 calculator 验算判别式和求根公式的数值，并把每个根代回原方程验根。"
);

await runScenario(
  "calculator-rich",
  "请用 calculator 工具完成三件事，并分别告诉我结果：1) 计算组合数 C(10,3)；2) 把 5 公里换算成米；3) 求矩阵 [[1,2],[3,4]] 的行列式。"
);
