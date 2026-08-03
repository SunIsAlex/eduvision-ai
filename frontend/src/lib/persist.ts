import type { ChatMessage } from "./types";
import { repairAdjacentDisplayMath } from "./utils";

const LEGACY_STORAGE_KEY = "eduvision-chat-messages-v1";
const MAX_MESSAGES = 50;

function storageKey(sessionId: string): string {
  return `eduvision-chat-session-v1:${sessionId}`;
}

function normalize(m: unknown): ChatMessage | null {
  if (!m || typeof m !== "object") return null;
  const role = (m as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") return null;
  const msg = m as Partial<ChatMessage>;
  return {
    id: typeof msg.id === "string" ? msg.id : String(Math.random()).slice(2),
    role,
    content: typeof msg.content === "string" ? repairAdjacentDisplayMath(msg.content) : "",
    ...(typeof msg.reasoning === "string" ? { reasoning: msg.reasoning } : {}),
    ...(typeof msg.ocr === "string" ? { ocr: msg.ocr } : {}),
    ...(Array.isArray(msg.tools) ? { tools: msg.tools } : {}),
    ...(typeof msg.image === "string" ? { image: msg.image } : {}),
    ...(typeof msg.pipeline === "string" ? { pipeline: msg.pipeline } : {}),
    ...(typeof msg.model === "string" ? { model: msg.model } : {}),
    ...(typeof msg.error === "boolean" ? { error: msg.error } : {}),
    ...(Array.isArray(msg.debugEvents) ? { debugEvents: msg.debugEvents } : {}),
    ...(role === "assistant"
      ? { status: msg.status === "error" ? ("error" as const) : ("done" as const) }
      : {}),
  };
}

/** 从 localStorage 恢复聊天记录；解析失败或无数据时返回空数组。 */
export function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalize).filter((m): m is ChatMessage => m !== null);
}

export function loadMessages(sessionId: string): ChatMessage[] {
  try {
    const key = storageKey(sessionId);
    const raw = localStorage.getItem(key) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const messages = normalizeMessages(parsed);
    if (!localStorage.getItem(key) && messages.length > 0) {
      localStorage.setItem(key, JSON.stringify(messages));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    return messages;
  } catch {
    return [];
  }
}

/** 保存聊天记录（最多保留最近 MAX_MESSAGES 条；图片超配额时降级去掉图片重试）。 */
export function saveMessages(sessionId: string, messages: ChatMessage[]): void {
  const toSave = messages.slice(-MAX_MESSAGES);
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(toSave));
    return;
  } catch {
    // 可能是图片 data URL 超出 localStorage 配额：去掉图片再试一次。
  }
  try {
    const withoutImages = toSave.map((m) =>
      m.image ? { ...m, image: undefined } : m
    );
    localStorage.setItem(storageKey(sessionId), JSON.stringify(withoutImages));
  } catch {
    // 持久化失败不影响正常使用。
  }
}

/** 清空已保存的聊天记录（新对话时调用）。 */
export function removeSavedMessages(sessionId: string): void {
  try {
    localStorage.removeItem(storageKey(sessionId));
  } catch {
    // ignore
  }
}
