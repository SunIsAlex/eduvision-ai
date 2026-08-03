import type { Env } from "./types";

export const AUTH_COOKIE = "eduvision_access";
export const ADMIN_AUTH_COOKIE = "eduvision_admin_access";
const TOKEN_CONTEXT = "eduvision-access-v1";
const ADMIN_TOKEN_CONTEXT = "eduvision-admin-access-v1";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

async function createToken(password: string, context: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(context)))
  );
}

export function createAuthToken(password: string): Promise<string> {
  return createToken(password, TOKEN_CONTEXT);
}

export function createAdminAuthToken(password: string): Promise<string> {
  return createToken(password, ADMIN_TOKEN_CONTEXT);
}

export async function isAuthenticatedRequest(request: Request, env: Env): Promise<boolean> {
  const password = env.ACCESS_PASSWORD?.trim();
  if (!password) return true;
  const supplied = readCookie(request, AUTH_COOKIE);
  return Boolean(supplied) && constantTimeEqual(supplied!, await createAuthToken(password));
}

export async function isAdminAuthenticatedRequest(request: Request, env: Env): Promise<boolean> {
  const password = env.ADMIN_ACCESS_PASSWORD?.trim();
  if (!password) return false;
  const supplied = readCookie(request, ADMIN_AUTH_COOKIE);
  return Boolean(supplied) && constantTimeEqual(supplied!, await createAdminAuthToken(password));
}

export function authCookie(value: string, request: Request, maxAge = 60 * 60 * 24 * 30): string {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const secure = new URL(request.url).protocol === "https:" || forwardedProto === "https";
  return `${AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function adminAuthCookie(value: string, request: Request, maxAge = 60 * 60 * 8): string {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const secure = new URL(request.url).protocol === "https:" || forwardedProto === "https";
  return `${ADMIN_AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
