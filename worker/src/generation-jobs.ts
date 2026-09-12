import type { AccountStore } from "./account-store";
import { runPipeline, type StreamEvent } from "./stream";
import type { ChatRequest, Env } from "./types";

type JobState = "running" | "finished";

interface GenerationJob {
  userId: string;
  requestId: string;
  events: StreamEvent[];
  state: JobState;
  changed: Set<() => void>;
  expiresAt: number;
}

const jobs = new Map<string, GenerationJob>();
const JOB_TTL_MS = 60 * 60 * 1000;

function key(userId: string, requestId: string): string {
  return `${userId}:${requestId}`;
}

function wake(job: GenerationJob): void {
  for (const resolve of job.changed) resolve();
  job.changed.clear();
}

function parsed(event: StreamEvent): Record<string, unknown> {
  try { return JSON.parse(event.data) as Record<string, unknown>; } catch { return {}; }
}

function applyEvents(messages: unknown[], request: ChatRequest, events: StreamEvent[]): unknown[] {
  const output = structuredClone(messages) as Array<Record<string, unknown>>;
  const assistantIndex = output.findIndex((message) => message.id === request.assistantMessageId);
  const userIndex = output.findIndex((message) => message.id === request.userMessageId);
  if (assistantIndex < 0) return output;
  const assistant = output[assistantIndex]!;
  for (const event of events) {
    const data = parsed(event);
    const text = typeof data.text === "string" ? data.text : "";
    if (event.event === "answer") assistant.content = String(assistant.content ?? "") + text;
    else if (event.event === "reasoning") assistant.reasoning = String(assistant.reasoning ?? "") + text;
    else if (event.event === "plan") assistant.plan = String(assistant.plan ?? "") + text;
    else if (event.event === "verify") assistant.verify = String(assistant.verify ?? "") + text;
    else if (event.event === "line_check") {
      const checks = Array.isArray(assistant.lineChecks) ? assistant.lineChecks as Array<Record<string, unknown>> : [];
      const next = { blockId: data.blockId, status: data.status, ...(data.detail ? { detail: data.detail } : {}) };
      const index = checks.findIndex((check) => check.blockId === data.blockId);
      assistant.lineChecks = index < 0 ? [...checks, next] : checks.map((check, i) => i === index ? next : check);
    } else if (event.event === "tool_call") {
      const tools = Array.isArray(assistant.tools) ? assistant.tools : [];
      assistant.tools = [...tools, { ...data, status: "running" }];
    } else if (event.event === "tool_result") {
      const tools = Array.isArray(assistant.tools) ? assistant.tools as Array<Record<string, unknown>> : [];
      assistant.tools = tools.map((tool) => tool.toolCallId === data.toolCallId
        ? { ...tool, status: data.ok === false ? "error" : "done", output: data.output }
        : tool);
    }
    else if (event.event === "done") {
      assistant.status = "done";
      assistant.pipeline = data.pipeline;
      assistant.model = data.model;
    } else if (event.event === "error") {
      assistant.status = "error";
      assistant.error = true;
      if (!assistant.content) assistant.content = text;
    } else if (event.event === "ocr_result" && userIndex >= 0) {
      output[userIndex] = { ...output[userIndex], content: text, ocrGenerated: true, ocrConfirmed: false };
      output.splice(assistantIndex, 1);
      break;
    }
  }
  return output;
}

async function persistResult(store: AccountStore, job: GenerationJob, request: ChatRequest): Promise<void> {
  if (!request.sessionId || !Array.isArray(request.sessionMessages)) return;
  const messages = applyEvents(request.sessionMessages, request, job.events);
  await store.saveSession(job.userId, request.sessionId, {
    messages,
    contextBreak: request.contextBreak,
  });
}

export function getOrStartGeneration(
  env: Env,
  store: AccountStore,
  userId: string,
  request: ChatRequest
): GenerationJob {
  const requestId = request.requestId ?? crypto.randomUUID();
  const jobKey = key(userId, requestId);
  const existing = jobs.get(jobKey);
  if (existing) return existing;
  const job: GenerationJob = {
    userId, requestId, events: [], state: "running", changed: new Set(), expiresAt: Date.now() + JOB_TTL_MS,
  };
  jobs.set(jobKey, job);
  void (async () => {
    try {
      if (request.sessionId && Array.isArray(request.sessionMessages)) {
        await store.saveSession(userId, request.sessionId, {
          messages: request.sessionMessages,
          contextBreak: request.contextBreak,
        });
      }
      for await (const event of runPipeline(env, { ...request, requestId })) {
        job.events.push(event);
        wake(job);
      }
    } catch (error) {
      console.error("[generation-job] failed:", error);
      job.events.push({ event: "error", data: JSON.stringify({ text: "生成解答时出错，请稍后重试。" }) });
    } finally {
      job.state = "finished";
      wake(job);
      await persistResult(store, job, request).catch((error) =>
        console.error("[generation-job] session save failed:", error)
      );
      setTimeout(() => jobs.delete(jobKey), JOB_TTL_MS).unref?.();
    }
  })();
  return job;
}

export async function* subscribeGeneration(job: GenerationJob): AsyncGenerator<StreamEvent> {
  let cursor = 0;
  for (;;) {
    while (cursor < job.events.length) yield job.events[cursor++]!;
    if (job.state === "finished") return;
    await new Promise<void>((resolve) => job.changed.add(resolve));
  }
}
