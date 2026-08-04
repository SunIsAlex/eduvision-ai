import { runTool } from "./toolRunner";
import type { ApiMessage, ModelOption } from "./types";
import type { LocalApiConfig } from "./localConfig";
import type { StreamCallbacks } from "./api";

type OpenAIMessage = Record<string, unknown>;

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
  return /vision|omni|4o|4\.1|sonnet|gemini|luna|sol/i.test(model ?? "");
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
  const vision = available.find((model) => model.multimodal && model.id !== selected)?.id;
  if (image && vision && !imageModel(selected, available)) {
    cb.onThinking(`正在使用 ${vision} 做题目 OCR 复述…`);
    try {
      const transcription = await ocrImage(config, vision, image, signal);
      question = `${question}\n\n【图片题目 OCR 复述】\n${transcription}`.trim();
      // The selected text-only model receives the verified transcription, not
      // the image it cannot process. Historical images are omitted below too.
      image = undefined;
    } catch (error) {
      cb.onError(error instanceof Error ? error.message : "图片 OCR 失败");
      return;
    }
  }
  const conversation: OpenAIMessage[] = [
    { role: "system", content: localSystem(Boolean(request.thinking), Boolean(request.ultra)) },
    ...messages({
      ...request,
      question,
      image,
      history: imageModel(selected, available)
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
        model: selected,
        stream: true,
        max_tokens: 8192,
        messages: conversation,
        tools: [CALCULATOR_TOOL],
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
    }
    if (buffer.trim()) consume(buffer);

    if (toolCalls.size === 0 || finishReason !== "tool_calls") {
      cb.onDone({ pipeline: "browser-local", model: selected });
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
