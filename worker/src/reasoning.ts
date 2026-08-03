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
import { MODELS, type ChatMessage, type Env } from "./types";

const TEACHER_SYSTEM = `你是一位严谨、简洁的中学教师。目标是在保证正确和易懂的前提下，用最少的必要推理解决学生的问题。

作答原则：
1. 按难度自适应：简单题直接给出结论和 1～3 个关键步骤；普通题给出思路、必要推导和答案；只有证明题或确实复杂的题目才展开完整论证。
2. 得出可靠结论后立即停止。不要反复审题、自我质疑、重复验算、枚举无关可能，也不要同时尝试多种解法；除非用户明确要求，不复述整道题，不重复总结。
3. 只输出给学生看的解答，不输出内部思考、自我对话、计划或检查过程。解释“为什么”时给出可验证的关键依据，而不是冗长思维过程。
4. 图片题只提取解题需要的文字、数据和图形关系并直接作答；有多问时逐项回答。看不清或信息不足就明确指出，不猜测、不编造。
5. 优先心算和直接推导，但下列情况必须先调用 calculator，再引用真实结果作答：pH/pOH 或平衡常数的数值计算；最终数值依赖对数、根式、非整数指数、三角函数或高精度近似；用户明确要求使用 calculator。遇到这些题时，只需确定公式和一个可直接求最终值的表达式，然后立即调用工具；调用前严禁心算、估算、分步计算、预测或写出近似结果。能合并成一个表达式时只调用一次。工具返回后直接使用结果，不得再手算一遍或从头重复推导。
6. 下列情况必须调用 javascript 数值求解：未知量同时出现在方程两边且没有简单解析解；非线性方程或联立方程需要迭代；化学平衡需要同时满足物料衡算、电荷守恒、络合/酸碱/溶度积关系；用户明确要求数值法、迭代法、二分法或牛顿法。优先使用稳定的二分法，在物理允许区间内求根，并输出根、残差和最终单位换算；严禁用手工试值或反复近似代替工具。javascript 也可用于必要的大规模枚举、计数和递推。
7. 一次工具调用能完成时不要拆成多轮。工具失败时最多修正重试一次，仍失败才改为直接推导或说明限制。
8. 严禁虚构工具调用。只有真实调用并拿到结果后，才可以写“工具验证”或引用工具结果；纯符号推导、公式变形和概念解释不调用工具。
9. 默认使用中文、Markdown 和 LaTeX（行内 $...$，独立行 $$...$$）。避免固定套话和过度分段；结论要明确。英文题保留必要的英文术语并用中文解释。
10. 若用户明确要求详细推导、证明、所有情况或指定工具，则服从该要求，但仍避免重复内容。
11. 数值求解输出前必须做通用一致性检查：正文方程、工具代码和验证式必须一致；重新枚举守恒式涉及的全部物种或变量，逐项代回并报告以主要量级为分母的相对残差（理论残差为 0 时禁止除以 0）。任一关键相对残差大于 1e-6、左右两边明显不等或量纲不一致时，必须修正后重算，不能宣称结果可靠。
12. 复杂方程优先代数消元并降为单变量有界求根；确实无法降维才使用带物理约束、阻尼和收敛检查的多元算法。一次 javascript 应同时输出结果和全部关键残差；若已用完整精度验证通过，calculator 最多做 1～2 个独立抽查，不重复计算由定义直接得到的量。
13. 使用单调性、凹凸性、Jensen、切线法或“对称性取等”前，必须做一次短验证：写出相关导数或等价判据，在题目的完整实际区间内检查符号；若导数变号就分段处理或换方法。对称只能提出候选点，不能证明它是全局最值；还必须排除边界和其他驻点。绝不凭熟悉印象宣称函数在整段上单调、凸或凹。
14. 最终答案只保留一条已经闭合且逐步有效的证明。输出前用一遍简短反向审查确认：每个定理的前提覆盖完整定义域、每个不等号方向正确、等号条件可实现，且正文没有重新采用思考过程中已被否定的论证。发现关键步骤无效就先修正；不要用数值试验或“看起来对称”掩盖证明缺口。完成这次检查后立即作答，不继续寻找第二种解法。`;

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

/** Text questions that need an iterative/root-finding JavaScript program. */
const JAVASCRIPT_REQUIRED_RE =
  /(?:数值求解|迭代法?|二分法?|牛顿法?|非线性方程|联立.{0,8}方程)|(?:NH3|氨水|络合|配位|EDTA|CN[-⁻]?).{0,40}(?:溶解度|沉淀平衡)|(?:溶解度|沉淀平衡).{0,40}(?:NH3|氨水|络合|配位|EDTA|CN[-⁻]?)/i;

export function requiresJavaScript(question: string): boolean {
  return JAVASCRIPT_REQUIRED_RE.test(question);
}

/** Build the chat messages: system + recent history + current question/image. */
function buildMessages(input: {
  question: string;
  image?: string;
  history?: ChatMessage[];
}): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (input.history && input.history.length > 0) {
    for (const msg of input.history.slice(-6)) {
      // Historical images are omitted to keep follow-up requests compact.
      if (msg.content.trim()) messages.push({ role: msg.role, content: msg.content });
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
  }
): AsyncGenerator<StreamDelta, void, unknown> {
  const client = createClient(env);
  const model = input.model ?? MODELS.VISION;
  const requestId = input.requestId ?? "local";
  const messages = toAnthropicMessages(
    buildMessages({ question: input.question, image: input.image, history: input.history })
  );
  const javascriptRequired = requiresJavaScript(input.question);
  const calculatorRequired = !javascriptRequired && requiresCalculator(input.question);
  let emptyRounds = 0;
  let toolCallCount = 0;
  let corrections = 0;
  console.log(
    `[request] ${requestId} model=${model} thinking=${input.thinking === true} requiredTool=${javascriptRequired ? "javascript" : calculatorRequired ? "calculator" : "none"} image=${Boolean(input.image)} question=${input.question.slice(0, 120)}`
  );

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const requiredTool = javascriptRequired
      ? "javascript"
      : calculatorRequired
        ? "calculator"
        : null;
    const mustCallTool = requiredTool !== null && toolCallCount === 0;
    const selectedTools = mustCallTool
      ? TOOL_DEFINITIONS.filter((tool) => tool.function.name === requiredTool)
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
      model,
      max_tokens: input.thinking ? MAX_ANSWER_TOKENS + 2048 : MAX_ANSWER_TOKENS,
      system: TEACHER_SYSTEM,
      stream: true,
      messages,
      tools,
      ...(input.thinking
        ? {
            thinking: { type: "adaptive" as const, display: "summarized" as const },
            output_config: { effort: "low" as const },
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
      for (const delta of buffered.bufferedAnswer) yield delta;
    } else {
      roundResult = yield* streamRound(stream);
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

    // Anthropic requires the exact assistant content blocks before tool_result.
    messages.push({
      role: "assistant",
      content: roundResult.assistantContent,
    });

    let toolExecutionFailed = false;
    const toolResultBlocks: Array<Record<string, unknown> & { type: string }> = [];
    for (const call of roundResult.toolCalls) {
      const executor = TOOL_EXECUTORS[call.name] ?? "browser";
      console.log(`[tool_call] ${requestId} ${call.name} ${call.args.slice(0, 200)}`);
      yield {
        kind: "tool_call",
        requestId,
        toolCallId: call.id,
        name: call.name,
        args: call.args,
        executor,
      };

      const result = await awaitBrowserToolResult(requestId, call.id, env.TOOL_RESULTS);
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
