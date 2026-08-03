/**
 * Shared types for the EduVision Node backend.
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

/** Runtime configuration loaded from .dev.vars or process environment. */
export interface Env {
  API_KEY: string;
  API_URL?: string;
  /** Override the text reasoning/answering model (see MODELS). */
  API_MODEL?: string;
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
