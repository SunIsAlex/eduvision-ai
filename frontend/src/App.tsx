import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, Check, GraduationCap, Link2, Loader2, LockKeyhole, RotateCcw, Sparkles } from "lucide-react";
import { Composer } from "./components/Composer";
import { ChatMessage } from "./components/ChatMessage";
import { useChat } from "./hooks/useChat";

const EXAMPLES = [
  "解方程 x²-5x+6=0，并说明使用了什么方法",
  "为什么铁制品会生锈？如何防止生锈？",
  "欧姆定律是什么？并联电路总电阻怎么算？",
];

export default function App() {
  const [authState, setAuthState] = useState<"checking" | "locked" | "open">("checking");

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("鉴权状态读取失败");
        return response.json() as Promise<{ authenticated?: boolean }>;
      })
      .then((status) => {
        if (active) setAuthState(status.authenticated ? "open" : "locked");
      })
      .catch(() => {
        if (active) setAuthState("locked");
      });
    return () => {
      active = false;
    };
  }, []);

  if (authState === "checking") {
    return (
      <div className="flex h-full items-center justify-center bg-[#212121] text-[#b4b4b4]">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="正在验证访问权限" />
      </div>
    );
  }
  if (authState === "locked") return <LoginScreen onSuccess={() => setAuthState("open")} />;
  return <ChatApp />;
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="flex h-full items-center justify-center bg-[#212121] px-5 text-[#ececec]">
      <form
        className="w-full max-w-sm rounded-3xl border border-[#424242] bg-[#2b2b2b] p-7 shadow-2xl shadow-black/25"
        onSubmit={(event) => {
          event.preventDefault();
          if (!password || loading) return;
          setLoading(true);
          setError("");
          void fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          })
            .then(async (response) => {
              const body = (await response.json().catch(() => ({}))) as { error?: string };
              if (!response.ok) throw new Error(body.error ?? `登录失败（${response.status}）`);
              onSuccess();
            })
            .catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : "登录失败");
              setPassword("");
            })
            .finally(() => setLoading(false));
        }}
      >
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500">
          <LockKeyhole className="h-6 w-6 text-white" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">访问 EduVision AI</h1>
        <p className="mt-2 text-sm leading-6 text-[#a0a0a0]">请输入访问密码后继续。</p>
        <label className="mt-6 block">
          <span className="sr-only">访问密码</span>
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={password}
            disabled={loading}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="访问密码"
            className="w-full rounded-2xl border border-[#4a4a4a] bg-[#212121] px-4 py-3 text-base tracking-wider outline-none transition placeholder:tracking-normal placeholder:text-[#777] focus:border-brand-500 disabled:opacity-60"
          />
        </label>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={!password || loading}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          进入
        </button>
      </form>
    </div>
  );
}

function ChatApp() {
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
          <div className="scrollbar-thin -mx-1 flex w-full items-center gap-2 overflow-x-auto px-1 pb-0.5 lg:mx-0 lg:w-auto lg:min-w-0 lg:flex-1 lg:overflow-visible lg:px-0 lg:pb-0">
            {chat.messages.length > 0 && (
              <>
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
                <button type="button" onClick={chat.reset} className={toolbarButton}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  新对话
                </button>
              </>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-2 pl-3">
              <button
                type="button"
                onClick={() => setDebug((value) => !value)}
                title="显示服务端流式事件、工具参数和模型响应"
                aria-label="调试"
                aria-pressed={debug}
                className={
                  debug
                    ? "flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/60 bg-amber-500/10 text-amber-300 transition"
                    : "flex h-10 w-10 items-center justify-center rounded-xl border border-[#424242] bg-[#242424] text-[#b4b4b4] transition hover:border-[#5a5a5a] hover:bg-[#2f2f2f] hover:text-[#ececec]"
                }
              >
                <Bug className="h-4 w-4" />
              </button>
              {chat.messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(window.location.href).then(() => {
                      setLinkCopied(true);
                      window.setTimeout(() => setLinkCopied(false), 1500);
                    });
                  }}
                  title={linkCopied ? "会话链接已复制" : "复制可恢复和调试当前会话的链接"}
                  aria-label={linkCopied ? "会话链接已复制" : "复制会话链接"}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#424242] bg-[#242424] text-[#b4b4b4] transition hover:border-[#5a5a5a] hover:bg-[#2f2f2f] hover:text-[#ececec]"
                >
                  {linkCopied ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <Link2 className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>
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
        models={chat.models}
        selectedModel={chat.selectedModel}
        onSelectedModelChange={chat.setSelectedModel}
        modelsLoading={chat.modelsLoading}
        selectedSkill={chat.selectedSkill}
        onSelectedSkillChange={chat.setSelectedSkill}
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
      <p className="text-xs leading-5 text-[#777]">
        答案由 AI 生成，请核对后再用于作业。支持数学公式（LaTeX）。
      </p>
    </div>
  );
}
