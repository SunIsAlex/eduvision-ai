import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { runPipeline } from "./stream";
import { cancelBrowserToolWaits, deliverBrowserToolResult } from "./toolbridge";
import { getModelCatalog, isAvailableModel } from "./model-catalog";
import { AccountStoreError } from "./account-store";
import type { AccountUser } from "./account-store";
import { resolveReviewModel, resolveUltraModel } from "./types";
import { generateTitle } from "./title";
import { isSkillId, resolveModel, type ChatRequest, type Env } from "./types";
import {
  adminAuthCookie,
  constantTimeEqual,
  createAdminAuthToken,
  isAdminAuthenticatedRequest,
} from "./auth";
import { getUpstreamStatus } from "./upstream";

export const app = new Hono<{ Bindings: Env; Variables: { user: AccountUser } }>();

// Keep room for base64 expansion, JSON framing, question text and history.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_BYTES = 12 * 1024 * 1024;

app.use(
  "*",
  cors({
    origin: () => {
      return "*";
    },
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

const registrationFailures = new Map<string, { count: number; resetAt: number }>();
const loginFailures = new Map<string, { count: number; resetAt: number }>();
const adminLoginFailures = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const PUBLIC_API_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
  "/api/admin/auth/status",
  "/api/admin/auth/login",
]);

app.use("/api/*", async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path) || c.req.path.startsWith("/api/admin/")) return next();
  const store = c.env.ACCOUNTS;
  if (!store) return c.json({ error: "账号服务未初始化" }, 503);
  const user = await store.authenticatedUser(c.req.raw);
  if (!user) return c.json({ error: "请先登录账号" }, 401);
  c.set("user", user);
  return next();
});

function clientIp(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

app.get("/api/admin/auth/status", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    configured: Boolean(c.env.ADMIN_ACCESS_PASSWORD?.trim()),
    authenticated: await isAdminAuthenticatedRequest(c.req.raw, c.env),
  });
});

app.post("/api/admin/auth/login", async (c) => {
  c.header("Cache-Control", "no-store");
  const expected = c.env.ADMIN_ACCESS_PASSWORD?.trim();
  if (!expected) return c.json({ error: "服务器未配置 ADMIN_ACCESS_PASSWORD" }, 503);
  const ip = clientIp(c.req.raw.headers);
  const now = Date.now();
  const prior = adminLoginFailures.get(ip);
  const attempt = prior && prior.resetAt > now ? prior : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (attempt.count >= MAX_LOGIN_FAILURES) {
    c.header("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
    return c.json({ error: "尝试次数过多，请稍后再试" }, 429);
  }
  const body = await c.req.json<{ password?: unknown }>().catch(() => null);
  const supplied = typeof body?.password === "string" ? body.password.slice(0, 256) : "";
  if (!(await constantTimeEqual(supplied, expected))) {
    attempt.count += 1;
    adminLoginFailures.set(ip, attempt);
    return c.json({ error: "管理员密码错误" }, 401);
  }
  adminLoginFailures.delete(ip);
  c.header("Set-Cookie", adminAuthCookie(await createAdminAuthToken(expected), c.req.raw));
  return c.json({ ok: true });
});

function registrationEnabled(env: Env): boolean {
  return env.ALLOW_REGISTRATION?.trim().toLowerCase() !== "false";
}

function registrationCode(env: Env): string {
  return env.REGISTRATION_CODE?.trim() || env.ACCESS_PASSWORD?.trim() || "";
}

function accountErrorResponse(error: unknown): Response {
  const status = error instanceof AccountStoreError ? error.status : 500;
  const message = error instanceof AccountStoreError ? error.message : "服务器内部错误";
  return Response.json({ error: message }, { status });
}

app.get("/api/auth/status", async (c) => {
  c.header("Cache-Control", "no-store");
  const store = c.env.ACCOUNTS;
  if (!store) return c.json({ error: "账号服务未初始化" }, 503);
  const user = await store.authenticatedUser(c.req.raw);
  return c.json({
    authenticated: Boolean(user),
    user: user ?? undefined,
    registrationEnabled: registrationEnabled(c.env),
    registrationRequiresCode: Boolean(registrationCode(c.env)),
    userCount: store.userCount,
  });
});

app.post("/api/auth/login", async (c) => {
  c.header("Cache-Control", "no-store");
  const store = c.env.ACCOUNTS;
  if (!store) return c.json({ error: "账号服务未初始化" }, 503);
  const ip = clientIp(c.req.raw.headers);
  const now = Date.now();
  const prior = loginFailures.get(ip);
  const attempt = prior && prior.resetAt > now ? prior : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (attempt.count >= MAX_LOGIN_FAILURES) {
    c.header("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
    return c.json({ error: "尝试次数过多，请稍后再试" }, 429);
  }
  const body = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: "请求格式无效" }, 400);
  const username = typeof body.username === "string" ? body.username.slice(0, 64) : "";
  const password = typeof body.password === "string" ? body.password.slice(0, 128) : "";
  const result = await store.login(username, password);
  if (!result) {
    attempt.count += 1;
    loginFailures.set(ip, attempt);
    return c.json({ error: "用户名或密码错误" }, 401);
  }
  loginFailures.delete(ip);
  c.header("Set-Cookie", store.cookieFor(result.token, c.req.raw));
  return c.json({ ok: true, user: result.user });
});

