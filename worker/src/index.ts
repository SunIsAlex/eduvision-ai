import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { runPipeline } from "./stream";
import { deliverBrowserToolResult } from "./toolbridge";
import { resolveModel, type ChatRequest, type Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

// EdgeOne Node Functions accept at most 6 MB request/response bodies. Keep
// room for base64 expansion, JSON framing, question text and recent history.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

app.use(
  "*",
  cors({
    origin: () => {
      return "*";
    },
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  })
);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "eduvision-ai",
    models: {
      answer: resolveModel(c.env.API_MODEL),
    },
    uploads: Boolean(c.env.MEDIA_BUCKET),
    timestamp: new Date().toISOString(),
  })
);

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
      return c.json({ error: "图片超过 EdgeOne 请求限制，请压缩后重试" }, 413);
    }
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
  const delivered = await deliverBrowserToolResult(
    requestId,
    toolCallId,
    { ok, output },
    c.env.TOOL_RESULTS
  );
  if (!delivered) {
    return c.json({ error: "没有等待该工具结果的会话（可能已超时或位于其他实例）" }, 404);
  }
  return c.json({ ok: true });
});

/**
 * POST /api/upload — stores a homework image.
 * With an R2 binding the image is persisted and a /media/<key> URL is
 * returned; without one the data URL is echoed back (dev fallback).
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
    return c.json({ error: "图片超过 EdgeOne 请求限制" }, 413);
  }

  const bucket = c.env.MEDIA_BUCKET;
  if (!bucket) {
    const buf = await file.arrayBuffer();
    const base64 = btoa(
      [...new Uint8Array(buf)].map((b) => String.fromCharCode(b)).join("")
    );
    return c.json({
      url: `data:${file.type};base64,${base64}`,
      mode: "data",
    });
  }

  const key = `${crypto.randomUUID()}.${file.name.split(".").pop() ?? "jpg"}`;
  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  const origin = new URL(c.req.url).origin;
  return c.json({ url: `${origin}/media/${key}`, mode: "r2" });
});

/** GET /media/:key — serve previously uploaded images from R2. */
app.get("/media/:key", async (c) => {
  const bucket = c.env.MEDIA_BUCKET;
  if (!bucket) return c.json({ error: "存储未配置" }, 404);
  const object = await bucket.get(c.req.param("key"));
  if (!object) return c.json({ error: "文件不存在" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});

/**
 * Serve the SPA through Wrangler's static-assets binding. `run_worker_first`
 * keeps API routes in this Worker, so non-API requests must be forwarded here.
 */
app.get("*", (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text(
    "EduVision AI worker 运行正常（未配置静态资源）。前端界面由构建后的 frontend/dist 提供，请访问根路径；开发模式请访问 http://localhost:5173"
  );
});

export default app;
