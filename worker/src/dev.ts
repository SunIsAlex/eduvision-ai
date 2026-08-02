/**
 * Portable local dev server for environments where wrangler/workerd is not
 * available (e.g. Android/Termux). Serves the exact same Hono app on :8787.
 *
 * Usage:  npm run dev:node --workspace worker
 */
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import app from "./index";
import type { Env } from "./types";

/** 构建后的前端静态资源目录（worker/src -> 项目根 -> frontend/dist）。 */
const DIST_ROOT = fileURLToPath(new URL("../../frontend/dist", import.meta.url));

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
    SILICONFLOW_API_KEY:
      vars.SILICONFLOW_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? "",
    SILICONFLOW_BASE_URL:
      vars.SILICONFLOW_BASE_URL ?? process.env.SILICONFLOW_BASE_URL,
    CORS_ORIGIN: vars.CORS_ORIGIN ?? process.env.CORS_ORIGIN ?? "*",
    AI_MODEL: vars.AI_MODEL ?? process.env.AI_MODEL,
  };
}

const port = Number(process.env.PORT ?? 8787);

// Hono's fetch signature accepts bindings as the second argument, so the same
// worker code runs unmodified outside Cloudflare.
serve({
  fetch: async (request) => {
    const url = new URL(request.url);
    const isBackend =
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/media") ||
      url.pathname === "/health";
    if (isBackend) return app.fetch(request, await loadDevEnv());
    return serveSpa(url);
  },
  port,
});

console.log(`[eduvision] worker dev server: http://localhost:${port}`);