app.post("/api/auth/register", async (c) => {
  c.header("Cache-Control", "no-store");
  const store = c.env.ACCOUNTS;
  if (!store) return c.json({ error: "账号服务未初始化" }, 503);
  if (!registrationEnabled(c.env)) return c.json({ error: "服务器已关闭新账号注册" }, 403);
  const ip = clientIp(c.req.raw.headers);
  const now = Date.now();
  const prior = registrationFailures.get(ip);
  const attempt = prior && prior.resetAt > now ? prior : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (attempt.count >= MAX_LOGIN_FAILURES) {
    c.header("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
    return c.json({ error: "尝试次数过多，请稍后再试" }, 429);
  }
  const body = await c.req.json<{
    username?: unknown;
    password?: unknown;
    registrationCode?: unknown;
  }>().catch(() => null);
  if (!body) return c.json({ error: "请求格式无效" }, 400);
  const expectedCode = registrationCode(c.env);
  const suppliedCode = typeof body.registrationCode === "string" ? body.registrationCode.slice(0, 256) : "";
  if (expectedCode && !(await constantTimeEqual(suppliedCode, expectedCode))) {
    attempt.count += 1;
    registrationFailures.set(ip, attempt);
    return c.json({ error: "邀请码错误" }, 403);
  }
  try {
    const result = await store.register(
      typeof body.username === "string" ? body.username.slice(0, 64) : "",
      typeof body.password === "string" ? body.password.slice(0, 128) : ""
    );
    registrationFailures.delete(ip);
    c.header("Set-Cookie", store.cookieFor(result.token, c.req.raw));
    return c.json({ ok: true, user: result.user }, 201);
  } catch (error) {
    return accountErrorResponse(error);
  }
});

app.post("/api/auth/logout", (c) => {
  const store = c.env.ACCOUNTS!;
  c.header("Set-Cookie", store.logoutCookie(c.req.raw));
  return c.json({ ok: true });
});

app.put("/api/auth/password", async (c) => {
  const store = c.env.ACCOUNTS!;
  const body = await c.req.json<{ currentPassword?: unknown; newPassword?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: "请求格式无效" }, 400);
  try {
    const token = await store.changePassword(
      c.get("user").id,
      typeof body.currentPassword === "string" ? body.currentPassword.slice(0, 128) : "",
      typeof body.newPassword === "string" ? body.newPassword.slice(0, 128) : ""
    );
    c.header("Set-Cookie", store.cookieFor(token, c.req.raw));
    return c.json({ ok: true });
  } catch (error) {
    return accountErrorResponse(error);
  }
});

app.get("/api/sessions", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    return c.json({ sessions: await c.env.ACCOUNTS!.listSessions(c.get("user").id) });
  } catch (error) {
    return accountErrorResponse(error);
  }
});

app.get("/api/sessions/:sessionId", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const snapshot = await c.env.ACCOUNTS!.getSession(c.get("user").id, c.req.param("sessionId"));
    return snapshot ? c.json(snapshot) : c.json({ error: "会话不存在" }, 404);
  } catch (error) {
    return accountErrorResponse(error);
  }
});

app.put("/api/sessions/:sessionId", async (c) => {
  const declaredLength = Number(c.req.header("content-length") ?? 0);
  if (declaredLength > MAX_SESSION_BYTES) return c.json({ error: "会话数据过大" }, 413);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SESSION_BYTES) {
    return c.json({ error: "会话数据过大" }, 413);
  }
  let value: { messages?: unknown; contextBreak?: unknown; title?: unknown; titleGenerated?: unknown };
  try {
    value = JSON.parse(raw) as typeof value;
  } catch {
    return c.json({ error: "会话数据不是合法 JSON" }, 400);
  }
  try {
    await c.env.ACCOUNTS!.saveSession(c.get("user").id, c.req.param("sessionId"), value);
    return c.json({ ok: true });
  } catch (error) {
    return accountErrorResponse(error);
  }
});

app.delete("/api/sessions/:sessionId", async (c) => {
  try {
    await c.env.ACCOUNTS!.deleteSession(c.get("user").id, c.req.param("sessionId"));
    return c.json({ ok: true });
  } catch (error) {
    return accountErrorResponse(error);
  }
});

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "eduvision-ai",
    models: {
      answer: resolveModel(c.env.API_MODEL),
      ultra: resolveUltraModel(c.env),
      review: resolveReviewModel(c.env),
    },
    uploads: false,
    upstream: getUpstreamStatus(c.env),
    timestamp: new Date().toISOString(),
  })
);

