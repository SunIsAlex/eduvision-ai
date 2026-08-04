import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { runPipeline } from "./stream";
import { deliverBrowserToolResult } from "./toolbridge";
import { getModelCatalog, isAvailableModel } from "./model-catalog";
import { generateTitle } from "./title";
import { isSkillId, resolveModel, type ChatRequest, type Env } from "./types";
import {
  authCookie,
  adminAuthCookie,
  constantTimeEqual,
  createAuthToken,
  createAdminAuthToken,
  isAuthenticatedRequest,
  isAdminAuthenticatedRequest,
} from "./auth";
import { getUpstreamStatus } from "./upstream";

export const app = new Hono<{ Bindings: Env }>();

// Keep room for base64 expansion, JSON framing, question text and history.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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

const loginFailures = new Map<string, { count: number; resetAt: number }>();
const adminLoginFailures = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

app.use("/api/*", async (c, next) => {
  if (
    ["/api/auth/status", "/api/auth/login", "/api/admin/auth/status", "/api/admin/auth/login"].includes(
      c.req.path
    )
  ) return next();
  if (await isAuthenticatedRequest(c.req.raw, c.env)) return next();
  return c.json({ error: "请先输入访问密码" }, 401);
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

app.get("/api/auth/status", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    required: Boolean(c.env.ACCESS_PASSWORD?.trim()),
    authenticated: await isAuthenticatedRequest(c.req.raw, c.env),
  });
});

app.post("/api/auth/login", async (c) => {
  c.header("Cache-Control", "no-store");
  const expected = c.env.ACCESS_PASSWORD?.trim();
  if (!expected) return c.json({ ok: true });
  const ip = clientIp(c.req.raw.headers);
  const now = Date.now();
  const prior = loginFailures.get(ip);
  const attempt = prior && prior.resetAt > now ? prior : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (attempt.count >= MAX_LOGIN_FAILURES) {
    c.header("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
    return c.json({ error: "尝试次数过多，请稍后再试" }, 429);
  }
  let body: { password?: unknown };
  try {
    body = await c.req.json<typeof body>();
  } catch {
    return c.json({ error: "请求格式无效" }, 400);
  }
  const supplied = typeof body.password === "string" ? body.password.slice(0, 256) : "";
  if (!(await constantTimeEqual(supplied, expected))) {
    attempt.count += 1;
    loginFailures.set(ip, attempt);
    return c.json({ error: "访问密码错误" }, 401);
  }
  loginFailures.delete(ip);
  c.header("Set-Cookie", authCookie(await createAuthToken(expected), c.req.raw));
  return c.json({ ok: true });
});

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "eduvision-ai",
    models: {
      answer: resolveModel(c.env.API_MODEL),
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

  return streamSSE(c, async (stream) => {
    const gen = runPipeline(c.env, body);
    try {
      for await (const evt of gen) {
        await stream.writeSSE({
          event: evt.event,
          data: evt.data,
        });
        if (evt.event === "done" || evt.event === "error") break;
      }
    } finally {
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

/**
 * POST /api/upload — stores a homework image.
 * Images are compressed in the browser and returned as data URLs. Session
 * snapshots persist them on the VPS together with the conversation.
 */
app.post("/api/upload", async (c) => {
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const file = body["file"];

  if (!(file instanceof File)) {
    return c.json({ error: "缺少 file 字段" }, 400);
  }
  if (!file.type.startsWith("image/")) {
    return c.json({ error: "仅支持图片文件" }, 400);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: "图片超过请求限制" }, 413);
  }

  const buf = await file.arrayBuffer();
  const base64 = btoa(
    [...new Uint8Array(buf)].map((byte) => String.fromCharCode(byte)).join("")
  );
  return c.json({ url: `data:${file.type};base64,${base64}`, mode: "data" });
});
