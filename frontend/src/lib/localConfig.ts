/** Optional browser-only upstream configuration. Never sent to our server. */
export interface LocalApiConfig {
  apiKey: string;
  apiUrl: string;
  /** Optional model used to transcribe images when the answer model is text-only. */
  ocrModel?: string;
}

const STORAGE_KEY = "eduvision-local-api-config-v1";

export function loadLocalApiConfig(): LocalApiConfig {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<LocalApiConfig> | null;
    return {
      apiKey: typeof value?.apiKey === "string" ? value.apiKey : "",
      apiUrl: typeof value?.apiUrl === "string" ? value.apiUrl : "",
      ocrModel: typeof value?.ocrModel === "string" ? value.ocrModel : "",
    };
  } catch {
    return { apiKey: "", apiUrl: "", ocrModel: "" };
  }
}

export function saveLocalApiConfig(config: LocalApiConfig): void {
  try {
    if (!config.apiKey.trim() && !config.apiUrl.trim()) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Browser storage can be disabled; direct mode still works for this page.
  }
}

export function clearLocalApiConfig(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore restricted storage
  }
}
