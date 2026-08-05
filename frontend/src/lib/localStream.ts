import { runTool } from "./toolRunner";
import type { ApiMessage, ModelOption } from "./types";
import type { LocalApiConfig } from "./localConfig";
import type { StreamCallbacks } from "./api";

type OpenAIMessage = Record<string, unknown>;

// Stop a runaway visible CoT before it consumes the provider's entire output
// allowance. The follow-up answer has its own fresh output budget.
const LOCAL_REASONING_TOKEN_LIMIT = 16_000;

function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

const CALCULATOR_TOOL = {
  type: "function",
  function: {
    name: "calculator",
    description: "在浏览器本地精确计算纯数学表达式。不要把解释写进 expression。",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
};

function endpoint(url: string): string {
  const base = url.trim().replace(/\/$/, "");
  if (!base) throw new Error("请先在“手动配置”中填写 API URL");
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${/\/v1$/i.test(base) ? base : `${base}/v1`}/chat/completions`;
}

function messages(request: {
  history: ApiMessage[];
  question?: string;
  image?: string;
}): OpenAIMessage[] {
  const result: OpenAIMessage[] = request.history.map((message) => ({
    role: message.role,
    content: message.image
      ? [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          { type: "image_url", image_url: { url: message.image, detail: "high" } },
        ]
      : message.content,
  }));
  result.push({
    role: "user",
    content: request.image
      ? [
          ...(request.question ? [{ type: "text", text: request.question }] : []),
          { type: "image_url", image_url: { url: request.image, detail: "high" } },
        ]
      : request.question ?? "",
  });
  return result;
}

function localSystem(thinking: boolean, ultra: boolean): string {
  return `你是运行在用户浏览器中的 AI 教师。默认中文、Markdown 和 LaTeX，直接给出可检查的解答。${
    thinking ? "先用一两句简短思路说明，再输出答案。" : "不要输出内部思考。"
  }${
    ultra
      ? " Ultra 模式：精确题先解析推导，圆锥曲线/解析几何去掉绝对值前必须先检验符号或给出符号区间，最后代回原等式；不要用近似值替代根式答案。"
      : ""
  } 需要数值计算时调用 calculator 工具，工具结果来自浏览器本地 mathjs。`;
}

function imageModel(model: string | undefined, available: ModelOption[]): boolean {
  const found = available.find((item) => item.id === model);
  if (found) return found.multimodal === true;
  return /vision|omni|ocr|(?:^|[-_/])vl(?:$|[-_/])|4o|4\.1|sonnet|gemini|luna|sol/i.test(model ?? "");
}

function isDeepSeek(config: LocalApiConfig): boolean {
  return /deepseek\.com/i.test(config.apiUrl);
}

function effectiveModel(
  config: LocalApiConfig,
  selected: string,
  thinking: boolean,
  available: ModelOption[]
): string {
  if (!isDeepSeek(config)) return selected;
  const wanted = thinking ? /reasoner|reasoning/i : /chat(?!.*reasoner)|v3/i;
  const opposite = thinking ? /chat(?!.*reasoner)/i : /reasoner|reasoning/i;
  if (wanted.test(selected) && !opposite.test(selected)) return selected;
  return available.find((model) => wanted.test(model.id))?.id ?? selected;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => (item && typeof item === "object" && "text" in item ? String(item.text ?? "") : ""))
    .join("");
}

async function ocrImage(
  config: LocalApiConfig,
  model: string,
  image: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(endpoint(config.apiUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey.trim()}`,
      "x-api-key": config.apiKey.trim(),
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content: "请只做题目 OCR 复述：准确抄录图片中的文字、点名、下标、正负号、数字和几何关系，不要解题，不要猜测看不清的内容。",
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: image, detail: "high" } }],
        },
      ],
    }),
    signal,
  });
  if (!response.ok) throw new Error(`OCR 请求失败（${response.status}）`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const text = contentText(body.choices?.[0]?.message?.content);
  if (!text.trim()) throw new Error("OCR 模型没有返回题目复述");
  return text.trim();
}

