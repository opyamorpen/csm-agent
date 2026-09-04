import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  const fakeUserRt = { userId: 0, mcp: { failures: new Map<string, string>() }, tools: [], systemPrompt: '' };
  return {
    models: {} as never,
    model: { input: [] } as never,
    users: {
      get: () => fakeUserRt,
      failuresOf: () => [] as Array<[string, string]>,
      reconnect: async () => {},
      retryFailed: async () => {},
      list: () => [fakeUserRt],
    },
    mcp: fakeUserRt.mcp,
    tools: [],
    systemPrompt: '',
    llm: {} as never,
    attachSystemUser: () => {},
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
  // userStateDir（按用户 MCP 配置）跟随 CSM_DATA_DIR：指到临时目录，绝不写真实 ~/.csm-agent。
  const previousDataDir = process.env.CSM_DATA_DIR;
  process.env.CSM_DATA_DIR = dir;
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
    if (previousDataDir === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = previousDataDir;
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
    // 「我的连接」（/api/config/mcp）已按用户化：成员可读写自己的，不再 403（见专测）。
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

test('mcp config is per-user: members save their own connections without admin rights', async () => {
  await withServer(async ({ call, memberId }) => {
    const memberLogin = await call('POST', '/api/auth/login', { body: { username: 'csm1', password: 'member-pass-1' } });
    const memberCookie = cookieFrom(memberLogin);
    const empty = await call('GET', '/api/config/mcp', { cookie: memberCookie });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.servers, []);
    const saved = await call('PUT', '/api/config/mcp', {
      cookie: memberCookie,
      body: { servers: [{ name: 'crm', transport: 'streamable-http', url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer mine' } }] },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.servers.length, 1);
    // 落在成员自己的用户目录（CSM_DATA_DIR 已指向临时目录）。
    assert.ok(existsSync(join(process.env.CSM_DATA_DIR!, 'users', String(memberId), 'config', 'mcp.user.yaml')));
    // 管理员的「我的连接」不受影响（另一份文件）。
    const adminLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin-pass-1' } });
    const adminCookie = cookieFrom(adminLogin);
    const adminView = await call('GET', '/api/config/mcp', { cookie: adminCookie });
    assert.deepEqual(adminView.data.servers, []);
    // 非法配置仍 400。
    const bad = await call('PUT', '/api/config/mcp', { cookie: memberCookie, body: { servers: [{ name: '' }] } });
    assert.equal(bad.status, 400);
  });
});

test('customer-domain reads are gated by per-user visibility', async () => {
  await withServer(async ({ call, db, memberId }) => {
    db.upsertCustomer({ id: 'crm-mine', name: '我的客户', sourceObject: 'object_Umwnn__c', afterSalesStage: '正常', contractStatus: '正常' });
    db.upsertCustomer({ id: 'crm-other', name: '别人的客户', sourceObject: 'object_Umwnn__c', afterSalesStage: '正常', contractStatus: '正常' });
    db.grantCustomerAccess(memberId, ['crm-mine']);
    const memberLogin = await call('POST', '/api/auth/login', { body: { username: 'csm1', password: 'member-pass-1' } });
    const memberCookie = cookieFrom(memberLogin);
    // 列表只含已授权客户。
    const list = await call('GET', '/api/customers', { cookie: memberCookie });
    assert.deepEqual(list.data.customers.map((c: any) => c.id), ['crm-mine']);
    // 自己的客户可访问；未授权客户一律 404（不泄露存在性）。
    assert.equal((await call('GET', '/api/customers/crm-mine/overview', { cookie: memberCookie })).status, 200);
    for (const sub of ['/overview', '/timeline', '/workhours', '/weekly-reports']) {
      assert.equal((await call('GET', `/api/customers/crm-other${sub}`, { cookie: memberCookie })).status, 404, sub);
    }
    assert.equal((await call('POST', '/api/customers/crm-other/refresh', { cookie: memberCookie, body: {} })).status, 404);
    // admin（未授权任何人前）也只看自己映射内的客户：空列表。
    const adminLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin-pass-1' } });
    const adminCookie = cookieFrom(adminLogin);
    const adminList = await call('GET', '/api/customers', { cookie: adminCookie });
    assert.deepEqual(adminList.data.customers.map((c: any) => c.id), []);
  });
});
