import { removeSavedMessages } from "./persist";

export interface SessionMeta {
  id: string;
  title: string;
  titleGenerated: boolean;
  updatedAt: number;
}

const LEGACY_INDEX_KEY = "eduvision-session-index-v1";
const MAX_SESSIONS = 50;

function indexKey(scope: string): string {
  return `eduvision-session-index-v2:${scope}`;
}

function normalizeIndex(value: unknown): SessionMeta[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is SessionMeta =>
        Boolean(item) && typeof (item as SessionMeta).id === "string" &&
        typeof (item as SessionMeta).updatedAt === "number"
    )
    .map((item) => ({
      id: item.id,
      title: typeof item.title === "string" ? item.title : "",
      titleGenerated: item.titleGenerated === true,
      updatedAt: item.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSessionIndex(scope: string): SessionMeta[] {
  try {
    const key = indexKey(scope);
    const scoped = localStorage.getItem(key);
    const raw = scoped ?? (scope !== "guest" ? localStorage.getItem(LEGACY_INDEX_KEY) : null);
    if (!raw) return [];
    const result = normalizeIndex(JSON.parse(raw) as unknown);
    if (!scoped && result.length > 0) {
      localStorage.setItem(key, JSON.stringify(result));
      localStorage.removeItem(LEGACY_INDEX_KEY);
    }
    return result;
  } catch {
    return [];
  }
}

export function persistSessionIndex(list: SessionMeta[], scope: string): SessionMeta[] {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = sorted.slice(0, MAX_SESSIONS);
  for (const dropped of sorted.slice(MAX_SESSIONS)) removeSavedMessages(dropped.id, scope);
  try {
    localStorage.setItem(indexKey(scope), JSON.stringify(kept));
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
  return kept;
}

export function mergeSessionIndexes(cloud: SessionMeta[], local: SessionMeta[]): SessionMeta[] {
  const merged = new Map(local.map((session) => [session.id, session]));
  for (const session of cloud) {
    const prior = merged.get(session.id);
    merged.set(session.id, !prior || session.updatedAt >= prior.updatedAt ? session : prior);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function upsertSession(list: SessionMeta[], id: string): SessionMeta[] {
  const now = Date.now();
  if (list.some((item) => item.id === id)) {
    return list.map((item) => item.id === id ? { ...item, updatedAt: now } : item);
  }
  return [...list, { id, title: "", titleGenerated: false, updatedAt: now }];
}

export function renameSession(list: SessionMeta[], id: string, title: string): SessionMeta[] {
  return list.map((item) => item.id === id ? { ...item, title, titleGenerated: true } : item);
}

export function removeSession(list: SessionMeta[], id: string): SessionMeta[] {
  return list.filter((item) => item.id !== id);
}
