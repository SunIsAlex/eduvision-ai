import { useEffect, useRef, useState } from "react";
import { Brain, Calculator, Check, Code, Copy, LineChart, Loader2, TriangleAlert } from "lucide-react";
import { Markdown } from "./Markdown";
import { FunctionPlot } from "./FunctionPlot";
import type { ChatMessage as Message, ThinkingStep } from "../lib/types";
import { cn, normalizeGptReasoningMarkdown } from "../lib/utils";

interface Props {
  message: Message;
  thinking?: ThinkingStep[];
  showDebug?: boolean;
}

const PIPELINE_LABELS: Record<string, string> = {
  multimodal: "多模态智能解答",
};

function prettyArgs(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([key]) => key !== "intention")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
  } catch {
    return raw;
  }
}

function getToolIntention(raw: string): string | null {
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>).intention;
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

function getCalculatorExpression(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { expression?: unknown };
    return typeof parsed.expression === "string" && parsed.expression.trim()
      ? parsed.expression.trim()
      : null;
  } catch {
    return null;
  }
}

function CalculatorExpression({ raw }: { raw: string }) {
  const expression = getCalculatorExpression(raw);
  const [tex, setTex] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setTex(null);
    if (!expression) return () => undefined;

    void import("../lib/calc")
      .then(({ expressionToTex }) => {
        if (active) setTex(expressionToTex(expression));
      })
      .catch(() => {
        if (active) setTex(null);
      });

    return () => {
      active = false;
    };
  }, [expression]);

  if (!expression) {
    return (
      <code className="block overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-mute">
        {prettyArgs(raw)}
      </code>
    );
  }

  return (
    <div
      className="tool-expression mt-2 overflow-x-auto rounded-lg border border-line bg-[#f5f3ec] px-3 py-2 text-center"
      title={expression}
      aria-label={`计算表达式：${expression}`}
    >
      {tex ? (
        <Markdown content={`$${tex}$`} />
      ) : (
        <code className="font-mono text-sm text-brand-700">{expression}</code>
      )}
    </div>
  );
}

