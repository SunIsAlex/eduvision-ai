import { useEffect, useRef, useState } from "react";
import { Bot, Brain, Calculator, Check, Code, Copy, LineChart, Loader2, TriangleAlert, User } from "lucide-react";
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
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
  } catch {
    return raw;
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
      <code className="block overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-slate-400">
        {prettyArgs(raw)}
      </code>
    );
  }

  return (
    <div
      className="tool-expression mt-2 overflow-x-auto rounded-md border border-slate-800 bg-slate-950/70 px-3 py-2 text-center"
      title={expression}
      aria-label={`计算表达式：${expression}`}
    >
      {tex ? (
        <Markdown content={`$${tex}$`} />
      ) : (
        <code className="font-mono text-sm text-amber-200">{expression}</code>
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
        <div className="max-w-[88%] sm:max-w-[78%]">
          <div className="flex items-start justify-end gap-2">
            <div className="rounded-3xl bg-[#2f2f2f] px-5 py-3.5 text-[#ececec] shadow-sm shadow-black/10">
              {message.content && <p className="whitespace-pre-wrap break-words">{message.content}</p>}
              {message.image && (
                <img
                  src={message.image}
                  alt="题目"
                  className="mt-3 max-h-64 rounded-xl border border-[#555] object-contain"
                />
              )}
            </div>
            <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#3f3f3f]">
              <User className="h-4 w-4 text-[#d1d1d1]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500">
        <Bot className="h-4 w-4 text-white" />
      </div>
      <div className="min-w-0 max-w-[94%] flex-1 sm:max-w-[90%]">
        {/* Pipeline badge */}
        {message.pipeline && !message.error && (
          <span className="mb-2 inline-block rounded-lg bg-[#2f2f2f] px-2.5 py-1 text-xs leading-5 text-[#a0a0a0]">
            {PIPELINE_LABELS[message.pipeline] ?? message.pipeline}
            {message.model ? ` · ${message.model.split("/").pop()}` : ""}
          </span>
        )}

        {thinking && thinking.length > 0 && (
          <div className="mb-3 rounded-xl border border-brand-500/20 bg-[#282828] px-4 py-3">
            <p className="flex items-center gap-2 text-[13px] text-slate-300">
              <Brain className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span className="font-medium">模型正在思考</span>
              <span className="ml-auto tabular-nums text-[11px] text-slate-500">
                {waitingSeconds}s
              </span>
            </p>
            <p className="mt-1 flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-emerald-400" />
              {thinking[thinking.length - 1]?.text}
            </p>
          </div>
        )}

        {message.ocr && (
          <details open className="mb-2 overflow-hidden rounded-lg border border-sky-500/30 bg-slate-900/70">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs text-sky-300">
              <Code className="h-3.5 w-3.5" />
              题目转写
              {message.status === "streaming" && !message.reasoning && !message.content && (
                <span className="flex items-center gap-1 text-[11px] text-sky-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  识别中
                </span>
              )}
              <button
                type="button"
                title="复制 Markdown 转写"
                className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-white"
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
            <div className="border-t border-sky-500/20 px-3 py-2 text-sm text-slate-300">
              <Markdown content={message.ocr} />
            </div>
          </details>
        )}

        {/* Provider-generated summarized thinking, similar to the Claude app. */}
        {message.reasoning && (
          <details
            open={message.status === "streaming"}
            className={cn(
              "mb-3 overflow-hidden border",
              isGptReasoning
                ? "rounded-2xl border-[#444] bg-[#2a2a2a] shadow-sm shadow-black/10"
                : "rounded-xl border-[#3d3d3d] bg-[#282828]"
            )}
          >
            <summary className={cn(
              "flex cursor-pointer select-none items-center gap-2 text-xs text-slate-400 transition hover:text-slate-200",
              isGptReasoning ? "px-4 py-3" : "px-3 py-2"
            )}>
              <Brain className="h-3.5 w-3.5" />
              思考摘要
              {message.status === "streaming" && (
                <span className="ml-auto flex items-center gap-1 text-[11px] text-emerald-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  思考中
                </span>
              )}
            </summary>
            <div
              ref={reasoningRef}
              className={cn(
                "reasoning-markdown scrollbar-thin max-h-56 overflow-y-auto px-4 py-3 text-sm leading-6 text-[#b4b4b4]",
                isGptReasoning
                  ? "mx-3 mb-3 rounded-xl border border-[#3a3a3a] bg-[#222]"
                  : "border-t border-[#3d3d3d]"
              )}
            >
              <Markdown content={reasoningContent} />
              {message.status === "streaming" && (
                <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-emerald-400 align-middle" />
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
              return (
                <div
                  key={t.toolCallId}
                  className="rounded-xl border border-[#3d3d3d] bg-[#282828] px-4 py-3"
                >
                  <div className="flex items-center gap-2 text-xs text-slate-300">
                    {isCalc ? (
                      <Calculator className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    ) : isPlot ? (
                      <LineChart className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                    ) : (
                      <Code className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                    )}
                    <span className="font-medium">{isCalc ? "计算器" : isPlot ? "函数图像" : "JavaScript 沙箱"}</span>
                    {!isCalc && !isPlot && (
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500"
                        title={prettyArgs(t.args)}
                      >
                        {prettyArgs(t.args)}
                      </span>
                    )}
                    {(isCalc || isPlot) && <span className="flex-1" />}
                    {running ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-400" />
                    ) : t.status === "done" ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    ) : (
                      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
                    )}
                  </div>
                  {isCalc && <CalculatorExpression raw={t.args} />}
                  {isPlot && <FunctionPlot raw={t.args} />}
                  {t.output && !isPlot && (
                    <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 px-2 py-1.5 font-mono text-[11px] leading-4 text-emerald-300">
                      {t.output}
                    </pre>
                  )}
                </div>
              );
            })}
            {message.tools.some((tool) => tool.name === "javascript") && (
              <p className="text-[10px] text-slate-600">
                JavaScript 在你的浏览器本地沙箱中执行 · 风险自负
              </p>
            )}
          </div>
        )}

        {showDebug && (
          <details open className="mb-2 overflow-hidden rounded-lg border border-amber-500/30 bg-slate-950/90">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs text-amber-300">
              <Code className="h-3.5 w-3.5" />
              原始响应事件（{message.debugEvents?.length ?? 0}）
              <button
                type="button"
                className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-white"
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
            <pre className="scrollbar-thin max-h-96 overflow-auto whitespace-pre-wrap border-t border-amber-500/20 px-3 py-2 font-mono text-[11px] leading-4 text-slate-300">
              {JSON.stringify(message.debugEvents ?? [], null, 2)}
            </pre>
          </details>
        )}

        <div
          className={cn(
            "px-1 py-1",
            message.error && "rounded-xl border border-red-500/40 bg-red-950/20 px-4 py-3"
          )}
        >
          {message.error ? (
            <p className="flex items-center gap-2 text-red-400">
              <TriangleAlert className="h-4 w-4 shrink-0" />
              {message.content}
            </p>
          ) : message.content ? (
            <Markdown content={message.content} />
          ) : (
            <span className="inline-flex items-center gap-1 text-slate-400">
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:120ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:240ms]" />
            </span>
          )}

          {/* Typing cursor while streaming */}
          {message.status === "streaming" && message.content && (
            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-emerald-400 align-middle" />
          )}
        </div>
      </div>
    </div>
  );
}
