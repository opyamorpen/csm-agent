import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { buildHandler } from '../src/server.js';
import { Store } from '../src/store.js';
import { ensureBootstrapAdmin, hashPassword } from '../src/auth.js';
import { assessRisk } from '../src/workbench/risk.js';
import {
  mentionsCustomer,
  parseWebIntelFindings,
  reclassifyWebIntelSentiment,
  WEB_INTEL_ANGLES,
  WEB_INTEL_REFRESH_DAYS,
  WebIntelService,
} from '../src/workbench/webintel.js';
import type { HttpPost } from '../src/tools/websearch.js';
import type { Runtime } from '../src/bootstrap.js';
import type { Customer } from '../src/workbench/types.js';

async function withDb(fn: (db: WorkbenchDatabase) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-webintel-'));
  const db = new WorkbenchDatabase(dir);
  try { await fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

/** keyed Tavily stub：每个角度都回一条命中客户名的新闻 + 一条同名公司噪音。 */
function tavilyStub(customerName: string): HttpPost {
  return async (url) => {
    void url;
    return JSON.stringify({
      results: [
        { title: `${customerName}完成 B 轮融资`, url: 'https://news.example.com/funding', published_date: '2026-08-01', content: `${customerName} 融资 2 亿元` },
        { title: `${customerName}（美国同名公司）裁员`, url: 'https://news.example.com/other', published_date: '2026-08-01', content: 'Another company with same name' },
      ],
    });
  };
}

function fakeRuntime(findings: unknown, calls: { count: number } = { count: 0 }): Runtime {
  return {
    models: {
      complete: async () => {
        calls.count += 1;
        return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ findings }) }] };
      },
    } as never,
    model: {} as never,
    mcp: {} as never,
    systemPrompt: '',
    llm: { provider: 'fake', model: 'classifier' } as never,
    tools: [],
    reloadMcp: async () => {},
    setLlm: () => ({}) as never,
  };
}

test('webintel: 8 angles match the csm-web-intelligence skill dimensions', () => {
  const keys = WEB_INTEL_ANGLES.map((angle) => angle.key);
  assert.deepEqual(keys, ['financing', 'contract', 'product', 'executive', 'org', 'sentiment', 'hiring', 'policy']);
});

test('webintel: mentionsCustomer filters same-name noise by name match', () => {
  const hit = { title: '诺瓦星云完成 B 轮融资', url: 'https://x.example.com/1', content: '西安诺瓦星云科技股份有限公司 融资' };
  const miss = { title: '诺瓦星云（美国）裁员', url: 'https://x.example.com/2', content: 'A different company' };
  assert.equal(mentionsCustomer(hit, ['西安诺瓦星云科技股份有限公司', '诺瓦星云']), true);
  assert.equal(mentionsCustomer(miss, ['西安诺瓦星云科技股份有限公司']), false, '全称简称都不在标题/摘要里 → 预过滤剔除');
});

test('webintel: parseWebIntelFindings drops entries without url/date, clamps category, validates sentiment', () => {
  const text = JSON.stringify({
    findings: [
      { label: '完成融资', detail: 'B 轮 2 亿', occurred_at: '2026-08-01', source_url: 'https://news.example.com/1', category: 'financing', sentiment: 'positive' },
      { label: '无来源', occurred_at: '2026-08-01', source_url: '', category: 'product' },
      { label: '无日期', occurred_at: '', source_url: 'https://news.example.com/2', category: 'org' },
      { label: '日期带时间', occurred_at: '2026-08-01T10:00:00Z', source_url: 'https://news.example.com/3', category: 'unknown-category' },
      { label: '情感非法', detail: '组织调整', occurred_at: '2026-08-02', source_url: 'https://news.example.com/4', category: 'org', sentiment: 'bad' },
      { label: '情感缺省', detail: '例行披露', occurred_at: '2026-08-02', source_url: 'https://news.example.com/5', category: 'org' },
    ],
  });
  const findings = parseWebIntelFindings(text);
  assert.equal(findings.length, 4);
  assert.equal(findings[0].category, 'financing');
  assert.equal(findings[0].sentiment, 'positive');
  assert.equal(findings[1].occurred_at, '2026-08-01', '日期截断为 YYYY-MM-DD');
  assert.equal(findings[1].category, 'other', '未知 category 收敛为 other');
  assert.equal(findings[1].sentiment, null);
  assert.equal(findings[2].category, 'org', '情感非法条目的 category 保留');
  assert.equal(findings[2].sentiment, null, '非法 sentiment 归 null（读取端走关键词兜底）');
  assert.equal(findings[3].sentiment, null, '缺省 sentiment 为 null');
  assert.deepEqual(parseWebIntelFindings('模型没有返回 JSON'), []);
  assert.deepEqual(parseWebIntelFindings('{"not_findings": []}'), []);
});

