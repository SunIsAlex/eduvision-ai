import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/account-store";
import { app } from "../src/index";
import type { Env } from "../src/types";

const root = await mkdtemp(join(tmpdir(), "eduvision-accounts-"));

try {
  const store = await AccountStore.open({ root, tokenSecret: "test-secret-with-more-than-thirty-two-characters" });
  const alice = await store.register("alice", "alice-password-123");
  const bob = await store.register("bob", "bob-password-456");
  assert.equal(store.userCount, 2);

  const rawAccounts = await readFile(join(root, "accounts.json"), "utf8");
  assert.equal(rawAccounts.includes("alice-password-123"), false, "plaintext password leaked");
  assert.match(rawAccounts, /scrypt\$/);

  const aliceRequest = new Request("https://example.test/api/auth/status", {
    headers: { cookie: `eduvision_access=${encodeURIComponent(alice.token)}` },
  });
  assert.deepEqual(await store.authenticatedUser(aliceRequest), alice.user);

  const sessionId = "11111111-1111-4111-8111-111111111111";
  await store.saveSession(alice.user.id, sessionId, {
    messages: [{ role: "user", content: "Alice 的题目" }],
    contextBreak: 0,
  });
  await store.saveSession(bob.user.id, sessionId, {
    messages: [{ role: "user", content: "Bob 的题目" }],
    contextBreak: 0,
  });
  const aliceSession = await store.getSession(alice.user.id, sessionId);
  const bobSession = await store.getSession(bob.user.id, sessionId);
  assert.equal((aliceSession?.messages[0] as { content: string }).content, "Alice 的题目");
  assert.equal((bobSession?.messages[0] as { content: string }).content, "Bob 的题目");
  assert.equal((await store.listSessions(alice.user.id)).length, 1);
  assert.equal((await store.listSessions(bob.user.id)).length, 1);

  await store.changePassword(alice.user.id, "alice-password-123", "alice-new-password-789");
  assert.equal(await store.authenticatedUser(aliceRequest), null, "old token survived password change");
  assert.equal(await store.login("alice", "alice-password-123"), null, "old password survived change");
  assert.ok(await store.login("alice", "alice-new-password-789"));

  const env: Env = { API_KEY: "", ACCOUNTS: store, ALLOW_REGISTRATION: "true" };
  const request = (path: string, init?: RequestInit) =>
    app.request(`https://example.test${path}`, init, env);
  const register = async (username: string, password: string) => {
    const response = await request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    return cookie;
  };

  const unauthenticatedStatus = await request("/api/auth/status");
  assert.equal(unauthenticatedStatus.status, 200);
  assert.equal((await unauthenticatedStatus.json() as { authenticated: boolean }).authenticated, false);

  const carolCookie = await register("carol", "carol-password-123");
  const daveCookie = await register("dave", "dave-password-456");
  const httpSessionId = "22222222-2222-4222-8222-222222222222";
  const saveResponse = await request(`/api/sessions/${httpSessionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie: carolCookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "Carol cloud chat" }], contextBreak: 0 }),
  });
  assert.equal(saveResponse.status, 200);

  const daveRead = await request(`/api/sessions/${httpSessionId}`, { headers: { cookie: daveCookie } });
  assert.equal(daveRead.status, 404, "another user read Carol's session");
  const carolRead = await request(`/api/sessions/${httpSessionId}`, { headers: { cookie: carolCookie } });
  assert.equal(carolRead.status, 200);
  const carolCloud = await carolRead.json() as { messages: Array<{ content: string }> };
  assert.equal(carolCloud.messages[0]?.content, "Carol cloud chat");
  const cloudIndex = await request("/api/sessions", { headers: { cookie: carolCookie } });
  assert.equal(cloudIndex.status, 200);
  assert.equal((await cloudIndex.json() as { sessions: unknown[] }).sessions.length, 1);

  const passwordResponse = await request("/api/auth/password", {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie: carolCookie },
    body: JSON.stringify({ currentPassword: "carol-password-123", newPassword: "carol-new-password-789" }),
  });
  assert.equal(passwordResponse.status, 200);
  const staleCookieResponse = await request("/api/sessions", { headers: { cookie: carolCookie } });
  assert.equal(staleCookieResponse.status, 401, "old HTTP login survived password change");

  console.log("accounts e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
