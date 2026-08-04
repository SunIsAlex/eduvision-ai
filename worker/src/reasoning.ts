import {
  createClient,
  streamRound,
  type ImageBlockParam,
  type MessageCreateParamsStreaming,
  type MessageParam,
  type RawMessageStreamEvent,
  type Tool,
  type RoundResult,
  type StreamDelta,
} from "./anthropic";
import { TOOL_EXECUTORS, TOOL_DEFINITIONS } from "./tools";
import { awaitBrowserToolResult } from "./toolbridge";
import { executeServerTool } from "./server-tools";
import { readFile } from "node:fs/promises";
import { MODELS, resolveReviewModel, type ChatMessage, type Env, type SkillId } from "./types";

const TEACHER_SYSTEM = `你是一位严谨、简洁的中学教师。目标是在保证正确和易懂的前提下，用最少的必要推理解决学生的问题。

作答原则：
1. 按难度自适应：简单题直接给出结论和 1～3 个关键步骤；普通题给出思路、必要推导和答案；只有证明题或确实复杂的题目才展开完整论证。
2. 得出可靠结论后立即停止。不要反复审题、自我质疑、重复验算、枚举无关可能，也不要同时尝试多种解法；除非用户明确要求，不复述整道题，不重复总结。
3. 只输出给学生看的解答，不输出内部思考、自我对话、计划或检查过程。解释“为什么”时给出可验证的关键依据，而不是冗长思维过程。
4. 图片题只提取解题需要的文字、数据和图形关系并直接作答；作答前必须独立重读原图中的点名、三角形下标、正负号和数值，不得把规划文本的转录当作原题。有多问时逐项回答。看不清或信息不足就明确指出，不猜测、不编造。
5. 优先心算和直接推导，但下列情况必须先调用 calculator，再引用真实结果作答：pH/pOH 或平衡常数的数值计算；最终数值依赖对数、根式、非整数指数、三角函数或高精度近似；用户明确要求使用 calculator。遇到这些题时，只需确定公式和一个可直接求最终值的表达式，然后立即调用工具；调用前严禁心算、估算、分步计算、预测或写出近似结果。能合并成一个表达式时只调用一次。工具返回后直接使用结果，不得再手算一遍或从头重复推导。
6. 中学题要求精确解（圆锥曲线、解析几何、方程与不等式、数列等）时，必须先完成解析推导得到精确表达式（可含根式、分式、参数），再用 calculator 或 javascript 验证；严禁先用 javascript 二分/迭代求出近似值并当作最终答案，也不要把 calculator 的近似小数当最终答案。javascript 数值求解仅用于：未知量同时出现在方程两边且没有简单解析解；非线性方程或联立方程需要迭代；化学平衡需要同时满足物料衡算、电荷守恒、络合/酸碱/溶度积关系；用户明确要求数值法、迭代法、二分法或牛顿法。需要数值求解时优先稳定的二分法，在物理允许区间内求根，并输出根、残差和单位换算；严禁手工试值。javascript 也可用于验证已得到的解析解、必要的大规模枚举、计数和递推。
7. 一次工具调用能完成时不要拆成多轮。工具失败时最多修正重试一次，仍失败才改为直接推导或说明限制。
8. 严禁虚构工具调用。只有真实调用并拿到结果后，才可以写“工具验证”或引用工具结果；纯符号推导、公式变形和概念解释不调用工具。
9. 默认使用中文、Markdown 和 LaTeX（行内 $...$，独立行 $$...$$）。避免固定套话和过度分段；结论要明确。英文题保留必要的英文术语并用中文解释。
10. 若用户明确要求详细推导、证明、所有情况或指定工具，则服从该要求，但仍避免重复内容。用户选择了学科 SKILL 时，严格遵守附加的学科规范。`;

const PLANNER_SYSTEM = `你是一位解题规划器。收到学生的题目后，只输出简洁的解题思路，不要直接写给学生看的完整答案。

要求：
1. 图片题先逐字核对决定结论的条件，尤其是点名、三角形下标、正负号和等号右边；在计划首行原样写出该关键条件。看不清时标注不确定，禁止按相似字形猜测。
2. 输出关键思路、必要公式和分步框架；明确指出哪些步骤需要数值计算或工具验证。
3. 控制在 250 字以内，用中文和简洁的编号。
4. 不要展开完整推导，不要给出冗长的最终解答，不要声称已经计算或验证。
5. 对圆锥曲线、解析几何、方程与不等式等需要精确解的题目，计划中必须要求先求解析解（含根式/分式），数值工具只用于验证，禁止以近似值作为最终答案。`;

const REVIEWER_SYSTEM = `你是一位严谨的答案复核子代理。你会收到一道题、解题思路和一份完整答案，任务是独立复核答案中的数值与代数结论。

规则：
1. 图片题第一步必须重新阅读原图，逐字对比待复核答案中的点名、三角形下标、正负号及已知数值。任一转录不同都必须判为不一致，不得沿用解题思路或答案的转录。
2. 再从原题独立重建决定结论的解析关系，核对系数、判别式、韦达结果、面积/体积表达式、根和最终答案；不得默认待复核答案中间式正确。
3. calculator 只用于纯数值复算或把候选解代回原条件。符号恒等式、含参数表达式和精确解必须先用代数推导核对，不得用任意抽样或数值求根代替。
4. 圆锥曲线、解析几何和方程题要求精确解；若答案只给近似小数或用数值搜索代替解析推导，直接判为不一致。
5. 输出简短复核报告：每个校验项的原结论与独立核对结果要并列，一致或不一致要明确；不一致的项给出正确值。
6. 报告控制在 250 字内，只写可验证结论，不要重写完整答案。决定最终答案的条件、公式或候选解只要有一项未完成独立验证，结论必须判为不一致，不得输出“通过”。
7. 报告最后必须单独一行给出结论，格式只能是以下两种之一（该行不要附加其他内容）：
   校验结论：通过
   校验结论：发现 N 处不一致
8. 若答案以精确形式给出（根式、分式、π 等），可用 calculator 计算其近似值并代回原条件，但报告仍保留精确形式。
9. 验证方程、恒等式或公式时，代入题目给出的解或方程根，而不是任意抽样点；两个表达式只差常数倍不算不一致，先化简再判断。`;