test('webintel: refresh searches all angles, persists only model-validated findings, records sync run', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-wi', name: '西安诺瓦星云科技股份有限公司', shortName: '诺瓦星云' });
  const calls = { count: 0 };
  const service = new WebIntelService(db, fakeRuntime([
    { label: '完成 B 轮融资', detail: '融资 2 亿元', occurred_at: '2026-08-01', source_url: 'https://news.example.com/funding', category: 'financing' },
    { label: '同名公司裁员（应被模型剔除）', occurred_at: '2026-08-01', source_url: 'https://news.example.com/other', category: 'org' },
  ], calls), {
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    getKeylessEnabled: () => true,
    fetcher: tavilyStub('诺瓦星云'),
  });
  const customer = db.getCustomer('crm-wi') as Customer;
  const result = await service.refresh(customer, { force: true });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.searched, 8, '8 个角度各检索一次');
  assert.equal(calls.count, 1, '分类只调一次模型');
  assert.equal(result.saved, 2, '模型返回两条（剔除同名是模型的责任，本 stub 未剔除则照落）');
  const evidence = db.listEvidence('crm-wi');
  assert.equal(evidence.filter((item) => item.kind === 'web_signal').length, 2);
  const finding = evidence.find((item) => item.label.includes('融资'))!;
  assert.equal(finding.detail, '[financing] 融资 2 亿元', 'detail 带 category 前缀（模型未给 sentiment 退回旧格式）');
  assert.equal(finding.sourceUrl, 'https://news.example.com/funding');
  // 14 天新鲜度门：刚成功过，非 force 的再次刷新应跳过。
  assert.equal(service.isFresh('crm-wi'), true);
  const skipped = await service.refresh(customer);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.saved, 0);
}));

test('webintel: empty search results save nothing and still mark success (unknown, not a signal)', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-empty', name: '无动态客户' });
  const emptyFetcher: HttpPost = async () => JSON.stringify({ results: [] });
  const service = new WebIntelService(db, fakeRuntime([], { count: 0 }), {
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    getKeylessEnabled: () => true,
    fetcher: emptyFetcher,
  });
  const result = await service.refresh(db.getCustomer('crm-empty') as Customer, { force: true });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.searched, 8);
  assert.equal(result.saved, 0);
  assert.equal(db.listEvidence('crm-empty').length, 0);
  // 空结果也算成功检索：新鲜度门生效，避免每轮全量同步重复空搜。
  assert.equal(service.isFresh('crm-empty'), true);
}));

test('webintel: model failure fails the run without persisting anything', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-fail', name: '失败客户' });
  const runtime = {
    models: { complete: async () => ({ stopReason: 'error', errorMessage: 'provider down', content: [] }) },
    model: {}, llm: { provider: 'fake', model: 'classifier' },
  } as unknown as Runtime;
  const service = new WebIntelService(db, runtime, {
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    getKeylessEnabled: () => true,
    fetcher: tavilyStub('失败客户'),
  });
  await assert.rejects(() => service.refresh(db.getCustomer('crm-fail') as Customer, { force: true }), /provider down/);
  assert.equal(db.listEvidence('crm-fail').length, 0, '失败不落库，宁缺毋滥');
  // 失败的 run 不算新鲜：下轮同步会重试。
  assert.equal(service.isFresh('crm-fail'), false);
}));

