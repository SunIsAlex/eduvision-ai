import app from "../worker/src/index";
import type { Env } from "../worker/src/types";

interface EdgeOneContext {
  request: Request;
  env: Env;
  waitUntil(task: Promise<unknown>): void;
}

/** Tencent EdgeOne Makers file-system entrypoint. */
export default function onRequest(context: EdgeOneContext): Response | Promise<Response> {
  return app.fetch(context.request, context.env, {
    waitUntil: (task) => context.waitUntil(task),
    passThroughOnException: () => undefined,
    props: {},
  });
}
