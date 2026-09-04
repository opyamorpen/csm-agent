import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildHandler, importLegacyCustomerIdentities, resolveMergeCustomer } from '../src/server.js';
import { Store } from '../src/store.js';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { ensureBootstrapAdmin, hashPassword } from '../src/auth.js';
import type { Runtime } from '../src/bootstrap.js';

/**
 * 客户合并（重复/幽灵客户修复）：mergeCustomers 事务迁移 + POST /api/customers/merge
 * 鉴权/解析契约 + 启动 legacy 导入的 id 防护（错误文案当 customer_id 生成幽灵客户的根因回归）。
 */

const GHOST_NAME = '西安诺瓦星云科技股份有限公司';
const GHOST_ID = '未提供（CRM 查询接口报 NO_LICENSE_QUOTE_ERROR 授权错误，未能取得 CRM _id；ONES 侧归属已用客户信息字段 JrvswW8P=7A6ZJrgU 精确绑定）';
const REAL_ID = '66b58e2aabdbe10001971fec';

function withDb(fn: (db: WorkbenchDatabase) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-customer-merge-'));
  const db = new WorkbenchDatabase(dir);
  return Promise.resolve(fn(db)).finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function seedNovaPair(db: WorkbenchDatabase): void {
  db.upsertCustomer({ id: REAL_ID, name: GHOST_NAME, sourceObject: 'object_Umwnn__c', afterSalesStage: '续约期', contractStatus: '正常' });
  db.upsertCustomer({ id: GHOST_ID, name: GHOST_NAME, sourceObject: 'object_Umwnn__c', industry: '智能硬件' });
}

test('mergeCustomers: 迁移挂载数据、唯一键去重、1:1 表丢弃、NULL 回填、审计落库', () => {
  withDb((db) => {
    seedNovaPair(db);
    db.upsertSourceEvent({ customerId: GHOST_ID, sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 'ones-1', title: '工单', occurredAt: '2026-09-01T00:00:00Z' });
    // 同自然键证据两侧各一条：迁移时幽灵侧应被去重丢弃（into 侧为准）
    db.addEvidence({ customerId: REAL_ID, kind: 'risk', label: '阻塞', detail: '真行', occurredAt: '2026-09-01T00:00:00Z', confidence: 0.8, sourceSystem: 'ones', sourceUrl: 'https://example.com/a' });
    db.addEvidence({ customerId: GHOST_ID, kind: 'risk', label: '阻塞', detail: '幽灵', occurredAt: '2026-09-01T00:00:00Z', confidence: 0.8, sourceSystem: 'ones', sourceUrl: 'https://example.com/a' });
    // 非冲突证据一条：应成功改挂
    db.addEvidence({ customerId: GHOST_ID, kind: 'fact', label: '事实', detail: 'x', occurredAt: '2026-09-02T00:00:00Z', confidence: 0.9, sourceSystem: 'ones', sourceUrl: 'https://example.com/b' });
    // 幽灵行独享可见性授权：应改挂到真行
    db.createUser({ username: 'u1', passwordHash: 'x' });
    const u1 = db.getUserByUsername('u1')!.id;
    db.grantCustomerAccess(u1, [GHOST_ID]);
    // 1:1 表两侧都有行：from 侧丢弃、into 侧保留
    db.setCaseCandidate(REAL_ID, true, 'eligible', [], 0.9);
    db.setCaseCandidate(GHOST_ID, false, 'not eligible', [], 0.5);

    const result = db.mergeCustomers(GHOST_ID, REAL_ID, 'tester', u1);

    assert.equal(db.getCustomer(GHOST_ID), undefined, '幽灵行应被删除');
    assert.equal(db.getCustomer(REAL_ID)?.industry, '智能硬件', 'into 行 NULL 字段应被回填');
    assert.ok(result.fieldsFilled.includes('industry'));
    assert.equal(result.tables.source_events?.moved, 1);
    assert.equal(result.tables.evidence?.moved, 1);
    assert.equal(result.tables.evidence?.dropped, 1, '同自然键证据应去重丢弃幽灵侧');
    assert.equal(result.tables.user_customer_access?.moved, 1);
    assert.ok(db.customerAccessExists(u1, REAL_ID), '授权应改挂到保留行');
    const candidates = (db as any).db.prepare('SELECT customer_id, eligible FROM case_candidates').all() as any[];
    assert.equal(candidates.length, 1, '1:1 表应只留 into 侧行');
    assert.equal(candidates[0]!.customer_id, REAL_ID);
    assert.equal(candidates[0]!.eligible, 1);
    const evidenceRows = (db as any).db.prepare('SELECT customer_id, label FROM evidence').all() as any[];
    assert.deepEqual(evidenceRows.map((row) => row.label).sort(), ['事实', '阻塞'], '非冲突证据应改挂、冲突行只留 into 侧');
    assert.ok(evidenceRows.every((row) => row.customer_id === REAL_ID));
    const auditRow = (db as any).db.prepare("SELECT entity_id, details_json FROM audit_log WHERE action='customers_merge'").get() as any;
    assert.equal(auditRow.entity_id, REAL_ID);
    assert.ok(auditRow.details_json.includes(GHOST_ID), '审计应记录被合并的 from 行');

    // from === into 与不存在的客户直接拒绝
    assert.throws(() => db.mergeCustomers(REAL_ID, REAL_ID), /同一客户/);
    assert.throws(() => db.mergeCustomers('missing-id', REAL_ID), /不存在/);
  });
});

test('mergeCustomers: 事务回滚不留半程状态', () => {
  withDb((db) => {
    seedNovaPair(db);
    // 用触发器让 evidence 的 UPDATE 必然失败，验证 ROLLBACK 后幽灵行及其数据原样保留。
    (db as any).db.exec('CREATE TRIGGER boom BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, \'boom\'); END');
    db.addEvidence({ customerId: GHOST_ID, kind: 'fact', label: 'x', detail: 'x', occurredAt: '2026-09-02T00:00:00Z', confidence: 1, sourceSystem: 'ones', sourceUrl: 'https://example.com/c' });
    assert.throws(() => db.mergeCustomers(GHOST_ID, REAL_ID), /boom/);
    assert.ok(db.getCustomer(GHOST_ID), '回滚后幽灵行应仍在');
    const evidenceCount = (db as any).db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE customer_id=?').get(GHOST_ID).n;
    assert.equal(evidenceCount, 1, '回滚后幽灵行证据应原样保留');
  });
});

test('resolveMergeCustomer: id 直取（含幽灵行）、精确名唯一、同名歧义带候选', () => {
  withDb((db) => {
    seedNovaPair(db);
    assert.equal(resolveMergeCustomer(db, GHOST_ID).id, GHOST_ID, '长错误文案 id 也要能按 id 直取');
    db.upsertCustomer({ id: '66827e032ee9b900010c8c8b', name: 'BG SG Holdings Ltd.', sourceObject: 'object_Umwnn__c' });
    assert.equal(resolveMergeCustomer(db, 'BG SG Holdings Ltd.').id, '66827e032ee9b900010c8c8b', '唯一精确名可解析');
    assert.throws(() => resolveMergeCustomer(db, GHOST_NAME), new RegExp(REAL_ID), '同名双行必须报错并带 id 候选');
    assert.throws(() => resolveMergeCustomer(db, GHOST_NAME), new RegExp(GHOST_ID.slice(0, 12)));
    assert.throws(() => resolveMergeCustomer(db, '不存在有限公司'), /未找到/);
  });
});

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

async function withServer(fn: (ctx: { base: string; adminToken: string; memberToken: string; db: WorkbenchDatabase }) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-merge-api-'));
  const store = new Store(dir);
  const db = new WorkbenchDatabase(dir);
  const previousDataDir = process.env.CSM_DATA_DIR;
  process.env.CSM_DATA_DIR = dir;
  process.env.CSM_ADMIN_PASSWORD = 'admin-pass-1';
  try {
    ensureBootstrapAdmin(db);
  } finally {
    delete process.env.CSM_ADMIN_PASSWORD;
  }
  db.createUser({ username: 'csm1', displayName: '一号 CSM', passwordHash: hashPassword('member-pass-1') });
  const services = { db, sync: { refreshAll: () => ({}) }, cases: {}, drafts: {}, weekly: {}, wiki: {}, opportunities: {} } as never;
  const server = http.createServer(buildHandler(fakeRuntime(), store, services, db.getUserByUsername('admin')!.id));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string): Promise<string> => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, tokenName: 'merge-test' }),
    });
    const body: any = await response.json().catch(() => ({}));
    assert.equal(response.status, 200, `登录失败: ${JSON.stringify(body)}`);
    return body.token as string;
  };
  const adminToken = await login('admin', 'admin-pass-1');
  const memberToken = await login('csm1', 'member-pass-1');
  try {
    await fn({ base, adminToken, memberToken, db });
  } finally {
    server.close();
    db.close();
    if (previousDataDir === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('POST /api/customers/merge: member 403、同名歧义 400 带候选、admin 合并成功', async () => {
  await withServer(async ({ adminToken, memberToken, db, base }) => {
    seedNovaPair(db);
    db.upsertSourceEvent({ customerId: GHOST_ID, sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 'ones-1', title: '工单', occurredAt: '2026-09-01T00:00:00Z' });
    const call = async (token: string, body: unknown) => {
      const response = await fetch(`${base}/api/customers/merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json().catch(() => ({})) };
    };
    // member 被管理员门拦下
    const forbidden = await call(memberToken, { from: GHOST_ID, into: REAL_ID });
    assert.equal(forbidden.status, 403);
    // 同名双行按名称解析必须 400 并给出 id 候选
    const ambiguous = await call(adminToken, { from: GHOST_NAME, into: REAL_ID });
    assert.equal(ambiguous.status, 400);
    assert.ok(ambiguous.data.error.includes(REAL_ID) && ambiguous.data.error.includes('未提供'), ambiguous.data.error);
    // 缺参
    const missing = await call(adminToken, { into: REAL_ID });
    assert.equal(missing.status, 400);
    // admin 按 id 合并成功，返回逐表计数
    const ok = await call(adminToken, { from: GHOST_ID, into: REAL_ID });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.removed.id, GHOST_ID);
    assert.equal(ok.data.merged.id, REAL_ID);
    assert.equal(ok.data.tables.source_events.moved, 1);
    assert.equal(db.getCustomer(GHOST_ID), undefined);
    // 合并后同名重复消失
    assert.equal(db.listCustomersByExactName(GHOST_NAME).length, 1);
    // 再合并不存在的客户 → 400（解析层报「未找到」）
    const gone = await call(adminToken, { from: GHOST_ID, into: REAL_ID });
    assert.equal(gone.status, 400);
    assert.ok(String(gone.data.error).includes('未找到'));
  });
});

test('importLegacyCustomerIdentities: 非 ObjectId 跳过、已存在不覆盖、合法缺失补建', () => {
  withDb((db) => {
    const existingId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    db.upsertCustomer({ id: existingId, name: '存量客户', sourceObject: 'object_Umwnn__c', source: { real: 1 } });
    const outcome = importLegacyCustomerIdentities(db, [
      // 历史事故形态：CRM 查错说明文案被当成 customer_id 写入 records.json
      { id: 'rec-1', customer: '诺瓦星云', fields: { customer_id: GHOST_ID, customer_name: GHOST_NAME } },
      // 合法 ObjectId 且库内缺失：补建
      { id: 'rec-2', fields: { customer_id: 'bbbbbbbbbbbbbbbbbbbbbbbb', customer_name: '新客户有限公司' } },
      // 库内已存在：不覆盖（名称与 source_json 都不动）
      { id: 'rec-3', fields: { customer_id: existingId, customer_name: '改名尝试' } },
      // 缺 id / 缺名：跳过
      { id: 'rec-4', fields: { customer_name: '没有 id 的记录' } },
    ]);
    assert.equal(outcome.imported, 1);
    assert.equal(outcome.skipped, 3);
    assert.equal(db.getCustomer(GHOST_ID), undefined, '错误文案 id 不得再生成幽灵客户');
    assert.equal(db.getCustomer('bbbbbbbbbbbbbbbbbbbbbbbb')?.name, '新客户有限公司');
    assert.equal(db.getCustomer(existingId)?.name, '存量客户', '已存在客户的名称不被覆盖');
    assert.deepEqual(db.getCustomer(existingId)?.source, { real: 1 }, '已存在客户的 source_json 不被 legacyRecordId 污染');
  });
});
