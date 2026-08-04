import { removeSavedMessages } from "./persist";

/** One entry in the local session index shown in the drawer. */
export interface SessionMeta {
  id: string;
  /** Model-generated (or fallback) title; empty means "not yet named". */
  title: string;
  /** True once a title has been generated, so we never ask the model twice. */
  titleGenerated: boolean;
  updatedAt: number;
}

const INDEX_KEY = "eduvision-session-index-v1";
const MAX_SESSIONS = 50;

export function loadSessionIndex(): SessionMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is SessionMeta =>
          Boolean(item) &&
          typeof (item as SessionMeta).id === "string" &&
          typeof (item as SessionMeta).updatedAt === "number"
      )
      .map((item) => ({
        id: item.id,
        title: typeof item.title === "string" ? item.title : "",
        titleGenerated: item.titleGenerated === true,
        updatedAt: item.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * Sort by recency, cap the list, write it back and drop the message stores
 * of pruned sessions. Returns the final list, suitable for setState.
 */
export function persistSessionIndex(list: SessionMeta[]): SessionMeta[] {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = sorted.slice(0, MAX_SESSIONS);
  for (const dropped of sorted.slice(MAX_SESSIONS)) {
    removeSavedMessages(dropped.id);
  }
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(kept));
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
  return kept;
}

/** Insert a session into the index, or bump an existing one to the top. */
export function upsertSession(list: SessionMeta[], id: string): SessionMeta[] {
  const now = Date.now();
  if (list.some((item) => item.id === id)) {
    return list.map((item) => (item.id === id ? { ...item, updatedAt: now } : item));
  }
  return [...list, { id, title: "", titleGenerated: false, updatedAt: now }];
}

export function renameSession(list: SessionMeta[], id: string, title: string): SessionMeta[] {
  return list.map((item) =>
    item.id === id ? { ...item, title, titleGenerated: true } : item
  );
}

export function removeSession(list: SessionMeta[], id: string): SessionMeta[] {
  return list.filter((item) => item.id !== id);
}