const ULTRA_ANSWER_CONTRACT = `

Ultra 精确解答协议：
1. 对圆锥曲线、解析几何和参数方程，答案必须显式展示“交点方程/韦达关系 → 辅助点或几何量 → 决定结论的单一标量等式 → 精确解及代回”。
2. 决定最终答案的公式禁止用“经计算”“易得”“化简可得”跳过。必须写出其直接来源，使读者能检查系数、绝对值和分母。
3. 直线过已知点 A 与二次曲线交于 B,C 时，优先用 P(t)=A+t(1,k) 参数化；先用根的乘积判定 B,C 在 A 的同侧或异侧，再处理距离和无向面积的绝对值。任何去绝对值都必须先写出对应量的符号或符号区间，禁止凭形式直接改写。
4. 若两个三角形共用一条所在直线上的底，优先写成“公共底长 × 到该直线的距离”；不得在未判定符号时将两个无向面积之差合并成行列式之差。使用 \(|u|=u\)、\(|u|=-u\) 或 \(\bigl||u|-|v|\bigr|=|u\pm v|\) 前，必须先证明 u、v 的符号关系。
5. 推导辅助点、交点或斜率时，一旦出现含参分母，立即记录使分母为零的值并回到几何原意判断平行、重合或交点不存在；不得等到最后才遗忘该退化情形。
6. 求出候选参数后，必须代回上一步的单一标量等式，并检查题设排除值、分母、交点存在性及绝对值分支。任一项未完成时不得输出最终答案。`;

const ULTRA_REVIEW_CONTRACT = `

Ultra 复核协议：
1. 不得参考规划器的思路；只以原题为真值源，从空白纸独立重建决定最终答的标量等式。
2. 对圆锥曲线与解析几何，复核报告必须至少核对：交点二次方程、根的符号/位置关系、辅助点、无向面积的绝对值处理、最终标量方程和候选解代回。
3. 待复核答案若在决定性公式前使用“化简得”却没有给出可审计中间关系，不得通过；你必须自己推出该公式后再判定。
4. calculator 仅能检查纯数值或已得候选解，不能证明含参恒等式。若独立标量等式未得到，结论必须是“发现不一致”。`;

const DIRECT_TEACHER_SYSTEM = `你是一位严谨、简洁的中学教师。当前是直答模式：立即回答，不展示思考过程、计划、自我检查或重复总结。

规则：
1. 简单题直接给结论；普通题只给必要公式和关键步骤；证明题给一条闭合的中学范围证明。默认中文、Markdown、LaTeX。
2. 图片题只提取解题必需的信息；必须独立重读原图的点名、三角形下标、正负号和数值，不得把规划文本当作原题。看不清就指出，不猜测题目出处、年份或难度。
3. 必须服从请求中附加的工具执行要求。需要数值计算时尽快调用 calculator。中学题优先求精确解析解：先推导出精确表达式（含根式/分式），再调用 javascript 或 calculator 验证；圆锥曲线、解析几何等题严禁把数值近似当作最终答案，除非题目本身无解析解或明确要求数值解。拿到工具结果后直接作答，不重复手算，不虚构工具结果。
4. 用户选择了学科 SKILL 时，严格遵守附加的学科规范。得出可靠结论后立即停止。`;

const SKILL_FILES: Partial<Record<SkillId, URL>> = {
  math: new URL("../prompts/math/SKILL.md", import.meta.url),
  chemistry: new URL("../prompts/chemistry/SKILL.md", import.meta.url),
};
const skillPromptCache = new Map<SkillId, Promise<string>>();

function loadSkillPrompt(skill: SkillId): Promise<string> {
  const file = SKILL_FILES[skill];
  if (!file) return Promise.resolve("");
  const cached = skillPromptCache.get(skill);
  if (cached) return cached;
  const loading = readFile(file, "utf8").then((content) => `\n\n${content.trim()}`);
  skillPromptCache.set(skill, loading);
  return loading;
}

const MAX_TOOL_ROUNDS = 3;
const MAX_CORRECTIONS = 1;
const MAX_ANSWER_TOKENS = 4096;

/** 解答文本中出现这些字样，视为声称使用了计算器/工具验证。 */
const CALC_CLAIM_RE =
  /工具验证|调用(?:了)?(?:calculator|计算器)|(?:calculator|计算器)[^\n。；]{0,10}(?:计算|验证|结果)/i;

/** Text questions whose requested numerical answer must come from calculator. */
const CALCULATOR_REQUIRED_RE =
  /(?:请|必须|使用|用).{0,12}(?:calculator|计算器)|(?:pH|pOH).{0,16}(?:值|多少|计算|求)|(?:计算|求|比较).{0,32}(?:log|ln|对数|根式|平方根|开方|非整数指数|三角函数)/i;

function requiresCalculator(question: string): boolean {
  return CALCULATOR_REQUIRED_RE.test(question);
}

/**
 * Extract a standalone calculator request which needs no model reasoning.
 * Keeping this deliberately narrow avoids treating word problems as bare
 * expressions while making requests such as “计算99*88282” instant and
 * independent of a second provider round trip.
 */
