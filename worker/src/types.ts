/**
 * Shared types for the EduVision worker.
 */

/** A chat message from the client. `image` is a data URL or media URL. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  image?: string;
}

/** Request body for POST /api/chat/stream. */
export interface ChatRequest {
  image?: string;
  question?: string;
  history?: ChatMessage[];
  /** User-controlled Claude extended-thinking mode. */
  thinking?: boolean;
  /** Client-generated id used to correlate browser tool results back to this stream. */
  requestId?: string;
}

/** Environment bindings declared in wrangler.toml. */
export interface Env {
  API_KEY: string;
  API_URL?: string;
  /** Override the text reasoning/answering model (see MODELS). */
  API_MODEL?: string;
  /** EdgeOne Makers KV binding used to bridge browser tool results across isolates. */
  TOOL_RESULTS?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** R2 bucket for uploaded images (optional). */
  MEDIA_BUCKET?: R2Bucket;
  /** Static assets binding provided by wrangler when assets are configured. */
  ASSETS?: Fetcher;
}

/**
 * One multimodal Anthropic model handles text, images, reasoning and tools.
 */
export const MODELS = {
  VISION: "claude-sonnet-4-6",
} as const;

/** Ignore stale SiliconFlow model overrides when using the Anthropic endpoint. */
export function resolveModel(configured?: string): string {
  const model = configured?.trim();
  return model?.startsWith("claude-") ? model : MODELS.VISION;
}

export const DEFAULT_BASE_URL = "https://api.mytokk.com";
