export type Role = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Provider-generated summarized thinking shown live (assistant only). */
  reasoning?: string;
  /** Ultra 模式：子代理规划的解题思路（assistant only）。 */
  plan?: string;
  /** Ultra 模式：子代理对最终答案的复核报告（assistant only）。 */
  verify?: string;
  /** Ultra 模式：按 Markdown 语义块增量复核的状态。 */
  lineChecks?: LineCheck[];
  /** Tool calls made while producing this answer (assistant only). */
  tools?: ToolActivity[];
  image?: string;
  /** User text was populated from browser-local OCR; edits should not rerun OCR. */
  ocrGenerated?: boolean;
  /** Pipeline that produced this answer (set on completion). */
  pipeline?: string;
  model?: string;
  error?: boolean;
  /** 消息内容曾被用户编辑过（Telegram 风格“已编辑”标记）。 */
  edited?: boolean;
  /** 编辑历史：每次编辑前的内容，用于渲染 git diff 风格对比。 */
  edits?: MessageEdit[];
  status?: "streaming" | "done" | "error" | "stopped";
  /** Raw SSE event timeline, only rendered when the debug panel is enabled. */
  debugEvents?: DebugEvent[];
}

export interface DebugEvent {
  event: string;
  data: Record<string, unknown>;
  at: string;
}

export interface LineCheck {
  blockId: number;
  status: "running" | "passed" | "failed";
  detail?: string;
}

/** 一次编辑记录：previous 为该次编辑前的完整内容。 */
export interface MessageEdit {
  previous: string;
  at: string;
}

export interface ThinkingStep {
  text: string;
}

export interface ModelOption {
  id: string;
  displayName: string;
  /** Known to accept image input when discovered from a local provider. */
  multimodal?: boolean;
}

export type SkillId = "general" | "math" | "chemistry";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolActivity {
  toolCallId: string;
  name: string;
  args: string;
  executor?: "server" | "browser";
  status: "running" | "done" | "error";
  output?: string;
}

/** Wire-format messages sent to the backend (image as URL/data URL). */
export interface ApiMessage {
  role: Role;
  content: string;
  image?: string;
}
