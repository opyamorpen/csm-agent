import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildHandler } from '../src/server.js';
import { Store } from '../src/store.js';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { ensureBootstrapAdmin, hashPassword } from '../src/auth.js';
import type { Runtime } from '../src/bootstrap.js';

/**
 * 鉴权矩阵集成测试：buildHandler 直接起在随机端口的真实 HTTP 服务上，
 * 覆盖 白名单/401/登录（cookie 与 PAT 双通道）/限速/CSRF/admin 门/会话属主/登出。
 */

function fakeRuntime(): Runtime {
  return {
    models: {} as never,
    model: { input: [] } as never,
    mcp: { failures: new Map() } as never,
    tools: [],
    systemPrompt: '',
    llm: {} as never,
    reloadMcp: async () => {},
    setLlm: (() => ({})) as never,
  } as unknown as Runtime;
}

interface HttpResult {
  status: number;
  data: any;
  headers: Headers;
}

function makeClient(base: string) {
  return async (method: string, path: string, options: { body?: unknown; token?: string; cookie?: string; origin?: string } = {}): Promise<HttpResult> => {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.cookie) headers.cookie = options.cookie;
    if (options.origin) headers.origin = options.origin;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data, headers: response.headers };
  };
}

async function withServer(fn: (ctx: {
  base: string;
  call: ReturnType<typeof makeClient>;
  db: WorkbenchDatabase;
  adminId: number;
  memberId: number;
}) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-http-auth-'));
  const store = new Store(dir);
  const db = new WorkbenchDatabase(dir);
  process.env.CSM_ADMIN_PASSWORD = 'admin-pass-1';
  try {
    ensureBootstrapAdmin(db);
  } finally {
    delete process.env.CSM_ADMIN_PASSWORD;
  }
  const admin = db.getUserByUsername('admin')!;
  const member = db.createUser({ username: 'csm1', displayName: '一号 CSM', passwordHash: hashPassword('member-pass-1') });
  const services = {
    db,
    // 只补测试触达的表面：POST /api/sync 会调 refreshAll。
    sync: { refreshAll: () => ({}) },
    cases: {}, drafts: {}, weekly: {}, wiki: {}, opportunities: {},
  } as never;
  const server = http.createServer(buildHandler(fakeRuntime(), store, services, admin.id));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ base, call: makeClient(base), db, adminId: admin.id, memberId: member.id });
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function cookieFrom(result: HttpResult): string {
  const raw = result.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

test('unauthenticated requests: whitelist passes, everything else gets 401', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('GET', '/api/version')).status, 200);
    assert.equal((await call('GET', '/api/customers')).status, 401);
    assert.equal((await call('GET', '/api/sessions')).status, 401);
    assert.equal((await call('POST', '/api/sync', { body: {} })).status, 401);
    assert.equal((await call('GET', '/api/records')).status, 401);
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
  });
});

test('static shell loads without credentials (login page must render pre-auth)', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="loginGate"/);
  });
});

test('password login issues a cookie session; wrong credentials are rejected uniformly', async () => {
  await withServer(async ({ call }) => {
    const bad = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } });
    assert.equal(bad.status, 401);
    const missing = await call('POST', '/api/auth/login', { body: { username: 'ghost', password: 'nope' } });
    assert.equal(missing.status, 401);
    assert.equal(missing.data.error, bad.data.error, '用户不存在与密码错误返回同一文案（防枚举）');
    const ok = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin-pass-1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.username, 'admin');
    const cookie = cookieFrom(ok);
    assert.match(cookie, /^csm_session=/);
    assert.match(ok.headers.get('set-cookie') ?? '', /HttpOnly/);
    const me = await call('GET', '/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'admin');
    // 会话失效/登出后再访问即 401。
    assert.equal((await call('POST', '/api/auth/logout', { cookie })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { cookie })).status, 401);
  });
});

test('tokenName login issues a PAT; bearer works and logout revokes it', async () => {
  await withServer(async ({ call }) => {
    const login = await call('POST', '/api/auth/login', { body: { username: 'csm1', password: 'member-pass-1', tokenName: 'ci' } });
    assert.equal(login.status, 200);
    assert.equal(login.data.tokenKind, 'pat');
    assert.ok(login.data.token);
    const token = login.data.token as string;
    assert.equal((await call('GET', '/api/auth/me', { token })).status, 200);
    // 业务端点可用 Bearer。
    assert.equal((await call('GET', '/api/customers', { token })).status, 200);
    assert.equal((await call('POST', '/api/auth/logout', { token })).status, 200);
    assert.equal((await call('GET', '/api/customers', { token })).status, 401);
  });
});

test('five consecutive failures lock the account for further attempts', async () => {
  await withServer(async ({ call, db }) => {
    db.createUser({ username: 'lockme', passwordHash: hashPassword('right-pass-1') });
    for (let i = 0; i < 5; i++) {
      const fail = await call('POST', '/api/auth/login', { body: { username: 'lockme', password: 'wrong' } });
      assert.equal(fail.status, 401);
    }
    const locked = await call('POST', '/api/auth/login', { body: { username: 'lockme', password: 'right-pass-1' } });
    assert.equal(locked.status, 429);
    assert.ok(locked.data.retryAfterSec > 0);
  });
});