function directCalculatorExpression(question: string): string | null {
  const normalized = question.trim();
  const match = normalized.match(
    /^(?:请\s*)?(?:帮我\s*)?(?:计算|算一下|算出|求值)\s*[:：]?\s*(.+?)\s*[。！？?!]?$/i
  );
  const expression = match?.[1]?.trim();
  if (!expression || expression.length > 500) return null;
  // The hardened calculator accepts ASCII. Exclude prose, equations and
  // assignments here; unsupported expressions fall back to Claude below.
  if (/[^\x00-\x7F]/.test(expression) || /[=;{}'"`]/.test(expression)) return null;
  return expression;
}

/** Text questions that need an iterative/root-finding JavaScript program. */
const JAVASCRIPT_REQUIRED_RE =
  /(?:数值求解|迭代法?|二分法?|牛顿法?|非线性方程|联立.{0,8}方程)|(?:NH3|氨水|络合|配位|EDTA|CN[-⁻]?).{0,40}(?:溶解度|沉淀平衡)|(?:溶解度|沉淀平衡).{0,40}(?:NH3|氨水|络合|配位|EDTA|CN[-⁻]?)/i;

export function requiresJavaScript(question: string): boolean {
  return JAVASCRIPT_REQUIRED_RE.test(question);
}

/** Explicit graph requests must produce a real visual tool call. */
const FUNCTION_PLOT_REQUIRED_RE =
  /(?:画出|画一下|绘制|作出|显示).{0,16}(?:函数)?图(?:像)?|(?:Desmos|function_plot)/i;

function requiresFunctionPlot(question: string): boolean {
  return FUNCTION_PLOT_REQUIRED_RE.test(question);
}

/** Build the complete active conversation plus the current question/image. */
function buildMessages(input: {
  question: string;
  image?: string;
  history?: ChatMessage[];
}): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (input.history && input.history.length > 0) {
    for (const msg of input.history) {
      const content = msg.content.trim() || (msg.image ? "用户在此轮上传了一张题目图片。" : "");
      if (content || msg.image) {
        messages.push({ role: msg.role, content, ...(msg.image ? { image: msg.image } : {}) });
      }
    }
  }

  const baseUserText =
    input.question.trim() ||
    "请识别图片中的题目并简洁作答。只提取解题所需信息；看不清或信息不足的地方请明确说明。";
  const userText = requiresJavaScript(input.question)
    ? `${baseUserText}\n\n执行要求：本题必须使用 javascript 建立方程并数值求解。先写出完整平衡关系、物料衡算和未知量的物理区间，然后第一轮立即调用 javascript；优先用二分法，代码输出数值根、代回残差及最终单位换算。不要手工试值、迭代或预先猜测答案。工具返回后直接引用结果简洁作答，不要重新计算。`
    : requiresCalculator(input.question)
    ? `${baseUserText}\n\n执行要求：本题属于必须使用 calculator 的数值计算。只确定公式，不做任何心算、估算或分步数值计算；第一轮立即用一个完整表达式调用 calculator。工具返回后直接引用结果给出简洁解答，不要重新计算或重复推导。`
    : baseUserText;
  messages.push(
    input.image
      ? { role: "user", content: userText, image: input.image }
      : { role: "user", content: userText }
  );
  return messages;
}

function imageBlock(image: string): ImageBlockParam {
  if (image.startsWith("data:")) {
    const match = image.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s);
    if (!match) throw new Error("不支持的图片 data URL");
    return {
      type: "image",
      source: { type: "base64", media_type: match[1] as "image/jpeg", data: match[2]! },
    };
  }
  return { type: "image", source: { type: "url", url: image } };
}

/** Convert app messages into Anthropic's native multimodal format. */
function toAnthropicMessages(messages: ChatMessage[]): MessageParam[] {
  return messages.map((m) => {
    if (m.image) {
      return {
        role: m.role,
        content: [imageBlock(m.image), { type: "text", text: m.content }],
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Stream reasoning immediately, but buffer answer text until we know the
 * required tool call exists. This keeps CoT live without exposing an
 * unverified, tool-free final answer.
 */
async function* streamRequiredToolRound(
  stream: AsyncIterable<RawMessageStreamEvent>
): AsyncGenerator<
  StreamDelta,
  { bufferedAnswer: StreamDelta[]; result: RoundResult },
  unknown
> {
  const generator = streamRound(stream);
  const bufferedAnswer: StreamDelta[] = [];
  let next = await generator.next();
  while (!next.done) {
    if (next.value.kind === "reasoning") {
      yield next.value;
    } else {
      bufferedAnswer.push(next.value);
    }
    next = await generator.next();
  }
  return { bufferedAnswer, result: next.value };
}

/**
 * Ultra 模式第 1 步：高智力模型只输出解题思路（plan 事件）。
 */
async function* runPlanner(
  client: ReturnType<typeof createClient>,
  opts: {
    model: string;
    messages: MessageParam[];
    skillPrompt: string;
    thinking?: boolean;
  }
): AsyncGenerator<StreamDelta, string, unknown> {
  const params: MessageCreateParamsStreaming = {
    model: opts.model,
    max_tokens: 1024,
    system: PLANNER_SYSTEM + opts.skillPrompt,
    stream: true,
    messages: opts.messages,
    tools: [],
    ...(opts.thinking
      ? {
          thinking: { type: "adaptive" as const, display: "summarized" as const },
          output_config: { effort: "low" as const },
        }
      : { temperature: 0.2 }),
  };
  const stream = await client.messages.create(params);
  let plan = "";
  for await (const delta of streamRound(stream)) {
    if (delta.kind === "content") {
      plan += delta.text;
      yield { kind: "plan", text: delta.text };
    }
  }
  return plan.trim();
}

/** 只暴露 calculator 的工具定义（子代理专用，服务端执行）。 */
function calculatorOnlyTools(): Tool[] | undefined {
  const calculatorTool = TOOL_DEFINITIONS.find((tool) => tool.function.name === "calculator");
  if (!calculatorTool) return undefined;
  return [
    {
      name: calculatorTool.function.name,
      description: calculatorTool.function.description,
      input_schema: {
        ...calculatorTool.function.parameters,
        required: [...calculatorTool.function.parameters.required],
      },
    },
  ];
}

type LineCheckResult = {
  blockId: number;
  status: "passed" | "failed";
  detail?: string;
};

// 小批次让前端逐步亮灯；三条独立队列避免短答案结束后才集中回填。
const LINE_REVIEW_BATCH_SIZE = 2;
const FIRST_LINE_REVIEW_BATCH_SIZE = 2;
const LINE_REVIEW_CONCURRENCY = 3;

const LINE_REVIEW_TOOL: Tool = {
  name: "report_line_checks",
  description: "Return structured verification results for the requested answer blocks.",
  input_schema: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            blockId: { type: "integer" },
            status: { type: "string", enum: ["passed", "failed"] },
            detail: { type: "string" },
          },
          required: ["blockId", "status", "detail"],
        },
      },
    },
    required: ["checks"],
  },
};

const LINE_REVIEW_SYSTEM = `你是 Ultra 模式的增量答案审核器。主模型仍在输出，你会收到截至当前的答案块，以及本轮必须审核的块编号。

审核要求：
1. 只审核本轮指定块，但必须结合原题和此前全部答案块判断上下文。
2. passed 表示该块中的题目转录、公式、代数变形、符号、绝对值、定义域或结论均可由此前内容及原题推出；failed 表示至少存在一处实质错误、跳过决定性推导或与原题不符。
3. 普通叙述、标题以及尚未包含数学断言的过渡句，只要不错误即可 passed。不要因为后续推导尚未出现而判错。
4. 对圆锥曲线和解析几何，重点检查交点方程、韦达关系、根的符号、辅助点存在性、无向面积的绝对值和候选解代回；凡去绝对值，必须要求答案先给出被去项的符号证明或区间。
5. detail 用不超过 45 个中文字说明通过依据或具体错误；禁止输出思考过程。
6. 必须调用 report_line_checks，一次返回本轮每个 blockId，不能遗漏、添加或重复。`;

