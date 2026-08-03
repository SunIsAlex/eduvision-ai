/**
 * Node.js development and production server. Serves the Hono API and the
 * built React SPA from one process.
 *
 * Usage:  npm run dev:node --workspace worker
 */
import { serve } from "@hono/node-server";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "./index";
import type { Env } from "./types";

/** 构建后的前端静态资源目录（worker/src -> 项目根 -> frontend/dist）。 */
const DIST_ROOT = fileURLToPath(new URL("../../frontend/dist", import.meta.url));
const SESSION_ROOT =
  process.env.SESSION_DATA_DIR ?? fileURLToPath(new URL("../../.session-data", import.meta.url));
const SESSION_PATH_RE = /^\/api\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MAX_SESSION_BYTES = 12 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

/** 用构建好的前端提供 SPA 静态资源；找不到文件时回退到 index.html。 */
async function serveSpa(url: URL): Promise<Response> {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // 保留原始 pathname
  }
  if (pathname === "/") pathname = "/index.html";

  const filePath = normalize(join(DIST_ROOT, pathname));
  if (!filePath.startsWith(DIST_ROOT)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const body = await readFile(filePath);
    return new Response(body, {
      headers: {
        "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      },
    });
  } catch {
    try {
      const body = await readFile(join(DIST_ROOT, "index.html"));
      return new Response(body, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response("前端未构建：请先运行 npm run build --workspace frontend", {
        status: 200,
      });
    }
  }
}

/** File-backed capability URLs for the VPS Node runtime. */
async function serveSession(request: Request, sessionId: string): Promise<Response> {
  await mkdir(SESSION_ROOT, { recursive: true, mode: 0o700 });
  const sessionPath = join(SESSION_ROOT, `${sessionId}.json`);
  if (request.method === "GET") {
    try {
      return new Response(await readFile(sessionPath), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Response.json({ error: "会话不存在" }, { status: 404 });
      }
      throw error;
    }
  }
  if (request.method !== "PUT") return new Response("Method Not Allowed", { status: 405 });
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_SESSION_BYTES) {
    return Response.json({ error: "会话数据过大" }, { status: 413 });
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SESSION_BYTES) {
    return Response.json({ error: "会话数据过大" }, { status: 413 });
  }
  let value: { messages?: unknown; contextBreak?: unknown };
  try {
    value = JSON.parse(raw) as typeof value;
  } catch {
    return Response.json({ error: "会话数据不是合法 JSON" }, { status: 400 });
  }
  if (!Array.isArray(value.messages) || value.messages.length > 100) {
    return Response.json({ error: "会话消息格式不合法" }, { status: 400 });
  }
  const snapshot = JSON.stringify({
    messages: value.messages,
    contextBreak:
      typeof value.contextBreak === "number" && Number.isFinite(value.contextBreak)
        ? Math.max(0, Math.floor(value.contextBreak))
        : 0,
    updatedAt: new Date().toISOString(),
  });
  const temporaryPath = join(SESSION_ROOT, `.${sessionId}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporaryPath, snapshot, { mode: 0o600 });
  await rename(temporaryPath, sessionPath);
  return Response.json({ ok: true });
}

/** Candidate locations for .dev.vars (workspace scripts run from worker/). */
const DEV_VARS_CANDIDATES = [".dev.vars", "../.dev.vars"];

async function loadDevEnv(): Promise<Env> {
  const vars: Record<string, string> = {};
  for (const candidate of DEV_VARS_CANDIDATES) {
    try {
      const raw = await readFile(candidate, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      if (Object.keys(vars).length > 0) break;
    } catch {
      // try the next candidate; missing .dev.vars is fine in CI/other envs
    }
  }
  return {
    API_KEY: vars.API_KEY ?? process.env.API_KEY ?? "",
    API_URL: vars.API_URL ?? process.env.API_URL,
    API_MODEL: vars.API_MODEL ?? process.env.API_MODEL,
    DESMOS_API_KEY: vars.DESMOS_API_KEY ?? process.env.DESMOS_API_KEY,
  };
}

const port = Number(process.env.PORT ?? 8787);

// Hono's fetch signature accepts runtime configuration as the second argument.
serve({
  fetch: async (request) => {
    const url = new URL(request.url);
    const sessionMatch = url.pathname.match(SESSION_PATH_RE);
    if (sessionMatch?.[1]) return serveSession(request, sessionMatch[1]);
    const isBackend =
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/media") ||
      url.pathname === "/health";
    if (isBackend) return app.fetch(request, await loadDevEnv());
    return serveSpa(url);
  },
  port,
});

console.log(`[eduvision] Node server: http://localhost:${port}`);