/** Direct browser SSE for manually configured OpenAI-compatible endpoints. */
export async function streamLocalChat(
  request: {
    requestId: string;
    image?: string;
    question?: string;
    history: ApiMessage[];
    thinking?: boolean;
    model?: string;
    ultra?: boolean;
    availableModels?: ModelOption[];
  },
  config: LocalApiConfig,
  cb: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const url = endpoint(config.apiUrl);
  let question = request.question ?? "";
  let image = request.image;
  const available = request.availableModels ?? [];
  const selected = request.model || "gpt-5.6-luna";
  const thinking = Boolean(request.thinking);
  const activeModel = effectiveModel(config, selected, thinking, available);
  let forceFormalAnswer = false;
  const selectedSupportsImage = imageModel(activeModel, available);
  // OCR capability metadata is often missing from OpenAI-compatible /models
  // responses. The user therefore chooses this model explicitly; do not
  // reject that choice based on the same unreliable capability heuristic.
  const configuredOcr = available.find((model) => model.id === config.ocrModel)?.id;
  const vision = selectedSupportsImage ? activeModel : configuredOcr;
  if (image && !selectedSupportsImage && !vision) {
    cb.onError("当前回答模型不支持图片，请在顶部 OCR 列表中选择模型后重试");
    return;
  }
  if (image && vision) {
    cb.onThinking(`正在使用 ${vision} 做题目 OCR 复述…`);
    try {
      const transcription = await ocrImage(config, vision, image, signal);
      question = `${question}\n\n${transcription}`.trim();
      cb.onOcrResult?.(question);
      cb.onDebug?.("local_ocr", { model: vision, text: transcription });
      // A multimodal solver receives both the editable transcription and the
      // original image, preserving diagrams/layout. A text-only solver gets
      // only the transcription it can actually consume.
      if (!selectedSupportsImage) image = undefined;
    } catch (error) {
      cb.onError(error instanceof Error ? error.message : "图片 OCR 失败");
      return;
    }
  }
  const conversation: OpenAIMessage[] = [
    { role: "system", content: localSystem(thinking, Boolean(request.ultra)) },
    ...messages({
      ...request,
      question,
      image,
      history: selectedSupportsImage
        ? request.history
        : request.history.map((item) => ({ ...item, image: undefined })),
    }),
  ];

  for (let round = 0; round < 4; round++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`,
        "x-api-key": config.apiKey.trim(),
      },
      body: JSON.stringify({
        model: activeModel,
        stream: true,
        // DeepSeek counts reasoning_content against the same output budget.
        // Complex homework can otherwise spend the whole 8k budget thinking
        // and terminate with finish_reason=length before emitting content.
        max_tokens: thinking && !forceFormalAnswer ? 32768 : 8192,
        messages: conversation,
        tools: [CALCULATOR_TOOL],
        ...(isDeepSeek(config)
          ? { thinking: { type: thinking && !forceFormalAnswer ? "enabled" : "disabled" } }
          : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      cb.onError(`本地 API 请求失败（${response.status}）${detail ? `：${detail}` : ""}`);
      return;
    }
    if (!response.body) {
      cb.onError("本地 API 未返回 SSE 数据流");
      return;
    }

    cb.onThinking(round === 0 ? "正在浏览器本地连接 API…" : "正在使用浏览器本地计算结果继续…");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let finishReason = "";
    let reasoningCutOff = false;
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    const consume = (raw: string) => {
      const data = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim();
      if (!data || data === "[DONE]") return;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      // Keep the original provider chunk available in the existing debug JSON
      // panel. It contains model/finish_reason/reasoning_content/content but no
      // API credentials or request headers.
      cb.onDebug?.("local_sse", chunk as Record<string, unknown>);
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === "string") {
        content += delta.content;
        cb.onAnswer(delta.content);
      }
      const thought = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof thought === "string") {
        reasoning += thought;
        cb.onReasoning(thought);
      }
      for (const item of delta?.tool_calls ?? []) {
        const index = Number(item.index ?? 0);
        const current = toolCalls.get(index) ?? { id: "", name: "", args: "" };
        current.id += item.id ?? "";
        current.name += item.function?.name ?? "";
        current.args += item.function?.arguments ?? "";
        toolCalls.set(index, current);
      }
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    };

    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
      if (
        thinking &&
        !forceFormalAnswer &&
        !content.trim() &&
        estimateTokens(reasoning) >= LOCAL_REASONING_TOKEN_LIMIT
      ) {
        reasoningCutOff = true;
        finishReason = "reasoning_budget";
        buffer = "";
        // Cancel only this upstream response. Do not abort the shared signal,
        // because the immediate non-thinking completion must keep using it.
        await reader.cancel("reasoning budget reached").catch(() => undefined);
        break;
      }
    }
    if (!reasoningCutOff && buffer.trim()) consume(buffer);

    cb.onDebug?.("local_round", {
      model: activeModel,
      finishReason,
      reasoningChars: reasoning.length,
      estimatedReasoningTokens: estimateTokens(reasoning),
      contentChars: content.length,
      thinking: thinking && !forceFormalAnswer,
    });

    if (toolCalls.size === 0 || finishReason !== "tool_calls") {
      if (
        thinking &&
        !forceFormalAnswer &&
        reasoning.trim() &&
        (!content.trim() || finishReason === "length" || finishReason === "reasoning_budget")
      ) {
        forceFormalAnswer = true;
        cb.onThinking(
          finishReason === "reasoning_budget"
            ? "思考已达到预算，正在暂停思考并依据已有推理直接作答…"
            : finishReason === "length"
              ? "思考输出达到长度上限，正在依据已有推理完成答案…"
            : "思考完成，正在依据已有推理生成正式答案…"
        );
        // DeepSeek documents that reasoning_content from a no-tool turn may be
        // ignored in later requests. Put the completed reasoning into ordinary
        // assistant content so the non-thinking completion must condition on
        // it instead of solving again from scratch.
        conversation.push({
          role: "assistant",
          content: content.trim()
            ? `【上一轮分析】\n${reasoning}\n\n【已输出的答案片段】\n${content}`
            : `【上一轮分析】\n${reasoning}`,
        });
        conversation.push({
          role: "user",
          content: content.trim()
            ? "请严格依据上面的分析继续完成正式答案，只输出尚未完成的部分，不要重复已有答案片段，不要省略最终结论。"
            : "请严格依据上面的分析整理成给用户看的正式答案，保留必要关键推导和最终结论，不要重新求解，不要输出思维链。",
        });
        continue;
      }
      cb.onDone({ pipeline: "browser-local", model: activeModel });
      return;
    }

    const calls = [...toolCalls.values()];
    conversation.push({
      role: "assistant",
      content: content || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.args },
      })),
    });
    for (const call of calls) {
      cb.onToolCall({ toolCallId: call.id, name: call.name, args: call.args, executor: "browser" });
      const result = await runTool({ name: call.name, args: call.args });
      cb.onToolResult({ toolCallId: call.id, name: call.name, ok: result.ok, output: result.output });
      conversation.push({ role: "tool", tool_call_id: call.id, content: result.output });
    }
  }
  cb.onError("本地 API 工具调用超过最大轮数");
}
