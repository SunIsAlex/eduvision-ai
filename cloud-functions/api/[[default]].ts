import app from "../../worker/src/index";
import type { Env } from "../../worker/src/types";

interface NodeFunctionContext {
  request: Request;
  env: Env;
}

/** Tencent EdgeOne Makers Node.js Cloud Function entrypoint for /api/*. */
export default function onRequest(context: NodeFunctionContext): Response | Promise<Response> {
  return app.fetch(context.request, context.env);
}
