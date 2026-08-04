import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react";
import { Bug, Check, ChevronDown, Link2, Loader2, LockKeyhole, PanelLeft, SquarePen } from "lucide-react";
import { Composer } from "./components/Composer";
import { ChatMessage } from "./components/ChatMessage";
import { SessionDrawer } from "./components/SessionDrawer";
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
      <div className="flex h-full items-center justify-center bg-cream text-faint">
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
    <div className="flex h-full items-center justify-center bg-cream px-5 text-ink">
      <form
        className="w-full max-w-sm rounded-3xl border border-line bg-white p-7 shadow-[0_8px_30px_rgba(38,37,31,0.08)]"
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
        <p className="mt-2 text-sm leading-6 text-mute">请输入访问密码后继续。</p>
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
            className="w-full rounded-2xl border border-line bg-cream px-4 py-3 text-base tracking-wider outline-none transition placeholder:tracking-normal placeholder:text-faint focus:border-brand-500 disabled:opacity-60"
          />
        </label>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={!password || loading}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  // Whether the user is pinned to the bottom of the message list. While
  // streaming, we only auto-scroll when they're already at/near the bottom,
  // so reading older content is never interrupted by forced scrolling.
  const stickToBottomRef = useRef(true);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const iconButton =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-mute transition hover:bg-black/5 hover:text-ink";

  const handleScroll = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // Edge swipe gestures for the session drawer: a rightward swipe starting
  // from the left edge opens it; a leftward swipe anywhere closes it.
  const handleSwipeStart = useCallback((event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleSwipeEnd = useCallback(
    (event: TouchEvent) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      const touch = event.changedTouches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dy) > 60) return;
      if (!drawerOpen && start.x <= 28 && dx >= 70) setDrawerOpen(true);
      else if (drawerOpen && dx <= -70) setDrawerOpen(false);
    },
    [drawerOpen]
  );

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
    <div
      className="flex h-full flex-col bg-cream text-ink"
      onTouchStart={handleSwipeStart}
      onTouchEnd={handleSwipeEnd}
    >
      {/* Slim single-row header — controls stay out of the way of content */}
      <header className="border-b border-line bg-cream/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-4xl items-center gap-1.5 px-3 sm:px-4">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            title="会话列表"
            aria-label="会话列表"
            className={iconButton}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          {/* Model picker at top-left, ChatGPT-web style */}
          <label
            className="flex h-8 min-w-0 cursor-pointer items-center gap-0.5 rounded-lg pl-2 pr-1 text-[15px] font-semibold text-ink transition hover:bg-black/5"
            title="选择本轮及后续对话使用的模型"
          >
            <span className="sr-only">选择模型</span>
            <select
              value={chat.selectedModel}
              disabled={chat.loading || chat.modelsLoading}
              onChange={(event) => chat.setSelectedModel(event.target.value)}
              className="min-w-0 max-w-[9rem] cursor-pointer appearance-none truncate bg-transparent outline-none disabled:opacity-50 sm:max-w-[18rem]"
            >
              {chat.modelsLoading && <option value="">正在读取模型…</option>}
              {!chat.modelsLoading && chat.models.length === 0 && (
                <option value="">服务器默认模型</option>
              )}
              {chat.models.map((model) => (
                <option key={model.id} value={model.id} className="bg-white text-ink">
                  {model.displayName}
                </option>
              ))}
            </select>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
          </label>
          <div className="ml-auto flex items-center gap-0.5">
            {chat.messages.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={chat.endContext}
                  disabled={chat.contextEnded}
                  title="点击后，下一道题不会带上之前对话的上下文"
                  className={
                    chat.contextEnded
                      ? "flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg bg-brand-500/10 px-2.5 text-xs font-medium text-brand-600"
                      : "flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-2.5 text-xs font-medium text-mute transition hover:bg-black/5 hover:text-ink"
                  }
                >
                  {chat.contextEnded ? "已断开上下文" : "结束上下文"}
                </button>
                <button
                  type="button"
                  onClick={chat.reset}
                  title="新对话"
                  aria-label="新对话"
                  className={iconButton}
                >
                  <SquarePen className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setDebug((value) => !value)}
              title="显示服务端流式事件、工具参数和模型响应"
              aria-label="调试"
              aria-pressed={debug}
              className={
                debug
                  ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 transition"
                  : iconButton
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
                className={iconButton}
              >
                {linkCopied ? (
                  <Check className="h-4 w-4 text-emerald-600" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
              </button>
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
        <div className="mx-auto flex min-h-full max-w-4xl flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">
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
        selectedSkill={chat.selectedSkill}
        onSelectedSkillChange={chat.setSelectedSkill}
      />

      <SessionDrawer
        open={drawerOpen}
        sessions={chat.sessions}
        currentId={chat.sessionId}
        onClose={() => setDrawerOpen(false)}
        onSelect={(id) => {
          chat.switchSession(id);
          setDrawerOpen(false);
        }}
        onDelete={chat.deleteSession}
        onNewChat={() => {
          chat.reset();
          setDrawerOpen(false);
        }}
      />
    </div>
  );
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-8 py-8 text-center">
      <div>
        <h2 className="font-serif text-3xl font-medium tracking-tight text-ink sm:text-4xl">
          有什么题目想问我？
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-mute">
          拍一张题目照片，AI 老师为你讲解 · 支持几何图形、函数图像、化学结构、手写题目
        </p>
      </div>
      <div className="grid w-full max-w-xl gap-2.5">
        {EXAMPLES.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="rounded-xl border border-line px-4 py-3 text-left text-sm leading-6 text-mute transition hover:border-[#cbc5b4] hover:bg-card hover:text-ink"
          >
            {text}
          </button>
        ))}
      </div>
      <p className="text-xs leading-5 text-faint">
        答案由 AI 生成，请核对后再用于作业。支持数学公式（LaTeX）。
      </p>
    </div>
  );
}
