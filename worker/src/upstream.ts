import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import type { Env } from "./types";

const DEFAULT_CONNECTIONS = 16;
const DEFAULT_CONCURRENCY = 12;
const DEFAULT_QUEUE_SIZE = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

const connectionLimit = positiveInteger(process.env.UPSTREAM_CONNECTIONS, DEFAULT_CONNECTIONS, 128);
const agent = new Agent({
  connections: connectionLimit,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  headersTimeout: 120_000,
  bodyTimeout: 300_000,
  connectTimeout: 15_000,
});

type Release = () => void;
type Waiter = {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
};

class UpstreamQueue {
  private active = 0;
  private limit = DEFAULT_CONCURRENCY;
  private readonly waiting: Waiter[] = [];

  acquire(env: Env): Promise<Release> {
    this.limit = positiveInteger(env.UPSTREAM_MAX_CONCURRENCY, DEFAULT_CONCURRENCY, 128);
    const maxQueue = positiveInteger(env.UPSTREAM_MAX_QUEUE, DEFAULT_QUEUE_SIZE, 1000);
    const timeoutMs = positiveInteger(
      env.UPSTREAM_QUEUE_TIMEOUT_MS,
      DEFAULT_QUEUE_TIMEOUT_MS,
      300_000
    );
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiting.filter((waiter) => !waiter.cancelled).length >= maxQueue) {
      return Promise.reject(new Error("服务器当前请求过多，请稍后重试。"));
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        cancelled: false,
        timer: setTimeout(() => {
          waiter.cancelled = true;
          reject(new Error("等待上游模型超时，请稍后重试。"));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiting.push(waiter);
    });
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      if (waiter.cancelled) continue;
      clearTimeout(waiter.timer);
      this.active += 1;
      waiter.resolve(this.makeRelease());
    }
  }

  snapshot(): { active: number; queued: number } {
    return {
      active: this.active,
      queued: this.waiting.filter((waiter) => !waiter.cancelled).length,
    };
  }
}

const queue = new UpstreamQueue();

export function getUpstreamStatus(env: Env): {
  connections: number;
  maxConcurrency: number;
  maxQueue: number;
  active: number;
  queued: number;
} {
  return {
    connections: connectionLimit,
    maxConcurrency: positiveInteger(env.UPSTREAM_MAX_CONCURRENCY, DEFAULT_CONCURRENCY, 128),
    maxQueue: positiveInteger(env.UPSTREAM_MAX_QUEUE, DEFAULT_QUEUE_SIZE, 1000),
    ...queue.snapshot(),
  };
}

/** Fetch through the shared keep-alive pool without occupying a model slot. */
export function pooledFetch(url: string, init?: UndiciRequestInit): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
}

/**
 * Acquire a model-stream slot and fetch through the shared connection pool.
 * The caller must invoke release only after the response stream has ended.
 */
export async function queuedPooledFetch(
  env: Env,
  url: string,
  init?: UndiciRequestInit,
  signal?: AbortSignal
): Promise<{ response: Response; release: Release }> {
  const release = await queue.acquire(env);
  try {
    const response = await pooledFetch(url, { ...init, ...(signal ? { signal } : {}) });
    return { response, release };
  } catch (error) {
    release();
    throw error;
  }
}
