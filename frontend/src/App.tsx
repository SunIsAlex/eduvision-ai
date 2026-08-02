import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, GraduationCap, RotateCcw, Sparkles } from "lucide-react";
import { Composer } from "./components/Composer";
import { ChatMessage } from "./components/ChatMessage";
import { useChat } from "./hooks/useChat";

const EXAMPLES = [
  "解方程 x²-5x+6=0，并说明使用了什么方法",
  "为什么铁制品会生锈？如何防止生锈？",
  "欧姆定律是什么？并联电路总电阻怎么算？",
];

export default function App() {
  const chat = useChat();
  const [debug, setDebug] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  // Whether the user is pinned to the bottom of the message list. While
  // streaming, we only auto-scroll when they're already at/near the bottom,
  // so reading older content is never interrupted by forced scrolling.
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // Scroll behavior: instant, and only when pinned to the bottom (or right
  // after the user sends a new message). No smooth animation per delta —
  // that's what made the page visibly "jump" while typing.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const last = chat.messages[chat.messages.length - 1];
    if (last?.role === "user") {
      stickToBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.thinking]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-indigo-600">
              <GraduationCap className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-[15px] font-semibold leading-tight text-slate-50">
                EduVision AI
              </h1>
              <p className="text-[11px] text-slate-500">拍照搜题 · 多模态智能解题</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDebug((value) => !value)}
                title="显示服务端流式事件、工具参数和模型响应"
                aria-pressed={debug}
                className={
                  debug
                    ? "flex items-center gap-1.5 rounded-lg border border-amber-500/60 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300"
                    : "flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
                }
              >
                <Bug className="h-3.5 w-3.5" />
                调试
              </button>
            {chat.messages.length > 0 && (
              <>
              <button
                type="button"
                onClick={chat.endContext}
                disabled={chat.contextEnded}
                title="点击后，下一道题不会带上之前对话的上下文"
                className={
                  chat.contextEnded
                    ? "flex items-center gap-1.5 rounded-lg border border-brand-600/50 bg-brand-600/10 px-2.5 py-1.5 text-xs text-brand-400"
                    : "flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
                }
              >
                {chat.contextEnded ? "已断开上下文" : "结束上下文"}
              </button>
              <button
                type="button"
                onClick={chat.reset}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                新对话
              </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Messages */}
      <main
        ref={mainRef}
        onScroll={handleScroll}
        className="scrollbar-thin flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-5 sm:px-6">
          {chat.messages.length === 0 ? (
            <Welcome onPick={(text) => chat.setInput(text)} />
          ) : (
            chat.messages.map((m, i) => (
              <ChatMessage
                key={m.id}
                message={m}
                showDebug={debug}
                thinking={
                  m.role === "assistant" &&
                  m.status === "streaming" &&
                  !m.content &&
                  i === chat.messages.length - 1
                    ? chat.thinking
                    : undefined
                }
              />
            ))
          )}
        </div>
      </main>

      {/* Composer */}
      <Composer
        value={chat.input}
        onChange={chat.setInput}
        image={chat.image}
        onImageChange={chat.setImage}
        onSubmit={() => void chat.send()}
        onStop={chat.stop}
        loading={chat.loading}
        thinkingEnabled={chat.thinkingEnabled}
        onThinkingEnabledChange={chat.setThinkingEnabled}
      />
    </div>
  );
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-16 text-center sm:py-24">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 shadow-lg shadow-brand-500/20">
        <Sparkles className="h-8 w-8 text-white" />
      </div>
      <div>
        <h2 className="text-xl font-semibold text-slate-50">拍一张题目照片，AI 老师为你讲解</h2>
        <p className="mt-2 text-sm text-slate-400">
          支持几何图形、函数图像、化学结构、手写题目 · 图文并茂，公式用 LaTeX 渲染
        </p>
      </div>
      <div className="grid w-full max-w-md gap-2">
        {EXAMPLES.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-left text-sm text-slate-300 transition hover:border-brand-500/60 hover:bg-slate-900"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
