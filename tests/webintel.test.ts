import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import {
  mentionsCustomer,
  parseWebIntelFindings,
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

test('webintel: parseWebIntelFindings drops entries without url/date and clamps category', () => {
  const text = JSON.stringify({
    findings: [
      { label: '完成融资', detail: 'B 轮 2 亿', occurred_at: '2026-08-01', source_url: 'https://news.example.com/1', category: 'financing' },
      { label: '无来源', occurred_at: '2026-08-01', source_url: '', category: 'product' },
      { label: '无日期', occurred_at: '', source_url: 'https://news.example.com/2', category: 'org' },
      { label: '日期带时间', occurred_at: '2026-08-01T10:00:00Z', source_url: 'https://news.example.com/3', category: 'unknown-category' },
    ],
  });
  const findings = parseWebIntelFindings(text);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].category, 'financing');
  assert.equal(findings[1].occurred_at, '2026-08-01', '日期截断为 YYYY-MM-DD');
  assert.equal(findings[1].category, 'other', '未知 category 收敛为 other');
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
  assert.equal(finding.detail, '[financing] 融资 2 亿元', 'detail 带 category 前缀');
  assert.equal(finding.sourceUrl, 'https://news.example.com/funding');
  // 7 天新鲜度门：刚成功过，非 force 的再次刷新应跳过。
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

test('webintel: freshness window is 7 days from the last successful run', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-gate', name: '节流客户' });
  // 手工种一条 8 天前的成功 run：过了 7 天门，应可再搜。
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
