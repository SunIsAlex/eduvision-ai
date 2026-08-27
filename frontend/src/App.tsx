import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { Bug, Check, ChevronDown, KeyRound, Link2, Loader2, LockKeyhole, PanelLeft, UserRound, SquarePen, X } from "lucide-react";
import { Composer } from "./components/Composer";
import { ChatMessage } from "./components/ChatMessage";
import { SessionDrawer } from "./components/SessionDrawer";
import { useChat } from "./hooks/useChat";
import type { LocalApiConfig } from "./lib/localConfig";

interface AccountUser {
  id: string;
  username: string;
}

interface AuthStatus {
  authenticated: boolean;
  user?: AccountUser;
  registrationEnabled: boolean;
  registrationRequiresCode: boolean;
  userCount: number;
}

export default function App() {
  const [authState, setAuthState] = useState<"checking" | "locked" | "open" | "guest">("checking");
  const [account, setAccount] = useState<AccountUser | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({
    authenticated: false,
    registrationEnabled: true,
    registrationRequiresCode: false,
    userCount: 0,
  });

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("鉴权状态读取失败");
        return response.json() as Promise<AuthStatus>;
      })
      .then((status) => {
        if (!active) return;
        setAuthStatus(status);
        if (status.authenticated && status.user) {
          setAccount(status.user);
          setAuthState("open");
          return;
        }
        try {
          if (window.sessionStorage.getItem("eduvision-guest-mode") === "true") {
            setAuthState("guest");
            return;
          }
        } catch {
          // Session storage is optional.
        }
        setAuthState("locked");
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
  if (authState === "locked") {
    return (
      <LoginScreen
        status={authStatus}
        onSuccess={(user) => {
          try { window.sessionStorage.removeItem("eduvision-guest-mode"); } catch { /* ignore */ }
          setAccount(user);
          setAuthStatus((current) => ({ ...current, userCount: Math.max(1, current.userCount) }));
          setAuthState("open");
        }}
        onGuest={() => {
          try { window.sessionStorage.setItem("eduvision-guest-mode", "true"); } catch { /* ignore */ }
          setAuthState("guest");
        }}
      />
    );
  }
  return (
    <ChatApp
      key={account?.id ?? "guest"}
      account={account ?? undefined}
      guestMode={authState === "guest"}
      onExitGuest={() => {
        try { window.sessionStorage.removeItem("eduvision-guest-mode"); } catch { /* ignore */ }
        setAuthState("locked");
      }}
      onLogout={() => {
        setAccount(null);
        const url = new URL(window.location.href);
        url.searchParams.delete("session");
        window.history.replaceState(null, "", url);
        setAuthState("locked");
      }}
    />
  );
}

function LoginScreen({
  status,
  onSuccess,
  onGuest,
}: {
  status: AuthStatus;
  onSuccess: (user: AccountUser) => void;
  onGuest: () => void;
}) {
  const [registering, setRegistering] = useState(status.userCount === 0 && status.registrationEnabled);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password || loading) return;
    if (registering && password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    setError("");
    void fetch(registering ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim(), password, registrationCode }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { error?: string; user?: AccountUser };
        if (!response.ok || !body.user) throw new Error(body.error ?? `登录失败（${response.status}）`);
        onSuccess(body.user);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : registering ? "注册失败" : "登录失败");
        setPassword("");
        setConfirmation("");
      })
      .finally(() => setLoading(false));
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-cream px-5 py-8 text-ink">
      <form
        className="w-full max-w-sm rounded-3xl border border-line bg-white p-7 shadow-[0_8px_30px_rgba(38,37,31,0.08)]"
        onSubmit={submit}
      >
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500">
          <LockKeyhole className="h-6 w-6 text-white" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">
          {registering ? "创建 EduVision 账号" : "登录 EduVision AI"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-mute">
          {registering ? "每个账号拥有独立密码和云端聊天记录。" : "登录后在任意设备继续你的对话。"}
        </p>
        <label className="mt-6 block text-sm font-medium">
          用户名
          <input
            autoFocus
            autoComplete="username"
            value={username}
            disabled={loading}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="2–32 个字符"
            className="mt-2 w-full rounded-2xl border border-line bg-cream px-4 py-3 text-base outline-none transition placeholder:text-faint focus:border-brand-500 disabled:opacity-60"
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          密码
          <input
            type="password"
            autoComplete={registering ? "new-password" : "current-password"}
            value={password}
            disabled={loading}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={registering ? "至少 8 个字符" : "输入你的密码"}
            className="mt-2 w-full rounded-2xl border border-line bg-cream px-4 py-3 text-base outline-none transition placeholder:text-faint focus:border-brand-500 disabled:opacity-60"
          />
        </label>
        {registering && (
          <>
            <label className="mt-4 block text-sm font-medium">
              确认密码
              <input
                type="password"
                autoComplete="new-password"
                value={confirmation}
                disabled={loading}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="再次输入密码"
                className="mt-2 w-full rounded-2xl border border-line bg-cream px-4 py-3 text-base outline-none transition placeholder:text-faint focus:border-brand-500 disabled:opacity-60"
              />
            </label>
            {status.registrationRequiresCode && (
              <label className="mt-4 block text-sm font-medium">
                邀请码
                <input
                  type="password"
                  autoComplete="off"
                  value={registrationCode}
                  disabled={loading}
                  onChange={(event) => setRegistrationCode(event.target.value)}
                  placeholder="请输入管理员提供的邀请码"
                  className="mt-2 w-full rounded-2xl border border-line bg-cream px-4 py-3 text-base outline-none transition placeholder:text-faint focus:border-brand-500 disabled:opacity-60"
                />
              </label>
            )}
          </>
        )}
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={!username.trim() || !password || loading || (registering && (!confirmation || (status.registrationRequiresCode && !registrationCode)))}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {registering ? "创建账号" : "登录"}
        </button>
        {status.registrationEnabled && (
          <button
            type="button"
            disabled={loading}
            onClick={() => { setRegistering((current) => !current); setError(""); }}
            className="mt-3 w-full py-2 text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            {registering ? "已有账号？返回登录" : "没有账号？创建一个"}
          </button>
        )}
        <div className="my-3 flex items-center gap-3 text-xs text-faint">
          <span className="h-px flex-1 bg-line" />
          或
          <span className="h-px flex-1 bg-line" />
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={onGuest}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-line px-4 py-3 text-sm font-semibold text-mute transition hover:border-brand-500/50 hover:bg-brand-50 hover:text-brand-600 disabled:opacity-50"
        >
          进入访客模式
        </button>
        <p className="mt-3 text-center text-xs leading-5 text-faint">访客记录只保存在本机，且只能使用手动 API 配置</p>
      </form>
    </div>
  );
}