function markdownReviewBlocks(content: string, includeTrailing: boolean): string[] {
  const pieces = content.split(/\n{2,}/);
  if (!includeTrailing && !/\n{2,}$/.test(content)) pieces.pop();
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

async function reviewLineBatch(
  client: ReturnType<typeof createClient>,
  opts: {
    model: string;
    problemMessages: MessageParam[];
    answerBlocks: string[];
    targetIds: number[];
  }
): Promise<LineCheckResult[] | null> {
  const numberedAnswer = opts.answerBlocks
    .map((block, blockId) => `[块 ${blockId}]\n${block}`)
    .join("\n\n");
  const messages: MessageParam[] = [
    ...opts.problemMessages,
    { role: "assistant", content: `当前累计答案：\n\n${numberedAnswer}` },
    {
      role: "user",
      content: `只审核这些块：${opts.targetIds.join(", ")}。必须调用 report_line_checks。`,
    },
  ];
  const params: MessageCreateParamsStreaming = {
    model: opts.model,
    // 每批最多两项短结构化结论；避免长输出预算诱导小模型过度推理。
    max_tokens: 384,
    // 专用规则已覆盖逐块审核要点。不要在每个小批次重复注入完整
    // 学科提示和终审协议，否则图片题会显著增加首个结果的延迟。
    system: LINE_REVIEW_SYSTEM,
    stream: true,
    messages,
    tools: [LINE_REVIEW_TOOL],
    tool_choice: { type: "tool" as const, name: LINE_REVIEW_TOOL.name },
    temperature: 0,
  };
  try {
    const stream = await createWithRetry(client, params);
    const generator = streamRound(stream);
    let next = await generator.next();
    while (!next.done) next = await generator.next();
    const call = next.value.toolCalls.find((item) => item.name === LINE_REVIEW_TOOL.name);
    if (!call) return null;
    const parsed = JSON.parse(call.args) as { checks?: unknown };
    if (!Array.isArray(parsed.checks)) return null;
    const byId = new Map<number, LineCheckResult>();
    for (const raw of parsed.checks) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as { blockId?: unknown; status?: unknown; detail?: unknown };
      if (
        typeof item.blockId !== "number" ||
        (item.status !== "passed" && item.status !== "failed") ||
        !opts.targetIds.includes(item.blockId)
      ) continue;
      byId.set(item.blockId, {
        blockId: item.blockId,
        status: item.status,
        ...(typeof item.detail === "string" ? { detail: item.detail.slice(0, 120) } : {}),
      });
    }
    return opts.targetIds.every((id) => byId.has(id))
      ? opts.targetIds.map((id) => byId.get(id)!)
      : null;
  } catch (err) {
    console.warn("[ultra_line_review] batch failed:", err);
    return null;
  }
}

function createLineReviewCoordinator(
  client: ReturnType<typeof createClient>,
  opts: {
    model: string;
    problemMessages: MessageParam[];
  }
) {
  let content = "";
  let announced = 0;
  let scheduled = 0;
  const chains = Array.from({ length: LINE_REVIEW_CONCURRENCY }, () =>
    Promise.resolve<LineCheckResult[] | null>([])
  );
  let nextLane = 0;
  const tasks: Array<Promise<LineCheckResult[] | null>> = [];
  const completed: LineCheckResult[] = [];
  const emittedResults = new Set<number>();
  let readyPromise: Promise<void> | null = null;
  let signalReady: (() => void) | null = null;

  const notifyReady = () => {
    signalReady?.();
    signalReady = null;
    readyPromise = null;
  };

  const drain = (): StreamDelta[] => {
    const events: StreamDelta[] = [];
    for (const result of completed) {
      if (emittedResults.has(result.blockId)) continue;
      emittedResults.add(result.blockId);
      events.push({ kind: "line_check", ...result });
    }
    return events;
  };

  const schedule = (blocks: string[], force: boolean) => {
    const available = blocks.length - scheduled;
    const threshold = scheduled === 0 ? FIRST_LINE_REVIEW_BATCH_SIZE : LINE_REVIEW_BATCH_SIZE;
    if (available <= 0 || (!force && available < threshold)) return;
    const count = force ? available : Math.min(available, threshold);
    const targetIds = Array.from({ length: count }, (_, index) => scheduled + index);
    scheduled += count;
    const snapshot = blocks.slice();
    const lane = nextLane++ % chains.length;
    const task = chains[lane]!.then(() =>
      reviewLineBatch(client, {
        ...opts,
        answerBlocks: snapshot,
        targetIds,
      })
    );
    chains[lane] = task;
    tasks.push(task);
    void task.then((results) => {
      if (results) completed.push(...results);
      notifyReady();
    });
  };

  return {
    push(text: string): StreamDelta[] {
      content += text;
      const blocks = markdownReviewBlocks(content, false);
      const events: StreamDelta[] = drain();
      while (announced < blocks.length) {
        events.push({ kind: "line_check", blockId: announced++, status: "running" });
      }
      schedule(blocks, false);
      return events;
    },
    close(): StreamDelta[] {
      const blocks = markdownReviewBlocks(content, true);
      const opening: StreamDelta[] = drain();
      while (announced < blocks.length) {
        opening.push({ kind: "line_check", blockId: announced++, status: "running" });
      }
      schedule(blocks, true);
      return opening;
    },
    /** Wait only for a notification; drain() remains the single event consumer. */
    waitForReady(): Promise<void> {
      if (completed.some((result) => !emittedResults.has(result.blockId))) {
        return Promise.resolve();
      }
      if (!readyPromise) {
        readyPromise = new Promise<void>((resolve) => {
          signalReady = resolve;
        });
      }
      return readyPromise;
    },
    drain,
    async wait(): Promise<{
      events: StreamDelta[];
      results: LineCheckResult[];
      reliable: boolean;
    }> {
      const batches = await Promise.all(tasks);
      return {
        events: drain(),
        results: batches.flatMap((batch) => batch ?? []),
        reliable: batches.length > 0 && batches.every((batch) => batch !== null),
      };
    },
  };
}