test('webintel: refresh archives findings into the sync run; repeats keep the report but do not duplicate evidence', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-round', name: '轮次客户', shortName: '轮次' });
  const calls = { count: 0 };
  const service = new WebIntelService(db, fakeRuntime([
    { label: '完成 B 轮融资', detail: '融资 1 亿元', occurred_at: '2026-08-01', source_url: 'https://news.example.com/r1', category: 'financing' },
  ], calls), {
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    getKeylessEnabled: () => true,
    fetcher: tavilyStub('轮次'),
  });
  const customer = db.getCustomer('crm-round') as Customer;
  const first = await service.refresh(customer, { force: true });
  assert.equal(first.saved, 1);
  assert.equal(first.total, 1);
  // 第二轮（force）命中同一条旧闻：自然键去重不重复落库（saved=0），轮次报告仍完整留痕（total=1、is_new=false）。
  const second = await service.refresh(customer, { force: true });
  assert.equal(second.saved, 0);
  assert.equal(second.total, 1);
  assert.equal(db.listEvidence('crm-round').filter((item) => item.kind === 'web_signal').length, 1, '同自然键只存一行');
  const rounds = db.listWebIntelRuns('crm-round');
  assert.equal(rounds.length, 2, '每轮一条 run（run 即报告）');
  // 两轮 stub 执行极快、started_at 可能同毫秒，不假设顺序——按 is_new 集合断言。
  const newFlags = rounds.map((round) => (round.sourceStatus.web_intelligence.findings as Array<{ is_new: boolean }>)[0]?.is_new).sort();
  assert.deepEqual(newFlags, [false, true], '第一轮新增、第二轮重复命中标记非新增');
  for (const round of rounds) {
    const summary = round.sourceStatus.web_intelligence as Record<string, unknown>;
    assert.equal(summary.total, 1);
    assert.equal(summary.searched, 8);
  }
}));

test('webintel: freshness window is 14 days from the last successful run', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-gate', name: '节流客户' });
  // 手工种一条成功 run，再以「窗口 + 1 天」的时刻判定：过了 14 天门，应可再搜。
  const run = db.createSyncRun('web_intelligence', 'crm-gate');
  db.finishSyncRun(run.id, 'succeeded', {}, undefined);
  const last = db.latestWebIntelSyncAt('crm-gate')!;
  assert.ok(last);
  const service = new WebIntelService(db, fakeRuntime([]), {
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    getKeylessEnabled: () => true,
    fetcher: async () => JSON.stringify({ results: [] }),
  });
  const stale = new Date(last.getTime() + (WEB_INTEL_REFRESH_DAYS + 1) * 86_400_000);
  assert.equal(service.isFresh('crm-gate', stale), false);
  assert.equal(service.isFresh('crm-gate', new Date(last.getTime() + 86_400_000)), true);
}));

test('webintel: refresh persists model sentiment into the detail prefix (web-intel-v2)', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-sent', name: '情感客户', shortName: '情感' });
  const service = new WebIntelService(db, fakeRuntime([
    { label: '推出新保险', detail: '买方破产纳入承保范围', occurred_at: '2026-08-01', source_url: 'https://news.example.com/ins', category: 'product', sentiment: 'positive' },
    { label: '人事任命', detail: '聘任副主任', occurred_at: '2026-08-02', source_url: 'https://news.example.com/hr', category: 'executive', sentiment: 'neutral' },
  ]), {
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    getKeylessEnabled: () => true,
    fetcher: tavilyStub('情感'),
  });
  const result = await service.refresh(db.getCustomer('crm-sent') as Customer, { force: true });
  assert.equal(result.saved, 2);
  const evidence = db.listEvidence('crm-sent');
  assert.equal(evidence.find((item) => item.label === '推出新保险')!.detail, '[product|positive] 买方破产纳入承保范围');
  assert.equal(evidence.find((item) => item.label === '人事任命')!.detail, '[executive|neutral] 聘任副主任');
}));

