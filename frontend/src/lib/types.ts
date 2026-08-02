export type Role = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Streaming chain-of-thought shown live (assistant only). */
  reasoning?: string;
  /** Tool calls made while producing this answer (assistant only). */
  tools?: ToolActivity[];
  image?: string;
  /** Pipeline that produced this answer (set on completion). */
  pipeline?: string;
  model?: string;
  error?: boolean;
  status?: "streaming" | "done" | "error";
}

export interface ThinkingStep {
  text: string;
}

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

/** Wire-format messages sent to the worker (image as URL/data URL). */
export interface ApiMessage {
  role: Role;
  content: string;
  image?: string;
}
