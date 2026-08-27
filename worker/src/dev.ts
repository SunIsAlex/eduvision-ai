/**
 * Node.js development and production server. Serves the Hono API and the
 * built React SPA from one process.
 *
 * Usage:  npm run dev:node --workspace worker
 */
import { serve } from "@hono/node-server";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountStore } from "./account-store";
import { app } from "./index";
import { initializeModelCatalog } from "./model-catalog";
import { isAdminAuthenticatedRequest } from "./auth";
import type { Env } from "./types";

/** 构建后的前端静态资源目录（worker/src -> 项目根 -> frontend/dist）。 */
const DIST_ROOT = fileURLToPath(new URL("../../frontend/dist", import.meta.url));
const SESSION_ROOT =
  process.env.SESSION_DATA_DIR ?? fileURLToPath(new URL("../../.session-data", import.meta.url));
const CONFIG_FILE = process.env.CONFIG_FILE ?? fileURLToPath(new URL("../../.dev.vars", import.meta.url));
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

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
    API_MODEL: vars.API_MODEL ?? vars.AI_MODEL ?? process.env.API_MODEL ?? process.env.AI_MODEL,
    API_MODEL_ULTRA: vars.API_MODEL_ULTRA ?? process.env.API_MODEL_ULTRA,
    API_MODEL_REVIEW: vars.API_MODEL_REVIEW ?? process.env.API_MODEL_REVIEW,
    DESMOS_API_KEY: vars.DESMOS_API_KEY ?? process.env.DESMOS_API_KEY,
    ACCESS_PASSWORD: vars.ACCESS_PASSWORD ?? process.env.ACCESS_PASSWORD,
    ALLOW_REGISTRATION: vars.ALLOW_REGISTRATION ?? process.env.ALLOW_REGISTRATION,
    REGISTRATION_CODE: vars.REGISTRATION_CODE ?? process.env.REGISTRATION_CODE,
    AUTH_SESSION_SECRET: vars.AUTH_SESSION_SECRET ?? process.env.AUTH_SESSION_SECRET,
    ADMIN_ACCESS_PASSWORD: vars.ADMIN_ACCESS_PASSWORD ?? process.env.ADMIN_ACCESS_PASSWORD,
    UPSTREAM_MAX_CONCURRENCY:
      vars.UPSTREAM_MAX_CONCURRENCY ?? process.env.UPSTREAM_MAX_CONCURRENCY,
    UPSTREAM_MAX_QUEUE: vars.UPSTREAM_MAX_QUEUE ?? process.env.UPSTREAM_MAX_QUEUE,
    UPSTREAM_QUEUE_TIMEOUT_MS:
      vars.UPSTREAM_QUEUE_TIMEOUT_MS ?? process.env.UPSTREAM_QUEUE_TIMEOUT_MS,
  };
}

async function serveAdminConfig(request: Request): Promise<Response> {
  if (!(await isAdminAuthenticatedRequest(request, runtimeEnv))) {
    return Response.json({ error: "需要管理员权限" }, { status: 401 });
  }
  if (request.method === "GET") {
    try {
      const raw = await readFile(CONFIG_FILE, "utf8");
      const values: Record<string, string> = {};
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator < 1) continue;
        const key = trimmed.slice(0, separator).trim();
        if (ENV_KEY_RE.test(key)) values[key] = trimmed.slice(separator + 1);
      }
      return Response.json({ values }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "无法读取配置文件" }, { status: 500 });
    }
  }
  if (request.method !== "PUT") return new Response("Method Not Allowed", { status: 405 });
  const body = await request.json().catch(() => null) as { values?: unknown } | null;
  if (!body || !body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
    return Response.json({ error: "配置格式无效" }, { status: 400 });
  }
  const entries = Object.entries(body.values as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 100) {
    return Response.json({ error: "配置项数量无效" }, { status: 400 });
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) {
      return Response.json({ error: `配置项 ${key} 无效` }, { status: 400 });
    }
    normalized[key] = value;
  }
  if (!normalized.ADMIN_ACCESS_PASSWORD?.trim()) {
    return Response.json({ error: "ADMIN_ACCESS_PASSWORD 不能为空" }, { status: 400 });
  }
  const serialized = `${Object.keys(normalized).sort().map((key) => `${key}=${normalized[key]}`).join("\n")}\n`;
  const temporaryPath = `${CONFIG_FILE}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, CONFIG_FILE);
  setTimeout(() => process.exit(0), 800).unref();
  return Response.json({ ok: true, restarting: true });
}

const port = Number(process.env.PORT ?? 8787);
const runtimeEnv = await loadDevEnv();
const accountRoot = process.env.USER_DATA_DIR ?? fileURLToPath(new URL("../../.user-data", import.meta.url));
runtimeEnv.ACCOUNTS = await AccountStore.open({
  root: accountRoot,
  tokenSecret: runtimeEnv.AUTH_SESSION_SECRET,
  legacySessionRoot: SESSION_ROOT,
});
await initializeModelCatalog(runtimeEnv);

// Hono's fetch signature accepts runtime configuration as the second argument.
serve({
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/admin/config") return serveAdminConfig(request);
    const isBackend =
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/media") ||
      url.pathname === "/health";
    if (isBackend) return app.fetch(request, runtimeEnv);
    return serveSpa(url);
  },
  port,
});

console.log(`[eduvision] Node server: http://localhost:${port}`);