/** Public runtime browser configuration. Desmos API keys are client-visible by design. */
app.get("/api/config", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    desmosEnabled: Boolean(c.env.DESMOS_API_KEY?.trim()),
    desmosApiKey: c.env.DESMOS_API_KEY?.trim() || undefined,
  });
});

app.get("/api/models", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(getModelCatalog(c.env));
});

/**
 * POST /api/title — generates a short session title from the first Q&A pair.
 * Best-effort: the client falls back to a truncated question on failure.
 */
app.post("/api/title", async (c) => {
  let body: { question?: unknown; answer?: unknown; model?: unknown };
  try {
    body = await c.req.json<typeof body>();
  } catch {
    return c.json({ error: "请求体不是合法的 JSON" }, 400);
  }
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 500) : "";
  const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 800) : "";
  if (!question && !answer) return c.json({ error: "缺少对话内容" }, 400);
  const model =
    typeof body.model === "string" && isAvailableModel(body.model, c.env)
      ? body.model
      : resolveModel(c.env.API_MODEL);
  try {
    const title = await generateTitle(c.env, model, question || "（图片题目）", answer);
    if (!title) return c.json({ error: "标题生成为空" }, 502);
    return c.json({ title });
  } catch (error) {
    return c.json({ error: `标题生成失败：${(error as Error).message.slice(0, 120)}` }, 502);
  }
});

/**
 * POST /api/chat/stream — Server-Sent Events endpoint.
 * Events: thinking | reasoning | answer | tool_call | tool_result | done | error.
 */
app.post("/api/chat/stream", async (c) => {
  let body: ChatRequest;
  try {
    body = await c.req.json<ChatRequest>();
  } catch {
    return c.json({ error: "请求体不是合法的 JSON" }, 400);
  }

  // Basic input hygiene: only allow data:/https: images, cap size.
  const image = body.image;
  if (image && !image.startsWith("data:image/") && !image.startsWith("https://")) {
    return c.json({ error: "图片格式不支持" }, 400);
  }
  if (image?.startsWith("data:")) {
    const bytes = (image.length * 3) / 4;
    if (bytes > MAX_IMAGE_BYTES) {
      return c.json({ error: "图片超过请求限制，请压缩后重试" }, 413);
    }
  }
  if (body.model && !isAvailableModel(body.model, c.env)) {
    return c.json({ error: "所选模型当前不可用，请刷新模型列表后重试" }, 400);
  }
  if (body.skill !== undefined && !isSkillId(body.skill)) {
    return c.json({ error: "所选 SKILL 不存在" }, 400);
  }
  if (body.ultra !== undefined && typeof body.ultra !== "boolean") {
    return c.json({ error: "ultra 参数无效" }, 400);
  }
  if (body.ocrConfirmed !== undefined && typeof body.ocrConfirmed !== "boolean") {
    return c.json({ error: "ocrConfirmed 参数无效" }, 400);
  }

  return streamSSE(c, async (stream) => {
    // 客户端断开（点“停止”或直接关闭页面）时取消上游流，避免继续消耗
    // token/额度；同时释放等待浏览器工具结果的挂起条目。
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    c.req.raw.signal.addEventListener("abort", onAbort);
    stream.onAbort(onAbort);
    const gen = runPipeline(c.env, body, { signal: controller.signal });
    try {
      for await (const evt of gen) {
        if (controller.signal.aborted) break;
        await stream.writeSSE({
          event: evt.event,
          data: evt.data,
        });
        if (evt.event === "done" || evt.event === "error") break;
      }
    } finally {
      c.req.raw.signal.removeEventListener("abort", onAbort);
      controller.abort();
      cancelBrowserToolWaits(body.requestId ?? "local");
      await stream.close();
    }
  });
});

/**
 * POST /api/tool/result — the browser reports back the output of a
 * browser-executed tool call. Resolves the paused SSE stream, which then feeds
 * the result to the model and keeps streaming.
 */
app.post("/api/tool/result", async (c) => {
  let body: { requestId?: string; toolCallId?: string; ok?: boolean; output?: string };
  try {
    body = await c.req.json<typeof body>();
  } catch {
    return c.json({ error: "请求体不是合法的 JSON" }, 400);
  }

  const { requestId, toolCallId } = body;
  if (!requestId || !toolCallId) {
    return c.json({ error: "缺少 requestId 或 toolCallId" }, 400);
  }
  if (!/^[\w-]{8,128}$/.test(requestId) || !/^[\w-]{1,128}$/.test(toolCallId)) {
    return c.json({ error: "参数格式不合法" }, 400);
  }

  const output = String(body.output ?? "").slice(0, 20_000);
  const ok = body.ok !== false;
  const delivered = await deliverBrowserToolResult(requestId, toolCallId, { ok, output });
  if (!delivered) {
    return c.json({ error: "没有等待该工具结果的会话（可能已超时或位于其他实例）" }, 404);
  }
  return c.json({ ok: true });
});
