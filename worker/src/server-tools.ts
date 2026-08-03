import { calc } from "../../frontend/src/lib/calc";
import type { ToolResult } from "./tools";

/** Execute only explicitly allow-listed, resource-bounded server tools. */
export async function executeServerTool(name: string, rawArgs: string): Promise<ToolResult> {
  if (name !== "calculator") return { ok: false, output: `未知服务端工具：${name}` };
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return { ok: false, output: "工具参数解析失败" };
  }
  try {
    return { ok: true, output: calc(String(args.expression ?? "")) };
  } catch (error) {
    return { ok: false, output: `工具执行失败：${(error as Error).message}` };
  }
}
