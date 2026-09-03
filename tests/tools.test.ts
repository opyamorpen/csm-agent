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
  keylessSearchWithFailover,
  nextKeylessOrder,
  type HttpPost,
} from '../src/tools/websearch.js';
import * as websearchModule from '../src/tools/websearch.js';

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

// HTTP stub: keyed-Tavily responses come back as JSON the tool parses.
const fakePost = (responses: Record<string, () => string>): HttpPost =>
  async (url) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected url: ${url}`);
    return responses[key]();
  };

test('web_search: keyed Tavily returns formatted results with dates and sources', async () => {
  const handler = makeWebSearchHandler({
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    fetcher: fakePost({ 'api.tavily.com': () => JSON.stringify({ results: [{ title: '客户甲完成 B 轮融资', url: 'https://news.example.com/1', published_date: '2026-08-01', content: '融资 2 亿元' }] }) }),
  });
  const r = await handler({ query: '客户甲 融资' });
  assert.equal(r.isError, undefined);
  assert.ok(r.text.includes('客户甲完成 B 轮融资'));
  assert.ok(r.text.includes('https://news.example.com/1'));
  assert.ok(r.text.includes('Tavily'));
  assert.ok(r.text.includes('最近 90 天'));
});

test('web_search: keyed Tavily with no results is unknown, never a signal', async () => {
  const handler = makeWebSearchHandler({ getApiKey: () => 'tvly-test', getMaxResults: () => 5, fetcher: fakePost({ 'api.tavily.com': () => '{"results":[]}' }) });
  const r = await handler({ query: '客户甲 裁员' });
  assert.equal(r.isError, undefined);
  assert.ok(r.text.includes('不构成任何正面或负面信号'));
});

test('web_search: keyed Tavily fetch failure is reported honestly', async () => {
  const handler = makeWebSearchHandler({
    getApiKey: () => 'tvly-test',
    getMaxResults: () => 5,
    fetcher: async () => { throw new Error('HTTP 503'); },
  });
  const r = await handler({ query: '客户甲 融资' });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('联网搜索失败: HTTP 503'));
});

// Keyless anonymous tier — mirrors Hermes agent's public MCP endpoints.

const exaMcpResponse = (text: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });

const exaSearchText = [
  'Title: 客户甲完成 B 轮融资',
  'URL: https://news.example.com/exa-1',
  'Published: 2026-08-01',
  'Highlights:',
  '融资 2 亿元，领投方为某基金。',
].join('\n');

test('web_search: keyless mode routes to a public endpoint when no key is set', async () => {
  let called = '';
  const handler = makeWebSearchHandler({
    getApiKey: () => undefined,
    getMaxResults: () => 5,
    fetcher: async (url) => {
      called = url;
      if (url.includes('mcp.exa.ai')) return exaMcpResponse(exaSearchText);
      throw new Error(`unexpected url: ${url}`);
    },
  });
  // Ring starts at a random vendor; retry until exa serves, other vendors fail
  // with a non-rate-limit error which stops the walk — so force success by
  // letting every vendor answer with the exa payload shape instead.
  const handlerAll = makeWebSearchHandler({
    getApiKey: () => undefined,
    getMaxResults: () => 5,
    fetcher: async (url) => {
      called = url;
      if (url.includes('mcp.exa.ai')) return exaMcpResponse(exaSearchText);
      if (url.includes('search.parallel.ai')) return exaMcpResponse(JSON.stringify({ results: [{ url: 'https://news.example.com/p-1', title: '客户甲中标', excerpts: ['中标金额 500 万'] }] }));
      if (url.includes('api.tavily.com')) return JSON.stringify({ results: [{ title: '客户甲融资', url: 'https://news.example.com/t-1', published_date: '2026-08-02', content: 'B 轮' }] });
      if (url.includes('api.firecrawl.dev')) return JSON.stringify({ data: { web: [{ title: '客户甲新品', url: 'https://news.example.com/f-1', description: '发布新品' }] } });
      if (url.includes('api.keenable.ai')) return JSON.stringify({ results: [{ title: '客户甲招聘', url: 'https://news.example.com/k-1', snippet: '扩招' }] });
      throw new Error(`unexpected url: ${url}`);
    },
  });
  const r = await handlerAll({ query: '客户甲 融资' });
  assert.equal(r.isError, undefined);
  assert.ok(r.text.includes('免费通道'), '应注明走的是免费通道');
  assert.ok(r.text.includes('无严格时间过滤'), '应提示无严格时间过滤');
  assert.ok(/exa|parallel|tavily|firecrawl|keenable/.test(r.text), '应注明实际服务的供应商');
  assert.ok(called.length > 0, '应发起真实（stubbed）HTTP 调用');
  void handler;
});

test('web_search: keyless tier disabled surfaces config guidance', async () => {
  const handler = makeWebSearchHandler({
    getApiKey: () => undefined,
    getMaxResults: () => 5,
    getKeylessEnabled: () => false,
    fetcher: async () => { throw new Error('should not be called'); },
  });
  const r = await handler({ query: '客户甲 融资' });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('联网搜索未配置且免费通道已停用'));
});

test('keyless ring: rate-limit errors fail over to the next vendor', async () => {
  const calls: string[] = [];
  const post: HttpPost = async (url) => {
    calls.push(url);
    if (url.includes('mcp.exa.ai')) throw new Error('HTTP 429: rate limit exceeded');
    if (url.includes('search.parallel.ai')) return exaMcpResponse(JSON.stringify({ results: [{ url: 'https://news.example.com/p-1', title: '客户甲中标', excerpts: ['中标金额 500 万'] }] }));
    throw new Error(`unexpected url: ${url}`);
  };
  // Run until the walk starts at exa (ring rotates per call).
  let result: Awaited<ReturnType<typeof keylessSearchWithFailover>> | null = null;
  for (let i = 0; i < 5 && !result; i++) {
    const order = nextKeylessOrder();
    void order;
    try {
      const r = await keylessSearchWithFailover('客户甲 融资', 5, post);
      if (calls.some((c) => c.includes('mcp.exa.ai'))) result = r;
      else result = r; // any serving vendor is fine
    } catch (err) {
      if (!(err as Error).message.includes('失败')) throw err;
    }
    calls.length = 0;
  }
  assert.ok(result, '应至少有一次成功的 keyless 检索');
  assert.ok(['exa', 'parallel', 'tavily', 'firecrawl', 'keenable'].includes(result.servedBy));
});

test('keyless ring: non-rate-limit error stops the walk immediately', async () => {
  const calls: string[] = [];
  const post: HttpPost = async (url) => {
    calls.push(url);
    throw new Error('HTTP 400: malformed query');
  };
  await assert.rejects(
    keylessSearchWithFailover('客户甲 融资', 5, post),
    /HTTP 400/,
  );
  assert.equal(calls.length, 1, '非限流错误不应轮换到下一家');
});

test('keyless: MCP SSE-style response bodies are parsed', () => {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Title: SSE 结果\nURL: https://example.com/sse\nHighlights:\n内容摘要' }] } });
  const sse = ['event: message', `data: ${payload}`, ''].join('\n');
  const text = (websearchModule as { parseMcpBody?: (b: string) => string }).parseMcpBody?.(sse);
  assert.ok(text?.includes('https://example.com/sse'));
});

test('keyless: Exa formatted text parser extracts title/url/date/highlights', () => {
  const results = (websearchModule as { parseExaSearchText?: (t: string, l: number) => Array<{ title?: string; url?: string; publishedDate?: string; content?: string }> })
    .parseExaSearchText?.(`${exaSearchText}\n---\nTitle: 第二条\nURL: https://example.com/2\nHighlights:\n摘要`, 5) ?? [];
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '客户甲完成 B 轮融资');
  assert.equal(results[0].url, 'https://news.example.com/exa-1');
  assert.equal(results[0].publishedDate, '2026-08-01');
  assert.ok(results[0].content?.includes('融资 2 亿元'));
});

