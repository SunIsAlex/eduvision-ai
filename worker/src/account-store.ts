import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTH_COOKIE, authCookie, readCookie } from "./auth";

function derivePassword(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}
const ACCOUNT_FILE_VERSION = 1;
const SESSION_TOKEN_VERSION = 1;
const SESSION_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_SESSIONS = 50;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AccountRecord {
  id: string;
  username: string;
  usernameKey: string;
  passwordHash: string;
  passwordVersion: number;
  createdAt: string;
}

interface AccountFile {
  version: number;
  users: AccountRecord[];
}

interface SessionTokenPayload {
  v: number;
  sub: string;
  pv: number;
  exp: number;
}

export interface AccountUser {
  id: string;
  username: string;
}

export interface StoredSession {
  messages: unknown[];
  contextBreak: number;
  title: string;
  titleGenerated: boolean;
  updatedAt: string;
}

export interface StoredSessionMeta {
  id: string;
  title: string;
  titleGenerated: boolean;
  updatedAt: string;
}

export class AccountStoreError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function normalizeUsername(value: string): { username: string; key: string } {
  const username = value.trim().normalize("NFKC");
  const length = [...username].length;
  if (length < 2 || length > 32) {
    throw new AccountStoreError(400, "用户名长度应为 2–32 个字符");
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(username)) {
    throw new AccountStoreError(400, "用户名只能包含文字、数字、点、横线和下划线");
  }
  return { username, key: username.toLocaleLowerCase("en-US") };
}

function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 128) {
    throw new AccountStoreError(400, "密码长度应为 8–128 个字符");
  }
}

