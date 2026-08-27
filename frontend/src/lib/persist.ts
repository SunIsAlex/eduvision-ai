import type { ChatMessage } from "./types";
import { repairAdjacentDisplayMath } from "./utils";

const LEGACY_STORAGE_KEY = "eduvision-chat-messages-v1";
const MAX_MESSAGES = 50;

function storageKey(sessionId: string, scope: string): string {
  return `eduvision-chat-session-v2:${scope}:${sessionId}`;
}

function legacySessionKey(sessionId: string): string {
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
    ...(typeof msg.plan === "string" ? { plan: msg.plan } : {}),
    ...(typeof msg.verify === "string" ? { verify: msg.verify } : {}),
    ...(Array.isArray(msg.lineChecks) ? { lineChecks: msg.lineChecks } : {}),
    ...(Array.isArray(msg.tools) ? { tools: msg.tools } : {}),
    ...(typeof msg.image === "string" ? { image: msg.image } : {}),
    ...(typeof msg.ocrGenerated === "boolean" ? { ocrGenerated: msg.ocrGenerated } : {}),
    ...(typeof msg.ocrConfirmed === "boolean" ? { ocrConfirmed: msg.ocrConfirmed } : {}),
    ...(typeof msg.pipeline === "string" ? { pipeline: msg.pipeline } : {}),
    ...(typeof msg.model === "string" ? { model: msg.model } : {}),
    ...(typeof msg.error === "boolean" ? { error: msg.error } : {}),
    ...(typeof msg.edited === "boolean" ? { edited: msg.edited } : {}),
    ...(Array.isArray(msg.edits)
      ? {
          edits: msg.edits.filter(
            (entry) => Boolean(entry) && typeof (entry as { previous?: unknown }).previous === "string"
          ),
        }
      : {}),
    ...(Array.isArray(msg.debugEvents) ? { debugEvents: msg.debugEvents } : {}),
    ...(role === "assistant"
      ? {
          status:
            msg.status === "error"
              ? ("error" as const)
              : msg.status === "stopped"
                ? ("stopped" as const)
                : ("done" as const),
        }
      : {}),
  };
}

export function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalize).filter((m): m is ChatMessage => m !== null);
}

/** Registered accounts get separate browser caches; the first account can claim legacy local data. */
export function loadMessages(sessionId: string, scope: string): ChatMessage[] {
  try {
    const key = storageKey(sessionId, scope);
    const legacyKey = legacySessionKey(sessionId);
    const canMigrate = scope !== "guest";
    const raw = localStorage.getItem(key) ??
      (canMigrate ? localStorage.getItem(legacyKey) ?? localStorage.getItem(LEGACY_STORAGE_KEY) : null);
    if (!raw) return [];
    const messages = normalizeMessages(JSON.parse(raw) as unknown);
    if (!localStorage.getItem(key) && messages.length > 0) {
      localStorage.setItem(key, JSON.stringify(messages));
      localStorage.removeItem(legacyKey);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    return messages;
  } catch {
    return [];
  }
}

export function saveMessages(sessionId: string, messages: ChatMessage[], scope: string): void {
  const toSave = messages.slice(-MAX_MESSAGES);
  try {
    localStorage.setItem(storageKey(sessionId, scope), JSON.stringify(toSave));
    return;
  } catch {
    // Image data URLs may exceed localStorage quota; retain the text fallback.
  }
  try {
    localStorage.setItem(
      storageKey(sessionId, scope),
      JSON.stringify(toSave.map((message) => message.image ? { ...message, image: undefined } : message))
    );
  } catch {
    // Local cache failure does not affect the cloud copy or active chat.
  }
}

export function removeSavedMessages(sessionId: string, scope: string): void {
  try {
    localStorage.removeItem(storageKey(sessionId, scope));
  } catch {
    // ignore
  }
}