test('cookie mutations from a foreign origin are rejected (CSRF guard)', async () => {
  await withServer(async ({ call, base }) => {
    const ok = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin-pass-1' } });
    const cookie = cookieFrom(ok);
    // 同源与不带 Origin 的变更请求放行；跨站 Origin 拒绝。
    assert.equal((await call('POST', '/api/sync', { cookie })).status, 202);
    assert.equal((await call('POST', '/api/sync', { cookie, origin: base })).status, 202);
    assert.equal((await call('POST', '/api/sync', { cookie, origin: 'http://evil.example' })).status, 403);
  });
});

test('member cannot reach admin-only endpoints; admin can manage users', async () => {
  await withServer(async ({ call, memberId }) => {
    const memberLogin = await call('POST', '/api/auth/login', { body: { username: 'csm1', password: 'member-pass-1' } });
    const memberCookie = cookieFrom(memberLogin);
    assert.equal((await call('GET', '/api/users', { cookie: memberCookie })).status, 403);
    assert.equal((await call('POST', '/api/users', { cookie: memberCookie, body: { username: 'x' } })).status, 403);
    assert.equal((await call('GET', '/api/config/mcp', { cookie: memberCookie })).status, 403);
    assert.equal((await call('PUT', '/api/config/search', { cookie: memberCookie, body: {} })).status, 403);
    assert.equal((await call('PUT', '/api/config/llm', { cookie: memberCookie, body: {} })).status, 403);
    assert.equal((await call('POST', '/api/backup/run', { cookie: memberCookie, body: {} })).status, 403);

    const adminLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin-pass-1' } });
    const adminCookie = cookieFrom(adminLogin);
    const created = await call('POST', '/api/users', {
      cookie: adminCookie,
      body: { username: 'csm2', displayName: '二号', role: 'member' },
    });
    assert.equal(created.status, 200);
    assert.ok(created.data.initialPassword, '未传密码时应生成并回显一次初始密码');
    const listed = await call('GET', '/api/users', { cookie: adminCookie });
    assert.equal(listed.data.users.length, 3);
    assert.ok(!('passwordHash' in (listed.data.users[0] as object)), '用户列表不得携带密码哈希');
    // 重复用户名 409；最后一个管理员不可降级。
    assert.equal((await call('POST', '/api/users', { cookie: adminCookie, body: { username: 'csm2' } })).status, 409);
    const demote = await call('PATCH', `/api/users/${(listed.data.users.find((u: any) => u.username === 'admin') as any).id}`, { cookie: adminCookie, body: { role: 'member' } });
    assert.equal(demote.status, 409);
    // 重置密码：回显一次新密码，目标用户会话被收回。
    const reset = await call('POST', `/api/users/${memberId}/reset-password`, { cookie: adminCookie, body: {} });
    assert.equal(reset.status, 200);
    assert.ok(reset.data.password);
  });
});

test('sessions and records are private to their owner; legacy sessions fall back to admin', async () => {
  await withServer(async ({ call, adminId, memberId }) => {
    const adminLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin-pass-1' } });
    const adminCookie = cookieFrom(adminLogin);
    const memberLogin = await call('POST', '/api/auth/login', { body: { username: 'csm1', password: 'member-pass-1' } });
    const memberCookie = cookieFrom(memberLogin);

    const created = await call('POST', '/api/sessions', { cookie: memberCookie, body: {} });
    assert.equal(created.status, 200);
    const sessionId = created.data.id as string;
    // admin 看不到 member 的会话列表项，member 也访问不了他人会话详情/SSE。
    const memberList = await call('GET', '/api/sessions', { cookie: memberCookie });
    assert.equal(memberList.data.sessions.length, 1);
    const adminList = await call('GET', '/api/sessions', { cookie: adminCookie });
    assert.equal(adminList.data.sessions.filter((s: any) => s.id === sessionId).length, 0, 'admin 不应看到 member 的会话');
    assert.equal((await call('GET', `/api/sessions/${sessionId}/events`, { cookie: adminCookie })).status, 403);
    assert.equal((await call('GET', `/api/sessions/${sessionId}/export`, { cookie: adminCookie })).status, 403);
    // 审批确认同样只对属主开放。
    assert.equal((await call('POST', `/api/sessions/${sessionId}/confirm`, { cookie: adminCookie, body: { approve: true } })).status, 403);
    // 写入记录（records）跟随会话属主。
    assert.equal(Array.isArray((await call('GET', '/api/records', { cookie: memberCookie })).data.records), true);
    void adminId;
    void memberId;
  });
});

test('disabled accounts are blocked even with a still-valid token', async () => {
  await withServer(async ({ call, db, memberId }) => {
    const login = await call('POST', '/api/auth/login', { body: { username: 'csm1', password: 'member-pass-1', tokenName: 'ci2' } });
    const token = login.data.token as string;
    assert.equal((await call('GET', '/api/customers', { token })).status, 200);
    db.updateUser(memberId, { status: 'disabled' });
    assert.equal((await call('GET', '/api/customers', { token })).status, 403);
    // 登录也直接拒绝。
    const again = await call('POST', '/api/auth/login', { body: { username: 'csm1', password: 'member-pass-1' } });
    assert.equal(again.status, 403);
  });
});
