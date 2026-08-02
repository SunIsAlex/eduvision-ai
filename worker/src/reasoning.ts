import type OpenAI from "openai";
import { createClient, streamRound, visionContent, type StreamDelta } from "./siliconflow";
import { TOOL_EXECUTORS, TOOL_DEFINITIONS } from "./tools";
import { awaitBrowserToolResult } from "./toolbridge";
import { MODELS, type ChatMessage, type Env } from "./types";

const TEACHER_SYSTEM = `你是一位经验丰富、深受学生喜爱的中学教师。请用清晰、循序渐进的方式解答学生的问题。
要求：
1. 解答要像老师在课堂上讲解一样：先说明考点/思路，再分步推导，最后总结；
2. 数学问题给出完整的推导过程，不要跳步；公式使用 LaTeX（行内 $...$，独立行 $$...$$）；
3. 如果学生上传了图片，请直接阅读图片作答（几何图形、函数图像、实验装置、化学结构、表格、手写体等），并尽量把图片中的题目文字、小问、表格数据完整读出来逐项作答；看不清的地方如实说明，不要编造。图片题与文字题一视同仁：识别出题目后，凡涉及数值计算、比较大小、判别式、验根、单位换算等，同样按规则 7、8、14 调用 calculator 验算，不要因为题目来自图片就跳过验算或完全口算；
4. 使用 Markdown 排版，步骤用有序列表；
5. 中文作答（除非题目本身是英文题，则保留英文术语并给出中文解释）；
6. 不要输出任何内部思考过程，只输出最终解答；
7. 正常口算和手写推导即可，不必为每个数字都调用工具；但鼓励在关键数值计算与验算时调用 calculator 工具验证结果（如判别式、求根公式代入、验根、组合数、单位换算、复杂的乘方开方、实数/无理数近似比较等），并在解答中标注“工具验证：…”，让计算更可靠、讲解更有说服力；
8. 解方程类题目（如“解方程 x²-5x+6=0”）按常规方法（因式分解、配方法或求根公式）自然求解即可；建议最后用 calculator 把求得的根代回原方程验算（如 2^2-5*2+6 与 3^2-5*3+6），确认结果为 0 后说明验根通过；
9. 需要枚举、计数、暴力验证、递推、列出所有情况（例如“有多少种可能”“把所有情况列出来”）时，可以调用 javascript 工具编写代码执行（代码必须用 console.log 输出最终结果，并注意避免死循环），也可以直接手推；引用工具输出时不要编造；
10. 不确定 mathjs 是否支持某个运算时（solve 解方程、simplify 化简、derivative 求导等已被禁用），不要发明不存在的函数名，改用 javascript 工具写代码计算；
11. 纯符号推导、公式变形、概念解释等不需要调用工具；calculator 用于验算和复杂数值计算，何时调用由你根据题目需要自行判断，不必纠结；
12. 工具调用失败时，根据错误信息修正表达式或代码后重试（最多 6 轮）；仍失败则改用 javascript 工具或直接推导，不要反复调用同一错误表达式；
13. 严禁虚构工具调用：解答中写“工具验证”“调用计算器/calculator”等字样时，必须确实调用了该工具并引用真实返回结果；没有真实调用就不要写这些字样，直接给出推导即可；
14. 涉及根式、对数、指数的大小比较问题（如比较 √2+√3 与 π、比较含 ln/log 或指数的表达式大小等）：看到题目后的第一轮输出就必须调用 calculator 计算各个表达式的数值（保留足够精度），**不要先输出解答文字**；拿到工具返回结果后，再在解答中解说比较过程与结论。不允许先口算再作答，也不允许跳过工具直接比较。`;

const MAX_TOOL_ROUNDS = 6;

/** 解答文本中出现这些字样，视为声称使用了计算器/工具验证。 */
const CALC_CLAIM_RE =
  /工具验证|调用(?:了)?(?:calculator|计算器)|(?:calculator|计算器)[^\n。；]{0,10}(?:计算|验证|结果)/i;

/** Build the chat messages: system + recent history + current question/image. */
function buildMessages(input: {
  question: string;
  image?: string;
  history?: ChatMessage[];
}): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: TEACHER_SYSTEM }];

  if (input.history && input.history.length > 0) {
    for (const msg of input.history.slice(-6)) {
      messages.push(msg);
    }
  }

  const userText =
    input.question.trim() ||
    "请根据图片中的题目作答。注意：图片题与文字题同等对待，若题目涉及数值计算、比较大小、判别式、验根、单位换算等，请调用 calculator 工具验算，并引用工具真实返回的结果；不要在没有调用工具的情况下写“工具验证”等字样。";
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
  const messages = toOpenAIMessages(buildMessages(input));
  const client = createClient(env);
  const model = input.model ?? MODELS.VISION;
  const requestId = input.requestId ?? "local";
  let emptyRounds = 0;
  let toolCallCount = 0;
  let corrections = 0;
  console.log(`[request] ${requestId} model=${model} question=${input.question.slice(0, 120)}`);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      temperature: 0.3,
      max_tokens: 8192,
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
        if (toolCallCount === 0 && corrections < 2 && CALC_CLAIM_RE.test(roundResult.content)) {
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
  }

  throw new Error("工具调用轮次过多，已停止。");
}
