/**
 * Portable local dev server for environments where wrangler/workerd is not
 * available (e.g. Android/Termux). Serves the exact same Hono app on :8787.
 *
 * Usage:  npm run dev:node --workspace worker
 */
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import app from "./index";
import type { Env } from "./types";

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
  fetch: async (request) => app.fetch(request, await loadDevEnv()),
  port,
});

console.log(`[eduvision] worker dev server: http://localhost:${port}`);