async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const cost = 16_384;
  const blockSize = 8;
  const parallelization = 1;
  const derived = (await derivePassword(password, salt, 32, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;
  return [
    "scrypt",
    cost,
    blockSize,
    parallelization,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, rawCost, rawBlockSize, rawParallelization, rawSalt, rawHash] = encoded.split("$");
  if (
    algorithm !== "scrypt" || !rawCost || !rawBlockSize || !rawParallelization || !rawSalt || !rawHash
  ) return false;
  if (Number(rawCost) !== 16_384 || Number(rawBlockSize) !== 8 || Number(rawParallelization) !== 1) return false;
  const expected = Buffer.from(rawHash, "base64url");
  if (expected.length !== 32) return false;
  try {
    const derived = (await derivePassword(password, Buffer.from(rawSalt, "base64url"), expected.length, {
      N: Number(rawCost),
      r: Number(rawBlockSize),
      p: Number(rawParallelization),
      maxmem: 64 * 1024 * 1024,
    })) as Buffer;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function fallbackTitle(messages: unknown[]): string {
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as { role?: unknown; content?: unknown; image?: unknown };
    if (message.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim().replace(/\s+/g, " ").slice(0, 28);
    }
    if (typeof message.image === "string") return "图片题目";
  }
  return "新对话";
}

function normalizeStoredSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<StoredSession>;
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length > 100) return null;
  const contextBreak =
    typeof snapshot.contextBreak === "number" && Number.isFinite(snapshot.contextBreak)
      ? Math.min(snapshot.messages.length, Math.max(0, Math.floor(snapshot.contextBreak)))
      : 0;
  return {
    messages: snapshot.messages,
    contextBreak,
    title:
      typeof snapshot.title === "string" && snapshot.title.trim()
        ? snapshot.title.trim().slice(0, 80)
        : fallbackTitle(snapshot.messages),
    titleGenerated: snapshot.titleGenerated === true,
    updatedAt:
      typeof snapshot.updatedAt === "string" && !Number.isNaN(Date.parse(snapshot.updatedAt))
        ? snapshot.updatedAt
        : new Date().toISOString(),
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export class AccountStore {
  private accounts: AccountRecord[] = [];
  private mutation: Promise<void> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly tokenSecret: Buffer,
    private readonly legacySessionRoot?: string
  ) {}

  static async open(options: { root: string; tokenSecret?: string; legacySessionRoot?: string }): Promise<AccountStore> {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const secretPath = join(options.root, ".auth-secret");
    let tokenSecret: Buffer;
    if (options.tokenSecret?.trim()) {
      tokenSecret = Buffer.from(options.tokenSecret.trim(), "utf8");
      if (tokenSecret.length < 32) throw new Error("AUTH_SESSION_SECRET must contain at least 32 bytes");
    } else {
      try {
        tokenSecret = Buffer.from((await readFile(secretPath, "utf8")).trim(), "base64url");
        if (tokenSecret.length < 32) throw new Error("secret too short");
      } catch {
        tokenSecret = randomBytes(48);
        const temporaryPath = `${secretPath}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporaryPath, tokenSecret.toString("base64url"), { mode: 0o600 });
        await rename(temporaryPath, secretPath);
      }
    }
    const store = new AccountStore(options.root, tokenSecret, options.legacySessionRoot);
    await store.loadAccounts();
    return store;
  }

  get userCount(): number {
    return this.accounts.length;
  }

  private get accountPath(): string {
    return join(this.root, "accounts.json");
  }

  private sessionsRoot(userId: string): string {
    return join(this.root, "users", userId, "sessions");
  }

  private sessionPath(userId: string, sessionId: string): string {
    return join(this.sessionsRoot(userId), `${sessionId}.json`);
  }

  private async loadAccounts(): Promise<void> {
    try {
      const value = (await readJson(this.accountPath)) as Partial<AccountFile>;
      if (value.version !== ACCOUNT_FILE_VERSION || !Array.isArray(value.users)) {
        throw new Error("unsupported account file");
      }
      this.accounts = value.users.filter(
        (record): record is AccountRecord =>
          Boolean(record) && typeof record.id === "string" && typeof record.username === "string" &&
          typeof record.usernameKey === "string" && typeof record.passwordHash === "string" &&
          typeof record.passwordVersion === "number"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeAccounts();
    }
  }

  private async writeAccounts(): Promise<void> {
    const temporaryPath = `${this.accountPath}.${crypto.randomUUID()}.tmp`;
    const value: AccountFile = { version: ACCOUNT_FILE_VERSION, users: this.accounts };
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.accountPath);
  }

  private async mutate<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release: () => void = () => undefined;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private publicUser(account: AccountRecord): AccountUser {
    return { id: account.id, username: account.username };
  }

  async register(usernameValue: string, password: string): Promise<{ user: AccountUser; token: string }> {
    const { username, key } = normalizeUsername(usernameValue);
    validatePassword(password);
    return this.mutate(async () => {
      if (this.accounts.some((account) => account.usernameKey === key)) {
        throw new AccountStoreError(409, "该用户名已被使用");
      }
      const record: AccountRecord = {
        id: crypto.randomUUID(),
        username,
        usernameKey: key,
        passwordHash: await hashPassword(password),
        passwordVersion: 1,
        createdAt: new Date().toISOString(),
      };
      await mkdir(this.sessionsRoot(record.id), { recursive: true, mode: 0o700 });
      this.accounts.push(record);
      await this.writeAccounts();
      return { user: this.publicUser(record), token: this.createToken(record) };
    });
  }

  async login(usernameValue: string, password: string): Promise<{ user: AccountUser; token: string } | null> {
    let key: string;
    try {
      key = normalizeUsername(usernameValue).key;
    } catch {
      await hashPassword(password.slice(0, 128).padEnd(8, "0"));
      return null;
    }
    const account = this.accounts.find((candidate) => candidate.usernameKey === key);
    if (!account) {
      await hashPassword(password.slice(0, 128).padEnd(8, "0"));
      return null;
    }
    if (!(await verifyPassword(password, account.passwordHash))) return null;
    return { user: this.publicUser(account), token: this.createToken(account) };
  }

  async changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<string> {
    validatePassword(nextPassword);
    return this.mutate(async () => {
      const account = this.accounts.find((candidate) => candidate.id === userId);
      if (!account || !(await verifyPassword(currentPassword, account.passwordHash))) {
        throw new AccountStoreError(401, "当前密码错误");
      }
      account.passwordHash = await hashPassword(nextPassword);
      account.passwordVersion += 1;
      await this.writeAccounts();
      return this.createToken(account);
    });
  }

  private createToken(account: AccountRecord): string {
    const payload: SessionTokenPayload = {
      v: SESSION_TOKEN_VERSION,
      sub: account.id,
      pv: account.passwordVersion,
      exp: Math.floor(Date.now() / 1000) + SESSION_TOKEN_TTL_SECONDS,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.tokenSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  async authenticatedUser(request: Request): Promise<AccountUser | null> {
    const token = readCookie(request, AUTH_COOKIE);
    if (!token) return null;
    const separator = token.lastIndexOf(".");
    if (separator < 1) return null;
    const encoded = token.slice(0, separator);
    const suppliedSignature = Buffer.from(token.slice(separator + 1), "base64url");
    const expectedSignature = createHmac("sha256", this.tokenSecret).update(encoded).digest();
    if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
      return null;
    }
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionTokenPayload;
      if (payload.v !== SESSION_TOKEN_VERSION || typeof payload.sub !== "string" ||
          typeof payload.pv !== "number" || typeof payload.exp !== "number" ||
          payload.exp <= Math.floor(Date.now() / 1000)) return null;
      const account = this.accounts.find(
        (candidate) => candidate.id === payload.sub && candidate.passwordVersion === payload.pv
      );
      return account ? this.publicUser(account) : null;
    } catch {
      return null;
    }
  }

  cookieFor(token: string, request: Request): string {
    return authCookie(token, request, SESSION_TOKEN_TTL_SECONDS);
  }

  logoutCookie(request: Request): string {
    return authCookie("", request, 0);
  }

  async listSessions(userId: string): Promise<StoredSessionMeta[]> {
    const root = this.sessionsRoot(userId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await readdir(root, { withFileTypes: true });
    const sessions = await Promise.all(entries
      .filter((entry) => entry.isFile() && SESSION_ID_RE.test(entry.name.replace(/\.json$/, "")))
      .map(async (entry): Promise<StoredSessionMeta | null> => {
        const id = entry.name.replace(/\.json$/, "");
        try {
          const snapshot = normalizeStoredSession(await readJson(join(root, entry.name)));
          return snapshot ? { id, title: snapshot.title, titleGenerated: snapshot.titleGenerated, updatedAt: snapshot.updatedAt } : null;
        } catch {
          return null;
        }
      }));
    return sessions.filter((value): value is StoredSessionMeta => value !== null)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, MAX_SESSIONS);
  }

  async getSession(userId: string, sessionId: string): Promise<StoredSession | null> {
    this.assertSessionId(sessionId);
    const destination = this.sessionPath(userId, sessionId);
    try {
      return normalizeStoredSession(await readJson(destination));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.legacySessionRoot) return null;
    try {
      const imported = normalizeStoredSession(await readJson(join(this.legacySessionRoot, `${sessionId}.json`)));
      if (!imported) return null;
      await this.writeSession(userId, sessionId, imported);
      return imported;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async saveSession(
    userId: string,
    sessionId: string,
    value: { messages?: unknown; contextBreak?: unknown; title?: unknown; titleGenerated?: unknown }
  ): Promise<void> {
    this.assertSessionId(sessionId);
    if (!Array.isArray(value.messages) || value.messages.length > 100) {
      throw new AccountStoreError(400, "会话消息格式不合法");
    }
    const prior = await this.getSession(userId, sessionId);
    const suppliedTitle = typeof value.title === "string" ? value.title.trim().slice(0, 80) : "";
    const snapshot: StoredSession = {
      messages: value.messages,
      contextBreak:
        typeof value.contextBreak === "number" && Number.isFinite(value.contextBreak)
          ? Math.min(value.messages.length, Math.max(0, Math.floor(value.contextBreak)))
          : 0,
      title: suppliedTitle || prior?.title || fallbackTitle(value.messages),
      titleGenerated: value.titleGenerated === true || prior?.titleGenerated === true,
      updatedAt: new Date().toISOString(),
    };
    await this.writeSession(userId, sessionId, snapshot);
    await this.pruneSessions(userId);
  }

  async deleteSession(userId: string, sessionId: string): Promise<void> {
    this.assertSessionId(sessionId);
    try {
      await unlink(this.sessionPath(userId, sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!SESSION_ID_RE.test(sessionId)) throw new AccountStoreError(400, "会话 ID 无效");
  }

  private async writeSession(userId: string, sessionId: string, snapshot: StoredSession): Promise<void> {
    const root = this.sessionsRoot(userId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = this.sessionPath(userId, sessionId);
    const temporaryPath = join(root, `.${sessionId}.${crypto.randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(temporaryPath, destination);
  }

  private async pruneSessions(userId: string): Promise<void> {
    const sessions = await this.listSessions(userId);
    if (sessions.length < MAX_SESSIONS) return;
    const root = this.sessionsRoot(userId);
    const allEntries = await readdir(root, { withFileTypes: true });
    const keep = new Set(sessions.map((session) => session.id));
    await Promise.all(allEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .filter((id) => SESSION_ID_RE.test(id) && !keep.has(id))
      .map((id) => unlink(join(root, `${id}.json`)).catch(() => undefined)));
  }
}
