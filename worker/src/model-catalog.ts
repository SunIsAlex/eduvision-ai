import { DEFAULT_BASE_URL, resolveModel, type Env } from "./types";

export interface ModelInfo {
  id: string;
  displayName: string;
}

let catalog: ModelInfo[] = [];
let initialized = false;

/** Enumerate models once during process startup; provider failure is non-fatal. */
export async function initializeModelCatalog(env: Env): Promise<void> {
  const fallback = resolveModel(env.API_MODEL);
  const baseURL = (env.API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${baseURL}/v1/models?limit=1000`, {
      headers: {
        "x-api-key": env.API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; display_name?: unknown }>;
    };
    const unique = new Map<string, ModelInfo>();
    for (const item of body.data ?? []) {
      if (typeof item.id !== "string" || !item.id.trim()) continue;
      unique.set(item.id, {
        id: item.id,
        displayName:
          typeof item.display_name === "string" && item.display_name.trim()
            ? item.display_name
            : item.id,
      });
    }
    if (!unique.has(fallback)) unique.set(fallback, { id: fallback, displayName: fallback });
    catalog = [...unique.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    console.log(`[models] enumerated ${catalog.length} models; default=${fallback}`);
  } catch (error) {
    catalog = [{ id: fallback, displayName: fallback }];
    console.warn(`[models] enumeration failed; using default=${fallback}:`, (error as Error).message);
  } finally {
    clearTimeout(timer);
    initialized = true;
  }
}

export function getModelCatalog(env: Env): { models: ModelInfo[]; defaultModel: string } {
  const defaultModel = resolveModel(env.API_MODEL);
  const models = initialized && catalog.length > 0
    ? catalog
    : [{ id: defaultModel, displayName: defaultModel }];
  return { models, defaultModel };
}

export function isAvailableModel(model: string, env: Env): boolean {
  return getModelCatalog(env).models.some((item) => item.id === model);
}
