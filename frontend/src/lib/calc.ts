/**
 * Hardened mathjs calculator, executed in the user's browser (zero server
 * cost; the user accepts the risk). Follows the official hardening guidance:
 * the few functions that can parse/alter arbitrary input are disabled, and
 * stability guards bound expression size and heavy calls.
 */
import { create, all, type FactoryFunctionMap, type MathNode } from "mathjs";

const math = create(all as FactoryFunctionMap, { number: "BigNumber", precision: 64 });
// Capture parse BEFORE disabling it: our own code still needs to evaluate
// expressions, but user expressions resolve functions from the hardened
// instance and can never reach these entry points.
const limitedParse = math.parse as (expr: string) => MathNode;

math.import(
  {
    // Aliases for the names homework prompts most commonly use.
    comb: (...args: unknown[]) =>
      math.combinations(args[0] as number, args[1] as number),
    perm: (...args: unknown[]) =>
      math.permutations(args[0] as number, args[1] as number),
    // Common Chinese math notation: ln = natural log (mathjs calls it log),
    // lg = base-10 log (mathjs log10). Without these aliases the model wastes
    // turns discovering log(x) is actually ln.
    ln: (...args: unknown[]) => math.log(args[0] as number),
    lg: (...args: unknown[]) => math.log10(args[0] as number),
    import: () => {
      throw new Error("Function import is disabled");
    },
    createUnit: () => {
      throw new Error("Function createUnit is disabled");
    },
    reviver: () => {
      throw new Error("Function reviver is disabled");
    },
    evaluate: () => {
      throw new Error("Function evaluate is disabled");
    },
    parse: () => {
      throw new Error("Function parse is disabled");
    },
    simplify: () => {
      throw new Error("Function simplify is disabled");
    },
    derivative: () => {
      throw new Error("Function derivative is disabled");
    },
    resolve: () => {
      throw new Error("Function resolve is disabled");
    },
  },
  { override: true }
);

/**
 * Names the hardened instance actually exposes. Built once after aliases are
 * imported; used to give the model actionable feedback instead of letting it
 * guess/invent function names against the parser's cryptic errors.
 */
const DISABLED_FNS = new Set([
  "import",
  "createUnit",
  "reviver",
  "evaluate",
  "parse",
  "simplify",
  "derivative",
  "resolve",
]);
const KNOWN_FNS = new Set<string>(
  Object.keys(math).filter(
    (k) =>
      typeof (math as unknown as Record<string, unknown>)[k] === "function" &&
      !DISABLED_FNS.has(k)
  )
);

const MAX_EXPR_LEN = 500;
const MAX_NODES = 300;
const MAX_MATRIX_ELEMENTS = 20_000;
const MAX_FACTORIAL_ARG = 2000;
const MAX_COMB_ARG = 20_000;
const MAX_POW_EXPONENT = 1000;

/** Convert a calculator expression to KaTeX-compatible LaTeX for the UI. */
export function expressionToTex(rawExpr: string): string {
  const expr = rawExpr.trim().replace(/\*\*/g, "^");
  if (!expr) throw new Error("表达式为空");
  if (expr.length > MAX_EXPR_LEN) throw new Error("表达式过长");
  return limitedParse(expr).toTex();
}

