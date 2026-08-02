import type OpenAI from "openai";
import { createClient, streamRound, visionContent, type StreamDelta } from "./siliconflow";
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
6. javascript 仅用于必要的大规模枚举、计数、递推或 calculator 无法完成的计算。一次工具调用能完成时不要拆成多轮；工具失败时最多修正重试一次，仍失败就改为直接推导或说明限制。
7. 严禁虚构工具调用。只有真实调用并拿到结果后，才可以写“工具验证”或引用工具结果；纯符号推导、公式变形和概念解释不调用工具。
8. 默认使用中文、Markdown 和 LaTeX（行内 $...$，独立行 $$...$$）。避免固定套话和过度分段；结论要明确。英文题保留必要的英文术语并用中文解释。
9. 若用户明确要求详细推导、证明、所有情况或指定工具，则服从该要求，但仍避免重复内容。`;

const MAX_TOOL_ROUNDS = 3;
const MAX_CORRECTIONS = 1;
const INITIAL_THINKING_BUDGET = 1024;
const FOLLOW_UP_THINKING_BUDGET = 512;
const CALCULATOR_THINKING_BUDGET = 256;
const CALCULATOR_FOLLOW_UP_BUDGET = 128;
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

/** Build the chat messages: system + recent history + current question/image. */
function buildMessages(input: {
  question: string;
  image?: string;
  history?: ChatMessage[];
}): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (input.history && input.history.length > 0) {
    for (const msg of input.history.slice(-6)) {
      messages.push(msg);
    }
  }

  const baseUserText =
    input.question.trim() ||
    "请识别图片中的题目并简洁作答。只提取解题所需信息；看不清或信息不足的地方请明确说明。";
  const userText = requiresCalculator(input.question)
    ? `${baseUserText}\n\n执行要求：本题属于必须使用 calculator 的数值计算。只确定公式，不做任何心算、估算或分步数值计算；第一轮立即用一个完整表达式调用 calculator。工具返回后直接引用结果给出简洁解答，不要重新计算或重复推导。`
    : baseUserText;
  messages.push(
    input.image
      ? { role: "user", content: userText, image: input.image }
      : { role: "user", content: userText }
  );
  return messages;
}

/** Convert our internal messages into OpenAI-format chat messages. */
function toOpenAIMessages(
  messages: ChatMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.image) {
      return {
        role: m.role,
        content: visionContent(m.content, m.image),
      } as OpenAI.Chat.ChatCompletionMessageParam;
    }
    return { role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

/**
 * Single-model tool-calling pipeline: one multimodal model reads the image
 * (pixels preserved end-to-end), streams its chain of thought, and may call
 * tools. Server-side tools execute immediately; browser tools pause the stream
 * until the browser POSTs the result back, then the model continues.
 */
export async function* streamAnswer(
  env: Env,
  input: {
    question: string;
    image?: string;
    history?: ChatMessage[];
    model?: string;
    requestId?: string;
  }
): AsyncGenerator<StreamDelta, void, unknown> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: TEACHER_SYSTEM },
    ...toOpenAIMessages(buildMessages(input)),
  ];
  const client = createClient(env);
  const model = input.model ?? MODELS.VISION;
  const requestId = input.requestId ?? "local";
  const calculatorRequired = requiresCalculator(input.question);
  let emptyRounds = 0;
  let toolCallCount = 0;
  let corrections = 0;
  console.log(`[request] ${requestId} model=${model} question=${input.question.slice(0, 120)}`);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming & {
      thinking_budget: number;
    } = {
      model,
      temperature: 0.2,
      max_tokens: MAX_ANSWER_TOKENS,
      thinking_budget: calculatorRequired
        ? round === 0
          ? CALCULATOR_THINKING_BUDGET
          : CALCULATOR_FOLLOW_UP_BUDGET
        : round === 0
          ? INITIAL_THINKING_BUDGET
          : FOLLOW_UP_THINKING_BUDGET,
      stream: true,
      messages,
      tools: TOOL_DEFINITIONS as unknown as OpenAI.Chat.ChatCompletionTool[],
    };
    const stream = await client.chat.completions.create({
      ...params,
    });

    const roundResult = yield* streamRound(stream);

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
          } as OpenAI.Chat.ChatCompletionMessageParam);
          continue;
        }
        return;
      }
      // 空回合：模型什么都没产出（SiliconFlow 偶发在工具调用前提前断流），
      // 重试本轮而不是误判为“作答完成”。
      emptyRounds += 1;
      if (emptyRounds >= 2) {
        throw new Error("模型连续未返回内容，请重试。");
      }
      continue;
    }
    emptyRounds = 0;
    toolCallCount += roundResult.toolCalls.length;

    // Assistant message with tool calls, required before tool messages.
    messages.push({
      role: "assistant",
      content: roundResult.content || null,
      tool_calls: roundResult.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.args },
      })),
    } as OpenAI.Chat.ChatCompletionMessageParam);

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

      const result = await awaitBrowserToolResult(requestId, call.id);
      console.log(`[tool_result] ${requestId} ${call.name} ok=${result.ok} output=${result.output.slice(0, 120)}`);

      yield {
        kind: "tool_result",
        requestId,
        toolCallId: call.id,
        name: call.name,
        ok: result.ok,
        output: result.output,
      };

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.ok ? result.output : `工具执行失败：${result.output}`,
      } as OpenAI.Chat.ChatCompletionMessageParam);
    }

    if (calculatorRequired) {
      messages.push({
        role: "user",
        content:
          "工具结果已经返回。请直接引用该结果完成最终解答；不要重新心算、估算、验算或从头重复推导。",
      });
    }
  }

  throw new Error("工具调用轮次过多，已停止。");
}
