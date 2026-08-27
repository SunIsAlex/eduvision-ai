/** Optional browser-only upstream configuration. Never sent to our server. */
export interface LocalApiConfig {
  apiKey: string;
  apiUrl: string;
  /** Optional model used to transcribe images when the answer model is text-only. */
  ocrModel?: string;
}

const LEGACY_STORAGE_KEY = "eduvision-local-api-config-v1";

function storageKey(scope: string): string {
  return `eduvision-local-api-config-v2:${scope}`;
}

export function loadLocalApiConfig(scope: string): LocalApiConfig {
  try {
    const key = storageKey(scope);
    const scoped = window.localStorage.getItem(key);
    const legacy = scoped ? null : window.localStorage.getItem(LEGACY_STORAGE_KEY);
    const value = JSON.parse(scoped ?? legacy ?? "null") as Partial<LocalApiConfig> | null;
    const normalized = {
      apiKey: typeof value?.apiKey === "string" ? value.apiKey : "",
      apiUrl: typeof value?.apiUrl === "string" ? value.apiUrl : "",
      ocrModel: typeof value?.ocrModel === "string" ? value.ocrModel : "",
    };
    if (!scoped && legacy) {
      window.localStorage.setItem(key, JSON.stringify(normalized));
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    return normalized;
  } catch {
    return { apiKey: "", apiUrl: "", ocrModel: "" };
  }
}

export function saveLocalApiConfig(config: LocalApiConfig, scope: string): void {
  try {
    if (!config.apiKey.trim() && !config.apiUrl.trim()) {
      window.localStorage.removeItem(storageKey(scope));
      return;
    }
    window.localStorage.setItem(storageKey(scope), JSON.stringify(config));
  } catch {
    // Browser storage can be disabled; direct mode still works for this page.
  }
}

export function clearLocalApiConfig(scope: string): void {
  try {
    window.localStorage.removeItem(storageKey(scope));
  } catch {
    // ignore restricted storage
  }
}
