import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import {
  makeWorkbenchToolHandlers,
  CUSTOMER_PROFILE_TOOL_NAME,
  CUSTOMER_EVENTS_TOOL_NAME,
} from '../src/tools/workbench.js';
import {
  makeWebSearchHandler,
  makeRecordWebIntelligenceHandler,
  tavilyFetch,
  type SearchFetcher,
} from '../src/tools/websearch.js';

async function withDb(fn: (db: WorkbenchDatabase) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-tools-'));
  const db = new WorkbenchDatabase(dir);
  try { await fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function dbHandlers(db: WorkbenchDatabase, customerId: string | null) {
  return makeWorkbenchToolHandlers({
    getCustomer: () => (customerId ? { id: customerId, name: db.getCustomer(customerId)?.name ?? '' } : null),
    overview: (id) => db.overview(id),
    timeline: (id, limit) => db.listTimeline(id, limit).map((e) => e as unknown as Record<string, unknown>),
  });
}

test('workbench tools: profile returns overview with freshness note', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-1', name: '客户甲', renewalDate: '2026-12-01T00:00:00.000Z', contractValue: 100 });
  const handlers = dbHandlers(db, 'crm-1');
  const r = await handlers.profile();
  assert.equal(r.isError, undefined);
  assert.ok(r.text.includes('客户工作台档案'));
  assert.ok(r.text.includes('数据新鲜度') || r.text.includes('超过 36 小时'), '应输出新鲜度提示');
  assert.ok(r.text.includes('"name": "客户甲"'));
}));

test('workbench tools: profile fails with guidance when no customer is bound', () => withDb(async (db) => {
  const handlers = dbHandlers(db, null);
  await assert.rejects(handlers.profile(), /未绑定客户/);
}));

test('workbench tools: events returns synced timeline entries', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-1', name: '客户甲' });
  db.upsertSourceEvent({
    customerId: 'crm-1', sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 'ticket-1',
    title: '工单一', payload: {}, occurredAt: '2026-08-20T02:00:00.000Z', payloadHash: 'h1',
  } as never);
  const handlers = dbHandlers(db, 'crm-1');
  const r = await handlers.events({});
  assert.ok(r.text.includes('ticket-1'));
  const filtered = await handlers.events({ sourceType: 'crm_followup' });
  assert.ok(filtered.text.includes('没有已同步的'), '按类型过滤无结果时应说明本地没有不代表源系统没有');
  const filteredHit = await handlers.events({ sourceType: 'support_ticket' });
  assert.ok(filteredHit.text.includes('ticket-1'));
}));

const fakeSearcher = (results: Array<{ title: string; url: string; published_date: string; content: string }>): SearchFetcher =>
  async (body) => {
    assert.equal(body.topic, 'news');
    assert.equal(body.days, 90);
    return results;
  };

test('web_search: returns formatted results with dates and sources', async () => {
  const handler = makeWebSearchHandler({
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    fetcher: fakeSearcher([{ title: '客户甲完成 B 轮融资', url: 'https://news.example.com/1', published_date: '2026-08-01', content: '融资 2 亿元' }]),
  });
  const r = await handler({ query: '客户甲 融资' });
  assert.equal(r.isError, undefined);
  assert.ok(r.text.includes('客户甲完成 B 轮融资'));
  assert.ok(r.text.includes('https://news.example.com/1'));
  assert.ok(r.text.includes('最近 90 天'));
});

test('web_search: no results is unknown, never a signal', async () => {
  const handler = makeWebSearchHandler({ getApiKey: () => 'tvly-test', getMaxResults: () => 5, fetcher: async () => [] });
  const r = await handler({ query: '客户甲 裁员' });
  assert.equal(r.isError, undefined);
  assert.ok(r.text.includes('不构成任何正面或负面信号'));
});

test('web_search: missing api key returns explicit config guidance', async () => {
  const handler = makeWebSearchHandler({ getApiKey: () => undefined, getMaxResults: () => 5, fetcher: tavilyFetch });
  const r = await handler({ query: '客户甲 融资' });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('联网搜索未配置'));
});

test('web_search: fetch failure is reported honestly', async () => {
  const handler = makeWebSearchHandler({
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    fetcher: async () => { throw new Error('HTTP 503'); },
  });
  const r = await handler({ query: '客户甲 融资' });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('联网搜索失败: HTTP 503'));
});

test('record_web_intelligence: persists findings as web_signal evidence', () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-1', name: '客户甲' });
  const handler = makeRecordWebIntelligenceHandler({
    getCustomer: () => ({ id: 'crm-1', name: '客户甲' }),
    addEvidence: (input) => db.addEvidence(input),
  });
  const r = await handler({
    findings: [
      { label: '完成 B 轮融资', detail: '融资 2 亿元', occurred_at: '2026-08-01', source_url: 'https://news.example.com/1', category: 'financing' },
      { label: '无来源动态', detail: '会被跳过', occurred_at: '2026-08-02', source_url: '', category: 'other' },
    ],
  });
  assert.equal(r.isError, undefined);
  assert.ok(r.text.includes('1 条公开动态'));
  const evidence = db.listEvidence('crm-1').filter((e) => e.kind === 'web_signal');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].sourceUrl, 'https://news.example.com/1');
  assert.ok(evidence[0].detail.includes('[financing]'));
  // 概览接口能读到落库结果（闭环：下次分析不再重搜）。
  const overview = db.overview('crm-1') as { customer?: { name?: string } };
  assert.ok(overview.customer?.name === '客户甲');
}));

test('record_web_intelligence: rejects empty or incomplete findings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-tools-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-1', name: '客户甲' });
    const handler = makeRecordWebIntelligenceHandler({
      getCustomer: () => ({ id: 'crm-1', name: '客户甲' }),
      addEvidence: (input) => db.addEvidence(input),
    });
    const empty = await handler({ findings: [] });
    assert.equal(empty.isError, true);
    const incomplete = await handler({ findings: [{ label: '无日期', source_url: 'https://x.example.com' }] });
    assert.equal(incomplete.isError, true);
    assert.equal(db.listEvidence('crm-1').filter((e) => e.kind === 'web_signal').length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record_web_intelligence: requires a bound customer', async () => {
  const handler = makeRecordWebIntelligenceHandler({ getCustomer: () => null, addEvidence: () => '' });
  const r = await handler({ findings: [{ label: 'x', occurred_at: '2026-08-01', source_url: 'https://x.example.com' }] });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('未绑定客户'));
});

test('tool names are stable contracts', () => {
  assert.equal(CUSTOMER_PROFILE_TOOL_NAME, 'get_customer_profile');
  assert.equal(CUSTOMER_EVENTS_TOOL_NAME, 'get_customer_events');
});