/** 服务端执行一组工具调用，返回 Anthropic tool_result 内容块。 */
async function serverToolResultBlocks(
  toolCalls: Array<{ id: string; name: string; args: string }>
): Promise<Array<Record<string, unknown> & { type: string }>> {
  const blocks: Array<Record<string, unknown> & { type: string }> = [];
  for (const call of toolCalls) {
    const executed = await executeServerTool(call.name, call.args);
    console.log(`[subagent_tool] ${call.name} args=${call.args.slice(0, 120)} ok=${executed.ok}`);
    blocks.push({
      type: "tool_result",
      tool_use_id: call.id,
      content: executed.ok ? executed.output : `工具执行失败：${executed.output}`,
      is_error: !executed.ok,
    });
  }
  return blocks;
}

/** 解析复核报告末尾的机器可读结论行。issues 为 -1 表示无法解析。 */
function parseReviewConclusion(report: string): { passed: boolean; issues: number } {
  const lines = report.split(/\r?\n/).map((line) => line.trim());
  const line = [...lines].reverse().find((candidate) => candidate.startsWith("校验结论"));
  if (!line) return { passed: false, issues: -1 };
  // A reviewer may mechanically print “通过” after admitting that a
  // decisive formula was not checked. Never let an incomplete review suppress
  // the correction round.
  if (/通过/.test(line)) {
    return /未验证|无法.{0,8}验证|未.{0,12}独立验证/.test(report)
      ? { passed: false, issues: 1 }
      : { passed: true, issues: 0 };
  }
  const count = line.match(/发现\s*(\d+)\s*处不一致/)?.[1];
  if (count) return { passed: false, issues: Number(count) };
  if (/不一致|错误/.test(line)) return { passed: false, issues: 1 };
  return { passed: false, issues: -1 };
}

/** 子代理调用：短暂失败时重试一次（relay 偶发超时/503）。 */
async function createWithRetry(
  client: ReturnType<typeof createClient>,
  params: MessageCreateParamsStreaming,
  attempts = 2
): Promise<AsyncIterable<RawMessageStreamEvent>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      lastError = err;
      if ((err as Error).name === "AbortError") throw err;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Ultra 模式第 2 步：子代理复核最终答案（verify 事件）。
 * 只允许 calculator（服务端执行，不经过浏览器桥），最多两轮；
 * 返回复核报告与机器可读结论。
 */
async function* runReviewer(
  client: ReturnType<typeof createClient>,
  opts: {
    model: string;
    messages: MessageParam[];
    answerText: string;
    skillPrompt: string;
    thinking?: boolean;
    signal?: AbortSignal;
  }
): AsyncGenerator<StreamDelta, { report: string; passed: boolean; issues: number }, unknown> {
  const messages: MessageParam[] = [
    ...opts.messages,
    {
      role: "assistant",
      content: `待复核的最终答案：\n${opts.answerText}`,
    },
    {
      role: "user",
      content:
        "请按复核规范逐项校验上面最终答案中的数值与代数结论，输出复核报告，" +
        "并在报告末尾给出规范规定的“校验结论”行。",
    },
  ];
  const tools = calculatorOnlyTools();
  if (!tools) return { report: "", passed: false, issues: -1 };

  let report = "";
  yield { kind: "status", text: "子代理正在独立复核代数与数值结论…" };
  for (let round = 0; round < 2; round++) {
    if (opts.signal?.aborted) return { report: report.trim(), passed: false, issues: -1 };
    const params: MessageCreateParamsStreaming = {
      model: opts.model,
      max_tokens: 4096,
      system: REVIEWER_SYSTEM + opts.skillPrompt + ULTRA_REVIEW_CONTRACT,
      stream: true,
      messages,
      tools,
      ...(opts.thinking
        ? {
            thinking: { type: "adaptive" as const, display: "summarized" as const },
            output_config: { effort: "medium" as const },
          }
        : { temperature: 0.2 }),
    };
    const stream = await createWithRetry(client, params);

    // 手动逐条消费流，才能拿到 streamRound 的返回值（for await 会丢掉它）。
    const generator = streamRound(stream);
    let next = await generator.next();
    while (!next.done) {
      const delta = next.value;
      if (delta.kind === "content") {
        report += delta.text;
        yield { kind: "verify", text: delta.text };
      }
      next = await generator.next();
    }
    const result = next.value;

    if (result.toolCalls.length === 0) break;
    yield {
      kind: "status",
      text: `子代理正在用计算器核对 ${result.toolCalls.length} 项候选结论…`,
    };
    messages.push({ role: "assistant", content: result.assistantContent });
    messages.push({ role: "user", content: await serverToolResultBlocks(result.toolCalls) });
  }

  // 工具轮可能已输出半截报告却没有机器可读的结论行。
  // 只要结论仍无法解析，就强制补一轮纯文本；不能因为前面
  // 有一点文本就把未完成的复核当成终态。
  if (parseReviewConclusion(report).issues < 0) {
    if (opts.signal?.aborted) return { report: "", passed: false, issues: -1 };
    const finalParams: MessageCreateParamsStreaming = {
      model: opts.model,
      max_tokens: 2048,
      system: REVIEWER_SYSTEM + opts.skillPrompt + ULTRA_REVIEW_CONTRACT,
      stream: true,
      messages,
      tools: [],
      ...(opts.thinking
        ? {
            thinking: { type: "adaptive" as const, display: "summarized" as const },
            output_config: { effort: "medium" as const },
          }
        : { temperature: 0.2 }),
    };
    const stream = await createWithRetry(client, finalParams);
    for await (const delta of streamRound(stream)) {
      if (delta.kind === "content") {
        report += delta.text;
        yield { kind: "verify", text: delta.text };
      }
    }
  }
  const conclusion = parseReviewConclusion(report);
  return {
    report: report.trim(),
    // An inconclusive review is not a pass. Route it through the correction
    // stage instead of silently accepting the already-known unverified answer.
    ...(conclusion.issues < 0 ? { passed: false, issues: 1 } : conclusion),
  };
}

/**
 * Ultra 模式第 3 步（按需）：复核发现不一致时，追加一轮修正。
 * 修正内容以 content 事件流式追加到原答案之后。
 */
