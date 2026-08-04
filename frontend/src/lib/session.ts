import type { ChatMessage } from "./types";
import { normalizeMessages } from "./persist";

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SessionSnapshot {
  messages: ChatMessage[];
  contextBreak: number;
  updatedAt?: string;
}

export function createSessionId(): string {
  return crypto.randomUUID();
}

export function replaceSessionUrl(sessionId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  window.history.replaceState(null, "", url);
}

export function getOrCreateSessionId(): string {
  const existing = new URL(window.location.href).searchParams.get("session");
  if (existing && SESSION_RE.test(existing)) return existing;
  const created = createSessionId();
  replaceSessionUrl(created);
  return created;
}

export async function loadRemoteSession(sessionId: string): Promise<SessionSnapshot | null> {
  const response = await fetch(`/api/sessions/${sessionId}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`会话读取失败（${response.status}）`);
  const value = (await response.json()) as { messages?: unknown; contextBreak?: unknown; updatedAt?: unknown };
  return {
    messages: normalizeMessages(value.messages),
    contextBreak: typeof value.contextBreak === "number" ? Math.max(0, value.contextBreak) : 0,
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

export async function saveRemoteSession(
  sessionId: string,
  snapshot: Omit<SessionSnapshot, "updatedAt">
): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw new Error(`会话保存失败（${response.status}）`);
}

export async function deleteRemoteSession(sessionId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`会话删除失败（${response.status}）`);
  }
}