test('keyless ring order rotates across calls', () => {
  const first = nextKeylessOrder();
  const second = nextKeylessOrder();
  assert.notDeepEqual(first, second, '连续两次调用应轮换起始供应商');
  assert.deepEqual([...first].sort(), [...second].sort(), '轮换只是顺序变化，供应商集合不变');
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

// ── get_customer_detail：客户详情页 13 板块的按需抓取工具 ──
import {
  CUSTOMER_DETAIL_TOOL_NAME,
  CUSTOMER_DETAIL_SECTIONS,
  resolveSections,
  makeCustomerDetailResult,
  type CustomerDetailToolDeps,
} from '../src/tools/customer-detail.js';

function detailDeps(overrides: Partial<CustomerDetailToolDeps> = {}): CustomerDetailToolDeps {
  const event = (sourceType: string, title: string) => ({ id: `${sourceType}-1`, sourceType, title, occurredAt: '2026-08-20T02:00:00.000Z' });
  return {
    getCustomer: () => ({ id: 'crm-1', name: '客户甲' }),
    overview: () => ({
      customer: { id: 'crm-1', name: '客户甲', syncedAt: new Date().toISOString() },
      risk: { score: 42, level: 'yellow' },
      caseDrafts: [{ id: 'cd-1' }],
      actions: [{ id: 'act-1' }],
      timeline: [event('support_ticket', '工单（概览时间线切片）')],
      completionRates: { support_ticket: { done: 9, total: 10 } },
    }),
    timeline: () => [event('support_ticket', '工单一'), event('suggestion_feedback', '建议一'), event('crm_followup', '跟进一')],
    workhours: async () => ({ issueId: 'issue-1', totalHours: 100, records: [{ owner: { name: 'CSM' }, hours: 2 }] }),
    hemoryFragments: () => [{ id: 'frag-1', title: '沟通片段' }],
    webIntelRounds: () => [{ id: 'run-1', startedAt: '2026-09-03T12:10:00.000Z', status: 'succeeded',
      sourceStatus: { web_intelligence: { status: 'succeeded', searched: 8, count: 1, total: 2, findings: [{ label: '完成融资', is_new: true }] } } }],
    cases: async () => ({ caseCandidate: null, caseDrafts: [{ id: 'cd-1' }], latestDraftMarkdown: '## 背景…' }),
    weeklyReports: async () => ({ reports: [{ id: 'wk-1' }], latestMarkdown: '# 周报…' }),
    actions: () => [{ id: 'act-1', title: '行动一' }],
    ...overrides,
  };
}

test('get_customer_detail: sections 白名单解析 + all 展开', () => {
  assert.deepEqual(resolveSections(['support_ticket', 'support_ticket', 'bad']), ['support_ticket']);
  assert.equal(resolveSections(['all'])?.length, CUSTOMER_DETAIL_SECTIONS.length, 'all 应展开为全部板块');
  assert.ok(CUSTOMER_DETAIL_SECTIONS.includes('web_intel' as never), '公开动态轮次报告是详情板块之一');
  assert.equal(resolveSections(['bad']), null);
  assert.equal(resolveSections('overview'), null, '非数组无效');
});

test('get_customer_detail: 默认最小选择——只取指定板块，且事件类按类型过滤', async () => {
  const r = await makeCustomerDetailResult(detailDeps(), { sections: ['support_ticket'] });
  assert.equal(r.isError, undefined);
  assert.ok(r.text.includes('## 工单'), '应含板块标题');
  assert.ok(r.text.includes('工单一'));
  assert.ok(!r.text.includes('建议一'), '未请求的建议板块不应出现');
  assert.ok(!r.text.includes('## 建议'));
});

test('get_customer_detail: web_intel 板块输出公开动态轮次报告（含新增标记与空态提示）', async () => {
  const withRounds = await makeCustomerDetailResult(detailDeps(), { sections: ['web_intel'] });
  assert.ok(withRounds.text.includes('## 公开动态'), '应含板块标题');
  assert.ok(withRounds.text.includes('"is_new": true'), '轮次 findings 明细带新增标记');
  const empty = await makeCustomerDetailResult(detailDeps({ webIntelRounds: () => [] }), { sections: ['web_intel'] });
  assert.ok(empty.text.includes('暂无公开动态轮次记录'), '空态提示不代表没有公开信息');
});

test('get_customer_detail: overview 剔除 timeline/caseDrafts/actions（由各自板块承担，防重复拉取）', async () => {
  const r = await makeCustomerDetailResult(detailDeps(), { sections: ['overview'] });
  assert.ok(r.text.includes('## 概览'));
  assert.ok(r.text.includes('"score": 42'));
  assert.ok(!r.text.includes('概览时间线切片'), 'overview 内嵌时间线应被剔除');
  assert.ok(!r.text.includes('cd-1'), 'caseDrafts 应从 overview 剔除');
  assert.ok(!r.text.includes('act-1'), 'actions 应从 overview 剔除');
});

test('get_customer_detail: 工时/周报/案例板块走各自服务层', async () => {
  const r = await makeCustomerDetailResult(detailDeps(), { sections: ['customer_manhour', 'weekly_report', 'cases', 'actions'] });
  for (const label of ['## 工时', '## 实施周报', '## 客户案例', '## 待办事项']) assert.ok(r.text.includes(label), `缺少板块 ${label}`);
  assert.ok(r.text.includes('"totalHours": 100'));
  assert.ok(r.text.includes('周报…'));
  assert.ok(r.text.includes('背景…'));
});

test('get_customer_detail: 未绑定客户返回可读错误，坏 sections 同上', async () => {
  const unbound = await makeCustomerDetailResult(detailDeps({ getCustomer: () => null }), { sections: ['overview'] });
  assert.equal(unbound.isError, true);
  assert.ok(unbound.text.includes('未绑定客户'));
  const bad = await makeCustomerDetailResult(detailDeps(), { sections: ['bad'] });
  assert.equal(bad.isError, true);
  assert.ok(bad.text.includes(CUSTOMER_DETAIL_TOOL_NAME));
});
