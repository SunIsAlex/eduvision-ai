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
  /** Client-generated id used to correlate browser tool results back to this stream. */
  requestId?: string;
}

/** Environment bindings declared in wrangler.toml. */
export interface Env {
  SILICONFLOW_API_KEY: string;
  SILICONFLOW_BASE_URL?: string;
  CORS_ORIGIN?: string;
  /** Override the single multimodal answering model (see MODELS). */
  AI_MODEL?: string;
  /** R2 bucket for uploaded images (optional). */
  MEDIA_BUCKET?: R2Bucket;
  /** Static assets binding provided by wrangler when assets are configured. */
  ASSETS?: Fetcher;
}

/**
 * One model does everything: reads the image (pixels preserved end-to-end)
 * and produces the teacher-style explanation. Override via AI_MODEL.
 */
export const MODELS = {
  // GLM-5.2：复杂数值推理与工具调用已通过本项目端到端测试。
  VISION: "zai-org/GLM-5.2",
} as const;

export const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