export function calc(rawExpr: string): string {
  // JS-style power operator compatibility: 2**3 -> 2^3
  const expr = rawExpr.trim().replace(/\*\*/g, "^");
  if (!expr) throw new Error("表达式为空：请传入要计算的数学表达式");
  if (expr.length > MAX_EXPR_LEN) throw new Error("表达式过长（超过 500 字符）");

  // mathjs here is pure-ASCII only. Reject Chinese/full-width/√ π ² etc.
  // up front with concrete substitutions, so the model doesn't keep retrying
  // the same expression after a cryptic parse error.
  if (/[^\x00-\x7F]/.test(expr)) {
    throw new Error(
      "表达式包含非 ASCII 字符（中文/全角符号/π/√/² 等）：只写纯 ASCII 数学表达式，不要夹带解释文字；π 用 pi，√x 用 sqrt(x)，x² 用 x^2"
    );
  }
  if (expr.includes("//")) {
    throw new Error("不支持 // 整除运算符：整数除法请写 floor(a/b)，取余请写 mod(a,b) 或 a % b");
  }

  // Reject invented function names before the parser produces a cryptic error.
  const funcRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  let fm: RegExpExecArray | null;
  while ((fm = funcRe.exec(expr)) !== null) {
    const name = fm[1] ?? "";
    if (DISABLED_FNS.has(name)) {
      throw new Error(
        `函数 ${name} 已禁用（不支持解方程/化简/求导等符号运算）：请改用 javascript 工具写代码计算`
      );
    }
    if (!KNOWN_FNS.has(name)) {
      throw new Error(
        `不存在的函数 ${name}：可用函数名见 calculator 工具说明（如 sqrt gcd comb perm det sum mean 等），不要发明函数名；符号运算请改用 javascript 工具`
      );
    }
  }

  const hugePow = expr.match(/\^(\d{4,})/);
  if (hugePow) throw new Error("指数过大");

  let node: MathNode;
  try {
    node = limitedParse(expr);
  } catch (err) {
    throw new Error(`表达式无法解析：${(err as Error).message}`);
  }

  let nodeCount = 0;
  node.traverse(() => {
    nodeCount++;
  });
  if (nodeCount > MAX_NODES) throw new Error("表达式过于复杂");

  node.traverse((n: any) => {
    if (!n?.isFunctionNode || !n.fn?.isSymbolNode) return;
    const name = n.fn.name as string;
    const first = n.args?.[0] as any;
    const second = n.args?.[1] as any;
    const lit = (v: any): number | null =>
      v?.isConstantNode && v.value != null ? Math.abs(Number(v.value)) : null;
    if (name === "factorial") {
      const a = lit(first);
      if (a !== null && a > MAX_FACTORIAL_ARG) throw new Error("阶乘参数过大");
    } else if (
      name === "comb" ||
      name === "combinations" ||
      name === "perm" ||
      name === "permutations"
    ) {
      const a = lit(first);
      if (a !== null && a > MAX_COMB_ARG) throw new Error("组合/排列参数过大");
    } else if (name === "pow" || name === "nthRoot") {
      const e = lit(second);
      if (e !== null && e > MAX_POW_EXPONENT) throw new Error("指数过大");
    } else if (name === "zeros" || name === "ones" || name === "eye" || name === "range") {
      const a = lit(first);
      if (a !== null && a > MAX_MATRIX_ELEMENTS) throw new Error("矩阵规模过大");
    }
  });

  let result: unknown;
  try {
    result = node.compile().evaluate({});
  } catch (err) {
    throw new Error(`计算失败：${(err as Error).message}`);
  }
  return formatResult(result);
}

function formatResult(value: unknown): string {
  if (Array.isArray(value) || math.isMatrix(value)) {
    const size = Array.isArray(value) ? matrixElements(value) : value.size();
    const elements = Array.isArray(size) ? size.reduce((a, b) => a * b, 1) : Number(size);
    if (elements > MAX_MATRIX_ELEMENTS) throw new Error("结果过大");
    return math.format(value, { precision: 16 });
  }
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (math.isBigNumber(value)) {
    if (!value.isFinite()) throw new Error("结果超出可表示范围");
    return math.format(value, { precision: 16 });
  }
  return math.format(value, { precision: 16 });
}

function matrixElements(arr: unknown[]): number {
  if (arr.length === 0) return 0;
  if (Array.isArray(arr[0])) {
    const inner = matrixElements(arr[0] as unknown[]);
    if (inner === 0) return 0;
    return arr.length * inner;
  }
  return arr.length;
}