export function ChatMessage({ message, thinking, showDebug = false }: Props) {
  const isUser = message.role === "user";
  const isGptReasoning = /(?:^|\/)(?:gpt-|codex)/i.test(message.model ?? "");
  const reasoningContent = isGptReasoning
    ? normalizeGptReasoningMarkdown(message.reasoning ?? "")
    : message.reasoning ?? "";
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [waitingSeconds, setWaitingSeconds] = useState(0);

  useEffect(() => {
    if (message.status !== "streaming" || !thinking?.length) {
      setWaitingSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setWaitingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [message.status, Boolean(thinking?.length)]);

  // Keep the live thinking block pinned to its latest content while streaming.
  useEffect(() => {
    if (message.status === "streaming" && reasoningRef.current) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [message.reasoning, message.status]);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-bubble px-4 py-2.5 text-[15px] leading-7 text-ink sm:max-w-[75%]">
          {message.content && <p className="whitespace-pre-wrap break-words">{message.content}</p>}
          {message.image && (
            <img
              src={message.image}
              alt="题目"
              className="mt-2 max-h-64 rounded-xl border border-line object-contain"
            />
          )}
        </div>
      </div>
    );
  }

  // Assistant: full-width plain text, no avatar or bubble — Claude-style.
  return (
    <div className="w-full">
      {/* Pipeline badge */}
      {message.pipeline && !message.error && (
        <p className="mb-1.5 text-xs text-faint">
          {PIPELINE_LABELS[message.pipeline] ?? message.pipeline}
          {message.model ? ` · ${message.model.split("/").pop()}` : ""}
        </p>
      )}

      {thinking && thinking.length > 0 && (
        <div className="mb-3 rounded-xl border border-brand-500/30 bg-brand-50 px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] text-ink">
            <Brain className="h-3.5 w-3.5 shrink-0 text-brand-600" />
            <span className="font-medium">模型正在思考</span>
            <span className="ml-auto tabular-nums text-[11px] text-faint">
              {waitingSeconds}s
            </span>
          </p>
          <p className="mt-1 flex items-center gap-2 text-xs text-mute">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand-500" />
            {thinking[thinking.length - 1]?.text}
          </p>
        </div>
      )}

      {message.ocr && (
        <details open className="mb-2 overflow-hidden rounded-xl border border-line bg-card">
          <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs text-mute">
            <Code className="h-3.5 w-3.5" />
            题目转写
            {message.status === "streaming" && !message.reasoning && !message.content && (
              <span className="flex items-center gap-1 text-[11px] text-brand-600">
                <Loader2 className="h-3 w-3 animate-spin" />
                识别中
              </span>
            )}
            <button
              type="button"
              title="复制 Markdown 转写"
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-faint hover:bg-black/5 hover:text-ink"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void navigator.clipboard.writeText(message.ocr ?? "");
              }}
            >
              <Copy className="h-3 w-3" />
              复制 Markdown
            </button>
          </summary>
          <div className="border-t border-line px-3 py-2 text-sm">
            <Markdown content={message.ocr} />
          </div>
        </details>
      )}

      {/* Provider-generated summarized thinking, similar to the Claude app. */}
      {message.reasoning && (
        <details
          open={message.status === "streaming"}
          className="mb-3 overflow-hidden rounded-xl border border-line bg-card"
        >
          <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs text-mute transition hover:text-ink">
            <Brain className="h-3.5 w-3.5" />
            思考摘要
            {message.status === "streaming" && (
              <span className="ml-auto flex items-center gap-1 text-[11px] text-brand-600">
                <Loader2 className="h-3 w-3 animate-spin" />
                思考中
              </span>
            )}
          </summary>
          <div
            ref={reasoningRef}
            className="reasoning-markdown scrollbar-thin max-h-56 overflow-y-auto border-t border-line px-4 py-3 text-sm leading-6"
          >
            <Markdown content={reasoningContent} />
            {message.status === "streaming" && (
              <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-brand-500 align-middle" />
            )}
          </div>
        </details>
      )}

      {/* Tool calls made while producing this answer. */}
      {message.tools && message.tools.length > 0 && (
        <div className="mb-3 space-y-2">
          {message.tools.map((t) => {
            const running = t.status === "running";
            const isCalc = t.name === "calculator";
            const isPlot = t.name === "function_plot";
            const intention = getToolIntention(t.args);
            return (
              <div
                key={t.toolCallId}
                className="rounded-xl border border-line bg-card px-4 py-3"
              >
                <div className="flex items-center gap-2 text-xs text-ink">
                  {isCalc ? (
                    <Calculator className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                  ) : isPlot ? (
                    <LineChart className="h-3.5 w-3.5 shrink-0 text-violet-600" />
                  ) : (
                    <Code className="h-3.5 w-3.5 shrink-0 text-sky-600" />
                  )}
                  <span className="font-medium">{isCalc ? "计算器" : isPlot ? "函数图像" : "JavaScript 沙箱"}</span>
                  {!isCalc && !isPlot && (
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint"
                      title={prettyArgs(t.args)}
                    >
                      {prettyArgs(t.args)}
                    </span>
                  )}
                  {(isCalc || isPlot) && <span className="flex-1" />}
                  {running ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand-500" />
                  ) : t.status === "done" ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  ) : (
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-red-500" />
                  )}
                </div>
                {intention && (
                  <div className="tool-intention mt-2 rounded-lg bg-[#f2efe6] px-3 py-2 text-xs">
                    <Markdown content={intention} />
                  </div>
                )}
                {isCalc && <CalculatorExpression raw={t.args} />}
                {isPlot && <FunctionPlot raw={t.args} />}
                {t.output && !isPlot && (
                  <pre className="scrollbar-thin mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-[#f5f3ec] px-2.5 py-1.5 font-mono text-[11px] leading-4 text-mute">
                    {t.output}
                  </pre>
                )}
              </div>
            );
          })}
          {message.tools.some((tool) => tool.name === "javascript") && (
            <p className="text-[10px] text-faint">
              JavaScript 在你的浏览器本地沙箱中执行 · 风险自负
            </p>
          )}
        </div>
      )}

      {showDebug && (
        <details open className="mb-2 overflow-hidden rounded-xl border border-amber-300/70 bg-amber-50">
          <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs text-amber-700">
            <Code className="h-3.5 w-3.5" />
            原始响应事件（{message.debugEvents?.length ?? 0}）
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-faint hover:bg-black/5 hover:text-ink"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void navigator.clipboard.writeText(JSON.stringify(message.debugEvents ?? [], null, 2));
              }}
            >
              <Copy className="h-3 w-3" />
              复制
            </button>
          </summary>
          <pre className="scrollbar-thin max-h-96 overflow-auto whitespace-pre-wrap border-t border-amber-200 px-3 py-2 font-mono text-[11px] leading-4 text-mute">
            {JSON.stringify(message.debugEvents ?? [], null, 2)}
          </pre>
        </details>
      )}

      <div
        className={cn(
          "py-0.5",
          message.error && "rounded-xl border border-red-300 bg-red-50 px-4 py-3"
        )}
      >
        {message.error ? (
          <p className="flex items-center gap-2 text-red-600">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            {message.content}
          </p>
        ) : message.content ? (
          <Markdown content={message.content} />
        ) : (
          <span className="inline-flex items-center gap-1 text-faint">
            <span className="h-2 w-2 animate-bounce rounded-full bg-faint" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-faint [animation-delay:120ms]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-faint [animation-delay:240ms]" />
          </span>
        )}

        {/* Typing cursor while streaming */}
        {message.status === "streaming" && message.content && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-brand-500 align-middle" />
        )}
      </div>
    </div>
  );
}
