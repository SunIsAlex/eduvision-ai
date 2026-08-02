/**
 * Model-callable tools.
 *
 * All tools are executed in the USER'S BROWSER (zero server cost, risk on the
 * user):
 *
 *  - calculator:  hardened mathjs (no eval/import, bounded work), loaded
 *                 lazily in the frontend so the Worker bundle stays tiny.
 *  - javascript:  enumeration/counting code in a Web Worker sandbox (no DOM).
 *
 * The Worker only relays tool calls to the browser, waits for the result via
 * /api/tool/result, feeds it back to the model and keeps streaming on the same
 * SSE connection.
 */

export interface ToolResult {
  ok: boolean;
  output: string;
}

export type ToolExecutor = "browser";

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "calculator",
      description:
        "精确计算数学表达式（用户浏览器本地加固版 mathjs，BigNumber 高精度，0.1+0.2=0.3）。expression 只写表达式本身，不要解释、不要写等号。\n" +
          "运算符：+ - * / %(取余) ^ 或 **(幂) !(阶乘) 括号；数组/矩阵用方括号：[1,2,3]、[[1,2],[3,4]]；矩阵乘法用 *，逐元素乘用 .*。注意：不支持 //（整数除法请写 floor(a/b)）。\n" +
          "可用 mathjs 函数（名字：作用）：\n" +
          "- 基本与取整：abs 绝对值；floor/ceil 向下/向上取整；round 四舍五入；fix 向零取整；sign 符号；min/max 最小/最大；pow(x,n) 幂；sqrt 平方根；cbrt 立方根；nthRoot(x,n) n 次方根；square/cube 平方/立方；hypot 到原点的距离\n" +
          "- 对数指数：ln(=log) 自然对数；lg(=log10) 常用对数；log2；log1p；exp；expm1\n" +
          "- 三角函数（默认弧度；角度请写 \"90 degrees\" 或 to(x, degrees)）：sin cos tan asin acos atan atan2(y,x) sec csc cot 及双曲 sinh cosh tanh asinh acosh atanh\n" +
          "- 数论与组合：gcd 最大公约数；lcm 最小公倍数；factorial 阶乘；comb(=combinations) 组合数；perm(=permutations) 排列数；combinationsWithRep 可重复组合；catalan 卡特兰数；stirlingS2 第二类斯特林数；bellNumbers 贝尔数；gamma 伽马函数；xgcd 扩展欧几里得；invmod 模逆；zeta 黎曼ζ函数\n" +
          "- 统计：sum 求和；prod 求积；mean 均值；median 中位数；mode 众数；variance/std 方差/标准差；quantileSeq(数据,分位数)；corr 相关系数；cumsum 累加\n" +
          "- 线性代数：det 行列式；inv 逆矩阵；transpose 转置；dot 点积；cross 叉积；norm 模长；trace 迹；identity(n)/zeros/ones 单位/零/一矩阵；size 尺寸；reshape 变形；flatten 展平；diag 对角阵；pinv 伪逆；qr/lup 分解；eigs 特征值；kron 克罗内克积；sqrtm 矩阵平方根；polynomialRoot 多项式求根（系数按常数项起传入，如 polynomialRoot(-4,0,1) 表示 x²-4=0）\n" +
          "- 集合：setUnion 并集；setIntersect 交集；setDifference 差集；setSymDifference 对称差；setCartesian 笛卡尔积；setPowerset 幂集；setSize 元素个数；setIsSubset 子集判断\n" +
          "- 进制与位运算：bin/hex/oct 转二进制/十六进制/八进制；bitAnd/bitOr/bitXor/leftShift 位运算\n" +
          "- 单位换算：\"5 km to m\"、\"90 degrees to rad\"、\"1 h to s\"，也可写 to(5 km, m)；toBest 自动选合适单位\n" +
          "常量：pi、e、phi、tau、i(虚数单位)。\n" +
          "示例：123*456、comb(10,3)、gcd(24,36)、sqrt(2)、ln(100)、lg(100)、det([[1,2],[3,4]])、sum(range(1,101))、5 km to m。\n" +
          "注意：表达式必须是纯 ASCII，不支持中文或 √ π ² 等符号（√2 写 sqrt(2)、π 写 pi）；solve 解方程、simplify 化简、derivative 求导、parse/evaluate 均被禁用，不要调用；若报错，按报错提示修正后重试，实在不行改用 javascript 工具。",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "要计算的数学表达式，只放表达式本身，不要解释" },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "javascript",
      description:
        "在用户浏览器本地沙箱（Web Worker，无页面/DOM/文件访问权限，风险由用户承担）执行 JavaScript，用于枚举、计数、暴力验证、统计、递推、以及 calculator 做不了的计算（如求方程根、循环模拟）等场景。支持标准 JS：let/const、for/while、if/else、数组、对象、字符串、Math、BigInt；必须用 console.log 输出最终结果；注意避免死循环（15 秒超时）。示例代码：\nlet count=0;\nfor(let a=1;a<=6;a++){ for(let b=1;b<=6;b++){ if(a+b===7) count++; } }\nconsole.log(count)",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "要执行的 JavaScript 代码" } },
        required: ["code"],
      },
    },
  },
] as const;

/** Every current tool runs in the browser; the Worker never executes code. */
export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  calculator: "browser",
  javascript: "browser",
};