async function* runCorrection(
  client: ReturnType<typeof createClient>,
  opts: {
    model: string;
    messages: MessageParam[];
    answerText: string;
    report: string;
    skillPrompt: string;
    thinking?: boolean;
    signal?: AbortSignal;
  }
): AsyncGenerator<StreamDelta, string, unknown> {
  const messages: MessageParam[] = [
    ...opts.messages,
    { role: "assistant", content: opts.answerText },
    {
      role: "user",
      content:
        `子代理复核发现不一致，复核报告如下：\n${opts.report}\n\n` +
        "请从原题独立重做错误部分并输出【修正】：复核报告只能用来定位错误，不得把其中未验证的中间式或数值猜测当作正确依据。" +
        "对圆锥曲线、解析几何和方程题，必须给出闭合的解析推导和精确答案（根式/分式），并把每个候选解代回原条件；禁止数值求根、高次拟合或近似小数作为最终答案。",
    },
  ];
  // 纠错轮仅保留 calculator 作候选解代回验算，不提供
  // javascript，避免再次把数值求根产生的伪根写入答案。
  const tools = calculatorOnlyTools() ?? [];

  let fix = "";
  yield { kind: "status", text: "复核未通过，正在重做精确解析推导…" };
  for (let round = 0; round < 2; round++) {
    if (opts.signal?.aborted) return fix.trim();
    const params: MessageCreateParamsStreaming = {
      model: opts.model,
      max_tokens: 4096,
      system:
        (opts.thinking ? TEACHER_SYSTEM : DIRECT_TEACHER_SYSTEM) +
        opts.skillPrompt +
        ULTRA_ANSWER_CONTRACT,
      stream: true,
      messages,
      tools,
      ...(opts.thinking
        ? {
            thinking: { type: "adaptive" as const, display: "summarized" as const },
            output_config: { effort: "medium" as const },
          }
        : { temperature: 0.2 }),
    };
    try {
      const stream = await createWithRetry(client, params);
      const generator = streamRound(stream);
      let next = await generator.next();
      while (!next.done) {
        const delta = next.value;
        if (delta.kind === "content") {
          fix += delta.text;
          // 追加到原答案，前端 onAnswer 会继续渲染。
          yield { kind: "content", text: delta.text };
        }
        next = await generator.next();
      }
      const result = next.value;

      if (result.toolCalls.length === 0) return fix.trim();
      yield {
        kind: "status",
        text: `正在代回验算 ${result.toolCalls.length} 项精确候选解…`,
      };
      messages.push({ role: "assistant", content: result.assistantContent });
      messages.push({ role: "user", content: await serverToolResultBlocks(result.toolCalls) });
    } catch (err) {
      if (opts.signal?.aborted || (err as Error).name === "AbortError") return fix.trim();
      console.warn(`[ultra] correction stream round ${round + 1} failed, retrying:`, err);
      if (fix.trim()) return fix.trim();
      yield { kind: "status", text: "纠错流中断，正在重试精确推导…" };
    }
  }

  // 工具轮后没有修正文本：强制补一轮纯文本输出修正。
  if (!fix.trim()) {
    if (opts.signal?.aborted) return "";
    const finalParams: MessageCreateParamsStreaming = {
      model: opts.model,
      max_tokens: 4096,
      system:
        (opts.thinking ? TEACHER_SYSTEM : DIRECT_TEACHER_SYSTEM) +
        opts.skillPrompt +
        ULTRA_ANSWER_CONTRACT,
      stream: true,
      messages,
      tools: [],
      ...(opts.thinking
        ? {
            thinking: { type: "adaptive" as const, display: "summarized" as const },
            output_config: { effort: "medium" as const },
          }
        : { temperature: 0.2 }),
    };
    const stream = await createWithRetry(client, finalParams);
    for await (const delta of streamRound(stream)) {
      if (delta.kind === "content") {
        fix += delta.text;
        yield { kind: "content", text: delta.text };
      }
    }
  }
  return fix.trim();
}

/** 与 streamRound 相同，但在 content 增量时回调 capture（用于累计最终答案）。 */
async function* streamRoundWithCapture(
  stream: AsyncIterable<RawMessageStreamEvent>,
  capture: (text: string) => StreamDelta[] | void,
  reviewEvents?: {
    waitForReady(): Promise<void>;
    drain(): StreamDelta[];
  }
): AsyncGenerator<StreamDelta, RoundResult, unknown> {
  const generator = streamRound(stream);
  let mainNext = generator.next();
  while (true) {
    const winner = reviewEvents
      ? await Promise.race([
          mainNext.then((next) => ({ source: "main" as const, next })),
          reviewEvents.waitForReady().then(() => ({ source: "review" as const })),
        ])
      : { source: "main" as const, next: await mainNext };

    if (winner.source === "review") {
      for (const delta of reviewEvents!.drain()) yield delta;
      continue;
    }

    const next = winner.next;
    if (next.done) return next.value;
    const extra = next.value.kind === "content" ? capture(next.value.text) : undefined;
    yield next.value;
    if (extra) for (const delta of extra) yield delta;
    mainNext = generator.next();
  }
}

/**
 * One multimodal Claude model reads the image, answers, and calls browser tools.
 */
