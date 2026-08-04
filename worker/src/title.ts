import { createClient } from "./anthropic";
import { resolveModel, type Env } from "./types";

/**
 * Session-title generation: one tiny streamed call reusing whichever model
 * produced the chat answer. It goes through the same client abstraction as
 * the chat pipeline (same wire shape, both provider flavors), so any relay
 * that can serve chat can also serve titles.
 */
export async function generateTitle(
  env: Env,
  model: string,
  question: string,
  answer: string
): Promise<string> {
  const prompt =
    "请为下面这段学生与 AI 老师的对话生成一个会话标题。要求：不超过 15 个汉字；" +
    "概括所问的题目或知识点；只输出标题文字本身，不要引号、书名号、编号、结尾标点或任何解释。\n\n" +
    `学生：${question}\n\n老师：${answer}`;

  const client = createClient(env);
  const stream = await client.messages.create({
    model: model || resolveModel(env.API_MODEL),
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });

  let raw = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      raw += String(event.delta.text ?? "");
    }
  }
  return sanitizeTitle(raw);
}

/** First line only, stripped of wrapping quotes/trailing punctuation, capped. */
function sanitizeTitle(raw: string): string {
  const firstLine = (raw.split(/\r?\n/)[0] ?? "").trim();
  const unwrapped = firstLine
    .replace(/^[\s"'‘“「『《〈【[(]+/, "")
    .replace(/[\s"'’”」』》〉》】[)\]。．.,，;；:：!！?？…·~-]+$/, "")
    .trim();
  return unwrapped.slice(0, 30);
}