test('webintel: reclassifyWebIntelSentiment backfills the prefix, keeps ids, and reports negative deltas', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-rc', name: '回填客户' });
  db.addEvidence({ id: 'rc-1', customerId: 'crm-rc', kind: 'web_signal', label: '推出出口保险', detail: '[product] 将买方破产及恶意拖欠导致的服务费损失纳入承保范围', occurredAt: '2026-08-01', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://x.example.com/1' });
  db.addEvidence({ id: 'rc-2', customerId: 'crm-rc', kind: 'web_signal', label: '官网连获荣誉', detail: '[org] 荣誉上新', occurredAt: '2026-08-02', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://x.example.com/2' });
  db.addEvidence({ id: 'rc-3', customerId: 'crm-rc', kind: 'web_signal', label: '被处罚', detail: '[sentiment|negative] 监管处罚', occurredAt: '2026-08-03', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://x.example.com/3' });
  db.addEvidence({ id: 'rc-4', customerId: 'crm-rc', kind: 'voice', label: '客户声音', detail: '满意', occurredAt: '2026-08-03', confidence: 0.7, sourceSystem: 'hemory' });
  const calls = { count: 0 };
  const runtime = {
    models: { complete: async () => {
      calls.count += 1;
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ items: [
        { id: 'rc-1', sentiment: 'positive' },
        { id: 'rc-2', sentiment: 'neutral' },
        { id: 'bogus', sentiment: 'negative' },
        { id: 'rc-3', sentiment: 'positive' },
      ] }) }] };
    } },
    model: {}, llm: { provider: 'fake', model: 'classifier' },
  } as unknown as Runtime;
  const result = await reclassifyWebIntelSentiment(db, runtime, db.getCustomer('crm-rc') as Customer, 'tester', new Date('2026-08-25T00:00:00Z'));

  assert.equal(result.status, 'succeeded');
  assert.equal(result.candidates, 2, '只有缺 sentiment 的 web_signal 行进候选（已带 sentiment/非 web_signal 不进）');
  assert.equal(result.updated, 2, '未知名（bogus）与既有 sentiment 行的应答忽略');
  assert.equal(result.negativeBefore, 2, '回填前：承保条款关键词误伤 1 + 已判负 1');
  assert.equal(result.negativeAfter, 1, '回填后：positive 覆盖关键词误伤，仅真负面留存');
  assert.equal(calls.count, 1, '单客户一次模型批判');
  const evidence = db.listEvidence('crm-rc');
  assert.equal(evidence.find((item) => item.id === 'rc-1')!.detail, '[product|positive] 将买方破产及恶意拖欠导致的服务费损失纳入承保范围', '正文保留、只改前缀');
  assert.equal(evidence.find((item) => item.id === 'rc-2')!.detail, '[org|neutral] 荣誉上新');
  assert.equal(evidence.find((item) => item.id === 'rc-3')!.detail, '[sentiment|negative] 监管处罚', '已有 sentiment 的行不被改写');
  assert.ok(evidence.some((item) => item.id === 'rc-1' && item.kind === 'web_signal'), '行 id 保留（预警抑制语义不变）');
}));

test('webintel: reclassifyWebIntelSentiment skips when nothing lacks sentiment', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'rc-skip', name: '无候选客户' });
  db.addEvidence({ id: 'rc-done', customerId: 'rc-skip', kind: 'web_signal', label: '被处罚', detail: '[sentiment|negative] 监管处罚', occurredAt: '2026-08-03', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://x.example.com/3' });
  const calls = { count: 0 };
  const result = await reclassifyWebIntelSentiment(db, fakeRuntime([], calls), db.getCustomer('rc-skip') as Customer, 'tester');
  assert.equal(result.status, 'skipped');
  assert.equal(result.candidates, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.negativeBefore, 1);
  assert.equal(result.negativeAfter, 1);
  assert.equal(calls.count, 0, '无候选不调模型');
}));

test('webintel: reclassifyWebIntelSentiment propagates model failures', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'rc-fail', name: '失败客户' });
  db.addEvidence({ id: 'rc-f1', customerId: 'rc-fail', kind: 'web_signal', label: '披露年报', detail: '[org] 年报', occurredAt: '2026-08-03', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://x.example.com/9' });
  const runtime = {
    models: { complete: async () => ({ stopReason: 'error', errorMessage: 'provider down', content: [] }) },
    model: {}, llm: { provider: 'fake', model: 'classifier' },
  } as unknown as Runtime;
  await assert.rejects(() => reclassifyWebIntelSentiment(db, runtime, db.getCustomer('rc-fail') as Customer, 'tester'), /provider down/);
  assert.equal(db.listEvidence('rc-fail').find((item) => item.id === 'rc-f1')!.detail, '[org] 年报', '失败不改写任何行');
}));