export async function* streamAnswer(
  env: Env,
  input: {
    question: string;
    image?: string;
    history?: ChatMessage[];
    model?: string;
    requestId?: string;
    thinking?: boolean;
    skill?: SkillId;
    ultra?: boolean;
  },
  signal?: AbortSignal
): AsyncGenerator<StreamDelta, void, unknown> {
  const model = input.model ?? MODELS.VISION;
  const requestId = input.requestId ?? "local";
  const skill = input.skill ?? "general";
  const skillPrompt = await loadSkillPrompt(skill);
  const ultra = input.ultra === true;
  const answerThinking = input.thinking === true || ultra;
  // Ultra 模式全程使用高智力模型（可配置 API_MODEL_ULTRA，缺省回退到所选模型）。
  const answerModel = ultra ? env.API_MODEL_ULTRA?.trim() || model : model;
  const reviewModel = resolveReviewModel(env);
  const directExpression = !input.image
    ? directCalculatorExpression(input.question)
    : null;

  if (directExpression) {
    const toolCallId = `calculator_${crypto.randomUUID()}`;
    const args = JSON.stringify({
      intention: "计算给定算式的值",
      expression: directExpression,
    });
    yield {
      kind: "tool_call",
      requestId,
      toolCallId,
      name: "calculator",
      args,
      executor: "server",
    };
    const result = await executeServerTool("calculator", args);
    yield {
      kind: "tool_result",
      requestId,
      toolCallId,
      name: "calculator",
      ok: result.ok,
      output: result.output,
    };
    if (result.ok) {
      yield { kind: "content", text: `${directExpression} = ${result.output}` };
      return;
    }
    // Let Claude interpret or repair expressions outside the calculator's
    // supported grammar after showing the real failed tool attempt.
  }

  const client = createClient(env, signal);
  const messages = toAnthropicMessages(
    buildMessages({ question: input.question, image: input.image, history: input.history })
  );
  // Keep an immutable problem-only context for Ultra review/correction. The main
  // answer loop appends tool calls and results to `messages`; feeding those
  // drafts (especially exploratory numerical roots) into the correction agent
  // can anchor it on the very result it is supposed to replace.
  const problemMessages = [...messages];
  const javascriptRequired = requiresJavaScript(input.question);
  const calculatorRequired = !javascriptRequired && requiresCalculator(input.question);
  const functionPlotRequired = requiresFunctionPlot(input.question);
  // Ultra 模式：先由高智力模型规划思路；作答完成后由子代理复核最终答案。
  let planText = "";
  if (ultra) {
    planText = yield* runPlanner(client, {
      model: answerModel,
      messages,
      skillPrompt,
      thinking: input.thinking === true,
    });
    console.log(`[ultra] ${requestId} model=${answerModel} plan=${planText.length}`);
  }
  const lineReview = ultra
    ? createLineReviewCoordinator(client, {
        model: reviewModel,
        problemMessages,
      })
    : null;

  let emptyRounds = 0;
  let toolCallCount = 0;
  let answerText = "";
  const usedTools = new Set<string>();
  let corrections = 0;
  console.log(
    `[request] ${requestId} model=${answerModel} reviewModel=${reviewModel} skill=${skill} ultra=${ultra} thinking=${input.thinking === true} requiredTools=${[javascriptRequired && "javascript", calculatorRequired && "calculator", functionPlotRequired && "function_plot"].filter(Boolean).join(",") || "none"} image=${Boolean(input.image)} history=${input.history?.length ?? 0} historyImages=${input.history?.filter((message) => Boolean(message.image)).length ?? 0} question=${input.question.slice(0, 120)}`
  );

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) return;
    const requiredTool = javascriptRequired && !usedTools.has("javascript")
      ? "javascript"
      : calculatorRequired && !usedTools.has("calculator")
        ? "calculator"
        : functionPlotRequired && !usedTools.has("function_plot")
          ? "function_plot"
          : null;
    const mustCallTool = requiredTool !== null;
    const selectedTools = mustCallTool
      ? TOOL_DEFINITIONS.filter((tool) => tool.function.name === requiredTool)
      : ultra && !javascriptRequired
        ? TOOL_DEFINITIONS.filter((tool) => tool.function.name !== "javascript")
        : TOOL_DEFINITIONS;
    const tools: Tool[] = selectedTools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: {
        ...tool.function.parameters,
        required: [...tool.function.parameters.required],
      },
    }));
    const params: MessageCreateParamsStreaming = {
      model: answerModel,
      max_tokens: answerThinking ? MAX_ANSWER_TOKENS + 2048 : MAX_ANSWER_TOKENS,
      system:
        (answerThinking ? TEACHER_SYSTEM : DIRECT_TEACHER_SYSTEM) +
        skillPrompt +
        (ultra ? ULTRA_ANSWER_CONTRACT : ""),
      stream: true,
      messages,
      tools,
      ...(answerThinking
        ? {
            thinking: { type: "adaptive" as const, display: "summarized" as const },
            output_config: { effort: ultra ? ("medium" as const) : ("low" as const) },
          }
        : { temperature: 0.2 }),
      ...(mustCallTool && requiredTool
        ? { tool_choice: { type: "tool" as const, name: requiredTool } }
        : {}),
    };
    const stream = await client.messages.create(params);

    let roundResult: RoundResult;
    if (mustCallTool) {
      const buffered = yield* streamRequiredToolRound(stream);
      roundResult = buffered.result;
      if (roundResult.toolCalls.length === 0) {
        console.warn(
          `[tool_required] ${requestId} round=${round + 1} missing ${requiredTool} tool call; retrying`
        );
        messages.push({
          role: "user",
          content:
            `你没有执行本题强制要求的 ${requiredTool} 工具调用，刚才的答案已被丢弃。` +
            `下一条响应只能发出一次 ${requiredTool} tool_call，不要输出解答、近似值或声称已经计算。`,
        });
        yield {
          kind: "reasoning",
          text: `\n\n未检测到真实 ${requiredTool} 调用，正在重新请求工具执行…\n\n`,
        };
        continue;
      }
      for (const delta of buffered.bufferedAnswer) {
        if (delta.kind === "content") {
          answerText += delta.text;
          yield delta;
          for (const check of lineReview?.push(delta.text) ?? []) yield check;
          continue;
        }
        yield delta;
      }
    } else {
      roundResult = yield* streamRoundWithCapture(stream, (text) => {
        answerText += text;
        return lineReview?.push(text);
      }, lineReview ?? undefined);
    }

    // Round-level provider response for the opt-in frontend debug panel. This
    // includes drafts suppressed by the required-tool policy.
    yield {
      kind: "debug",
      round: round + 1,
      finishReason: roundResult.finishReason,
      reasoning: roundResult.reasoning,
      content: roundResult.content,
      toolCalls: roundResult.toolCalls,
    };

    // No tool calls: the answer is complete.
    if (roundResult.toolCalls.length === 0) {
      // Some OpenAI-compatible relays return only reasoning_content when
      // thinking is enabled. Do not finish with a visible thinking panel and
      // an empty answer; ask once for the user-facing solution explicitly.
      if (
        roundResult.content.trim() === "" &&
        roundResult.reasoning.trim() !== "" &&
        corrections < MAX_CORRECTIONS
      ) {
        corrections += 1;
        yield { kind: "status", text: "模型只返回了思考内容，正在重新请求正式解答…" };
        messages.push({
          role: "user",
          content:
            "上一轮只返回了思考/分析，没有返回给用户看的正式解答。请立即重新输出完整、可检查的正式答案；" +
            "不要输出思维链、不要只写分析过程，数学题必须给出最终结果和关键推导。",
        });
        continue;
      }
      if (roundResult.content.trim() !== "") {
        // 防虚构：解答声称调用了计算器，但整个请求没有任何真实 tool_call 时，
        // 追加一轮纠正，要求模型真实调用 calculator 后重新作答。
        if (
          toolCallCount === 0 &&
          corrections < MAX_CORRECTIONS &&
          CALC_CLAIM_RE.test(roundResult.content)
        ) {
          corrections += 1;
          console.warn(
            `[correction] ${requestId} 解答声称调用计算器但无真实 tool_call，要求实际调用`
          );
          messages.push({
            role: "user",
            content:
              "注意：你刚才的解答中写到了“工具验证/调用了计算器（calculator）”，但实际没有发生任何工具调用。" +
              "请立即真实调用 calculator 验算相关数值（引用工具返回结果），然后只输出简短的修正说明" +
              "（如：验算结果：a≈…，b≈…，c≈…，因此结论为…），不要重复完整推导；" +
              "若确实不需要工具，请删去“工具验证/调用计算器”等字样，直接给出推导即可。",
          });
          continue;
        }

        // 子代理复核：校验最终答案，发现不一致时追加一轮修正。
        if (ultra) {
          for (const event of lineReview?.close() ?? []) yield event;
          const lineOutcome = await lineReview?.wait();
          for (const event of lineOutcome?.events ?? []) yield event;

          let review: { report: string; passed: boolean; issues: number };
          if (lineOutcome?.reliable && lineOutcome.results.length > 0) {
            const failures = lineOutcome.results.filter((item) => item.status === "failed");
            review = failures.length === 0
              ? {
                  report: `增量审核已通过 ${lineOutcome.results.length} 个答案块。\n\n校验结论：通过`,
                  passed: true,
                  issues: 0,
                }
              : {
                  report:
                    failures
                      .map(
                        (item) =>
                          `答案块 ${item.blockId + 1}：${item.detail || "存在数学或逻辑错误"}`
                      )
                      .join("\n") +
                    `\n\n校验结论：发现 ${failures.length} 处不一致`,
                  passed: false,
                  issues: failures.length,
                };
            yield { kind: "verify", text: review.report };
          } else {
            // Structured incremental review failed or returned malformed data;
            // retain the full-answer reviewer as a reliability fallback.
            review = yield* runReviewer(client, {
              model: answerModel,
              messages: problemMessages,
              answerText,
              skillPrompt,
              thinking: true,
              signal,
            });
          }
          if (review.passed) {
            console.log(
              `[ultra] ${requestId} incremental review passed (blocks=${lineOutcome?.results.length ?? 0})`
            );
          } else if (review.issues > 0) {
            console.log(
              `[ultra] ${requestId} review report tail: ${review.report.slice(-160).replace(/\n/g, " ")}`
            );
            const fixText = yield* runCorrection(client, {
              model: answerModel,
              messages: problemMessages,
              answerText,
              report: review.report,
              skillPrompt,
              thinking: true,
              signal,
            });
            console.log(
              `[ultra] ${requestId} review issues=${review.issues} fix=${fixText.length}`
            );
            if (!fixText) {
              // Never leave a known-wrong answer looking authoritative merely
              // because the correction provider stream failed after the main
              // answer had already been shown.
              yield {
                kind: "content",
                text:
                  `\n\n【复核未通过】原答案不可作为最终结论。` +
                  `子代理的独立复核结果如下：\n\n${review.report}`,
              };
            }
          } else {
            console.warn(`[ultra] ${requestId} review conclusion unparseable, skipped`);
          }
        }
        return;
      }
      // 空回合：上游在工具调用前意外断流时重试，而不是误判为完成。
      // 重试本轮而不是误判为“作答完成”。
      emptyRounds += 1;
      if (emptyRounds >= 2) {
        throw new Error("模型连续未返回内容，请重试。");
      }
      continue;
    }
    emptyRounds = 0;
    toolCallCount += roundResult.toolCalls.length;
    for (const call of roundResult.toolCalls) usedTools.add(call.name);

    // Anthropic requires the exact assistant content blocks before tool_result.
    messages.push({
      role: "assistant",
      content: roundResult.assistantContent,
    });

    // Register every browser wait before emitting any call, and start server
    // tools immediately. This lets all calls from one Claude turn run in
    // parallel instead of serializing browser round trips.
    const executions = roundResult.toolCalls.map((call) => {
      const executor = TOOL_EXECUTORS[call.name] ?? "browser";
      const resultPromise =
        executor === "server"
          ? executeServerTool(call.name, call.args)
          : awaitBrowserToolResult(requestId, call.id, signal);
      return { call, executor, resultPromise };
    });

    for (const { call, executor } of executions) {
      console.log(`[tool_call] ${requestId} ${call.name} ${call.args.slice(0, 200)}`);
      yield {
        kind: "tool_call",
        requestId,
        toolCallId: call.id,
        name: call.name,
        args: call.args,
        executor,
      };
    }

    const completed = await Promise.all(
      executions.map(async (execution) => ({
        ...execution,
        result: await execution.resultPromise,
      }))
    );

    let toolExecutionFailed = false;
    const toolResultBlocks: Array<Record<string, unknown> & { type: string }> = [];
    for (const { call, result } of completed) {
      if (!result.ok) toolExecutionFailed = true;
      console.log(`[tool_result] ${requestId} ${call.name} ok=${result.ok} output=${result.output.slice(0, 120)}`);

      yield {
        kind: "tool_result",
        requestId,
        toolCallId: call.id,
        name: call.name,
        ok: result.ok,
        output: result.output,
      };

      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: result.ok ? result.output : `工具执行失败：${result.output}`,
        is_error: !result.ok,
      });
    }

    if ((javascriptRequired || calculatorRequired) && toolExecutionFailed) {
      toolResultBlocks.push({
        type: "text",
        text: javascriptRequired
          ? "javascript 执行失败。只根据工具返回的真实错误修正代码并重新调用一次 javascript；不要心算、估算、改为手工求解或输出最终答案。代码必须是可直接执行的完整脚本：禁止顶层 return，禁止用同一名称同时表示函数和数值，禁止对标量做数组解构，最终用 console.log 输出 root、residual 和单位换算结果。"
          : "calculator 执行失败。只根据工具返回的真实错误修正表达式并重新调用一次 calculator；不要心算、估算或输出最终答案。",
      });
    }

    // All tool_result blocks for one assistant turn must be in the single,
    // immediately following user message. This matters when Claude emits
    // multiple parallel tool_use blocks in one response.
    messages.push({ role: "user", content: toolResultBlocks });
    if ((javascriptRequired || calculatorRequired) && toolExecutionFailed) continue;
  }

  throw new Error("工具调用轮次过多，已停止。");
}
