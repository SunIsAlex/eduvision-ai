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
  /** User-controlled provider reasoning mode. */
  thinking?: boolean;
  /** Client-generated id used to correlate browser tool results back to this stream. */
  requestId?: string;
  /** Model selected from the server-enumerated provider catalog. */
  model?: string;
}

/** Runtime configuration loaded from .dev.vars or process environment. */
export interface Env {
  API_KEY: string;
  API_URL?: string;
  /** Override the text reasoning/answering model (see MODELS). */
  API_MODEL?: string;
  /** Public browser API key issued by Desmos for production embedding. */
  DESMOS_API_KEY?: string;
  /** Optional shared password protecting every private API endpoint. */
  ACCESS_PASSWORD?: string;
  /** Separate password for the server configuration control panel. */
  ADMIN_ACCESS_PASSWORD?: string;
  /** Maximum number of simultaneous upstream model streams per Node process. */
  UPSTREAM_MAX_CONCURRENCY?: string;
  /** Maximum number of requests waiting for an upstream stream slot. */
  UPSTREAM_MAX_QUEUE?: string;
  /** Maximum queue wait in milliseconds. */
  UPSTREAM_QUEUE_TIMEOUT_MS?: string;
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
  return model || MODELS.VISION;
}

export const DEFAULT_BASE_URL = "https://api.mytokk.com";