test('POST /api/web-intel/reclassify: rewrites prefix, recomputes risk; missing param 400, invisible 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-webintel-api-'));
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
  const admin = db.getUserByUsername('admin')!;
  db.createUser({ username: 'csm1', displayName: '一号 CSM', passwordHash: hashPassword('member-pass-1') });
  db.upsertCustomer({ id: 'crm-api', name: '端点客户' });
  db.grantCustomerAccess(admin.id, ['crm-api']);
  db.addEvidence({ id: 'api-1', customerId: 'crm-api', kind: 'web_signal', label: '推出出口保险', detail: '[product] 买方破产纳入承保范围', occurredAt: '2026-08-03', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://x.example.com/api-1' });
  const recomputed: string[] = [];
  const services = {
    db,
    sync: { recompute: (customerId: string) => {
      recomputed.push(customerId);
      const customer = db.getCustomer(customerId);
      if (customer) db.saveRisk(assessRisk(customer, db.listEvidence(customerId), new Date(), {}));
    } },
    cases: {}, drafts: {}, weekly: {}, wiki: {}, opportunities: {},
  } as never;
  const fakeUserRt = { userId: 0, mcp: { failures: new Map<string, string>() }, tools: [], systemPrompt: '' };
  const runtime = {
    models: { complete: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'api-1', sentiment: 'positive' }] }) }] }) },
    model: {}, users: { get: () => fakeUserRt, failuresOf: () => [], reconnect: async () => {}, retryFailed: async () => {}, list: () => [fakeUserRt] },
    mcp: fakeUserRt.mcp, tools: [], systemPrompt: '', llm: {},
    attachSystemUser: () => {}, setLlm: (() => ({})) as never,
  } as unknown as Runtime;
  const server = http.createServer(buildHandler(runtime, store, services, admin.id));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string): Promise<string> => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, tokenName: 'webintel-test' }),
    });
    const body: any = await response.json().catch(() => ({}));
    assert.equal(response.status, 200, `登录失败: ${JSON.stringify(body)}`);
    return body.token as string;
  };
  const adminToken = await login('admin', 'admin-pass-1');
  const memberToken = await login('csm1', 'member-pass-1');
  const call = async (token: string, body: unknown): Promise<{ status: number; data: any }> => {
    const response = await fetch(`${base}/api/web-intel/reclassify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  try {
    // 缺 customerId → 400（全量回填由 CLI 逐客户驱动）。
    const missing = await call(adminToken, {});
    assert.equal(missing.status, 400);
    // 不可见客户 → 404（member 无授权）。
    const invisible = await call(memberToken, { customerId: 'crm-api' });
    assert.equal(invisible.status, 404);
    // 可见客户回填成功：前缀改写 + 重算风险（positive 覆盖「破产」关键词误伤）。
    const ok = await call(adminToken, { customerId: 'crm-api' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.updated, 1);
    assert.equal(ok.data.negativeBefore, 1);
    assert.equal(ok.data.negativeAfter, 0);
    assert.deepEqual(recomputed, ['crm-api'], '回填后必须重算风险与预警');
    assert.equal(db.listEvidence('crm-api').find((item) => item.id === 'api-1')!.detail, '[product|positive] 买方破产纳入承保范围');
    assert.equal(ok.data.risk.ruleVersion, 'csm-risk-v4');
    assert.equal(ok.data.risk.dimensions.web.score, 0, 'positive 覆盖关键词误伤后 web 维度归零');
    // 幂等：再跑一次没有候选 → skipped。
    const again = await call(adminToken, { customerId: 'crm-api' });
    assert.equal(again.status, 200);
    assert.equal(again.data.status, 'skipped');
    assert.deepEqual(recomputed, ['crm-api', 'crm-api']);
  } finally {
    server.close();
    db.close();
    if (previousDataDir === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
