import { calc } from "../../frontend/src/lib/calc";
import type { ToolResult } from "./tools";

/** Execute only explicitly allow-listed, resource-bounded server tools. */
export async function executeServerTool(name: string, rawArgs: string): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return { ok: false, output: "工具参数解析失败" };
  }
  if (name === "calculator") {
    try {
      return { ok: true, output: calc(String(args.expression ?? "")) };
    } catch (error) {
      return { ok: false, output: `工具执行失败：${(error as Error).message}` };
    }
  }

  if (name === "function_plot") return validateFunctionPlot(args);
  return { ok: false, output: `未知服务端工具：${name}` };
}

function validateFunctionPlot(args: Record<string, unknown>): ToolResult {
  const expressions = args.expressions;
  if (!Array.isArray(expressions) || expressions.length === 0 || expressions.length > 8) {
    return { ok: false, output: "expressions 必须包含 1～8 个表达式" };
  }
  for (const item of expressions) {
    if (!item || typeof item !== "object") return { ok: false, output: "表达式格式不合法" };
    const expression = item as Record<string, unknown>;
    if (typeof expression.latex !== "string" || !expression.latex.trim()) {
      return { ok: false, output: "每个表达式都必须包含 latex" };
    }
    if (expression.latex.length > 500) return { ok: false, output: "单个表达式过长" };
    if (
      expression.color !== undefined &&
      (typeof expression.color !== "string" || !/^#[0-9a-f]{6}$/i.test(expression.color))
    ) {
      return { ok: false, output: "color 必须是 #RRGGBB" };
    }
  }
  const viewport = args.viewport;
  if (viewport !== undefined) {
    if (!viewport || typeof viewport !== "object") return { ok: false, output: "viewport 格式不合法" };
    const v = viewport as Record<string, unknown>;
    const values = [v.xMin, v.xMax, v.yMin, v.yMax];
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { ok: false, output: "viewport 的四个边界必须是有限数值" };
    }
    if ((v.xMin as number) >= (v.xMax as number) || (v.yMin as number) >= (v.yMax as number)) {
      return { ok: false, output: "viewport 最小值必须小于最大值" };
    }
  }
  return { ok: true, output: `绘图参数已验证（${expressions.length} 个表达式）` };
}