function ChatApp({ account, guestMode = false, onExitGuest, onLogout }: { account?: AccountUser; guestMode?: boolean; onExitGuest?: () => void; onLogout?: () => void }) {
  const chat = useChat({ guestMode, accountId: account?.id });
  const [accountOpen, setAccountOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(guestMode);
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

  // 最近一条用户提问的索引（用于显示“编辑”入口）。
  const lastUserIndex = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i]?.role === "user") return i;
    }
    return -1;
  }, [chat.messages]);

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
            <span className="shrink-0 text-xs font-medium text-mute">回答</span>
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
          {chat.localApiConfig.apiKey.trim() && chat.localApiConfig.apiUrl.trim() && (
            <label
              className="flex h-8 min-w-0 cursor-pointer items-center gap-1 rounded-lg pl-2 pr-1 text-xs font-medium text-mute transition hover:bg-black/5"
              title="回答模型不支持图片时，用此模型识别题目"
            >
              <span className="shrink-0">OCR</span>
              <select
                value={chat.localApiConfig.ocrModel ?? ""}
                disabled={chat.loading || chat.modelsLoading}
                onChange={(event) => chat.setOcrModel(event.target.value)}
                className="min-w-0 max-w-[7rem] cursor-pointer appearance-none truncate bg-transparent text-ink outline-none disabled:opacity-50 sm:max-w-[14rem]"
                aria-label="选择 OCR 模型"
              >
                <option value="">请选择模型</option>
                {chat.models.map((model) => (
                  <option key={model.id} value={model.id} className="bg-white text-ink">
                    {model.displayName}
                  </option>
                ))}
              </select>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
            </label>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {guestMode && (
              <button
                type="button"
                onClick={onExitGuest}
                title="退出访客模式并返回登录"
                className="mr-1 rounded-full bg-amber-100 px-2 py-1 text-[11px] font-medium text-amber-700 transition hover:bg-amber-200"
              >
                访客
              </button>
            )}
            {account && (
              <button
                type="button"
                onClick={() => setAccountOpen(true)}
                title="账号与密码"
                className="mr-1 flex h-8 max-w-28 items-center gap-1.5 rounded-full bg-brand-500/10 px-2.5 text-xs font-medium text-brand-700 transition hover:bg-brand-500/20"
              >
                <UserRound className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{account.username}</span>
              </button>
            )}
            {chat.messages.length > 0 && (
              <>
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
              onClick={() => setConfigOpen(true)}
              title="手动配置浏览器本地 API"
              aria-label="手动配置浏览器本地 API"
              className={
                chat.localApiConfig.apiKey && chat.localApiConfig.apiUrl
                  ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 transition hover:bg-brand-500/20"
                  : iconButton
              }
            >
              <KeyRound className="h-4 w-4" />
            </button>
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
                title={linkCopied ? "会话链接已复制" : "复制当前会话链接（仅当前账号可访问）"}
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
            <Welcome />
          ) : (
            chat.messages.map((m, i) => (
              <ChatMessage
                key={m.id}
                message={m}
                showDebug={debug}
                isLast={i === chat.messages.length - 1}
                isLastUserMessage={m.role === "user" && i === lastUserIndex && !chat.loading}
                onEdit={chat.editMessage}
                onEditUser={chat.editUserMessage}
                onResume={chat.resumeMessage}
                thinking={
                  m.role === "assistant" &&
                  m.status === "streaming" &&
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
        disabled={guestMode && (!chat.localApiConfig.apiKey || !chat.localApiConfig.apiUrl)}
        thinkingEnabled={chat.thinkingEnabled}
        onThinkingEnabledChange={chat.setThinkingEnabled}
        ultraEnabled={chat.ultraEnabled}
        onUltraEnabledChange={chat.setUltraEnabled}
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
      {configOpen && (
        <ManualConfigDialog
          value={chat.localApiConfig}
          onSave={(value) => {
            chat.setLocalApiConfig(value);
            setConfigOpen(false);
          }}
          onClose={() => setConfigOpen(false)}
        />
      )}
      {accountOpen && account && (
        <AccountDialog
          user={account}
          onClose={() => setAccountOpen(false)}
          onLogout={() => {
            setAccountOpen(false);
            onLogout?.();
          }}
        />
      )}
    </div>
  );
}

function AccountDialog({
  user,
  onClose,
  onLogout,
}: {
  user: AccountUser;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const changePassword = (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致");
      return;
    }
    setLoading(true);
    setError("");
    setMessage("");
    void fetch("/api/auth/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `修改失败（${response.status}）`);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmation("");
        setMessage("密码已更新，其他设备上的旧登录已失效。");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "密码修改失败"))
      .finally(() => setLoading(false));
  };

  const logout = () => {
    setLoggingOut(true);
    setError("");
    void fetch("/api/auth/logout", { method: "POST" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`退出失败（${response.status}）`);
        onLogout();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "退出失败"))
      .finally(() => setLoggingOut(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onMouseDown={onClose}>
      <form
        className="w-full max-w-md rounded-3xl border border-line bg-white p-6 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={changePassword}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{user.username}</h2>
            <p className="mt-1 text-xs leading-5 text-mute">聊天记录受账号保护并保存到云端</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-mute hover:bg-black/5" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="my-5 h-px bg-line" />
        <h3 className="text-sm font-semibold">修改密码</h3>
        <input
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          placeholder="当前密码"
          className="mt-3 w-full rounded-xl border border-line bg-cream px-3 py-2.5 text-sm outline-none focus:border-brand-500"
        />
        <input
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          placeholder="新密码（至少 8 个字符）"
          className="mt-3 w-full rounded-xl border border-line bg-cream px-3 py-2.5 text-sm outline-none focus:border-brand-500"
        />
        <input
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder="再次输入新密码"
          className="mt-3 w-full rounded-xl border border-line bg-cream px-3 py-2.5 text-sm outline-none focus:border-brand-500"
        />
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        {message && <p className="mt-3 text-sm text-emerald-600">{message}</p>}
        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={loggingOut || loading}
            onClick={logout}
            className="rounded-xl px-3 py-2 text-sm font-medium text-red-500 hover:bg-red-50 disabled:opacity-50"
          >
            {loggingOut ? "正在退出…" : "退出账号"}
          </button>
          <button
            type="submit"
            disabled={loading || !currentPassword || newPassword.length < 8 || !confirmation}
            className="flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            保存新密码
          </button>
        </div>
      </form>
    </div>
  );
}

function ManualConfigDialog({
  value,
  onSave,
  onClose,
}: {
  value: LocalApiConfig;
  onSave: (value: LocalApiConfig) => void;
  onClose: () => void;
}) {
  const [apiUrl, setApiUrl] = useState(value.apiUrl);
  const [apiKey, setApiKey] = useState(value.apiKey);
  const [showKey, setShowKey] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onMouseDown={onClose}>
      <form
        className="w-full max-w-md rounded-3xl border border-line bg-white p-6 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ apiUrl: apiUrl.trim(), apiKey: apiKey.trim(), ocrModel: value.ocrModel ?? "" });
        }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">手动配置</h2>
            <p className="mt-1 text-xs text-mute">配置后请求和 mathjs 计算均在浏览器本地运行</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-mute hover:bg-black/5" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="mt-5 block text-sm font-medium">
          API URL
          <input
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            placeholder="https://api.example.com 或 .../v1/chat/completions"
            className="mt-2 w-full rounded-xl border border-line bg-cream px-3 py-2.5 font-mono text-xs outline-none focus:border-brand-500"
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          API Key
          <div className="relative mt-2">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              className="w-full rounded-xl border border-line bg-cream px-3 py-2.5 pr-16 font-mono text-xs outline-none focus:border-brand-500"
            />
            <button type="button" onClick={() => setShowKey((current) => !current)} className="absolute right-2 top-1/2 -translate-y-1/2 px-2 text-xs text-mute hover:text-ink">
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
        </label>
        <p className="mt-4 text-xs leading-5 text-faint">Key 只保存在本机 localStorage，不会提交到 EduVision 服务器。API 服务必须允许浏览器跨域请求。</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => onSave({ apiUrl: "", apiKey: "", ocrModel: "" })} className="rounded-xl px-3 py-2 text-sm text-red-500 hover:bg-red-50">清除配置</button>
          <button type="submit" disabled={!apiUrl.trim() || !apiKey.trim()} className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50">保存并启用</button>
        </div>
      </form>
    </div>
  );
}

function Welcome() {
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
      <p className="text-xs leading-5 text-faint">
        答案由 AI 生成，请核对后再用于作业。支持数学公式（LaTeX）。
      </p>
    </div>
  );
}
