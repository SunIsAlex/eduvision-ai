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
  /** User-selected domain prompt module. Never inferred by the server. */
  skill?: SkillId;
  /** Ultra 模式：高智力模型规划思路，子代理校验数值后再作答。 */
  ultra?: boolean;
}

export const SKILL_IDS = ["general", "math", "chemistry"] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export function isSkillId(value: unknown): value is SkillId {
  return typeof value === "string" && (SKILL_IDS as readonly string[]).includes(value);
}

/** Runtime configuration loaded from .dev.vars or process environment. */
export interface Env {
  API_KEY: string;
  API_URL?: string;
  /** Override the text reasoning/answering model (see MODELS). */
  API_MODEL?: string;
  /** Ultra 模式使用的高智力模型；缺省时回退到 API_MODEL。 */
  API_MODEL_ULTRA?: string;
  /** Ultra 增量逐块审核使用的快速模型。 */
  API_MODEL_REVIEW?: string;
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

/** Ultra 模式使用的“高智力”模型；未配置时回退到默认模型。 */
export function resolveUltraModel(env: Env): string {
  return env.API_MODEL_ULTRA?.trim() || resolveModel(env.API_MODEL);
}

/** 增量审核优先低延迟；与最终答案/兜底复核的高智力模型相互独立。 */
export function resolveReviewModel(env: Env): string {
  return env.API_MODEL_REVIEW?.trim() || "gpt-5.6-luna";
}

export const DEFAULT_BASE_URL = "https://api.mytokk.com";
