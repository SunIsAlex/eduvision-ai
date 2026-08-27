import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Loader2, LockKeyhole, Plus, RotateCw, Save, Settings, Trash2 } from "lucide-react";

type AuthState = "checking" | "locked" | "open" | "unconfigured";
type ConfigRow = { id: string; key: string; value: string };

const SECRET_KEY_RE = /(KEY|PASSWORD|SECRET|TOKEN|CODE)$/i;

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body;
}

export default function AdminApp() {
  const [authState, setAuthState] = useState<AuthState>("checking");

  useEffect(() => {
    void fetch("/api/admin/auth/status", { cache: "no-store" })
      .then((response) => responseJson<{ configured: boolean; authenticated: boolean }>(response))
      .then((body) => setAuthState(!body.configured ? "unconfigured" : body.authenticated ? "open" : "locked"))
      .catch(() => setAuthState("locked"));
  }, []);

  if (authState === "checking") return <CenteredSpinner />;
  if (authState === "unconfigured") {
    return <Notice title="管理面板尚未启用" detail="请先在服务器配置中设置 ADMIN_ACCESS_PASSWORD，然后重启服务。" />;
  }
  if (authState === "locked") return <AdminLogin onSuccess={() => setAuthState("open")} />;
  return <ConfigPanel />;
}

function CenteredSpinner() {
  return <div className="flex h-full items-center justify-center bg-[#212121] text-[#b4b4b4]"><Loader2 className="h-5 w-5 animate-spin" /></div>;
}

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-[#212121] px-5 text-[#ececec]">
      <div className="w-full max-w-md rounded-3xl border border-[#424242] bg-[#2b2b2b] p-7">
        <Settings className="mb-5 h-8 w-8 text-brand-400" />
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-[#a0a0a0]">{detail}</p>
      </div>
    </div>
  );
}

function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="flex h-full items-center justify-center bg-[#212121] px-5 text-[#ececec]">
      <form className="w-full max-w-sm rounded-3xl border border-[#424242] bg-[#2b2b2b] p-7 shadow-2xl shadow-black/25" onSubmit={(event) => {
        event.preventDefault();
        if (!password || loading) return;
        setLoading(true); setError("");
        void fetch("/api/admin/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) })
          .then((response) => responseJson(response)).then(onSuccess)
          .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : "登录失败"); setPassword(""); })
          .finally(() => setLoading(false));
      }}>
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500"><LockKeyhole className="h-6 w-6" /></div>
        <h1 className="text-xl font-semibold">EduVision 管理面板</h1>
        <p className="mt-2 text-sm text-[#a0a0a0]">请输入独立管理员密码。</p>
        <input autoFocus type="password" autoComplete="current-password" value={password} disabled={loading} onChange={(event) => setPassword(event.target.value)} placeholder="管理员密码" className="mt-6 w-full rounded-2xl border border-[#4a4a4a] bg-[#212121] px-4 py-3 outline-none focus:border-brand-500" />
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button disabled={!password || loading} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold disabled:opacity-50">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}登录
        </button>
      </form>
    </div>
  );
}

function ConfigPanel() {
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/admin/config", { cache: "no-store" })
      .then((response) => responseJson<{ values: Record<string, string> }>(response))
      .then(({ values }) => setRows(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "配置读取失败"))
      .finally(() => setLoading(false));
  }, []);

  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    rows.forEach(({ key }) => counts.set(key.trim(), (counts.get(key.trim()) ?? 0) + 1));
    return new Set([...counts].filter(([key, count]) => key && count > 1).map(([key]) => key));
  }, [rows]);

  const save = () => {
    if (saving || duplicateKeys.size) return;
    const values = Object.fromEntries(rows.map(({ key, value }) => [key.trim(), value]));
    setSaving(true); setError(""); setMessage("");
    void fetch("/api/admin/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) })
      .then((response) => responseJson<{ restarting: boolean }>(response))
      .then(() => {
        setMessage("配置已保存，服务正在重启……");
        window.setTimeout(async () => {
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
            try {
              const response = await fetch("/api/admin/auth/status", { cache: "no-store" });
              if (response.ok) { window.location.reload(); return; }
            } catch { /* keep waiting */ }
          }
          setMessage("配置已保存；请手动刷新页面确认服务状态。");
          setSaving(false);
        }, 800);
      })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : "保存失败"); setSaving(false); });
  };

  return (
    <div className="min-h-full bg-[#212121] text-[#ececec]">
      <header className="border-b border-[#303030] bg-[#171717]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3"><Settings className="h-5 w-5 text-brand-400" /><div><h1 className="font-semibold">EduVision 控制面板</h1><p className="text-xs text-[#8e8e8e]">服务器环境配置</p></div></div>
          <a href="/" className="text-sm text-[#b4b4b4] hover:text-white">返回应用</a>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8">
        <div className="rounded-3xl border border-[#3a3a3a] bg-[#292929] p-5 sm:p-7">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-semibold">配置参数</h2><p className="mt-1 text-sm text-[#999]">保存会原子写入配置文件，并自动重启服务。</p></div>
            <button type="button" onClick={() => setRows((current) => [...current, { id: crypto.randomUUID(), key: "", value: "" }])} className="flex items-center gap-2 rounded-xl border border-[#4a4a4a] px-3 py-2 text-sm hover:bg-[#333]"><Plus className="h-4 w-4" />添加参数</button>
          </div>
          {loading ? <div className="flex justify-center py-16"><Loader2 className="animate-spin" /></div> : (
            <div className="space-y-3">
              {rows.map((row) => {
                const secret = SECRET_KEY_RE.test(row.key);
                const revealed = visible.has(row.id);
                return <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(180px,0.8fr)_minmax(260px,1.4fr)_40px]">
                  <input value={row.key} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, key: event.target.value.toUpperCase() } : item))} placeholder="PARAMETER_NAME" className={`rounded-xl border bg-[#1f1f1f] px-3 py-2.5 font-mono text-sm outline-none ${duplicateKeys.has(row.key.trim()) ? "border-red-500" : "border-[#444] focus:border-brand-500"}`} />
                  <div className="relative"><input type={secret && !revealed ? "password" : "text"} value={row.value} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} placeholder="值" className="w-full rounded-xl border border-[#444] bg-[#1f1f1f] px-3 py-2.5 pr-11 font-mono text-sm outline-none focus:border-brand-500" />{secret && <button type="button" onClick={() => setVisible((current) => { const next = new Set(current); next.has(row.id) ? next.delete(row.id) : next.add(row.id); return next; })} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-[#888] hover:text-white">{revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>}</div>
                  <button type="button" aria-label="删除参数" onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))} className="flex h-10 w-10 items-center justify-center rounded-xl text-[#888] hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
                </div>;
              })}
            </div>
          )}
          {duplicateKeys.size > 0 && <p className="mt-4 text-sm text-red-400">参数名不能重复。</p>}
          {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
          {message && <p className="mt-4 flex items-center gap-2 text-sm text-emerald-400">{saving && <RotateCw className="h-4 w-4 animate-spin" />}{message}</p>}
          <div className="mt-7 flex justify-end"><button type="button" disabled={loading || saving || rows.length === 0 || duplicateKeys.size > 0} onClick={save} className="flex items-center gap-2 rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存并重启</button></div>
        </div>
      </main>
    </div>
  );
}
