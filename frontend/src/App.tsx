import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, Check, GraduationCap, Link2, RotateCcw, Sparkles } from "lucide-react";
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
  const [linkCopied, setLinkCopied] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  // Whether the user is pinned to the bottom of the message list. While
  // streaming, we only auto-scroll when they're already at/near the bottom,
  // so reading older content is never interrupted by forced scrolling.
  const stickToBottomRef = useRef(true);
  const toolbarButton =
    "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-[#424242] bg-[#242424] px-3.5 py-2 text-[13px] font-medium leading-5 text-[#b4b4b4] transition hover:border-[#5a5a5a] hover:bg-[#2f2f2f] hover:text-[#ececec]";

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
    <div className="flex h-full flex-col bg-[#212121] text-[#ececec]">
      {/* Header */}
      <header className="border-b border-[#303030] bg-[#171717]/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-3.5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500 shadow-sm shadow-black/30">
              <GraduationCap className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-6 tracking-tight text-[#f4f4f4]">
                EduVision AI
              </h1>
              <p className="text-xs leading-5 text-[#8e8e8e]">拍照搜题 · 多模态智能解题</p>
            </div>
          </div>
          <div className="scrollbar-thin -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-0.5 lg:mx-0 lg:overflow-visible lg:px-0 lg:pb-0">
              <button
                type="button"
                onClick={() => setDebug((value) => !value)}
                title="显示服务端流式事件、工具参数和模型响应"
                aria-pressed={debug}
                className={
                  debug
                    ? `${toolbarButton} border-amber-500/60 bg-amber-500/10 text-amber-300`
                    : toolbarButton
                }
              >
                <Bug className="h-3.5 w-3.5" />
                调试
              </button>
            {chat.messages.length > 0 && (
              <>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(window.location.href).then(() => {
                    setLinkCopied(true);
                    window.setTimeout(() => setLinkCopied(false), 1500);
                  });
                }}
                title="复制可恢复和调试当前会话的链接"
                className={toolbarButton}
              >
                {linkCopied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Link2 className="h-3.5 w-3.5" />
                )}
                {linkCopied ? "已复制" : "会话链接"}
              </button>
              <button
                type="button"
                onClick={chat.endContext}
                disabled={chat.contextEnded}
                title="点击后，下一道题不会带上之前对话的上下文"
                className={
                  chat.contextEnded
                    ? `${toolbarButton} border-brand-500/50 bg-brand-500/10 text-brand-300`
                    : toolbarButton
                }
              >
                {chat.contextEnded ? "已断开上下文" : "结束上下文"}
              </button>
              <button
                type="button"
                onClick={chat.reset}
                className={toolbarButton}
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
        <div className="mx-auto flex max-w-4xl flex-col gap-7 px-4 py-6 sm:px-6 sm:py-8">
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
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-500 shadow-lg shadow-black/25">
        <Sparkles className="h-8 w-8 text-white" />
      </div>
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-[#f4f4f4]">拍一张题目照片，AI 老师为你讲解</h2>
        <p className="mt-3 text-sm leading-6 text-[#a0a0a0]">
          支持几何图形、函数图像、化学结构、手写题目 · 图文并茂，公式用 LaTeX 渲染
        </p>
      </div>
      <div className="grid w-full max-w-lg gap-3">
        {EXAMPLES.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="rounded-2xl border border-[#424242] bg-[#2f2f2f] px-5 py-4 text-left text-sm leading-6 text-[#d1d1d1] transition hover:border-[#5b5b5b] hover:bg-[#363636]"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
