import { app } from "../../worker/src/index";
import type { Env } from "../../worker/src/types";

interface NodeFunctionContext {
  request: Request;
  env: Env;
}

/** Tencent EdgeOne Makers Node.js handler shared by every /api/* method. */
function handle(context: NodeFunctionContext): Response | Promise<Response> {
  return app.fetch(context.request, context.env);
}

// Use named method handlers. EdgeOne's default-export wrapper currently emits
// a broken `stdin_default` reference for this bundled Hono entrypoint.
export const onRequestGet = handle;
export const onRequestPost = handle;
export const onRequestPut = handle;
export const onRequestPatch = handle;
export const onRequestDelete = handle;
export const onRequestHead = handle;
export const onRequestOptions = handle;
