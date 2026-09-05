import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { assessRisk } from '../src/workbench/risk.js';
import { buildOnesCustomerQuery, caseSpeakerRole, crmCustomer, crmFollowupEvent, isDeliveredOnesEvent, nextHemorySlot, nextPortfolioSlot, nextWebIntelTick, onesIssueUrl, onesSourceType, parseOnesIssuePage, parseOnesManhourMode, parseOnesManhourPage, PortfolioSyncService, shanghaiDayBounds } from '../src/workbench/sync.js';
import { applyDeploymentTypeOverride, applyConfirmDraftEdits, applyDraftEdits, computeWorkhours, confirmDraftEditContract, draftDisplayFields, draftEditContract, draftModelRetryDelays, fitFollowupSections, HemoryDraftService, invalidOnesOptionValues, mapOnesDeskRequiredFields, missingOnesDeskDescription, missingOnesDeskSpecFields, missingOnesRequiredFields, ONES_DESK_CLASSIFICATION_HINTS, ONES_DESK_FIELD_SPECS, parseOnesIssueFields, resolveDeploymentType, resolveOnesOption, unknownOnesDeskFieldIds } from '../src/workbench/drafts.js';
import { HemorySegmentationService, isMeaningfulHemoryFragment } from '../src/workbench/hemory.js';
import { collectOpportunitySignals, OpportunityService, parseOpportunityAnalysis } from '../src/workbench/opportunity.js';

async function withDb(fn: (db: WorkbenchDatabase) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workbench-'));
  const db = new WorkbenchDatabase(dir);
  try { await fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('workbench: CRM id is the stable customer key and missing data stays unknown', () => withDb((db) => {
  const customer = db.upsertCustomer({ id: 'crm-1', name: '客户甲', renewalDate: null, contractValue: 100 });
  const risk = assessRisk(customer, [], new Date('2026-08-25T00:00:00Z'));
  db.saveRisk(risk);
  assert.equal(risk.level, 'unknown');
  assert.equal(risk.score, null);
  // v3：需求完成率/工单解决率/互动/客户声音/公开动态五维度；续约日期与合同状态退出计分。
  assert.deepEqual(risk.unknowns.sort(), ['公开动态', '客户声音', '工单解决率', '最后互动时间', '需求完成率'].sort());
  assert.equal(risk.ruleVersion, 'csm-risk-v3');
  assert.equal(db.listCustomers()[0].id, 'crm-1');
}));

test('workbench: risk v3 dimensions — completion rates tiering, web signals, renewal date not scoring', () => {
  const now = new Date('2026-08-25T00:00:00Z');
  const base = { id: 'crm-r3', name: '客户丙', lastContactAt: '2026-08-24T00:00:00Z', explicitNonrenewal: false, contractStatus: '正常' };
  const rate = (done: number, total: number) => ({ type: 'x', done, total, pct: Math.round((done / total) * 100), stale: false });
  const webEvidence = (label: string, occurredAt: string, detail = '') => ({
    customerId: 'crm-r3', kind: 'web_signal', label, detail, occurredAt, confidence: 0.6, sourceSystem: 'web',
  });

  // 需求完成率分档边界：≥30% → 0 分；15%~29% → 半分（13）；<15% → 满分 25。
  const healthy = assessRisk(base, [], now, { suggestionRate: rate(3, 10), ticketRate: rate(9, 10) });
  assert.equal(healthy.dimensions.suggestion.score, 0);
  assert.equal(healthy.dimensions.ticket.score, 0);
  const mid = assessRisk(base, [], now, { suggestionRate: rate(2, 10), ticketRate: rate(8, 10) });
  assert.equal(mid.dimensions.suggestion.score, 13);
  assert.equal(mid.dimensions.ticket.score, 13);
  const bad = assessRisk(base, [], now, { suggestionRate: rate(1, 10), ticketRate: rate(5, 10) });
  assert.equal(bad.dimensions.suggestion.score, 25);
  assert.equal(bad.dimensions.ticket.score, 25);

  // 续约临近度不再计分：距续约 5 天 vs 300 天分数完全一致。
  const near = assessRisk({ ...base, renewalDate: '2026-08-30T00:00:00Z' }, [], now, { suggestionRate: rate(3, 10) });
  const far = assessRisk({ ...base, renewalDate: '2027-06-20T00:00:00Z' }, [], now, { suggestionRate: rate(3, 10) });
  assert.equal(near.score, far.score);
  assert.ok(!near.dimensions.renewal && !near.dimensions.contract, 'v3 不再有 renewal/contract 维度');

  // 0 条记录与缺状态类型都是 unknown（不计分、不冒充）。
  assert.equal(assessRisk(base, [], now, {}).dimensions.suggestion.known, false);
  assert.equal(assessRisk(base, [], now, { suggestionRate: { type: 'x', done: 0, total: 0, pct: 0, stale: false } }).dimensions.suggestion.known, false);
  const staleRisk = assessRisk(base, [], now, { suggestionRate: { type: 'x', done: 0, total: 3, pct: 0, stale: true }, ticketRate: rate(9, 10) });
  assert.equal(staleRisk.dimensions.suggestion.known, false);
  assert.ok(staleRisk.unknowns.includes('需求完成率'));

  // 公开动态：无记录 unknown；1 条负向半分（10）；≥2 条负向满分（20）；90 天窗口外不计。
  const noWeb = assessRisk(base, [], now, {});
  assert.equal(noWeb.dimensions.web.known, false);
  const oneNeg = assessRisk(base, [webEvidence('裁员 5%', '2026-08-01')], now, {});
  assert.equal(oneNeg.dimensions.web.score, 10);
  const twoNeg = assessRisk(base, [webEvidence('裁员 5%', '2026-08-01'), webEvidence('被处罚', '2026-07-15')], now, {});
  assert.equal(twoNeg.dimensions.web.score, 20);
  assert.equal(twoNeg.score != null && twoNeg.score >= 40 ? 'medium-or-high' : 'low', 'medium-or-high');
  const oldWeb = assessRisk(base, [webEvidence('裁员 5%', '2026-01-01')], now, {});
  assert.equal(oldWeb.dimensions.web.known, false, '窗口外动态不入维度');
  // 正向动态（融资）不产生风险分。
  const positive = assessRisk(base, [webEvidence('完成 B 轮融资', '2026-08-01', '[financing] 融资 2 亿')], now, {});
  assert.equal(positive.dimensions.web.score, 0);
  assert.equal(positive.dimensions.web.known, true);
  // detail 前缀 [category]（sentiment/org/executive）兜底判负向。
  const categoryNeg = assessRisk(base, [webEvidence('某公司动态', '2026-08-01', '[org] 组织架构调整')], now, {});
  assert.equal(categoryNeg.dimensions.web.score, 10);
});

test('workbench: explicit nonrenewal overrides incomplete coverage', () => withDb((db) => {
  const customer = db.upsertCustomer({ id: 'crm-2', name: '客户乙', explicitNonrenewal: true, contractStatus: '明确不续约' });
  const risk = assessRisk(customer, []);
  assert.equal(risk.level, 'high');
}));

test('workbench: customer portfolio excludes lost after-sales stage but keeps direct detail access', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-active', name: '活跃客户', afterSalesStage: '服务中', renewalDate: '2026-12-01T00:00:00.000Z', contractValue: 100 });
  db.upsertCustomer({ id: 'crm-lost', name: '流失客户', afterSalesStage: '流失', renewalDate: '2026-09-01T00:00:00.000Z', contractValue: 999 });
  db.upsertCustomer({ id: 'crm-legacy-lost', name: '历史流失客户', contractStatus: '已流失' });
  assert.deepEqual(db.listCustomers().map((customer) => customer.id), ['crm-active']);
  assert.equal(db.getCustomer('crm-lost')?.name, '流失客户');
}));

test('workbench: customer portfolio supports renewal date and amount sorting with unknowns last', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-late', name: '较晚到期', renewalDate: '2027-01-01T00:00:00.000Z', contractValue: 300 });
  db.upsertCustomer({ id: 'crm-early', name: '较早到期', renewalDate: '2026-09-01T00:00:00.000Z', contractValue: 100 });
  db.upsertCustomer({ id: 'crm-unknown', name: '缺失数据', renewalDate: null, contractValue: null });
  assert.deepEqual(db.listCustomers('', 'renewal_date').map((customer) => customer.id), ['crm-early', 'crm-late', 'crm-unknown']);
  assert.deepEqual(db.listCustomers('', 'renewal_amount').map((customer) => customer.id), ['crm-late', 'crm-early', 'crm-unknown']);
}));

test('workbench: CRM stage is persisted separately from contract lifecycle status', () => {
  const input = crmCustomer({ _id: 'crm-stage', field_n1qN0__c__r: '阶段客户集团有限公司', field_83f4l__c: '阶段客户', field_c0avd__c__r: '续约中', life_status__r: '正常' });
  assert.equal(input?.afterSalesStage, '续约中');
  assert.equal(input?.contractStatus, '正常');
  assert.equal(input?.sourceObject, 'object_Umwnn__c');
  // 客户名称（引用显示值）是主名称，售后客户名称（简称）只作次级名称。
  assert.equal(input?.name, '阶段客户集团有限公司');
  assert.equal(input?.shortName, '阶段客户');
  // 引用缺失的记录回退到售后客户名称，仍可入客户表。
  const fallback = crmCustomer({ _id: 'crm-stage2', field_83f4l__c: '只有简称', field_c0avd__c__r: '续约中', life_status__r: '正常' });
  assert.equal(fallback?.name, '只有简称');
});

test('workbench: CRM CSM owner resolves from the owner employee field, not 客户经理/所属销售', () => {
  const input = crmCustomer({
    _id: 'crm-owner', field_n1qN0__c__r: '负责人客户集团有限公司',
    owner: ['1251'], owner__r: { id: '1251', name: '赵荣泽', post: '客户成功经理' },
    field_M1uu5__c: ['sale-1'], field_M1uu5__c__r: { name: '客户经理甲' },
    field_c2pNm__c: ['sale-2'], field_c2pNm__c__r: { name: '销售乙' },
  });
  // CSM 负责人 = 售后客户的「负责人」（owner，employee 显示值），不是客户经理也不是所属销售。
  assert.equal(input?.csmName, '赵荣泽');
  assert.equal(crmCustomer({ _id: 'crm-owner2', field_n1qN0__c__r: '无负责人客户' })?.csmName, null);
});

test('workbench: CRM usage version option values normalize to labels', () => {
  // CRM query 返回单选字段的是选项 value（option1/Hox1iRI04/E4H2tH6o4），入库前规范化成 label。
  assert.equal(crmCustomer({ _id: 'crm-uv1', field_n1qN0__c__r: '版本客户A', field_Q2L6p__c: 'option1' })?.usageVersion, '公有云版');
  assert.equal(crmCustomer({ _id: 'crm-uv2', field_n1qN0__c__r: '版本客户B', field_Q2L6p__c: 'Hox1iRI04' })?.usageVersion, '私有部署按年订阅版');
  assert.equal(crmCustomer({ _id: 'crm-uv3', field_n1qN0__c__r: '版本客户C', field_Q2L6p__c: 'E4H2tH6o4' })?.usageVersion, '私有部署一次性授权版');
  // label 直传与未知 value 原样保留；缺失为 null。
  assert.equal(crmCustomer({ _id: 'crm-uv4', field_n1qN0__c__r: '版本客户D', field_Q2L6p__c: '公有云版' })?.usageVersion, '公有云版');
  assert.equal(crmCustomer({ _id: 'crm-uv5', field_n1qN0__c__r: '版本客户E', field_Q2L6p__c: 'future-value' })?.usageVersion, 'future-value');
  assert.equal(crmCustomer({ _id: 'crm-uv6', field_n1qN0__c__r: '版本客户F' })?.usageVersion, null);
});

test('workbench: CRM followup event binds after-sales customer and keeps record create time', () => {
  const input = crmFollowupEvent({
    _id: 'rec-1', active_record_content: '首次跟进\n沟通了续约意向', active_record_type__r: '常规客情维护',
    field_MIe19__c__r: '线上', create_time: 1755500000000, field_oUaZx__c: 1755600000000,
    related_object_data: [{ describe_api_name: 'object_Umwnn__c', id: 'crm-f', name: '客户福' }, { describe_api_name: 'AccountObj', id: 'acc-1' }],
  });
  assert.equal(input?.customerId, 'crm-f');
  assert.equal(input?.sourceType, 'crm_followup');
  assert.equal(input?.externalId, 'rec-1');
  assert.equal(input?.title, '首次跟进');
  assert.equal(input?.occurredAt, new Date(1755600000000).toISOString());
  assert.equal(input?.payload?.createTime, new Date(1755500000000).toISOString());
  assert.equal(input?.payload?.content, '首次跟进\n沟通了续约意向');

  // 未关联售后客户（object_Umwnn__c）的销售记录不归属任何客户。
  assert.equal(crmFollowupEvent({ _id: 'rec-2', related_object_data: [{ describe_api_name: 'AccountObj', id: 'acc-1' }] }), null);
});

test('workbench: source events are idempotent by source identity', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-3', name: '客户丙' });
  const first = db.upsertSourceEvent({ customerId: 'crm-3', sourceSystem: 'ones', sourceType: 'issue', externalId: 'internal-uuid', displayId: 'PROJ-1', title: '旧标题', occurredAt: '2026-01-01T00:00:00Z' });
  const second = db.upsertSourceEvent({ customerId: 'crm-3', sourceSystem: 'ones', sourceType: 'issue', externalId: 'internal-uuid', displayId: 'PROJ-1', title: '新标题', occurredAt: '2026-01-02T00:00:00Z' });
  assert.equal(first.id, second.id);
  assert.equal(db.listTimeline('crm-3').length, 1);
  assert.equal(db.listTimeline('crm-3')[0].title, '新标题');
  assert.equal(db.listTimeline('crm-3')[0].externalId, 'internal-uuid');
  assert.equal(db.listTimeline('crm-3')[0].displayId, 'PROJ-1');
}));

test('workbench: onesCompletionRates is full-population by status type and marks stale records', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-rates', name: '完成率客户' });
  const done = { field005: { name: '已完成', category: 'done' } };
  const open = { field005: { name: '处理中', category: 'in_progress' } };
  const legacy = { field005: '已完成' }; // 旧同步数据：纯状态名，无 category
  db.upsertSourceEvent({ customerId: 'crm-rates', sourceSystem: 'ones', sourceType: 'suggestion_feedback', externalId: 's-1', title: '建议1', occurredAt: '2026-08-01T00:00:00Z', payload: done });
  db.upsertSourceEvent({ customerId: 'crm-rates', sourceSystem: 'ones', sourceType: 'suggestion_feedback', externalId: 's-2', title: '建议2', occurredAt: '2026-08-02T00:00:00Z', payload: open });
  db.upsertSourceEvent({ customerId: 'crm-rates', sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 't-1', title: '工单1', occurredAt: '2026-08-03T00:00:00Z', payload: done });
  db.upsertSourceEvent({ customerId: 'crm-rates', sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 't-2', title: '工单2', occurredAt: '2026-08-04T00:00:00Z', payload: legacy });
  // 运维工单与未归属事件不进需求/工单两个率。
  db.upsertSourceEvent({ customerId: 'crm-rates', sourceSystem: 'ones', sourceType: 'operations_ticket', externalId: 'o-1', title: '运维1', occurredAt: '2026-08-05T00:00:00Z', payload: done });
  db.upsertSourceEvent({ customerId: null, sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 't-3', title: '未归属工单', occurredAt: '2026-08-06T00:00:00Z', payload: done });
  const rates = db.onesCompletionRates('crm-rates');
  assert.deepEqual(rates.suggestion_feedback, { type: 'suggestion_feedback', done: 1, total: 2, pct: 50, stale: false });
  assert.deepEqual(rates.support_ticket, { type: 'support_ticket', done: 1, total: 2, pct: 50, stale: true }, '缺 category 的旧数据 → stale，绝不拿状态名猜');
  assert.deepEqual(rates.operations_ticket, { type: 'operations_ticket', done: 1, total: 1, pct: 100, stale: false });
  assert.ok((db.overview('crm-rates') as Record<string, unknown>).completionRates, 'overview 携带全量完成率');
}));

test('workbench: recompute wires full rates into risk and schedules opportunity analysis', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-web', name: '公开动态客户', shortName: '公开动态', lastContactAt: '2026-08-20T00:00:00Z' });
  db.upsertSourceEvent({ customerId: 'crm-web', sourceSystem: 'ones', sourceType: 'suggestion_feedback', externalId: 's-1', title: '建议1', occurredAt: '2026-08-01T00:00:00Z', payload: { field005: { name: '已完成', category: 'done' } } });
  db.upsertSourceEvent({ customerId: 'crm-web', sourceSystem: 'ones', sourceType: 'suggestion_feedback', externalId: 's-2', title: '建议2', occurredAt: '2026-08-02T00:00:00Z', payload: { field005: { name: '处理中', category: 'in_progress' } } });
  db.upsertSourceEvent({ customerId: 'crm-web', sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 't-1', title: '工单1', occurredAt: '2026-08-03T00:00:00Z', payload: { field005: { name: '已完成', category: 'done' } } });
  let scheduled = '';
  const sync = new PortfolioSyncService(db, {} as never, async () => ({ events: [], proposedCount: 0, includedCount: 0 }),
    undefined, async (customerId) => { scheduled = customerId; return { status: 'skipped' }; });
  db.addEvidence({ customerId: 'crm-web', kind: 'web_signal', label: '完成 B 轮融资', detail: '[financing] 融资 2 亿元', occurredAt: '2026-08-10', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://news.example.com/1' });
  sync.recompute('crm-web');
  const risk = db.latestRisk('crm-web')!;
  assert.equal(risk.ruleVersion, 'csm-risk-v3');
  assert.equal(risk.dimensions.suggestion.score, 0, '50% ≥ 30% 健康线 → 0 分');
  assert.equal(risk.dimensions.ticket.score, 0);
  assert.equal(risk.dimensions.web.score, 0, '正向公开动态不产生风险分');
  assert.ok(risk.dimensions.web.known);
  // 增购机会 v2：recompute 不再直接生成规则双假设，改为落证据后异步调度 LLM 分析（server 注入实现）。
  assert.equal(scheduled, 'crm-web', 'recompute 落证据后调度增购机会分析');
  assert.equal(db.listOpportunities('crm-web').length, 0, '缺省注入（如测试环境）不产出假设');
  // 信号口径收敛：正向 web 动态进入分析输入；hemory 会议信号按同一 collectOpportunitySignals 收集。
  const signals = collectOpportunitySignals(db.listEvidence('crm-web'));
  assert.equal(signals.web.length, 1);
  assert.equal(signals.web[0].label, '完成 B 轮融资');
  assert.equal(signals.hemory.length, 0);
}));

test('workbench: opportunity model output is sanitized, hallucination-filtered and fully replaces old hypotheses', async () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-opp', name: '机会客户', shortName: '机会', industry: '半导体' });
  const ev1 = db.addEvidence({ customerId: 'crm-opp', kind: 'opportunity', label: '会议增购信号', detail: '我们计划下半年扩容 200 个账号', occurredAt: '2026-08-20', confidence: 0.75, sourceSystem: 'hemory' });
  const ev2 = db.addEvidence({ customerId: 'crm-opp', kind: 'web_signal', label: '完成 B 轮融资', detail: '[financing] 融资 2 亿元', occurredAt: '2026-08-10', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://news.example.com/1' });
  db.upsertOpportunity({ customerId: 'crm-opp', type: 'needs_led_expansion', title: '旧规则假设', detail: '旧长文', confidence: 0.6, status: 'hypothesis', evidenceRefs: [ev1], discoveryQuestions: [], recommendedAction: '旧建议' });
  let calls = 0;
  const runtime = { llm: { provider: 'fake', model: 'fake-model' }, models: { complete: async () => {
    calls += 1;
    return { content: [{ type: 'text', text: JSON.stringify({ opportunities: [
      { summary: '  扩容 200 账号的增购机会 ', confidence: 5, evidence_ids: ['S1', 'S2'] },
      { summary: '幻觉引用条目', confidence: 0.8, evidence_ids: ['S9'] },
      { summary: '重复/无引用条目', confidence: 0.7, evidence_ids: [] },
    ] }) }], stopReason: 'stop' };
  } } } as any;
  const service = new OpportunityService(db, runtime);
  const first = await service.analyze('crm-opp');
  assert.equal(first.status, 'succeeded');
  assert.equal(first.generated, 1, '幻觉引用与零引用条目被过滤');
  assert.equal(calls, 1);
  const opportunities = db.listOpportunities('crm-opp');
  assert.equal(opportunities.length, 1, '旧规则假设被全量替换');
  assert.equal(opportunities[0].title, '扩容 200 账号的增购机会');
  assert.equal(opportunities[0].type, 'signal_expansion');
  assert.equal(opportunities[0].confidence, 0.95, 'confidence 夹取到 0.95');
  assert.deepEqual(opportunities[0].evidenceRefs, [ev1, ev2]);
  assert.ok(opportunities[0].detail.includes('会议录音') && opportunities[0].detail.includes('公开动态'), 'detail 为来源概要串');
  assert.ok(db.getOpportunityGeneration('crm-opp')?.status === 'succeeded');

  // 门控：证据无变化 → 秒级跳过，不再调模型；force 强制重跑。
  const second = await service.analyze('crm-opp');
  assert.equal(second.status, 'skipped');
  assert.match(second.reason ?? '', /证据无变化/);
  assert.equal(calls, 1);
  const forced = await service.analyze('crm-opp', { force: true });
  assert.equal(forced.status, 'succeeded');
  assert.equal(calls, 2);

  // 证据变化但距上次成功不足 24h → 节流跳过；拨到 25h 后重跑。
  db.addEvidence({ customerId: 'crm-opp', kind: 'opportunity', label: '会议增购信号', detail: '还需要测试管理模块', occurredAt: '2026-08-25', confidence: 0.75, sourceSystem: 'hemory' });
  const throttled = await service.analyze('crm-opp');
  assert.equal(throttled.status, 'skipped');
  assert.match(throttled.reason ?? '', /24/);
  const later = await service.analyze('crm-opp', { now: Date.now() + 25 * 3_600_000 });
  assert.equal(later.status, 'succeeded');
  assert.equal(calls, 3);
}));

test('workbench: opportunity analysis keeps old hypotheses on model failure and retries after the failure gate', async () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-opf', name: '失败客户' });
  const ev = db.addEvidence({ customerId: 'crm-opf', kind: 'opportunity', label: '会议增购信号', detail: '需要扩容账号', occurredAt: '2026-08-20', confidence: 0.75, sourceSystem: 'hemory' });
  db.upsertOpportunity({ customerId: 'crm-opf', type: 'signal_expansion', title: '既有假设', detail: '会议录音（2026-08-20）', confidence: 0.7, status: 'hypothesis', evidenceRefs: [ev], discoveryQuestions: [], recommendedAction: '' });
  const failRuntime = { llm: {}, models: { complete: async () => ({ content: [], stopReason: 'error', errorMessage: 'relay 连接超时' }) } } as any;
  const service = new OpportunityService(db, failRuntime);
  const failed = await service.analyze('crm-opf');
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason ?? '', /relay 连接超时/);
  assert.equal(db.listOpportunities('crm-opf').length, 1, '失败保留旧假设');
  assert.equal(db.getOpportunityGeneration('crm-opf')?.status, 'failed');
  // 失败 1 小时门内重试仍跳过，过门后允许（换正常模型）重跑。
  const gateRun = await service.analyze('crm-opf', { now: Date.now() + 30 * 60_000 });
  assert.equal(gateRun.status, 'skipped');
  const okRuntime = { llm: {}, models: { complete: async () => ({ content: [{ type: 'text', text: '{"opportunities":[{"summary":"扩容账号机会","confidence":0.8,"evidence_ids":["S1"]}]}' }], stopReason: 'stop' }) } } as any;
  const healed = await new OpportunityService(db, okRuntime).analyze('crm-opf', { now: Date.now() + 2 * 3_600_000 });
  assert.equal(healed.status, 'succeeded');
  assert.equal(db.listOpportunities('crm-opf')[0].title, '扩容账号机会');
}));

test('workbench: opportunity analysis with no signals clears hypotheses deterministically without a model call', async () => withDb(async (db) => {
  db.upsertCustomer({ id: 'crm-empty', name: '无信号客户' });
  db.upsertOpportunity({ customerId: 'crm-empty', type: 'needs_led_expansion', title: '旧假设', detail: '旧', confidence: 0.6, status: 'hypothesis', evidenceRefs: [], discoveryQuestions: [], recommendedAction: '' });
  let calls = 0;
  const runtime = { llm: {}, models: { complete: async () => { calls += 1; return { content: [{ type: 'text', text: '[]' }], stopReason: 'stop' }; } } } as any;
  const result = await new OpportunityService(db, runtime).analyze('crm-empty');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.generated, 0);
  assert.equal(calls, 0, '无证据不调模型');
  assert.equal(db.listOpportunities('crm-empty').length, 0, '无证据支撑的旧假设被清空');
}));

test('workbench: parseOpportunityAnalysis rejects structurally invalid output and filters per-entry noise', () => {
  const ev = { id: 'ev-1', customerId: 'c', kind: 'opportunity', label: 'x', detail: 'y', occurredAt: '2026-08-01', confidence: 0.5, sourceSystem: 'hemory' } as const;
  const byRef = new Map([['S1', ev as never]]);
  const parsed = parseOpportunityAnalysis('```json\n{"opportunities":[{"summary":"机会A","confidence":0.9,"evidence_ids":["S1","S1"]},{"summary":"机会A","confidence":0.2,"evidence_ids":["S1"]},{"summary":"幻觉","confidence":0.9,"evidence_ids":["S2"]}]}\n```', byRef);
  assert.equal(parsed.length, 1, '幻觉引用丢弃、重复 summary 只留可信度更高的一条');
  assert.equal(parsed[0].summary, '机会A');
  assert.equal(parsed[0].confidence, 0.9);
  assert.throws(() => parseOpportunityAnalysis('不是 JSON', byRef), /无法解析/);
  assert.throws(() => parseOpportunityAnalysis('{"nope":1}', byRef), /无法解析/);
});

test('workbench: overview orders opportunities by confidence and decorates evidence sources', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-osrc', name: '来源客户' });
  const evWeb = db.addEvidence({ customerId: 'crm-osrc', kind: 'web_signal', label: '完成 B 轮融资', detail: '[financing] 融资', occurredAt: '2026-08-10', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://news.example.com/1' });
  const evHemory = db.addEvidence({ customerId: 'crm-osrc', kind: 'opportunity', label: '会议增购信号', detail: '扩容账号', occurredAt: '2026-08-20', confidence: 0.75, sourceSystem: 'hemory' });
  db.upsertOpportunity({ customerId: 'crm-osrc', type: 'signal_expansion', title: '低可信', detail: '', confidence: 0.5, status: 'hypothesis', evidenceRefs: [evHemory], discoveryQuestions: [], recommendedAction: '' });
  db.upsertOpportunity({ customerId: 'crm-osrc', type: 'signal_expansion', title: '高可信', detail: '', confidence: 0.9, status: 'hypothesis', evidenceRefs: [evWeb, evHemory], discoveryQuestions: [], recommendedAction: '' });
  const overview = db.overview('crm-osrc') as Record<string, any>;
  const items = overview.opportunities as any[];
  assert.equal(items[0].title, '高可信', '按可信度降序');
  assert.deepEqual(items[0].sources.map((item: any) => item.sourceSystem), ['web', 'hemory']);
  assert.equal(items[0].sources[0].sourceUrl, 'https://news.example.com/1');
  assert.equal(items[0].sourceCount, 2);
  // 同一来源 URL 去重：webintel 多角度可能对同一链接存两条证据，来源行只留一条。
  const evWebDup = db.addEvidence({ customerId: 'crm-osrc', kind: 'web_signal', label: '完成 B 轮融资（另一角度）', detail: '[contract] 同一报道', occurredAt: '2026-08-11', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://news.example.com/1' });
  db.upsertOpportunity({ customerId: 'crm-osrc', type: 'signal_expansion', title: '同链双证', detail: '', confidence: 0.8, status: 'hypothesis', evidenceRefs: [evWeb, evWebDup], discoveryQuestions: [], recommendedAction: '' });
  const deduped = ((db.overview('crm-osrc') as Record<string, any>).opportunities as any[]).find((item: any) => item.title === '同链双证');
  assert.equal(deduped.sources.length, 1);
  assert.equal(deduped.sourceCount, 1);
  // 引用已失效（不存在的证据）不产生来源行，缺数据按 unknown 展示由前端兜底。
  db.upsertOpportunity({ customerId: 'crm-osrc', type: 'signal_expansion', title: '悬空引用', detail: '', confidence: 0.3, status: 'hypothesis', evidenceRefs: ['ev-gone'], discoveryQuestions: [], recommendedAction: '' });
  const refreshed = (db.overview('crm-osrc') as Record<string, any>).opportunities as any[];
  const dangling = refreshed.find((item: any) => item.title === '悬空引用');
  assert.equal(dangling.sources.length, 0);
  assert.equal(dangling.sourceCount, 0);
}));

test('workbench: last interaction aggregates the latest business event across sources and formats', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-inter', name: '互动客户', lastContactAt: '2026-08-10T02:00:00.000Z' });
  // 三种 occurred_at 历史格式各一条：ISO Z、+08:00（Hemory）、naive 本地时间（ONES Desk 启动迁移）。
  // naive '2026-08-25 20:00:00'（上海）= 12:00Z，必须大于同日的 ISO Z 08:00，验证没有把 naive 误当 UTC。
  db.upsertSourceEvent({ customerId: 'crm-inter', sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 't-1', title: '工单', occurredAt: '2026-08-25T08:00:00Z' });
  db.upsertSourceEvent({ customerId: 'crm-inter', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'h-1', title: '沟通片段', occurredAt: '2026-08-20T10:00:00+08:00' });
  db.upsertSourceEvent({ customerId: 'crm-inter', sourceSystem: 'ones', sourceType: 'suggestion_feedback', externalId: 's-1', title: '建议', occurredAt: '2026-08-25 20:00:00' });
  // customer_snapshot 是 CRM 记录修改元数据，不算互动。
  db.upsertSourceEvent({ customerId: 'crm-inter', sourceSystem: 'crm', sourceType: 'customer_snapshot', externalId: 'snap-1', title: '快照', occurredAt: '2026-08-26T09:00:00Z' });
  assert.equal(db.lastInteractionAt('crm-inter'), '2026-08-25T12:00:00.000Z');
  assert.equal((db.overview('crm-inter') as Record<string, unknown>).lastInteractionAt, '2026-08-25T12:00:00.000Z');

  // 无任何事件时回退 CRM 最后联系时间。
  db.upsertCustomer({ id: 'crm-only-crm', name: '只有CRM联系时间', lastContactAt: '2026-08-01T01:00:00.000Z' });
  assert.equal(db.lastInteractionAt('crm-only-crm'), '2026-08-01T01:00:00.000Z');

  // 停用片段（被新代际取代）不参与聚合，同时间线口径；recording_event_id 需真实存在的录音事件（外键）。
  const recording = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-stale', title: '录音', occurredAt: '2026-08-26T10:00:00+08:00' });
  const stale = db.upsertSourceEvent({ customerId: 'crm-inter', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'h-stale', title: '旧代际片段', occurredAt: '2026-08-26T18:00:00+08:00' });
  db.activateHemoryFragments(recording.id, 'fp-stale', [stale.id]);
  const fresh = db.upsertSourceEvent({ customerId: 'crm-inter', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'h-fresh', title: '新代际片段', occurredAt: '2026-08-26T11:00:00+08:00' });
  db.activateHemoryFragments(recording.id, 'fp-stale-2', [fresh.id]);
  assert.equal(db.lastInteractionAt('crm-inter'), '2026-08-26T03:00:00.000Z');
}));

test('workbench: ONES CSM sources are selected by customer option and exact issue types', () => {
  const query = buildOnesCustomerQuery(['customer-option-1']);
  assert.match(query, /JrvswW8P IN \('customer-option-1'\)/);
  // 双选项客户：全称与简称选项的工作项都要拉取。
  const dual = buildOnesCustomerQuery(['opt-full', 'opt-short']);
  assert.match(dual, /JrvswW8P IN \('opt-full', 'opt-short'\)/);
  assert.match(query, /A99xMfkg/);
  assert.match(query, /7sxvwZMY/);
  assert.match(query, /943qpMX7/);
  assert.match(query, /5DMbQXvd/);
  assert.match(query, /GvyPHeW5/);
  assert.match(query, /SELECT uuid, display_id,/);
  assert.match(query, /ORDER BY field009 DESC/);
  assert.doesNotMatch(query, /ORDER BY field010 DESC/);
  assert.equal(onesSourceType({ field007: { name: '建议和反馈' } }), 'suggestion_feedback');
  assert.equal(onesSourceType({ field007: { name: '运维工单' } }), 'operations_ticket');
  assert.equal(onesSourceType({ field007: { name: '其他类型' } }), null);
  assert.match(onesIssueUrl('internal-uuid', 'DESK-123'), /\/issue\/DESK-123$/);
  assert.doesNotMatch(onesIssueUrl('internal-uuid', 'DESK-123'), /internal-uuid/);
});

test('workbench: existing ONES work items migrate to creation time ordering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workbench-'));
  let db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-created-at', name: '创建时间客户' });
    db.upsertSourceEvent({ customerId: 'crm-created-at', sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 'uuid-old', title: '较早创建',
      occurredAt: '2026-08-25T12:00:00Z', payload: { display_id: 'SUP-1', field009: '2026-08-20T08:00:00Z', field010: '2026-08-25T12:00:00Z' } });
    db.upsertSourceEvent({ customerId: 'crm-created-at', sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 'uuid-new', displayId: 'SUP-2', title: '较晚创建',
      occurredAt: '2026-08-24T12:00:00Z', payload: { field009: '2026-08-22T08:00:00Z', field010: '2026-08-24T12:00:00Z' } });
    db.close();
    db = new WorkbenchDatabase(dir);
    assert.deepEqual(db.listTimeline('crm-created-at').map((event) => [event.externalId, event.displayId, event.occurredAt]), [
      ['uuid-new', 'SUP-2', '2026-08-22T08:00:00Z'],
      ['uuid-old', 'SUP-1', '2026-08-20T08:00:00Z'],
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workbench: ONESQL page parser unwraps item records and keeps the cursor', () => {
  const page = parseOnesIssuePage(JSON.stringify({
    data: [{ type: 'item', item: { uuid: 'issue-1', display_id: 'SUP-1', field001: '测试工单' } }],
    page_info: { has_next_page: true, end_cursor: 'next-page' },
  }));
  assert.deepEqual(page.records, [{ uuid: 'issue-1', display_id: 'SUP-1', field001: '测试工单' }]);
  assert.equal(page.hasNextPage, true);
  assert.equal(page.endCursor, 'next-page');
});

test('workbench: ONES manhour parser normalizes detail records and pagination', () => {
  const page = parseOnesManhourPage(JSON.stringify({
    result: 'SUCCESS',
    data: {
      list: [
        { id: 'log-1', description: '客户会议', hours: 1.5, startTime: 1785373200, owner: { id: 'user-1', name: '登记人' } },
        { id: 'log-2', description: '缓存记录', hours: 0.5, startTime: '2026-07-30T01:00:00.000Z', owner: { id: 'user-2', name: '缓存登记人' } },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'next-page' },
    },
  }));
  assert.equal(page.records[0].id, 'log-1');
  assert.equal(page.records[0].owner?.name, '登记人');
  assert.equal(page.records[0].hours, 1.5);
  assert.equal(page.records[0].startTime, '2026-07-30T01:00:00.000Z');
  assert.equal(page.records[1].startTime, '2026-07-30T01:00:00.000Z');
  assert.equal(page.hasNextPage, true);
  assert.equal(page.endCursor, 'next-page');
});

test('workbench: action completion is persisted without default outcome; explicit outcome recorded', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-4', name: '客户丁' });
  const action = db.createAction({ customerId: 'crm-4', title: '确认续约预算', whyNow: '进入续约窗口' });
  const completed = db.completeAction(action.id);
  assert.equal(completed?.status, 'completed');
  // 完成直达：不传 outcome 只流转状态，不再兜底记「CSM 在工作台确认完成」。
  assert.equal(completed?.outcome, null);
  const explicit = db.createAction({ customerId: 'crm-4', title: '指定结果', whyNow: '进入续约窗口' });
  db.completeAction(explicit.id, '已同步上线');
  assert.equal(db.getAction(explicit.id)?.outcome, '已同步上线');
  assert.equal(db.completeAction('missing-id'), null);
}));

test('workbench: legacy action statuses are collapsed to new on open (two-state model)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-status-collapse-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-m1', name: '迁移客户' });
    const legacy: Array<[string, string]> = [
      ['历史已接受行动', 'accepted'],
      ['进行中行动', 'in_progress'],
      ['已搁置行动', 'snoozed'],
      ['误报行动', 'false_positive'],
    ];
    const ids: string[] = [];
    for (const [title, status] of legacy) {
      const action = db.createAction({ customerId: 'crm-m1', title, whyNow: '原因' });
      db.db.prepare('UPDATE action_items SET status=? WHERE id=?').run(status, action.id);
      ids.push(action.id);
    }
    const completed = db.createAction({ customerId: 'crm-m1', title: '已完成行动', whyNow: '原因' });
    db.completeAction(completed.id);
    db.close();
    const reopened = new WorkbenchDatabase(dir);
    try {
      // 两态模型：开库时 accepted/in_progress/snoozed/false_positive 一律归入未完成，completed 不动。
      for (const id of ids) assert.equal(reopened.getAction(id)?.status, 'new');
      assert.equal(reopened.getAction(completed.id)?.status, 'completed');
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: bulk complete degrades only failing item; no outcome unless explicit', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-b2', name: '完成客户' });
  const ok = db.createAction({ customerId: 'crm-b2', title: '普通行动', whyNow: '原因' });
  const done = db.createAction({ customerId: 'crm-b2', title: '已完成行动', whyNow: '原因' });
  db.completeAction(done.id);
  // 两态模型：未完成可完成，已完成跳过。
  const results = db.bulkCompleteActions([ok.id, done.id, 'missing-id']);
  assert.deepEqual(results.map((item) => item.result), ['completed', 'skipped', 'failed']);
  assert.equal(results[1].reason, '当前状态已完成，仅未完成可完成');
  assert.equal(results[2].title, null);
  assert.equal(db.getAction(ok.id)?.status, 'completed');
  assert.equal(db.getAction(ok.id)?.outcome, null);
  assert.equal(db.getAction(done.id)?.status, 'completed');
  const completed = db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='complete_action' AND entity_id=?").get(ok.id) as { n: number };
  assert.equal(completed.n, 1);
  // 显式 outcome 传播到完成项。
  const next = db.createAction({ customerId: 'crm-b2', title: '指定结果行动', whyNow: '原因' });
  const withOutcome = db.bulkCompleteActions([next.id], '已同步上线');
  assert.equal(withOutcome[0].result, 'completed');
  assert.equal(db.getAction(next.id)?.outcome, '已同步上线');
}));

test('workbench: case drafts use optimistic versions', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-5', name: '客户戊' });
  const draft = db.createCaseDraft('crm-5', '案例', { background: 'A' }, []);
  const updated = db.updateCaseDraft(draft.id, 1, '案例 v2', { background: 'B' });
  assert.equal(updated?.version, 2);
  assert.equal(db.updateCaseDraft(draft.id, 1, '冲突', {}), null);
}));

test('workbench: case drafts keep only the latest version per customer', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-6', name: '客户己' });
  const first = db.createCaseDraft('crm-6', '第一版', { background: 'A' }, []);
  const updated = db.updateCaseDraft(first.id, 1, '第一版', { background: 'A2' })!;
  db.markCasePublished(updated.id, updated.version, 'page-old');
  db.beginCasePublishAttempt(updated.id, updated.version, 'parent-1', 'hash-old');
  // 已发布旧行也一并让位：新稿落库即删除同客户所有旧行，发布尝试记录 FK 级联清理（用户拍板单版本保留）。
  const second = db.createCaseDraft('crm-6', '第二版', { background: 'B' }, []);
  assert.equal(db.listCaseDrafts('crm-6').length, 1);
  assert.equal(db.listCaseDrafts('crm-6')[0].id, second.id);
  assert.equal(db.getCaseDraft(first.id), undefined);
  assert.equal(db.getCasePublishAttemptByHash('hash-old'), undefined, '旧行发布尝试记录随 FK 级联删除');
  // 其他客户的草稿不受影响。
  db.upsertCustomer({ id: 'crm-7', name: '客户庚' });
  db.createCaseDraft('crm-7', '别家案例', { background: 'C' }, []);
  assert.equal(db.listCaseDrafts('crm-6').length, 1);
  assert.equal(db.listCaseDrafts('crm-7').length, 1);
}));

test('workbench: case draft startup cleanup keeps the latest row per customer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-keep-'));
  try {
    const db = new WorkbenchDatabase(dir);
    db.upsertCustomer({ id: 'crm-8', name: '客户辛' });
    // 直接 SQL 造存量多版本数据（绕过 createCaseDraft 的单版本清理，模拟历史库）。
    for (const [id, title, stamp] of [['d-old', '旧版', '2026-08-01T00:00:00Z'], ['d-new', '新版', '2026-08-20T00:00:00Z']] as const) {
      db.db.prepare('INSERT INTO case_drafts(id,customer_id,version,status,title,fields_json,evidence_refs_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, 'crm-8', 1, 'draft', title, '{}', '[]', stamp, stamp);
    }
    db.close();
    // 重开触发 migrate 存量清理（幂等自愈）：仅保留 updated_at 最新一行。
    const reopened = new WorkbenchDatabase(dir);
    const drafts = reopened.listCaseDrafts('crm-8');
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].id, 'd-new');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: manual Hemory attribution survives a later full upsert', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-h', name: '客户海' });
  const event = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r1:t1:x',
    title: '没有客户名的片段', occurredAt: '2026-08-25T04:00:00Z', payload: { recordingId: 'r1', transcript: '没有客户名的片段' }, attributionStatus: 'unattributed' });
  db.attributeHemoryFragments([event.id], 'crm-h', { [event.id]: event.payloadHash });
  const refreshed = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r1:t1:x',
    title: '没有客户名的片段', occurredAt: '2026-08-25T04:00:00Z', payload: { recordingId: 'r1', transcript: '没有客户名的片段' }, attributionStatus: 'unattributed' });
  assert.equal(refreshed.customerId, 'crm-h');
  assert.equal(refreshed.attributionStatus, 'confirmed');
}));

test('workbench: ignored Hemory fragments stay hidden and ignored across re-sync until restored', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-i', name: '客户己' });
  // 直接 upsert 的片段绕过分段服务，需先落一个 raw_transcript 录音再手动登记 generation 才会出现在列表查询。
  db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'r-ignore', title: '原始转写',
    occurredAt: new Date().toISOString(), payload: { recordingId: 'r-ignore' }, attributionStatus: 'unattributed' });
  const register = (eventIds: string[]) => db.activateHemoryFragments(db.findSourceEvent('hemory', 'raw_transcript', 'r-ignore')!.id, 'fingerprint-ignore', eventIds);
  const upsert = (occurredAt: string, externalId: string) => db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
    externalId, title: '待忽略片段', occurredAt, payload: { recordingId: 'r-ignore', rawRecordingEventId: 'rec-raw-ignore', transcript: '待忽略片段' }, attributionStatus: 'unattributed' });
  const recent = upsert(new Date().toISOString(), 'r-ignore:t0:x');
  register([recent.id]);
  assert.ok(db.listHemoryFragments({ status: 'pending' }).some((item) => item.id === recent.id));
  db.ignoreHemoryFragments([recent.id], { [recent.id]: recent.payloadHash });
  // 待归属不可见、已忽略状态可见、全部状态可见。
  assert.equal(db.listHemoryFragments({ status: 'pending' }).some((item) => item.id === recent.id), false);
  assert.equal(db.listHemoryFragments({ status: 'ignored' }).some((item) => item.id === recent.id), true);
  assert.ok(db.listHemoryFragments({ status: 'all' }).some((item) => item.id === recent.id));
  // 重同步 upsert 后忽略状态回放保持。
  const resynced = upsert(new Date().toISOString(), 'r-ignore:t0:x');
  assert.equal(resynced.attributionStatus, 'ignored');
  assert.equal(resynced.customerId, null);
  // hash 变化时拒绝忽略，避免误覆盖新内容。
  const changed = db.getSourceEvent(recent.id)!;
  assert.throws(() => db.ignoreHemoryFragments([recent.id], { [recent.id]: `${changed.payloadHash}-stale` }), /片段内容已变化/);
  // 恢复 = 清除归属，回到待归属。
  db.attributeHemoryFragments([recent.id], null, {});
  assert.equal(db.listHemoryFragments({ status: 'pending' }).some((item) => item.id === recent.id), true);
}));

test('workbench: pending Hemory list defaults to a 7-day Shanghai window and date filter uses Shanghai bounds', () => withDb((db) => {
  const upsert = (externalId: string, occurredAt: string) => db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
    externalId, title: '窗口片段', occurredAt, payload: { recordingId: 'r-window', rawRecordingEventId: 'rec-raw-window', transcript: '窗口片段' }, attributionStatus: 'unattributed' });
  const events: string[] = [];
  const insert = (externalId: string, occurredAt: string) => { const event = upsert(externalId, occurredAt); events.push(event.id); return event; };
  // 全部发生在“今天”（上海），必须在默认窗口内。
  const now = new Date();
  const today = insert('r-window:t0:x', now.toISOString());
  // 上海 6 天前（窗口边界最后一天）与 8 天前（窗口外）。
  const todayStart = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) + 'T00:00:00+08:00');
  const edge = insert('r-window:t1:x', new Date(todayStart.getTime() - 6 * 86_400_000 + 3_600_000).toISOString());
  const outside = insert('r-window:t2:x', new Date(todayStart.getTime() - 8 * 86_400_000).toISOString());
  const shanghai = insert('r-window:t3:x', '2026-08-24T18:00:00Z');
  // 统一登记 generation（activateHemoryFragments 每次会重置整批 active，最后一次性登记）。
  const rawEvent = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'r-window', title: '原始转写',
    occurredAt: today.occurredAt, payload: { recordingId: 'r-window' }, attributionStatus: 'unattributed' });
  db.activateHemoryFragments(rawEvent.id, 'fingerprint-window', events);
  const pendingIds = db.listHemoryFragments({ status: 'pending' }).map((item) => item.id);
  assert.ok(pendingIds.includes(today.id));
  assert.ok(pendingIds.includes(edge.id));
  assert.equal(pendingIds.includes(outside.id), false);
  // days=0 关闭窗口；指定日期不受窗口限制；全部状态不受窗口限制。
  assert.ok(db.listHemoryFragments({ status: 'pending', days: 0 }).map((item) => item.id).includes(outside.id));
  const outsideDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(todayStart.getTime() - 8 * 86_400_000));
  assert.ok(db.listHemoryFragments({ status: 'pending', date: outsideDate }).map((item) => item.id).includes(outside.id));
  assert.ok(db.listHemoryFragments({ status: 'all' }).map((item) => item.id).includes(outside.id));
  // 上海日期过滤：UTC 前一天 18:00（上海当天 02:00）必须落在指定上海日。
  assert.ok(db.listHemoryFragments({ status: 'pending', date: '2026-08-25' }).map((item) => item.id).includes(shanghai.id));
  assert.equal(db.listHemoryFragments({ status: 'pending', date: '2026-08-24' }).map((item) => item.id).includes(shanghai.id), false);
  // 历史数据是 +08:00 本地格式（与 UTC Z 混存），比较必须先归一化：
  // 上海 8-25 23:00 = UTC 8-25 15:00，字符串比较会错判出 8-25 区间。
  const plusOffset = insert('r-window:t4:x', '2026-08-25T23:00:00+08:00');
  db.activateHemoryFragments(rawEvent.id, 'fingerprint-window', events);
  assert.ok(db.listHemoryFragments({ status: 'pending', date: '2026-08-25' }).map((item) => item.id).includes(plusOffset.id));
  // 7 天窗口对 +08:00 格式同样生效：今天上海 10:00 的片段必须在默认窗口内。
  const nowPlusOffset = insert('r-window:t5:x', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()) + '+08:00');
  db.activateHemoryFragments(rawEvent.id, 'fingerprint-window', events);
  assert.ok(db.listHemoryFragments({ status: 'pending' }).map((item) => item.id).includes(nowPlusOffset.id));
}));

test('workbench: Hemory since/until filters by Shanghai wall-clock range and lifts the pending window', () => withDb((db) => {
  const upsert = (externalId: string, occurredAt: string) => db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
    externalId, title: '时段片段', occurredAt, payload: { recordingId: 'r-range', rawRecordingEventId: 'rec-raw-range', transcript: '时段片段' }, attributionStatus: 'unattributed' });
  // 同一上海日的三个时刻：14:00（区间内）、16:30（区间外）、+08:00 与 Z 两种格式混存。
  const inside = upsert('r-range:t0:x', '2026-08-25T14:00:00+08:00');
  const outside = upsert('r-range:t1:x', '2026-08-25T16:30:00+08:00');
  const insideZ = upsert('r-range:t2:x', '2026-08-25T07:00:00Z'); // 上海 15:00，区间内
  // 8 天前的窗口外片段：显式 since/until 必须解除 7 天窗口限制。
  const oldInside = upsert('r-range:t3:x', '2026-08-17T15:00:00+08:00');
  const rawEvent = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'r-range', title: '原始转写',
    occurredAt: inside.occurredAt, payload: { recordingId: 'r-range' }, attributionStatus: 'unattributed' });
  db.activateHemoryFragments(rawEvent.id, 'fingerprint-range', [inside.id, outside.id, insideZ.id, oldInside.id]);
  const range = (since?: string, until?: string) => db.listHemoryFragments({ status: 'pending', since, until }).map((item) => item.id);
  // 闭区间 14:00–15:30：+08:00 与 Z 归一化后都按上海时刻判定。
  assert.ok(range('2026-08-25T14:00:00+08:00', '2026-08-25T15:30:00+08:00').includes(inside.id));
  assert.ok(range('2026-08-25T14:00:00+08:00', '2026-08-25T15:30:00+08:00').includes(insideZ.id));
  assert.equal(range('2026-08-25T14:00:00+08:00', '2026-08-25T15:30:00+08:00').includes(outside.id), false);
  // 只填一边的开区间。
  assert.ok(range('2026-08-25T16:00:00+08:00').includes(outside.id));
  // until=14:30：上海 14:00 的片段在界内，上海 15:00（Z 格式）的片段在界外。
  assert.ok(range(undefined, '2026-08-25T14:30:00+08:00').includes(inside.id));
  assert.equal(range(undefined, '2026-08-25T14:30:00+08:00').includes(insideZ.id), false);
  // 显式 since 解除 pending 7 天窗口：8 天前 15:00 的片段在 14:00–16:00 区间内可见。
  assert.ok(range('2026-08-17T14:00:00+08:00', '2026-08-17T16:00:00+08:00').includes(oldInside.id));
}));

// v2 两阶段分段：outputs 按调用序消耗（阶段 1 分区在前，阶段 2 复核在后）；
// 复核输出省略时直接沿用分区结果（等价于模型复核后未修改）。
function fakeSegmentationRuntime(outputs: Array<Record<string, unknown>>) {
  let calls = 0;
  return {
    runtime: {
      models: { complete: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(outputs[Math.min(calls++, outputs.length - 1)]) }] }) },
      model: {}, llm: { provider: 'fake', model: 'segmenter' },
    } as any,
    calls: () => calls,
  };
}

test('workbench: Hemory AI segmentation persists topics and suppresses one or two line fragments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-segments-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = [
      { spokenAt: '2026-08-25T05:00:00Z', speaker: '甲', text: '你好。' },
      { spokenAt: '2026-08-25T05:00:05Z', speaker: '乙', text: '听得到。' },
      { spokenAt: '2026-08-25T05:01:00Z', speaker: '客户', text: '当前上线流程在审批节点经常被阻塞，需要排查权限配置。' },
      { spokenAt: '2026-08-25T05:01:20Z', speaker: 'CSM', text: '我们会收集报错时间和操作路径，先定位具体失败环节。' },
      { spokenAt: '2026-08-25T05:01:40Z', speaker: '客户', text: '请把排查结论和后续处理计划同步给项目负责人。' },
    ];
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'recording-1',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'recording-1', lines }, attributionStatus: 'unattributed' });
    const fake = fakeSegmentationRuntime([{ segments: [
      { start_index: 0, end_index: 1, topic: '接通确认', summary: '双方确认音频连接。', subject: '音频连接', focus: '通话接通确认', topic_key: 'call-check', include: true },
      { start_index: 2, end_index: 4, topic: '审批阻塞排查', summary: '客户反馈审批阻塞，双方约定收集报错证据并同步处理计划。', subject: '上线流程', focus: '审批节点阻塞排查', topic_key: 'approval-block', include: true },
    ] }]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const fragments = await service.segmentRecording(recording);
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].sourceType, 'ai_topic_segment');
    assert.equal(fragments[0].title, '审批阻塞排查');
    assert.equal(fragments[0].payload?.generationVersion, 'hemory-topic-segments-v3.2');
    assert.equal(fragments[0].payload?.topicGroupId, 'recording-1:approval-block');
    assert.equal(fragments[0].payload?.topicPartIndex, 1);
    assert.equal(fragments[0].payload?.topicPartCount, 1);
    assert.ok(fragments[0].externalId.startsWith('v3.2:'));
    assert.equal(db.listHemoryFragments({ status: 'pending', days: 0 }).length, 1);
    assert.equal((await service.segmentRecording(recording)).length, 1);
    assert.equal(fake.calls(), 2);
    assert.equal(isMeaningfulHemoryFragment(lines.slice(0, 2)), false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: fragments mentioning a customer name stay unattributed (no auto attribution)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-no-autoattr-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 转写里明确提到客户名，但提及名称通常是在引用其他客户案例，不代表在与该客户沟通——不得自动归属。
    db.upsertCustomer({ id: 'crm-name', name: '北京华大九天科技股份有限公司', shortName: '华大九天' });
    const lines = [
      { spokenAt: '2026-08-27T02:00:00Z', speaker: '我', text: '来，像华大九天一样，我们现在想卖人家二十万，但是估计太难了。' },
      { spokenAt: '2026-08-27T02:00:20Z', speaker: '同事', text: '就华大没聊错，现在卡在内部审批上。' },
      { spokenAt: '2026-08-27T02:00:40Z', speaker: '我', text: '内部讨论一下报价策略和后续推进节奏。' },
    ];
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'recording-name',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'recording-name', lines }, attributionStatus: 'unattributed' });
    const fake = fakeSegmentationRuntime([{ segments: [
      { start_index: 0, end_index: 2, topic: '内部报价讨论', summary: '内部讨论华大九天案例的报价策略。', subject: '报价策略', focus: '内部讨论', topic_key: 'pricing', include: true },
    ] }]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const fragments = await service.segmentRecording(recording);
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].attributionStatus, 'unattributed');
    assert.equal(fragments[0].customerId, null);
    // 提及客户名的片段与其他片段一样进入待归属列表，等 CSM 人工标记（夹具日期固定，绕开滚动的 7 天窗口防日历翻转 flake）。
    const pending = db.listHemoryFragments({ status: 'pending', days: 0 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, fragments[0].id);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: a newer Hemory recording generation supersedes old active segments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-regeneration-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const base = [
      { spokenAt: '2026-08-25T05:00:00Z', speaker: '客户', text: '我们需要梳理新的交付流程以及当前负责人安排。' },
      { spokenAt: '2026-08-25T05:00:20Z', speaker: 'CSM', text: '我会先整理现有步骤和每个节点的责任人信息。' },
      { spokenAt: '2026-08-25T05:00:40Z', speaker: '客户', text: '整理完成后请同步一份可以评审的流程清单。' },
    ];
    const first = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'recording-2',
      title: '原始转写', occurredAt: base[0].spokenAt, payload: { recordingId: 'recording-2', lines: base }, attributionStatus: 'unattributed' });
    const fake = fakeSegmentationRuntime([
      { segments: [{ start_index: 0, end_index: 2, topic: '交付流程', summary: '整理交付流程。', subject: '交付流程', focus: '流程与负责人梳理', topic_key: 'delivery-flow', include: true }] },
      { segments: [{ start_index: 0, end_index: 2, topic: '交付流程', summary: '整理交付流程。', subject: '交付流程', focus: '流程与负责人梳理', topic_key: 'delivery-flow', include: true }] },
      { segments: [{ start_index: 0, end_index: 3, topic: '交付流程评审', summary: '整理交付流程并安排评审。', subject: '交付流程', focus: '流程与负责人梳理', topic_key: 'delivery-flow', include: true }] },
      { segments: [{ start_index: 0, end_index: 3, topic: '交付流程评审', summary: '整理交付流程并安排评审。', subject: '交付流程', focus: '流程与负责人梳理', topic_key: 'delivery-flow', include: true }] },
    ]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const old = await service.segmentRecording(first);
    const nextLines = [...base, { spokenAt: '2026-08-25T05:01:00Z', speaker: 'CSM', text: '明天下午会组织相关负责人一起完成流程评审。' }];
    const second = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'recording-2',
      title: '原始转写', occurredAt: base[0].spokenAt, payload: { recordingId: 'recording-2', lines: nextLines }, attributionStatus: 'unattributed' });
    const current = await service.segmentRecording(second);
    assert.notEqual(current[0].id, old[0].id);
    assert.deepEqual(db.listHemoryFragments({ status: 'all' }).map((item) => item.id), [current[0].id]);
    // v2 两阶段：每轮分段 = 分区 + 复核各一次调用。
    assert.equal(fake.calls(), 4);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: Shanghai schedule uses 13:00 and current-day full bounds', () => {
  const now = new Date('2026-08-25T03:00:00Z');
  const next = nextHemorySlot(now);
  assert.equal(next.at.toISOString(), '2026-08-25T05:00:00.000Z');
  assert.equal(next.hour, 13);
  const bounds = shanghaiDayBounds('2026-08-25', now);
  assert.equal(bounds.startedAt, '2026-08-24T16:00:00.000Z');
  assert.equal(bounds.endedAt, now.toISOString());
  assert.equal(nextHemorySlot(new Date('2026-08-25T06:00:00Z')).hour, 20);
});

test('workbench: portfolio sync slot is 02:00 Shanghai (not server-local timezone)', () => {
  // 上海 01:30 → 当天 02:00；上海 02:30 → 次日 02:00（上海 02:00 = 前一日 18:00Z）。
  assert.equal(nextPortfolioSlot(new Date('2026-08-25T17:30:00Z')).at.toISOString(), '2026-08-25T18:00:00.000Z');
  assert.equal(nextPortfolioSlot(new Date('2026-08-25T18:30:00Z')).at.toISOString(), '2026-08-26T18:00:00.000Z');
  assert.equal(nextPortfolioSlot(new Date('2026-08-25T10:30:00Z')).at.toISOString(), '2026-08-25T18:00:00.000Z', '上海 18:30 顺延到明天 02:00');
});

test('workbench: web intel rotation ticks hourly across the Shanghai night window 20:00–08:00', () => {
  // 上海 19:05（11:05Z，窗口外）→ 当晚 20:00（12:00Z）。
  const first = nextWebIntelTick(new Date('2026-08-25T11:05:00Z'));
  assert.equal(first.at.toISOString(), '2026-08-25T12:00:00.000Z');
  assert.equal(first.hour, 20);
  // 上海 20:30（12:30Z）→ 21:00（13:00Z）。
  assert.equal(nextWebIntelTick(new Date('2026-08-25T12:30:00Z')).at.toISOString(), '2026-08-25T13:00:00.000Z');
  // 上海 23:30（15:30Z）→ 跨午夜取次日 00:00（16:00Z），槽位归属次日的上海日。
  const midnight = nextWebIntelTick(new Date('2026-08-25T15:30:00Z'));
  assert.equal(midnight.at.toISOString(), '2026-08-25T16:00:00.000Z');
  assert.equal(midnight.hour, 0);
  assert.equal(midnight.date, '2026-08-26');
  // 上海凌晨 03:00（2026-08-25T19:00Z = 26 日 03:00）→ 04:00（20:00Z）。
  assert.equal(nextWebIntelTick(new Date('2026-08-25T19:00:00Z')).at.toISOString(), '2026-08-25T20:00:00.000Z');
  // 上海 07:30（23:30Z）与 08:30（00:30Z，窗口外）都顺延到当晚 20:00。
  assert.equal(nextWebIntelTick(new Date('2026-08-24T23:30:00Z')).at.toISOString(), '2026-08-25T12:00:00.000Z');
  assert.equal(nextWebIntelTick(new Date('2026-08-25T00:30:00Z')).hour, 20);
});

/** 轮换测试注入的公开动态刷新桩：模拟 WebIntelService.refresh 的真实副作用——
 * 先落一条 web_intelligence SyncRun（latestWebIntelAttemptAt 的排序依据），再按剧本返回。 */
function webIntelRotationStub(db: WorkbenchDatabase, script: Record<string, 'succeeded' | 'failed'>): {
  injected: (customer: any, options: { force?: boolean }) => Promise<{ status: string; saved: number }>;
  attempted: string[];
} {
  const attempted: string[] = [];
  return {
    attempted,
    injected: async (customer: any, options: { force?: boolean }) => {
      attempted.push(`${customer.id}:${options.force === true ? 'force' : 'gated'}`);
      const run = db.createSyncRun('web_intelligence', customer.id);
      const outcome = script[customer.id] ?? 'succeeded';
      if (outcome === 'failed') {
        db.finishSyncRun(run.id, 'failed', {}, 'stub 失败');
        return { status: 'failed', saved: 0 };
      }
      db.finishSyncRun(run.id, 'succeeded', {});
      db.addEvidence({ customerId: customer.id, kind: 'web_signal', label: `${customer.name} 完成融资`, detail: '[financing] 融资 1 亿元',
        occurredAt: '2026-09-01', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://news.example.com/stub' });
      return { status: 'succeeded', saved: 1 };
    },
  };
}

test('workbench: web intel tick picks least-recently-attempted customer, once per Shanghai day, churn excluded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-webintel-tick-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-a', name: '客户甲' });
    db.upsertCustomer({ id: 'crm-b', name: '客户乙' });
    db.upsertCustomer({ id: 'crm-lost', name: '流失客户', contractStatus: '已流失', explicitNonrenewal: true });
    const stub = webIntelRotationStub(db, { 'crm-a': 'failed' });
    const service = new PortfolioSyncService(db, {} as any, async () => [], stub.injected);
    // tick1：两个候选都从未尝试（attemptedAt 平局）→ id 字典序取 crm-a，剧本让它失败（不新鲜但当天已尝试）。
    const first = await service.runWebIntelTick();
    assert.equal(first.customerId, 'crm-a');
    assert.equal(first.status, 'failed');
    assert.equal(first.saved, 0);
    // tick2：crm-a 今天已尝试（失败也算）→ 从未尝试的 crm-b（attemptedAt=0 最古老）优先；流失客户永不入选。
    const second = await service.runWebIntelTick();
    assert.equal(second.customerId, 'crm-b');
    assert.equal(second.status, 'succeeded');
    assert.equal(second.saved, 1);
    // tick3：当天全部尝试过 → 空转跳过（失败客户当天不重锤，次日整点最先重试）。
    const third = await service.runWebIntelTick();
    assert.equal(third.customerId, null);
    assert.equal(third.status, 'skipped');
    assert.deepEqual(stub.attempted, ['crm-a:gated', 'crm-b:gated'], '整点 tick 一律走 14 天门（force=false），流失客户从未被检索');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: web intel rotation drain processes remaining customers once, records summary, and re-drain is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-webintel-drain-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-x', name: '客户丙' });
    db.upsertCustomer({ id: 'crm-y', name: '客户丁' });
    const stub = webIntelRotationStub(db, {});
    const service = new PortfolioSyncService(db, {} as any, async () => [], stub.injected);
    const run = service.refreshWebIntelRotation();
    for (let i = 0; i < 100 && db.getSyncRun(run.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const finished = db.getSyncRun(run.id)!;
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.scope, 'web-intel:rotation');
    const summary = finished.sourceStatus.web_intelligence as Record<string, unknown>;
    assert.equal(summary.attempted, 2);
    assert.equal(summary.saved, 2);
    assert.equal((summary.customers as Array<{ customerId: string }>).length, 2);
    assert.equal(db.listEvidence('crm-x').filter((item) => item.kind === 'web_signal').length, 1);
    // 同日再排空：全部当天已尝试 → 空转成功（attempted 0），不重复检索。
    const again = service.refreshWebIntelRotation();
    for (let i = 0; i < 100 && db.getSyncRun(again.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const againSummary = db.getSyncRun(again.id)!.sourceStatus.web_intelligence as Record<string, unknown>;
    assert.equal(againSummary.attempted, 0);
    assert.equal(stub.attempted.length, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: recent Hemory sync scans a rolling 7-day Shanghai window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-window-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const calls: Array<Record<string, unknown>> = [];
    const mcp = {
      call: async (_publicName: string, args: any) => {
        calls.push(args);
        return { text: '# more=false\n', isError: false } as any;
      },
    } as any;
    const service = new PortfolioSyncService(db, mcp, async () => []);
    const run = service.refreshRecentHemory();
    for (let i = 0; i < 50 && db.getSyncRun(run.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(db.getSyncRun(run.id)?.status, 'succeeded');
    assert.equal(db.getSyncRun(run.id)?.scope, 'hemory:recent');
    assert.equal(calls.length, 1);
    const todayStart = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date()) + 'T00:00:00+08:00');
    const expectedStart = new Date(todayStart.getTime() - 6 * 86_400_000).toISOString();
    assert.equal(calls[0]?.started_at, expectedStart);
    // 运行中的同步互斥：滚动窗口任务完成后才允许新的 Hemory run（此处已完成，返回新 run）。
    const second = service.refreshHemoryDate('2026-08-25');
    assert.notEqual(second.id, run.id);
    for (let i = 0; i < 50 && db.getSyncRun(second.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: web_signal evidence dedupes by natural key and migrate cleans legacy duplicates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-evidence-dedup-'));
  let db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-d1', name: '去重客户' });
    const first = db.addEvidenceIdempotent({ customerId: 'crm-d1', kind: 'web_signal', label: '融资', detail: '[financing] x',
      occurredAt: '2026-08-01', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://n.example/1' });
    const again = db.addEvidenceIdempotent({ customerId: 'crm-d1', kind: 'web_signal', label: '融资（另一轮命中）', detail: '[financing] x',
      occurredAt: '2026-08-01', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://n.example/1' });
    assert.equal(first.created, true);
    assert.equal(again.created, false, '同自然键返回既有行不重复插入');
    assert.equal(again.id, first.id);
    // 同 URL 不同日期是两条独立证据；无 URL 的输入没有稳定自然键、不去重。
    db.addEvidenceIdempotent({ customerId: 'crm-d1', kind: 'web_signal', label: '同文不同日', detail: 'x',
      occurredAt: '2026-08-02', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://n.example/1' });
    db.addEvidenceIdempotent({ customerId: 'crm-d1', kind: 'fact', label: '无URL', detail: 'x',
      occurredAt: '2026-08-01', confidence: 0.6, sourceSystem: 'crm' });
    db.addEvidenceIdempotent({ customerId: 'crm-d1', kind: 'fact', label: '无URL 再来', detail: 'x',
      occurredAt: '2026-08-01', confidence: 0.6, sourceSystem: 'crm' });
    assert.equal(db.listEvidence('crm-d1').length, 4);
    // 模拟本特性上线前的存量库：无唯一索引时积累的重复行，重开库由 migrate 收敛并补建索引。
    (db as any).db.exec('DROP INDEX idx_evidence_natural_key');
    db.addEvidence({ customerId: 'crm-d1', kind: 'web_signal', label: '历史重复一', detail: 'x',
      occurredAt: '2026-08-01', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://n.example/1' });
    db.addEvidence({ customerId: 'crm-d1', kind: 'web_signal', label: '历史重复二', detail: 'x',
      occurredAt: '2026-08-01', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://n.example/1' });
    db.close();
    db = new WorkbenchDatabase(dir);
    const duplicates = db.listEvidence('crm-d1').filter((item) => item.kind === 'web_signal'
      && item.sourceUrl === 'https://n.example/1' && item.occurredAt === '2026-08-01');
    assert.equal(duplicates.length, 1, 'migrate 清理存量重复（每自然键保留最早一行）');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Hemory MCP 返回两条录音的分页转写；毒丸录音排在前面（Map 迭代序 = 首次出现序）。
function hemoryTwoRecordingMcp(): { mcp: any; calls: () => number } {
  let calls = 0;
  // 日期相对当前时间（昨天/前天）：滚动 7 天同步窗口的夹具写死历史日期会在数天后翻出窗口（日期翻转 flake）。
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19) + 'Z';
  return {
    calls: () => calls,
    mcp: {
      call: async () => {
        calls++;
        return { text: '# more=false\n'
          + '## recording-poison\n'
          + `${daysAgo(2)}\t客户\t当前上线流程在审批节点经常被阻塞，需要排查权限配置。\n`
          + `${daysAgo(2)}\tCSM\t我们会收集报错时间和操作路径，先定位具体失败环节。\n`
          + `${daysAgo(2)}\t客户\t请把排查结论和后续处理计划同步给项目负责人。\n`
          + '## recording-fresh\n'
          + `${daysAgo(1)}\t客户\t希望月底前完成新版权限方案的评审。\n`
          + `${daysAgo(1)}\tCSM\t我先安排评审材料和时间窗口。\n`
          + `${daysAgo(1)}\t客户\t评审通过后再同步实施计划。\n`, isError: false } as any;
      },
    } as any,
  };
}

test('workbench: a poisoned recording fails to partial while later recordings still land', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-isolation-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const { mcp } = hemoryTwoRecordingMcp();
    // 毒丸录音分段必抛错（含 attempts>=3 的永久失败形态），fresh 录音照常出 1 条片段。
    // 片段可见性走 activateHemoryFragments 代际门（listHemoryFragments 只认 active=1），fake segmenter 模拟分段服务完成时的两步。
    const service = new PortfolioSyncService(db, mcp, async (recording) => {
      if (String(recording.externalId).includes('poison')) throw new Error('Hemory 分段已达到最大重试次数');
      // 片段时间跟随录音本身（夹具已是相对日期）：写死历史日期会在数天后滚出收件箱窗口（日期翻转 flake）。
      const event = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'v3.2:fresh:t1',
        title: '权限方案评审', occurredAt: recording.occurredAt, payload: { recordingId: 'recording-fresh' }, attributionStatus: 'unattributed' });
      db.activateHemoryFragments(recording.id, `fp-${recording.externalId}`, [event.id]);
      return { events: [event], proposedCount: 1, includedCount: 1 };
    });
    const run = service.refreshRecentHemory();
    for (let i = 0; i < 100 && db.getSyncRun(run.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const finished = db.getSyncRun(run.id)!;
    // 单录音失败 → run=partial、失败明细可见、另一条录音的片段照常入库。
    assert.equal(finished.status, 'partial');
    assert.match(finished.error ?? '', /recording-poison.*最大重试/);
    assert.equal(finished.sourceStatus.hemory?.status, 'partial');
    assert.match(finished.sourceStatus.hemory?.error ?? '', /recording-poison/);
    const pending = db.listHemoryFragments({ status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].payload?.recordingId, 'recording-fresh');
    // 两条 raw_transcript 都已入库（毒丸只有分段失败，原始转写不丢）。
    assert.ok(db.findSourceEvent('hemory', 'raw_transcript', 'recording-poison'));
    assert.ok(db.findSourceEvent('hemory', 'raw_transcript', 'recording-fresh'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: startup recovery resets interrupted jobs and fails orphaned runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-recovery-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = [
      { spokenAt: '2026-08-25T05:00:00Z', speaker: '客户', text: '当前上线流程在审批节点经常被阻塞，需要排查权限配置。' },
      { spokenAt: '2026-08-25T05:00:20Z', speaker: 'CSM', text: '我们会收集报错时间和操作路径，先定位具体失败环节。' },
      { spokenAt: '2026-08-25T05:00:40Z', speaker: '客户', text: '请把排查结论和后续处理计划同步给项目负责人。' },
    ];
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'recording-recover',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'recording-recover', lines }, attributionStatus: 'unattributed' });
    // 场景一：分段 job 被进程重启烧到 attempts=3 且停在 running —— 启动恢复应重置额度并交给 resumePending 重跑成功。
    const fake = fakeSegmentationRuntime([{ segments: [
      { start_index: 0, end_index: 2, topic: '审批阻塞排查', summary: '客户反馈审批阻塞，双方约定收集报错证据并同步处理计划。', subject: '上线流程', focus: '审批节点阻塞排查', topic_key: 'approval-block', include: true },
    ] }]);
    const segments = new HemorySegmentationService(db, fake.runtime);
    // 必须用真实指纹建 job：segmentRecording 按指纹找 job，假指纹会导致它另建新 job 绕开场景。
    const stuck = db.createHemorySegmentationJob(recording.id, hemorySegmentationFingerprintOf(recording));
    db.updateHemorySegmentationJob(stuck.id, 'running');
    db.updateHemorySegmentationJob(stuck.id, 'running');
    db.updateHemorySegmentationJob(stuck.id, 'running');
    assert.equal(db.getHemorySegmentationJob(stuck.id)?.attempts, 3);
    // 场景二：真正模型失败 3 次的 job（failed 终态）不被启动恢复触碰。
    const otherRecording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'recording-other',
      title: '原始转写', occurredAt: '2026-08-24T05:00:00Z', payload: { recordingId: 'recording-other', lines: [] }, attributionStatus: 'unattributed' });
    const genuinelyFailed = db.createHemorySegmentationJob(otherRecording.id, hemorySegmentationFingerprintOf(otherRecording));
    db.updateHemorySegmentationJob(genuinelyFailed.id, 'running');
    db.updateHemorySegmentationJob(genuinelyFailed.id, 'running');
    db.updateHemorySegmentationJob(genuinelyFailed.id, 'running');
    db.updateHemorySegmentationJob(genuinelyFailed.id, 'failed', { error: '模型未返回有效分段' });
    // 场景三：内存里未跑完的 SyncRun 落 failed 终态，不再永久 running。
    const orphan = db.createSyncRun('hemory:recent');
    assert.equal(db.failOrphanedSyncRuns(), 1);
    assert.equal(db.getSyncRun(orphan.id)?.status, 'failed');
    assert.match(db.getSyncRun(orphan.id)?.error ?? '', /服务重启中断/);
    assert.equal(db.getSyncRun(orphan.id)?.finishedAt != null, true);
    assert.equal(db.failOrphanedSyncRuns(), 0);
    // 启动恢复只重置 running 残留：stuck 回 pending/attempts=0；genuinelyFailed 保持 failed/attempts=3。
    assert.equal(db.resetInterruptedHemorySegmentationJobs(), 1);
    const resetJob = db.getHemorySegmentationJob(stuck.id)!;
    assert.equal(resetJob.status, 'pending');
    assert.equal(resetJob.attempts, 0);
    const failedJob = db.getHemorySegmentationJob(genuinelyFailed.id)!;
    assert.equal(failedJob.status, 'failed');
    assert.equal(failedJob.attempts, 3);
    // resumePending 对齐生产启动路径：重置后的 job 重跑并成功入库。
    segments.resumePending();
    for (let i = 0; i < 100 && db.getHemorySegmentationJob(stuck.id)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(db.getHemorySegmentationJob(stuck.id)?.status, 'succeeded');
    assert.equal(db.listHemoryFragments({ status: 'pending', days: 0 }).length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: targeted resegment resets the poison job and re-segments the recording', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-targeted-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = [
      { spokenAt: '2026-08-25T05:00:00Z', speaker: '客户', text: '当前上线流程在审批节点经常被阻塞，需要排查权限配置。' },
      { spokenAt: '2026-08-25T05:00:20Z', speaker: 'CSM', text: '我们会收集报错时间和操作路径，先定位具体失败环节。' },
      { spokenAt: '2026-08-25T05:00:40Z', speaker: '客户', text: '请把排查结论和后续处理计划同步给项目负责人。' },
    ];
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'recording-target',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'recording-target', lines }, attributionStatus: 'unattributed' });
    const fake = fakeSegmentationRuntime([{ segments: [
      { start_index: 0, end_index: 2, topic: '审批阻塞排查', summary: '客户反馈审批阻塞，双方约定收集报错证据并同步处理计划。', subject: '上线流程', focus: '审批节点阻塞排查', topic_key: 'approval-block', include: true },
    ] }]);
    // 把 job 做成 attempts=3 的 failed 毒丸（segmentRecordingDetailed 直接抛错的那种）。
    const segments = new HemorySegmentationService(db, fake.runtime);
    segments.segmentRecording(recording).catch(() => {});
    for (let i = 0; i < 100 && db.listRecentHemorySegmentationJobs().every((item) => item.status !== 'failed'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const fingerprint = hemorySegmentationFingerprintOf(recording);
    const job = db.listRecentHemorySegmentationJobs().find((item) => item.fingerprint === fingerprint)!;
    assert.equal(job.status, 'succeeded');
    assert.equal(db.listHemoryFragments({ status: 'pending', days: 0 }).length, 1);
    // 手工把成功的 job 打回 attempts=3 + failed（真实毒丸形态），验证定向重切的 reset 生效。
    db.updateHemorySegmentationJob(job.id, 'running');
    db.updateHemorySegmentationJob(job.id, 'running');
    db.updateHemorySegmentationJob(job.id, 'running');
    db.updateHemorySegmentationJob(job.id, 'failed', { error: 'Hemory 分段已达到最大重试次数' });
    await assert.rejects(() => segments.segmentRecording(recording), /最大重试/);
    // 定向重切：重置该 job 后重跑成功，run=succeeded、片段入库。
    const service = new PortfolioSyncService(db, { call: async () => ({ text: '', isError: false }) } as any,
      (event) => segments.segmentRecordingDetailed(event));
    const run = service.resegmentHemoryRecording('recording-target');
    for (let i = 0; i < 100 && db.getSyncRun(run.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(db.getSyncRun(run.id)?.status, 'succeeded');
    assert.equal(db.getHemorySegmentationJob(job.id)?.status, 'succeeded');
    assert.equal(db.listHemoryFragments({ status: 'pending', days: 0 }).length, 1);
    // 库里不存在的录音：run 直接 failed 并给出可读错误。
    const missing = service.resegmentHemoryRecording('recording-not-in-db');
    for (let i = 0; i < 100 && db.getSyncRun(missing.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(db.getSyncRun(missing.id)?.status, 'failed');
    assert.match(db.getSyncRun(missing.id)?.error ?? '', /不在库内/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

function hemorySegmentationFingerprintOf(recording: any): string {
  // 测试内联指纹计算（与 hemory.ts 的 hash(`${version}:${externalId}:${payloadHash}`) 一致），避免导出私有 hash。
  return createHash('sha256').update(`hemory-topic-segments-v3.2:${recording.externalId}:${recording.payloadHash}`).digest('hex');
}

test('workbench: model failure fails the job without any fallback drafts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-d', name: '客户岛' });
    const event = db.upsertSourceEvent({ customerId: 'crm-d', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r2:t1:x',
      title: '请小王明天跟进这个报错需求，已经投入两小时', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r2', speaker: 'CSM', transcript: '请小王明天跟进这个报错需求，已经投入两小时' }, attributionStatus: 'confirmed' });
    const fakeMcp = { listTools: () => [], isWrite: () => false, resolve: () => undefined,
      call: async () => ({ text: '', isError: false }) } as any;
    // 模型返回非 JSON：任务必须 failed、不建批次、错误消息可见——绝不静默降级出规则兜底草稿。
    // 模型调用现在带指数退避自动重试（默认 5s/15s/45s），测试用 1ms 退避加速。
    const previousBaseMs = draftModelRetryDelays.baseMs;
    draftModelRetryDelays.baseMs = 1;
    const badModel = { llm: { provider: 'fake', model: 'broken' },
      models: { complete: async () => ({ content: [{ type: 'text', text: '服务暂时不可用' }], stopReason: 'stop' }) } } as any;
    const service = new HemoryDraftService(db, fakeMcp, badModel);
    const queued = service.enqueue('crm-d', [event.id]);
    assert.equal(queued.length, 1);
    for (let i = 0; i < 2000 && db.getDraftJob(queued[0].jobId)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const job = db.getDraftJob(queued[0].jobId)!;
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /模型未生成草稿.*模型未返回/);
    assert.equal(db.listDraftBatches('crm-d').length, 0, '失败任务不得创建草稿批次');
    // 模型未配置（runtime 缺失）同样 failed，不允许无模型的兜底生成。
    draftModelRetryDelays.baseMs = previousBaseMs;
    const noModel = new HemoryDraftService(db, fakeMcp);
    const queued2 = noModel.enqueue('crm-d', [event.id]);
    for (let i = 0; i < 40 && db.getDraftJob(queued2[0].jobId)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const job2 = db.getDraftJob(queued2[0].jobId)!;
    assert.equal(job2.status, 'failed');
    assert.match(job2.error ?? '', /模型未配置/);
    assert.equal(db.listDraftBatches('crm-d').length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: LLM drafts confirm and approved local todo writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-d2', name: '客户岛二' });
    const event = db.upsertSourceEvent({ customerId: 'crm-d2', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r2b:t1:x',
      title: '请小王明天跟进这个报错需求，已经投入两小时', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r2b', speaker: 'CSM', transcript: '请小王明天跟进这个报错需求，已经投入两小时' }, attributionStatus: 'confirmed' });
    const fakeMcp = { listTools: () => [], isWrite: () => false, resolve: () => undefined,
      call: async () => ({ text: '', isError: false }) } as any;
    const service = new HemoryDraftService(db, fakeMcp, fakeModelRuntime([
      { type: 'followup', title: '沟通记录', summary: '全天综述。', fields: { one_line_summary: '跟进报错需求的沟通' }, evidence_refs: [event.id] },
      { type: 'internal_todo', title: '跟进报错需求', summary: '请小王明天跟进', evidence_refs: [event.id] },
      { type: 'ticket', title: '报错工单', summary: '客户遇到报错缺陷', evidence_refs: [event.id] },
    ]));
    const queued = service.enqueue('crm-d2', [event.id]);
    assert.equal(queued.length, 1);
    for (let i = 0; i < 20 && db.getDraftJob(queued[0].jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getDraftJob(queued[0].jobId)?.status, 'succeeded');
    const batch = db.listDraftBatches('crm-d2')[0];
    // LLM 提案：followup+workhour 结构化 + ticket（信号命中）+ todo；suggestion 无提案即不生成。
    assert.equal(batch.items?.length, 4);
    assert.equal(service.enqueue('crm-d2', [event.id])[0].fingerprint, queued[0].fingerprint);
    assert.equal(db.listDraftBatches('crm-d2').length, 1);
    const todo = batch.items!.find((item) => item.type === 'internal_todo')!;
    const preview = await service.preview(batch.id, [todo.id]);
    const result = await service.confirm(batch.id, preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    assert.equal(result.items[0].status, 'written');
    assert.equal(db.listActions('crm-d2').length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

function fakeModelRuntime(drafts: unknown[]): any {
  return {
    llm: { provider: 'fake', model: 'fake-model' },
    models: { complete: async () => ({ content: [{ type: 'text', text: JSON.stringify({ drafts }) }], stopReason: 'stop' }) },
  };
}

function segment(db: WorkbenchDatabase, customerId: string, externalId: string, recordingId: string, title: string, occurredAt: string, transcript: string, summary?: string) {
  return db.upsertSourceEvent({ customerId, sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId,
    title, occurredAt, attributionStatus: 'confirmed',
    payload: summary ? { recordingId, speakers: ['CSM'], transcript, summary } : { recordingId, speakers: ['CSM'], transcript } });
}

async function waitForJob(db: WorkbenchDatabase, jobId: string, expected = 'succeeded'): Promise<void> {
  for (let i = 0; i < 200 && db.getDraftJob(jobId)?.status !== expected; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(db.getDraftJob(jobId)?.status, expected, db.getDraftJob(jobId)?.error ?? undefined);
}

test('workbench: batch regenerating flag tracks in-flight job and clears on success or failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-regen-'));
  const db = new WorkbenchDatabase(dir);
  const previousBaseMs = draftModelRetryDelays.baseMs;
  draftModelRetryDelays.baseMs = 1;
  try {
    db.upsertCustomer({ id: 'crm-rg', name: '再生客户' });
    const event = segment(db, 'crm-rg', 'rrg:t1', 'rrg', '重生成标记话题', '2026-08-25T05:00:00Z', '客户提到工单报错需要跟进');
    // 模型行为三态：pass 立即出 followup 提案；hold 挂起等测试放行（模拟模型调用窗口）；fail 抛错走失败路径。
    let behavior: 'pass' | 'hold' | 'fail' = 'pass';
    let heldRelease: ((drafts: unknown[]) => void) | null = null;
    const runtime = { llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async () => new Promise((resolve, reject) => {
        if (behavior === 'fail') { reject(new Error('模型调用失败')); return; }
        const respond = (drafts: unknown[]) => resolve({ content: [{ type: 'text', text: JSON.stringify({ drafts }) }], stopReason: 'stop' });
        if (behavior === 'hold') heldRelease = respond;
        else respond([{ type: 'followup', title: '沟通记录', summary: '综述。', fields: { one_line_summary: '跟进报错沟通' }, evidence_refs: [event.id] }]);
      }) } } as any;
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), runtime);
    const queued = service.enqueue('crm-rg', [event.id]);
    await waitForJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-rg')[0];
    assert.ok(batch);
    assert.equal(service.batchRegenerating(batch, service.activeRegenerationDays()), false, '无进行中任务时不得标记重新生成中');

    // regenerate 后模型挂起：任务进行中，旧批次必须被判「重新生成中」。
    behavior = 'hold';
    const regen = service.regenerate(batch.id);
    assert.ok(regen.length);
    for (let i = 0; i < 100 && !heldRelease; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(heldRelease, '模型调用须已挂起待放行');
    assert.equal(db.listActiveDraftJobs().length, 1, '进行中任务须可经 listActiveDraftJobs 查到');
    const days = service.activeRegenerationDays();
    assert.equal(days.size, 1);
    assert.ok(days.has('crm-rg:2026-08-25'), '活跃日集合按 客户:上海日 记键');
    assert.equal(service.batchRegenerating(batch, days), true, '生成窗口内旧批次必须标记重新生成中');
    assert.equal(db.listActiveDraftJobs().length, 1, '数据库层照实返回 running；孤儿判定在服务层');

    // 孤儿 running（进程崩溃残留、attempts 耗尽 resume 不再认领）不算进行中：否则批次永久禁操作。
    // 服务实例重启后 processing 清空，同一任务仍处 running 状态即成孤儿。
    const restarted = new HemoryDraftService(db, fakeMcpForDrafts(), runtime);
    assert.equal(restarted.activeRegenerationDays().size, 0, '孤儿 running 不得计入活跃日集合');
    assert.equal(service.activeRegenerationDays().size, 1, '原进程内任务仍在 processing，照常计入');

    // 放行出提案：新批次建成，旧条目作废，标记随任务终态清除。
    heldRelease([{ type: 'internal_todo', title: '跟进报错', summary: '请跟进', evidence_refs: [event.id] }]);
    await waitForJob(db, regen[0].jobId);
    assert.equal(service.activeRegenerationDays().size, 0, '任务终态后活跃日集合须清空');
    const staleItems = (db.getDraftBatch(batch.id)?.items ?? []).filter((item) => item.status === 'stale');
    assert.ok(staleItems.length, '有新提案后旧条目须作废');
    assert.equal(db.listActiveDraftJobs().length, 0);

    // 失败路径：再次 regenerate 且模型抛错 → 任务 failed，旧批次原样保留且标记清除。
    behavior = 'fail';
    const newBatch = db.listDraftBatches('crm-rg').find((item) => item.status !== 'stale');
    assert.ok(newBatch, '须存在一个活跃新批次');
    const regen2 = service.regenerate(newBatch.id);
    for (let i = 0; i < 400 && db.getDraftJob(regen2[0].jobId)?.status !== 'failed'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getDraftJob(regen2[0].jobId)?.status, 'failed');
    assert.equal(service.activeRegenerationDays().size, 0, '失败后不得残留进行中日集合');
    assert.equal(service.batchRegenerating(newBatch), false, '失败后旧批次恢复可操作');
    const kept = db.getDraftBatch(newBatch.id)?.items ?? [];
    assert.ok(kept.length && kept.every((item) => item.status !== 'stale'), '生成失败不得作废旧批次条目');
  } finally { draftModelRetryDelays.baseMs = previousBaseMs; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: draft prompt carries the ONES ASR phonetic-alias rule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-asr-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-asr', name: '近音客户' });
    // 转写里产品名被 ASR 误转为「万斯」：草稿提示词必须携带近音词规则供模型订正。
    const event = segment(db, 'crm-asr', 'rasr:t1', 'rasr', '万斯报表话题', '2026-08-25T05:00:00Z',
      '客户说万斯报表还不支持导出，希望后续能加上');
    let capturedPrompt = '';
    const runtime = { llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        capturedPrompt = input.messages[0].content;
        return { content: [{ type: 'text', text: JSON.stringify({ drafts: [] }) }], stopReason: 'stop' };
      } } } as any;
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), runtime);
    const queued = service.enqueue('crm-asr', [event.id]);
    assert.equal(queued.length, 1);
    await waitForJob(db, queued[0].jobId);
    assert.match(capturedPrompt, /语音识别/);
    assert.match(capturedPrompt, /发音相近/);
    for (const alias of ['万死', '万斯', '万四', 'vans']) assert.ok(capturedPrompt.includes(alias), `提示词必须包含近音词 ${alias}`);
    assert.match(capturedPrompt, /优先理解为并写作 ONES/);
    assert.match(capturedPrompt, /仅当上下文明确指向其他事物/);
    assert.match(capturedPrompt, /所属产品\/所属模块按对应的 ONES 产品线归类/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: same-day fragments merge into one batch with a single followup and a paired workhour draft', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-m', name: '客户马' });
    // 同日两个录音：上午会 13:00-13:30（上海），下午会 15:00-15:20。
    const f1 = segment(db, 'crm-m', 'r9:a', 'r9', '话题A', '2026-08-25T05:00:00Z', '先聊聊上线部署的安排');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T05:00:00Z','$.endAt','2026-08-25T05:30:00Z') WHERE id=?").run(f1.id);
    const first = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued1 = first.enqueue('crm-m', [f1.id]);
    await waitForJob(db, queued1[0]!.jobId);
    // 分次归属：同日第二个录音现在才绑定，应并入同一批次而不是新建一个。
    const f2 = segment(db, 'crm-m', 'r10:a', 'r10', '话题B', '2026-08-25T07:00:00Z', '又出现了一个报错工单');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T07:00:00Z','$.endAt','2026-08-25T07:20:00Z') WHERE id=?").run(f2.id);
    const queued2 = first.enqueue('crm-m', [f2.id]);
    await waitForJob(db, queued2[0]!.jobId);
    const batches = db.listDraftBatches('crm-m');
    assert.equal(batches.filter((batch) => batch.status !== 'stale').length, 1);
    const merged = batches.find((batch) => batch.status !== 'stale')!;
    assert.deepEqual(merged.sourceEventIds.sort(), [f1.id, f2.id].sort());
    // 沟通记录有且仅有一条：证据覆盖两个录音、正文含两个话题、标题带上海日。
    const followups = merged.items!.filter((item) => item.type === 'followup');
    assert.equal(followups.length, 1);
    const followup = followups[0];
    assert.deepEqual(followup.evidenceRefs.sort(), [f1.id, f2.id].sort());
    assert.match(followup.title, /客户马 2026-08-25 沟通记录/);
    assert.match(followup.summary, /【话题A】/);
    assert.match(followup.summary, /【话题B】/);
    assert.ok(String(followup.fields.one_line_summary ?? '').includes('话题A'));
    // 服务开始/结束 = 覆盖片段首尾时刻，不再同为首个事件时刻。
    assert.equal(followup.targetArguments.object_data.field_oUaZx__c, '2026-08-25T05:00:00.000Z');
    assert.equal(followup.targetArguments.object_data.field_wYlhw__c, '2026-08-25T07:00:00.000Z');
    // 连带工时：时长 = 两个录音跨度之和（0.5h + 0.33h ≈ 0.8h），描述是一句话。
    const workhours = merged.items!.filter((item) => item.type === 'workhour');
    assert.equal(workhours.length, 1);
    const workhour = workhours[0];
    assert.equal(workhour.targetArguments.hours, 0.8);
    // startTime 为 ONES 要求的带时区偏移 ISO 8601，取当天未发布沟通的最早时刻（上海 13:00）。
    assert.equal(workhour.targetArguments.startTime, '2026-08-25T13:00:00+08:00');
    assert.equal(workhour.targetArguments.description, followup.fields.one_line_summary);
    // LLM 返回同类型多条非 followup 草稿时不能被折叠：两条 ticket 都要保留
    //（证据片段文本须带缺陷信号，工作项提案才能通过信号门控）。
    const third = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'ticket', title: '工单一', summary: '第一个故障', evidence_refs: [f1.id] },
      { type: 'ticket', title: '工单二', summary: '第二个故障', evidence_refs: [f2.id] },
    ]));
    const updated = db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.transcript','页面白屏报错无法使用','$.summary','页面白屏报错无法使用') WHERE id IN (?,?)").run(f1.id, f2.id);
    void updated;
    const regenerated = third.regenerate(merged.id);    await waitForJob(db, regenerated[0]!.jobId);
    const active = db.listDraftBatches('crm-m').filter((batch) => batch.status !== 'stale');
    assert.equal(active.length, 1);
    assert.equal(active[0].items?.filter((item) => item.type === 'ticket').length, 2);
    assert.equal(active[0].items?.filter((item) => item.type === 'followup').length, 1);
    // 每条草稿只引用自己的证据片段。
    const tickets = active[0].items!.filter((item) => item.type === 'ticket');
    assert.deepEqual(tickets[0].fields.evidence_refs, [tickets[0].title === '工单一' ? f1.id : f2.id]);
    assert.deepEqual(tickets[1].fields.evidence_refs, [tickets[1].title === '工单一' ? f1.id : f2.id]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: published followup truncates the day merge to new communication only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-p', name: '客户佩', sourceObject: 'object_Umwnn__c' });
    const morning = segment(db, 'crm-p', 'rp:a', 'rp', '上午话题', '2026-08-25T01:00:00Z', '上午沟通了报表需求');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T01:00:00Z','$.endAt','2026-08-25T01:40:00Z') WHERE id=?").run(morning.id);
    const mcp = fakeCrmMcp('{"resultCode":"SUCCESS","data":{"id":"rec-p"}}');
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([
      // 工单提案在每轮 regenerate 中复用（fakeModelRuntime 静态输出）——发布豁免后其他类型照旧的断言靠它。
      { type: 'ticket', title: '报错工单', summary: '客户反馈报错故障', evidence_refs: ['rp3:a'] },
    ]));
    const queued = service.enqueue('crm-p', [morning.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch = db.listDraftBatches('crm-p').find((item) => item.status !== 'stale')!;
    const followup = batch.items!.find((item) => item.type === 'followup')!;
    // 确认写入 CRM：上午沟通已发布。
    const preview = await service.preview(batch.id, [followup.id]);
    await service.confirm(batch.id, preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    // 下午又出现新沟通：新草稿只覆盖下午。
    const afternoon = segment(db, 'crm-p', 'rp2:a', 'rp2', '下午话题', '2026-08-25T08:00:00Z', '下午讨论了扩容计划');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T08:00:00Z','$.endAt','2026-08-25T08:30:00Z') WHERE id=?").run(afternoon.id);
    const queued2 = service.enqueue('crm-p', [afternoon.id]);
    await waitForJob(db, queued2[0]!.jobId);
    const batchWith = (eventId: string) => db.listDraftBatches('crm-p')
      .find((item) => item.items?.some((entry) => entry.type === 'followup' && entry.status !== 'stale' && entry.evidenceRefs.includes(eventId)))!;
    const afternoonBatch = batchWith(afternoon.id);
    const newFollowup = afternoonBatch.items!.find((item) => item.type === 'followup' && item.status !== 'stale')!;
    assert.deepEqual(newFollowup.evidenceRefs, [afternoon.id]);
    assert.match(newFollowup.summary, /【下午话题】/);
    assert.doesNotMatch(newFollowup.summary, /上午话题/);
    // 已发布的上午沟通不再出现在新草稿正文里，工时也只计下午录音。
    const newWorkhour = afternoonBatch.items!.find((item) => item.type === 'workhour' && item.status !== 'stale')!;
    assert.equal(newWorkhour.targetArguments.hours, 0.5);
    assert.deepEqual(newWorkhour.evidenceRefs, [afternoon.id]);
    // 下午草稿也发布后，晚间新沟通仍应生成只覆盖晚间的草稿与工时（豁免只截断已发布内容）。
    const preview2 = await service.preview(afternoonBatch.id, [newFollowup.id]);
    await service.confirm(afternoonBatch.id, preview2.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    const evening = segment(db, 'crm-p', 'rp3:a', 'rp3', '晚间话题', '2026-08-25T13:00:00Z', '晚间又提到一个报错工单故障', '客户反馈系统报错故障无法使用');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T13:00:00Z','$.endAt','2026-08-25T13:25:00Z') WHERE id=?").run(evening.id);
    const queued3 = service.enqueue('crm-p', [evening.id]);
    await waitForJob(db, queued3[0]!.jobId);
    const eveningBatch = batchWith(evening.id);
    const eveningFollowup = eveningBatch.items!.find((item) => item.type === 'followup' && item.status !== 'stale')!;
    assert.deepEqual(eveningFollowup.evidenceRefs, [evening.id]);
    const eveningWorkhour = eveningBatch.items!.find((item) => item.type === 'workhour' && item.status !== 'stale')!;
    assert.equal(eveningWorkhour.targetArguments.hours, 0.4);
    // 晚间草稿也发布后全天已回写：强制重生成不再产出沟通记录/工时，但其他类型照旧。
    const preview3 = await service.preview(eveningBatch.id, [eveningFollowup.id]);
    await service.confirm(eveningBatch.id, preview3.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    const forced = service.regenerate(eveningBatch.id);
    await waitForJob(db, forced[0].jobId);
    const finalBatch = db.listDraftBatches('crm-p')
      .find((item) => item.items?.some((entry) => entry.type === 'ticket' && entry.status !== 'stale'))!;
    assert.ok(!finalBatch.items!.some((item) => item.type === 'followup' && item.status !== 'stale'), '已全部发布后不应再生成沟通记录草稿');
    assert.ok(!finalBatch.items!.some((item) => item.type === 'workhour' && item.status !== 'stale'), '无新沟通时不应连带生成工时草稿');
    assert.ok(finalBatch.items!.some((item) => item.type === 'ticket' && item.status !== 'stale'), '工单草稿不受发布豁免影响');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: CRM followup events also count as published signal for the day merge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-q', name: '客户祁', sourceObject: 'object_Umwnn__c' });
    // 手动在 CRM 录入的跟进（本地缓存为 crm_followup 事件）发生在上午 11 点（上海）。
    db.upsertSourceEvent({ customerId: 'crm-q', sourceSystem: 'crm', sourceType: 'crm_followup', externalId: 'crm-rec-1',
      title: '手动跟进', occurredAt: '2026-08-25T03:00:00Z', attributionStatus: 'confirmed' });
    const morning = segment(db, 'crm-q', 'rq:a', 'rq', '上午话题', '2026-08-25T02:00:00Z', '上午沟通了部署');
    const afternoon = segment(db, 'crm-q', 'rq2:a', 'rq2', '下午话题', '2026-08-25T06:00:00Z', '下午沟通了扩容');
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued = service.enqueue('crm-q', [morning.id, afternoon.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch = db.listDraftBatches('crm-q').find((item) => item.status !== 'stale')!;
    const followup = batch.items!.find((item) => item.type === 'followup')!;
    // CRM 已有跟进之后的新沟通才算：只汇总下午片段。
    assert.deepEqual(followup.evidenceRefs, [afternoon.id]);
    assert.match(followup.summary, /【下午话题】/);
    assert.doesNotMatch(followup.summary, /上午话题/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: written draft items consume fragments per type and block duplicate proposals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-consumed-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-c1', name: '客户澈' });
    // 两个带缺陷信号的片段：f1 已被写入工单消费，f2 是同日后补归属的新片段。
    // ticket 信号门控只采标题/分段摘要不扫转写原文，summary 必须带信号词。
    const f1 = segment(db, 'crm-c1', 'rc1:a', 'rc1', '白屏话题', '2026-08-25T05:00:00Z', '页面白屏报错无法使用', '页面白屏报错无法使用');
    const f2 = segment(db, 'crm-c1', 'rc1:b', 'rc1', '统计话题', '2026-08-25T07:00:00Z', '统计又报错了数据不对', '统计报错数据不对');
    // 第一轮：模型只提案 f1 的工单；确认写入（直接置 written 模拟 ONES 回写完成）。
    const first = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'ticket', title: '白屏工单', summary: '客户反馈白屏', evidence_refs: [f1.id] },
    ]));
    const queued = first.enqueue('crm-c1', [f1.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch1 = db.listDraftBatches('crm-c1').find((item) => item.items?.some((entry) => entry.type === 'ticket'))!;
    db.setDraftItemExecution(batch1.items!.find((item) => item.type === 'ticket')!.id, 'written',
      { result: { response: '{"result":"SUCCESS"}' } });
    // 第二轮：强制再生成。模型仍提案已消费的 f1 工单（复现重复入口）、覆盖 f1+f2 的混合工单、只覆盖 f2 的新工单。
    const second = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'ticket', title: '白屏工单', summary: '客户反馈白屏', evidence_refs: [f1.id] },
      { type: 'ticket', title: '混合工单', summary: '两个故障', evidence_refs: [f1.id, f2.id] },
      { type: 'ticket', title: '新工单', summary: '新故障', evidence_refs: [f2.id] },
    ]));
    const regenerated = second.regenerateByEventIds([f1.id]);
    await waitForJob(db, regenerated.jobs[0]!.jobId);
    const active = db.listDraftBatches('crm-c1').find((item) => item.items?.some((entry) => entry.title === '新工单'))!;
    const tickets = active.items!.filter((item) => item.type === 'ticket');
    // 完全被消费的提案整体丢弃；部分消费的保留但证据只剩未消费片段（消费单调递增）。
    assert.ok(!tickets.some((item) => item.title === '白屏工单'), '已写入工单不得原样重复提案');
    const mixed = tickets.find((item) => item.title === '混合工单');
    assert.ok(mixed, '部分消费的工单提案应保留');
    assert.deepEqual(mixed!.evidenceRefs, [f2.id]);
    const fresh = tickets.find((item) => item.title === '新工单');
    assert.ok(fresh, '未消费片段的新工单应保留');
    assert.deepEqual(fresh!.evidenceRefs, [f2.id]);
    // 粒度按片段×类型：f1 只被工单消费，跟进/工时草稿仍覆盖两个片段。
    const followup = active.items!.find((item) => item.type === 'followup')!;
    assert.deepEqual([...followup.evidenceRefs].sort(), [f1.id, f2.id].sort());
    // 旧批次的已写入工单保持 written（终态保护）。
    assert.equal(db.getDraftItem(batch1.items!.find((item) => item.type === 'ticket')!.id)!.status, 'written');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: fully consumed day skips generation with a note and keeps pending drafts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-skip-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-c2', name: '客户檀' });
    const f1 = segment(db, 'crm-c2', 'rc2:a', 'rc2', '白屏话题', '2026-08-25T05:00:00Z', '页面白屏报错无法使用');
    // 第一轮：工单 + 待办 + 自动跟进/工时；工单、跟进、工时全部写入，待办留待处理。
    const first = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'ticket', title: '白屏工单', summary: '客户反馈白屏', evidence_refs: [f1.id] },
      { type: 'internal_todo', title: '跟进排期', summary: '确认修复排期', evidence_refs: [f1.id] },
    ]));
    const queued = first.enqueue('crm-c2', [f1.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch1 = db.listDraftBatches('crm-c2')[0];
    for (const item of batch1.items!) {
      if (item.type !== 'internal_todo') db.setDraftItemExecution(item.id, 'written', { result: { response: '{"result":"SUCCESS"}' } });
    }
    const todoId = batch1.items!.find((item) => item.type === 'internal_todo')!.id;
    // 第二轮：模型只提案已被消费的工单——全部类型消费完毕，应零提案收尾而非空转作废。
    const second = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'ticket', title: '白屏工单', summary: '客户反馈白屏', evidence_refs: [f1.id] },
    ]));
    const regenerated = second.regenerateByEventIds([f1.id]);
    await waitForJob(db, regenerated.jobs[0]!.jobId);
    const job = db.getDraftJob(regenerated.jobs[0]!.jobId)!;
    assert.equal(job.status, 'succeeded');
    assert.match(job.note ?? '', /均已被已写入草稿消费/);
    // 零提案守卫：不建新批次、未写入的待办草稿不被作废。
    assert.equal(db.listDraftBatches('crm-c2').length, 1);
    assert.notEqual(db.getDraftItem(todoId)!.status, 'stale');
    // 跳过结论落审计（entity=draft_job，含当日片段集合）。
    const skipped = db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='generate_hemory_drafts' AND entity_type='draft_job' AND entity_id=?").get(job.id) as { n: number };
    assert.equal(skipped.n, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: written workhour consumes fragments without blocking the failed followup retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-wh-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-c3', name: '客户棠' });
    const f1 = segment(db, 'crm-c3', 'rc3:a', 'rc3', '部署话题', '2026-08-25T05:00:00Z', '沟通了报表需求');
    // 第一轮：跟进写入失败、工时已写入——再生成必须只重出跟进，不得重复计工时。
    const first = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued = first.enqueue('crm-c3', [f1.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch1 = db.listDraftBatches('crm-c3')[0];
    db.setDraftItemExecution(batch1.items!.find((item) => item.type === 'workhour')!.id, 'written',
      { result: { response: '{"result":"SUCCESS"}' } });
    db.setDraftItemExecution(batch1.items!.find((item) => item.type === 'followup')!.id, 'failed',
      { error: 'CRM 回写业务失败' });
    const second = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const regenerated = second.regenerateByEventIds([f1.id]);
    await waitForJob(db, regenerated.jobs[0]!.jobId);
    const active = db.listDraftBatches('crm-c3').find((item) => item.items?.some((entry) => entry.type === 'followup' && entry.status !== 'stale'))!;
    // 跟进可重出（未消费），工时不重复（片段已被 written 工时消费）。
    const newFollowup = active.items!.find((item) => item.type === 'followup' && item.status !== 'stale')!;
    assert.deepEqual(newFollowup.evidenceRefs, [f1.id]);
    assert.ok(!active.items!.some((item) => item.type === 'workhour' && item.status !== 'stale'), '工时已写入后不得连带重复生成');
    // 旧批次的 written 工时保持终态。
    assert.equal(db.getDraftItem(batch1.items!.find((item) => item.type === 'workhour')!.id)!.status, 'written');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: multi-day attribution creates one batch per Shanghai day', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-n', name: '客户倪' });
    // 8-24 深夜 23:30（上海）与 8-25 凌晨 00:30（上海）：跨上海自然日。
    const day1 = segment(db, 'crm-n', 'rd1:a', 'rd1', '昨日话题', '2026-08-24T15:30:00Z', '昨天聊了部署');
    const day2 = segment(db, 'crm-n', 'rd2:a', 'rd2', '今日话题', '2026-08-24T16:30:00Z', '今天继续聊扩容');
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const jobs = service.enqueue('crm-n', [day1.id, day2.id]);
    assert.equal(jobs.length, 2);
    for (const job of jobs) await waitForJob(db, job.jobId);
    const active = db.listDraftBatches('crm-n').filter((batch) => batch.status !== 'stale');
    assert.equal(active.length, 2);
    const titles = active.flatMap((batch) => batch.items!.filter((item) => item.type === 'followup').map((item) => item.title));
    assert.ok(titles.some((title) => title.includes('2026-08-24')), '应有 8-24 批次');
    assert.ok(titles.some((title) => title.includes('2026-08-25')), '应有 8-25 批次');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: workhour falls back to unknown when recording times are missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-t', name: '客户泰' });
    // 无 startAt/endAt 的历史片段：时长回到 unknown，由校验错误引导人工补充。
    const legacy = segment(db, 'crm-t', 'rt:a', 'rt', '旧话题', '2026-08-25T05:00:00Z', '沟通了旧系统迁移');
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued = service.enqueue('crm-t', [legacy.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch = db.listDraftBatches('crm-t').find((item) => item.status !== 'stale')!;
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    assert.equal(workhour.targetArguments.hours, 'unknown');
    assert.ok(workhour.validationErrors.some((message) => message.includes('工时时长')));
    // followup 照常生成，不受工时数据缺失影响。
    assert.ok(batch.items!.some((item) => item.type === 'followup'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: workhour floors short topic spans to 0.1h instead of dropping to unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-u', name: '客户乌' });
    // 人工归属常把长会中的小话题片段标给客户：2.5 分钟跨度四舍五入为 0.0h，必须按最小 0.1h 计。
    const topic = segment(db, 'crm-u', 'ru:a', 'ru', '小话题', '2026-08-25T06:26:00Z', '确认了款项安排');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T06:26:29Z','$.endAt','2026-08-25T06:29:02Z') WHERE id=?").run(topic.id);
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued = service.enqueue('crm-u', [topic.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch = db.listDraftBatches('crm-u').find((item) => item.status !== 'stale')!;
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    assert.equal(workhour.targetArguments.hours, 0.1);
    assert.deepEqual(workhour.unknowns, []);
    assert.ok(!workhour.validationErrors.some((message) => message.includes('工时时长')));
    // 纯函数口径：12 秒 → 0.1；缺录音 ID → null；跨度非法（end<=start）→ null。
    const span = (startAt: string, endAt: string) => [{ payload: { recordingId: 'r', startAt, endAt } }] as any[];
    assert.equal(computeWorkhours(span('2026-08-25T03:09:04Z', '2026-08-25T03:09:16Z')), 0.1);
    assert.equal(computeWorkhours([{ payload: { startAt: '2026-08-25T03:09:04Z', endAt: '2026-08-25T03:09:16Z' } }] as any[]), null);
    assert.equal(computeWorkhours(span('2026-08-25T03:09:04Z', '2026-08-25T03:09:04Z')), null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: draft generation surfaces real model error and retries transient failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  const originalBaseMs = draftModelRetryDelays.baseMs;
  draftModelRetryDelays.baseMs = 1;
  try {
    db.upsertCustomer({ id: 'crm-v', name: '客户沃' });
    const frag = segment(db, 'crm-v', 'rv:a', 'rv', '话题', '2026-08-25T05:00:00Z', '沟通了部署安排');
    // 场景一：provider 故障（complete 不抛异常，返回 stopReason=error）——真实错误必须透出，重试 3 次后任务 failed。
    let errorCalls = 0;
    const failing = { llm: { provider: 'fake', model: 'relay' },
      models: { complete: async () => { errorCalls++; return { stopReason: 'error', errorMessage: 'Request timed out.', content: [] }; } } } as any;
    const failingService = new HemoryDraftService(db, fakeMcpForDrafts(), failing);
    const job1 = failingService.enqueue('crm-v', [frag.id])[0]!;
    for (let i = 0; i < 2000 && db.getDraftJob(job1.jobId)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(errorCalls, 3, '必须自动重试满 3 次');
    const failed = db.getDraftJob(job1.jobId)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /模型调用失败（第 3\/3 次）: Request timed out\./);
    // 失败明细：sourceEventIds 回写为执行时真实片段集合，可按片段定位重生成。
    assert.deepEqual(failed.sourceEventIds, [frag.id]);
    // 场景二：首次连接超时、重试成功——瞬时故障不应导致任务失败。
    let flakyCalls = 0;
    const flaky = { llm: { provider: 'fake', model: 'relay' },
      models: { complete: async () => {
        flakyCalls++;
        if (flakyCalls === 1) return { stopReason: 'error', errorMessage: 'Request timed out.', content: [] };
        return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ drafts: [] }) }] };
      } } } as any;
    const flakyService = new HemoryDraftService(db, fakeMcpForDrafts(), flaky);
    const job2 = flakyService.regenerateByEventIds([frag.id]).jobs[0]!;
    for (let i = 0; i < 2000 && db.getDraftJob(job2.jobId)?.status !== 'succeeded'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (db.getDraftJob(job2.jobId)?.status === 'failed') break;
    }
    assert.equal(db.getDraftJob(job2.jobId)?.status, 'succeeded', '瞬时故障重试后任务必须成功');
    assert.equal(flakyCalls, 2);
    // 重新生成成功后旧失败任务被标记 superseded：失败列表不再堆积、重启也不再重试。
    assert.equal(db.getDraftJob(job1.jobId)?.status, 'superseded');
    assert.ok(!db.listFailedDraftJobs().some((job) => job.id === job1.jobId));
    assert.ok(!db.listPendingDraftJobs().some((job) => job.id === job1.jobId));
  } finally { draftModelRetryDelays.baseMs = originalBaseMs; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: failed draft jobs list exposes fragment details for regeneration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  const originalBaseMs = draftModelRetryDelays.baseMs;
  draftModelRetryDelays.baseMs = 1;
  try {
    db.upsertCustomer({ id: 'crm-x', name: '客户夕' });
    const f1 = segment(db, 'crm-x', 'rx:a', 'rx', '话题一', '2026-08-25T05:00:00Z', '聊了第一个话题', '第一个话题的分段摘要');
    const f2 = segment(db, 'crm-x', 'rx2:a', 'rx2', '话题二', '2026-08-25T07:00:00Z', '聊了第二个话题', '第二个话题的分段摘要');
    const failing = { llm: { provider: 'fake', model: 'relay' },
      models: { complete: async () => ({ stopReason: 'error', errorMessage: 'Request timed out.', content: [] }) } } as any;
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), failing);
    const queued = service.enqueue('crm-x', [f1.id, f2.id]);
    await waitForFailed(db, queued[0]!.jobId);
    const failed = db.listFailedDraftJobs();
    assert.equal(failed.length, 1);
    // 执行时回写种子：失败任务的 sourceEventIds 就是当天真实参与片段集合。
    assert.deepEqual(failed[0].sourceEventIds.sort(), [f1.id, f2.id].sort());
  } finally { draftModelRetryDelays.baseMs = originalBaseMs; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: dismissing a batch soft-deletes unwritten items and keeps written ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-y', name: '客户尧' });
    const frag = segment(db, 'crm-y', 'ry:a', 'ry', '话题', '2026-08-25T05:00:00Z', '沟通了部署');
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued = service.enqueue('crm-y', [frag.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch = db.listDraftBatches('crm-y')[0];
    // dismiss：未写入项（followup/workhour）软删除为 dismissed，批次状态刷新为 stale。
    const dismissed = service.dismissBatch(batch.id);
    assert.ok(dismissed.items!.every((item) => item.status === 'dismissed'));
    assert.equal(dismissed.status, 'stale');
    assert.throws(() => service.dismissBatch('not-exist'), /draft batch not found/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: dismissing a single item soft-deletes only that item and rejects written ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-d', name: '客户笛' });
    const frag = segment(db, 'crm-d', 'rd:a', 'rd', '话题', '2026-08-25T05:00:00Z', '沟通了上线');
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued = service.enqueue('crm-d', [frag.id]);
    await waitForJob(db, queued[0]!.jobId);
    const batch = db.listDraftBatches('crm-d')[0];
    const [followup, workhour] = batch.items!;
    // 一条已写入、一条待处理：单条忽略只软删除目标项，同批已写入项不受影响。
    db.setDraftItemExecution(workhour.id, 'written', { result: { ok: true } });
    const dismissed = service.dismissItem(followup.id);
    assert.equal(dismissed.status, 'dismissed');
    assert.equal(db.getDraftItem(workhour.id)?.status, 'written');
    // 已写入项拒绝忽略（防止误删审计轨迹）；不存在的条目同样报错。
    assert.throws(() => service.dismissItem(workhour.id), /已写入/);
    assert.throws(() => service.dismissItem('not-exist'), /draft item not found/);
    // 全部项进入终态（written/dismissed）后批次不再有待处理项，与 Web 已忽略 tab / actionableItemCount 口径一致。
    assert.equal(db.getDraftBatch(batch.id)!.items!.every((item) => ['written', 'dismissed', 'stale'].includes(item.status)), true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function waitForFailed(db: WorkbenchDatabase, jobId: string): Promise<void> {
  for (let i = 0; i < 2000 && db.getDraftJob(jobId)?.status !== 'failed'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(db.getDraftJob(jobId)?.status, 'failed');
}

test('workbench: stale batch heals on re-enqueue and regenerate works from CLI route semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-s', name: '客户斯' });
    const f1 = segment(db, 'crm-s', 'r5:a', 'r5', '话题A', '2026-08-25T01:00:00Z', '客服反馈一个需求，希望支持批量导出，另外需要帮忙做一次数据迁移');
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      // 静态提案按事件 id 引用（upsert 复用同一行），每轮生成复用：首轮即含 suggestion+operations。
      { type: 'suggestion', title: '批量导出需求', summary: '客服反馈希望支持批量导出', evidence_refs: [f1.id] },
      { type: 'operations', title: '数据迁移请求', summary: '客户需要帮忙做一次数据迁移', evidence_refs: [f1.id] },
    ]));
    const queued1 = service.enqueue('crm-s', [f1.id]);
    await waitForJob(db, queued1[0].jobId);
    const original = db.listDraftBatches('crm-s')[0];
    // followup+workhour 结构化 + LLM 的 suggestion/operations 提案。
    assert.equal(original.items?.length, 4);
    // 重新归属（内容变化）后旧批次作废。
    const changed = db.upsertSourceEvent({ customerId: 'crm-s', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r5:a',
      title: '话题A', occurredAt: '2026-08-25T01:00:00Z', attributionStatus: 'confirmed',
      payload: { recordingId: 'r5', speakers: ['CSM'], transcript: '客服反馈一个需求，希望支持批量导出，另外需要帮忙做一次数据迁移，下周还要升级服务器' } });
    const queued2 = service.enqueue('crm-s', [changed.id]);
    await waitForJob(db, queued2[0].jobId);
    const stale = db.getDraftBatch(original.id)!;
    assert.equal(stale.status, 'stale');
    const healed = db.listDraftBatches('crm-s').find((batch) => batch.status !== 'stale');
    assert.ok(healed, '重新归属后应生成新批次');
    // 运维请求信号（“需要帮忙做一次数据迁移”）在新内容里应被识别。
    assert.ok(healed!.items?.some((item) => item.type === 'operations'), '应生成运维工单草稿');
    // regenerate 强制重新生成。
    const forced = service.regenerate(healed!.id);
    await waitForJob(db, forced[0].jobId);
    assert.ok(db.listDraftBatches('crm-s').filter((batch) => batch.status !== 'stale').length >= 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

function fakeMcpForDrafts(): any {
  return { listTools: () => [], isWrite: () => false, resolve: () => undefined,
    call: async () => ({ text: '', isError: false }) } as any;
}

// 模拟纷享 CRM MCP 的最小工具面：describe 工具名带 create 但只读表单；data_record_create 才是写。
function fakeCrmMcp(responseText: string): any {
  const tools = [
    { publicName: 'mcp__crm__data_describe_get-create-form', server: 'crm', rawName: 'data_describe_get-create-form', description: '获取新建表单布局字段信息' },
    { publicName: 'mcp__crm__data_record_create', server: 'crm', rawName: 'data_record_create', description: '创建生成指定对象的一条新记录' },
  ];
  return {
    listTools: () => tools,
    isWrite: (_server: string, rawName: string) => /create/.test(rawName) && !/describe|query|get|search|list/.test(rawName),
    resolve: (publicName: string) => tools.find((tool) => tool.publicName === publicName),
    call: async (publicName: string, args: unknown) => {
      calls.push({ publicName, args });
      return { text: responseText, isError: false };
    },
  } as any;
}
const calls: Array<{ publicName: string; args: unknown }> = [];

test('workbench: followup drafts write to CRM data_record_create with customer binding and surface business errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-f', name: '客户福', sourceObject: 'object_Umwnn__c' });
    const event = db.upsertSourceEvent({ customerId: 'crm-f', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r7:t1:x',
      title: '沟通了报表需求', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r7', speaker: 'CSM', transcript: '沟通了报表需求，客户希望支持导出' }, attributionStatus: 'confirmed' });
    calls.length = 0;
    const mcp = fakeCrmMcp('{"resultCode":"SUCCESS","data":{"id":"rec-1"}}');
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([]));
    const queued = service.enqueue('crm-f', [event.id]);
    for (let i = 0; i < 40 && db.getDraftJob(queued[0].jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const batch = db.listDraftBatches('crm-f')[0];
    const followup = batch.items!.find((item) => item.type === 'followup')!;
    // 绑定到真正的写工具，而不是描述表单的只读工具。
    assert.equal(followup.targetTool, 'mcp__crm__data_record_create');
    assert.equal(followup.targetArguments.object_api_name, 'ActiveRecordObj');
    assert.equal(followup.targetArguments.apiName, 'CreateRecordsByData');
    assert.deepEqual(followup.targetArguments.object_data.related_object_data,
      [{ describe_api_name: 'object_Umwnn__c', id: 'crm-f', name: '客户福' }]);
    assert.deepEqual(followup.targetArguments.object_data.related_api_names, ['object_Umwnn__c']);
    assert.ok(!followup.validationErrors.length);
    // 预览→确认→执行成功。
    const preview = await service.preview(batch.id, [followup.id]);
    assert.equal(preview.items[0].validationErrors.length, 0);
    const written = await service.confirm(batch.id, preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    assert.equal(written.items[0].status, 'written');
    assert.equal(calls[0]?.publicName, 'mcp__crm__data_record_create');
    // 业务失败（resultCode != SUCCESS）必须转成失败状态而不是假成功。
    db.upsertCustomer({ id: 'crm-g', name: '客户贵', sourceObject: 'object_Umwnn__c' });
    const event2 = db.upsertSourceEvent({ customerId: 'crm-g', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r8:t1:x',
      title: '又沟通了一次', occurredAt: '2026-08-25T06:00:00Z',
      payload: { recordingId: 'r8', speaker: 'CSM', transcript: '又沟通了一次需求' }, attributionStatus: 'confirmed' });
    calls.length = 0;
    const failing = new HemoryDraftService(db, fakeCrmMcp('{"resultCode":"USER_TOOL_NOT_EXIST"}'), fakeModelRuntime([]));
    const queued2 = failing.enqueue('crm-g', [event2.id]);
    for (let i = 0; i < 40 && db.getDraftJob(queued2[0].jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const batch2 = db.listDraftBatches('crm-g')[0];
    const followup2 = batch2.items!.find((item) => item.type === 'followup')!;
    const preview2 = await failing.preview(batch2.id, [followup2.id]);
    const result2 = await failing.confirm(batch2.id, preview2.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    assert.equal(result2.items[0].status, 'failed');
    assert.match(result2.items[0].error ?? '', /USER_TOOL_NOT_EXIST/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: followup drafts bind the after-sales object for legacy AccountObj customers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 历史客户来自 AccountObj（source_object 为 NULL），本地存在同名售后客户记录。
    db.upsertCustomer({ id: 'crm-after', name: '客户夏', sourceObject: 'object_Umwnn__c' });
    db.upsertCustomer({ id: 'crm-legacy', name: '客户夏', sourceObject: 'object_Umwnn__c' });
    (db as any).db.prepare("UPDATE customers SET source_object=NULL WHERE id='crm-legacy'").run();
    const event = db.upsertSourceEvent({ customerId: 'crm-legacy', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r10:t1:x',
      title: '沟通续约', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r10', speaker: 'CSM', transcript: '沟通了续约和报价' }, attributionStatus: 'confirmed' });
    const service = new HemoryDraftService(db, fakeCrmMcp('{"resultCode":"SUCCESS","data":{"id":"rec-2"}}'), fakeModelRuntime([]));
    const queued = service.enqueue('crm-legacy', [event.id]);
    for (let i = 0; i < 40 && db.getDraftJob(queued[0].jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const batch = db.listDraftBatches('crm-legacy')[0];
    const followup = batch.items!.find((item) => item.type === 'followup')!;
    // 关联到同名售后客户的 _id，而不是 AccountObj 老客户自身的 id。
    assert.deepEqual(followup.targetArguments.object_data.related_object_data,
      [{ describe_api_name: 'object_Umwnn__c', id: 'crm-after', name: '客户夏' }]);
    assert.ok(!followup.validationErrors.length);
    // 无同名售后客户时必须报校验错误，不允许静默关联错误对象。
    db.upsertCustomer({ id: 'crm-orphan', name: '孤儿客户', sourceObject: 'object_Umwnn__c' });
    (db as any).db.prepare("UPDATE customers SET source_object=NULL WHERE id='crm-orphan'").run();
    const event2 = db.upsertSourceEvent({ customerId: 'crm-orphan', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r11:t1:x',
      title: '孤儿沟通', occurredAt: '2026-08-25T06:00:00Z',
      payload: { recordingId: 'r11', speaker: 'CSM', transcript: '一次无法归属对象的沟通' }, attributionStatus: 'confirmed' });
    const queued2 = service.enqueue('crm-orphan', [event2.id]);
    for (let i = 0; i < 40 && db.getDraftJob(queued2[0].jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const batch2 = db.listDraftBatches('crm-orphan')[0];
    const followup2 = batch2.items!.find((item) => item.type === 'followup')!;
    assert.ok(followup2.validationErrors.some((message) => message.includes('object_Umwnn__c')));
    assert.equal(followup2.status, 'draft');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// 模拟 ONES MCP 的最小工具面：get_issue_fields 只读字段契约，create_new_issue 才是写。
function fakeOnesMcp(options: { fieldValues?: Array<Record<string, unknown>>; requiredExtra?: Array<{ uuid: string; name: string }> } = {}): any {
  const tools = [
    { publicName: 'mcp__ones__create_new_issue', server: 'ones', rawName: 'create_new_issue', description: 'Create a new issue' },
    { publicName: 'mcp__ones__get_issue_fields', server: 'ones', rawName: 'get_issue_fields', description: 'Get issue fields of an issue type' },
  ];
  const calls: Array<{ publicName: string; args: unknown }> = [];
  const requiredExtras = options.requiredExtra ?? [];
  const mcp = {
    listTools: () => tools,
    isWrite: (_server: string, rawName: string) => /create_new_issue/.test(rawName),
    resolve: (publicName: string) => tools.find((tool) => tool.publicName === publicName),
    call: async (publicName: string, args: any) => {
      calls.push({ publicName, args });
      if (publicName === 'mcp__ones__get_issue_fields') {
        const list = [
          { uuid: 'field001', name: '标题', required: true, built_in: true, can_be_created: true, field_type_uuid: 'name' },
          { uuid: 'field003', name: '创建者', required: true, built_in: true, can_be_created: true, field_type_uuid: 'creator' },
          { uuid: 'field004', name: '负责人', required: true, built_in: true, can_be_created: true, field_type_uuid: 'assign' },
          { uuid: 'field005', name: '状态', required: true, built_in: true, can_be_created: true, field_type_uuid: 'status' },
          { uuid: 'field006', name: '所属项目', required: true, built_in: true, can_be_created: true, field_type_uuid: 'project' },
          { uuid: 'field007', name: '工作项类型', required: true, built_in: true, can_be_created: true, field_type_uuid: 'issue_type' },
          { uuid: 'JrvswW8P', name: '客户信息', required: true, built_in: false, can_be_created: true, field_type_uuid: 'single_option' },
          { uuid: 'field016', name: '描述', required: true, built_in: true, can_be_created: true, field_type_uuid: 'rich_desc' },
          ...requiredExtras.map((field) => ({ uuid: field.uuid, name: field.name, required: true, built_in: false, can_be_created: true, field_type_uuid: 'single_option' })),
        ];
        return { text: JSON.stringify({ result: 'SUCCESS', data: { list } }), isError: false };
      }
      return { text: JSON.stringify({ result: 'SUCCESS', data: { uuid: 'issue-new' } }), isError: false };
    },
    calls,
  };
  return mcp;
}

async function waitDraftJob(db: WorkbenchDatabase, jobId: string): Promise<void> {
  for (let i = 0; i < 100 && db.getDraftJob(jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(db.getDraftJob(jobId)?.status, 'succeeded');
}

test('workbench: ONES work-item drafts carry minimal required arguments with option binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-ones-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-o', name: '客户欧', sourceObject: 'object_Umwnn__c' });
    db.upsertIdentity('crm-o', 'ones_customer_option', 'opt-77', '客户欧', 'confirmed');
    const event = db.upsertSourceEvent({ customerId: 'crm-o', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r20:t1:x',
      title: '客户反馈需求', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r20', speaker: 'CSM', transcript: '客户希望支持批量导出的需求' }, attributionStatus: 'confirmed' });
    const mcp = fakeOnesMcp();
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([
      { type: 'suggestion', title: '支持批量导出', summary: '客户希望支持批量导出的需求', evidence_refs: [event.id],
        fields: { ones_required: { '建议类型': '新需求', '实例部署类型': '私有云', '所属模块': '导入导出', '优先级': 'P2' } } },
    ]));
    const queued = service.enqueue('crm-o', [event.id]);
    await waitDraftJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-o')[0];
    const suggestion = batch.items!.find((item) => item.type === 'suggestion')!;
    // 最小必填参数集：项目/类型/标题（顶层 title）+ 客户字段/描述/必填项（fieldValues）。
    assert.equal(suggestion.targetTool, 'mcp__ones__create_new_issue');
    assert.equal(suggestion.targetArguments.projectID, 'GL3ysesFPdnAQNIU');
    assert.equal(suggestion.targetArguments.issueTypeID, 'A99xMfkg');
    // create_new_issue 无 summary/description 顶层参数：标题走 title，Hemory 摘要写入 field016。
    assert.equal(suggestion.targetArguments.title, suggestion.title);
    assert.equal(suggestion.targetArguments.summary, undefined);
    const sugValues = suggestion.targetArguments.fieldValues as Array<Record<string, string>>;
    assert.ok(sugValues.some((value) => value.fieldID === 'JrvswW8P' && value.value === 'opt-77'));
    assert.ok(sugValues.some((value) => value.fieldID === 'field016' && value.value === suggestion.summary));
    assert.ok(!suggestion.validationErrors.length);
    // 预览触发 get_issue_fields 预检：必填项已覆盖时不报错。
    const preview = await service.preview(batch.id, [suggestion.id]);
    assert.equal(preview.items[0].validationErrors.length, 0);
    // 确认后以最小参数精确调用写工具。
    const written = await service.confirm(batch.id, preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    assert.equal(written.items[0].status, 'written');
    const createCall = mcp.calls.find((call) => call.publicName === 'mcp__ones__create_new_issue')!;
    assert.equal(createCall.args.title, suggestion.title);
    assert.equal(createCall.args.summary, undefined);
    const callValues = createCall.args.fieldValues as Array<Record<string, string>>;
    assert.ok(callValues.some((value) => value.fieldID === 'JrvswW8P' && value.value === 'opt-77'));
    assert.ok(callValues.some((value) => value.fieldID === 'field016' && value.value === suggestion.summary));
    // displayFields：最小必填项结构化展示；客户信息在名称与选项名一致时只显示一个名字；必填项 UUID 反解成名称。
    const customer = db.getCustomer('crm-o')!;
    const fields = draftDisplayFields(db, suggestion, customer);
    assert.deepEqual(fields.map((field) => field.label), ['所属项目', '工作项类型', '标题', '客户信息', '建议类型', '实例部署类型', '所属模块', '优先级', '描述']);
    assert.equal(fields.find((field) => field.key === 'customer')!.value, '客户欧');
    // 无 AI 提案的建议草稿：全部必填项都有兜底值（零缺失契约），预检不因缺项拦截。
    assert.equal(fields.find((field) => field.key === 'PYbGEZmN')!.value, '新需求');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: ONES drafts apply deployment type from CRM usage version over model proposals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-ones-deploy-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 公有云版客户：模型即使提案私有云（或漏提），fieldValues 也要覆盖为公有云 UUID。
    db.upsertCustomer({ id: 'crm-cloud', name: '客户云', sourceObject: 'object_Umwnn__c', usageVersion: '公有云版' });
    db.upsertIdentity('crm-cloud', 'ones_customer_option', 'opt-cloud', '客户云', 'confirmed');
    const event = db.upsertSourceEvent({ customerId: 'crm-cloud', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r30:t1:x',
      title: '客户反馈需求', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r30', speaker: 'CSM', transcript: '客户希望支持批量导出的需求' }, attributionStatus: 'confirmed' });
    const mcp = fakeOnesMcp();
    // 静态提案：crm-cloud 的 suggestion + 后续 priv 场景的 ticket + old 场景的 suggestion（按事件 externalId 后插入前无法引用 id，
    // 这里用同一批 placeholder 引用让门控回退到整批事件判定；部署类型覆盖与提案无关，按 CRM 使用版本确定性覆盖）。
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([
      { type: 'suggestion', title: '支持批量导出', summary: '客户希望支持批量导出的需求', evidence_refs: [event.id] },
      { type: 'ticket', title: '报错工单', summary: '客户遇到报错工单无法使用', evidence_refs: [event.id] },
    ]));
    const queued = service.enqueue('crm-cloud', [event.id]);
    await waitDraftJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-cloud')[0];
    const suggestion = batch.items!.find((item) => item.type === 'suggestion')!;
    const sugValues = suggestion.targetArguments.fieldValues as Array<Record<string, string>>;
    assert.ok(sugValues.some((value) => value.fieldID === 'HS5u8PNB' && value.value === 'Fzg8dBCT'), '公有云版客户→公有云 UUID');
    // 零缺失：无模型提案时建议草稿的全部规格字段都有值（兜底 + 覆盖）。
    for (const fieldID of ['PYbGEZmN', 'HS5u8PNB', 'field054', 'field012']) {
      assert.ok(sugValues.some((value) => value.fieldID === fieldID && value.value), `${fieldID} 必填项有值`);
    }
    const preview = await service.preview(batch.id, [suggestion.id]);
    assert.equal(preview.items[0].validationErrors.length, 0);
    // 私有部署客户：覆盖为私有云。
    db.upsertCustomer({ id: 'crm-priv', name: '客户私', sourceObject: 'object_Umwnn__c', usageVersion: '私有部署按年订阅版' });
    db.upsertIdentity('crm-priv', 'ones_customer_option', 'opt-priv', '客户私', 'confirmed');
    const privEvent = db.upsertSourceEvent({ customerId: 'crm-priv', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r31:t1:x',
      title: '客户报错工单', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r31', speaker: 'CSM', transcript: '客户遇到一个报错工单无法使用', summary: '客户反馈线上报错工单无法使用' }, attributionStatus: 'confirmed' });
    const queuedPriv = service.enqueue('crm-priv', [privEvent.id]);
    await waitDraftJob(db, queuedPriv[0].jobId);
    const privBatch = db.listDraftBatches('crm-priv')[0];
    const ticket = privBatch.items!.find((item) => item.type === 'ticket')!;
    const ticketValues = ticket.targetArguments.fieldValues as Array<Record<string, string>>;
    assert.ok(ticketValues.some((value) => value.fieldID === 'HS5u8PNB' && value.value === 'KFewLptQ'), '私有部署客户→私有云 UUID');
    // 未同步使用版本的旧客户：按私有云兜底。
    db.upsertCustomer({ id: 'crm-old', name: '客户旧', sourceObject: 'object_Umwnn__c' });
    db.upsertIdentity('crm-old', 'ones_customer_option', 'opt-old', '客户旧', 'confirmed');
    const oldEvent = db.upsertSourceEvent({ customerId: 'crm-old', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r32:t1:x',
      title: '客户反馈需求', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r32', speaker: 'CSM', transcript: '客户希望支持批量导出的需求' }, attributionStatus: 'confirmed' });
    const queuedOld = service.enqueue('crm-old', [oldEvent.id]);
    await waitDraftJob(db, queuedOld[0].jobId);
    const oldBatch = db.listDraftBatches('crm-old')[0];
    const oldSuggestion = oldBatch.items!.find((item) => item.type === 'suggestion')!;
    const oldValues = oldSuggestion.targetArguments.fieldValues as Array<Record<string, string>>;
    assert.ok(oldValues.some((value) => value.fieldID === 'HS5u8PNB' && value.value === 'KFewLptQ'), '未同步使用版本→私有云兜底');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: ONES drafts fall back to same-name after-sales customer option and preflight flags missing required fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-ones-fallback-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 草稿绑在历史旧行（source_object 为 NULL），同名售后客户有 confirmed option。
    db.upsertCustomer({ id: 'crm-after-o', name: '客户安', sourceObject: 'object_Umwnn__c' });
    db.upsertIdentity('crm-after-o', 'ones_customer_option', 'opt-88', '客户安', 'confirmed');
    db.upsertCustomer({ id: 'crm-legacy-o', name: '客户安', sourceObject: 'object_Umwnn__c' });
    (db as any).db.prepare("UPDATE customers SET source_object=NULL WHERE id='crm-legacy-o'").run();
    const event = db.upsertSourceEvent({ customerId: 'crm-legacy-o', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r21:t1:x',
      title: '客户工单', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r21', speaker: 'CSM', transcript: '客户遇到一个报错工单无法使用', summary: '客户反馈线上报错工单无法使用' }, attributionStatus: 'confirmed' });
    const mcp = fakeOnesMcp({ requiredExtra: [{ uuid: 'extra-1', name: '严重程度' }] });
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([
      { type: 'ticket', title: '报错工单', summary: '客户遇到报错工单无法使用', evidence_refs: [event.id] },
      { type: 'suggestion', title: '新需求', summary: '客户提出了标品还不支持的新功能需求', evidence_refs: [event.id] },
    ]));
    const queued = service.enqueue('crm-legacy-o', [event.id]);
    await waitDraftJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-legacy-o')[0];
    const ticket = batch.items!.find((item) => item.type === 'ticket')!;
    // 同名回退：fieldValues 使用同名售后客户的 option。
    const ticketValues = ticket.targetArguments.fieldValues as Array<Record<string, string>>;
    assert.ok(ticketValues.some((value) => value.fieldID === 'JrvswW8P' && value.value === 'opt-88'));
    assert.ok(!ticket.validationErrors.length);
    // 预检发现 get_issue_fields 的额外必填字段未填写。
    const preview = await service.preview(batch.id, [ticket.id]);
    assert.ok(preview.items[0].validationErrors.some((message) => /ONES 必填字段未填写: 严重程度\(extra-1\)/.test(message)));
    // 未解析客户 option 的草稿报可操作错误（静态提案引用不合法时按整批事件门控，suggestion 信号命中）。
    db.upsertCustomer({ id: 'crm-no-opt', name: '客户宁', sourceObject: 'object_Umwnn__c' });
    const event2 = db.upsertSourceEvent({ customerId: 'crm-no-opt', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r22:t1:x',
      title: '另一个需求', occurredAt: '2026-08-25T06:00:00Z',
      payload: { recordingId: 'r22', speaker: 'CSM', transcript: '客户提出了新功能需求，说标品还不支持，希望支持批量导出' }, attributionStatus: 'confirmed' });
    const queued2 = service.enqueue('crm-no-opt', [event2.id]);
    await waitDraftJob(db, queued2[0].jobId);
    const batch2 = db.listDraftBatches('crm-no-opt')[0];
    const suggestion2 = batch2.items!.find((item) => item.type === 'suggestion')!;
    assert.ok(suggestion2.validationErrors.some((message) => /客户缺少已确认的 ONES 客户信息 option ID（.*请刷新客户同步.*）/.test(message)));
    assert.equal(suggestion2.status, 'draft');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// 模拟 ONES MCP 的工时工具面：get_manhour_mode 只读；add_workhour_in_{mode} 按实例模式写入。
// create_new_issue 的描述刻意带 manhour 字样，复现宽松正则误绑的真实事故。
// modeResponse 可覆盖模式返回原文（默认 {"result":"<mode>"}，用于复现状态信封形状）。
function fakeOnesWorkhourMcp(options: { mode?: string; modeResponse?: string; writeResponse?: string; failModeCall?: boolean } = {}): any {
  const tools = [
    { publicName: 'mcp__ones__create_new_issue', server: 'ones', rawName: 'create_new_issue', description: 'Create a new issue. Do not use add-work/manhour tools first.' },
    { publicName: 'mcp__ones__get_manhour_mode', server: 'ones', rawName: 'get_manhour_mode', description: 'Get manhour mode (simple or summary)' },
    { publicName: 'mcp__ones__add_workhour_in_simple_mode', server: 'ones', rawName: 'add_workhour_in_simple_mode', description: 'Add a manhour record in simple mode for a specific issue.' },
    { publicName: 'mcp__ones__add_workhour_in_summary_mode', server: 'ones', rawName: 'add_workhour_in_summary_mode', description: 'Add a manhour record in summary mode for a specific issue.' },
  ];
  const calls: Array<{ publicName: string; args: any }> = [];
  const mcp: any = {
    listTools: () => tools,
    isWrite: (_server: string, rawName: string) => /^(create_new_issue|add_workhour)/.test(rawName),
    resolve: (publicName: string) => tools.find((tool) => tool.publicName === publicName),
    call: async (publicName: string, args: any) => {
      calls.push({ publicName, args });
      if (publicName === 'mcp__ones__get_manhour_mode') {
        if (options.failModeCall) return { text: 'mode tool error', isError: true };
        if (options.modeResponse) return { text: options.modeResponse, isError: false };
        return { text: JSON.stringify({ result: mcp.currentMode ?? options.mode ?? 'simple' }), isError: false };
      }
      return { text: options.writeResponse ?? JSON.stringify({ result: 'SUCCESS', data: { id: 'worklog-1' } }), isError: false };
    },
    calls,
    currentMode: options.mode ?? 'simple',
  };
  return mcp;
}

function manhourIssue(db: WorkbenchDatabase, customerId: string) {
  return db.upsertSourceEvent({ customerId, sourceSystem: 'ones', sourceType: 'customer_manhour', externalId: 'KHGS-9001',
    title: '售后客户', occurredAt: '2026-08-20T00:00:00Z', attributionStatus: 'confirmed', payload: {} });
}

test('workbench: workhour drafts bind the mode-specific ONES tool and write with startTime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workhour-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-wh', name: '客户卫', sourceObject: 'object_Umwnn__c' });
    manhourIssue(db, 'crm-wh');
    const fragment = segment(db, 'crm-wh', 'rw:a', 'rw', '年费方案', '2026-08-25T05:00:00Z', '与客户讨论了年费方案，投入两小时');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T05:00:00Z','$.endAt','2026-08-25T05:30:00Z') WHERE id=?").run(fragment.id);
    const mcp = fakeOnesWorkhourMcp({ mode: 'simple' });
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([]));
    const queued = service.enqueue('crm-wh', [fragment.id]);
    await waitDraftJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-wh')[0];
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    // 工具按实例模式 rawName 精确绑定，绝不落在描述带 manhour 的 create_new_issue 上。
    assert.equal(workhour.targetTool, 'mcp__ones__add_workhour_in_simple_mode');
    assert.ok(!workhour.validationErrors.length, JSON.stringify(workhour.validationErrors));
    assert.equal(workhour.targetArguments.issueID, 'KHGS-9001');
    assert.equal(workhour.targetArguments.hours, 0.5);
    assert.equal(workhour.targetArguments.startTime, '2026-08-25T13:00:00+08:00');
    // 预览（含模式一致性预检）与确认写入：调用参数即草稿参数。
    const preview = await service.preview(batch.id, [workhour.id]);
    assert.equal(preview.items[0].validationErrors.length, 0);
    const written = await service.confirm(batch.id, preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    assert.equal(written.items[0].status, 'written');
    const writeCall = mcp.calls.find((call) => call.publicName === 'mcp__ones__add_workhour_in_simple_mode')!;
    assert.deepEqual(writeCall.args, { issueID: 'KHGS-9001', hours: 0.5, startTime: '2026-08-25T13:00:00+08:00',
      description: workhour.targetArguments.description });
    // 实例模式切换后，旧绑定在预检时被拒绝，不允许带着错工具写入。
    mcp.currentMode = 'summary';
    db.upsertCustomer({ id: 'crm-wh2', name: '客户温', sourceObject: 'object_Umwnn__c' });
    manhourIssue(db, 'crm-wh2');
    const fragment2 = segment(db, 'crm-wh2', 'rw2:a', 'rw2', '扩容计划', '2026-08-25T07:00:00Z', '与客户讨论扩容，投入一小时');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T07:00:00Z','$.endAt','2026-08-25T08:00:00Z') WHERE id=?").run(fragment2.id);
    const service2 = new HemoryDraftService(db, mcp, fakeModelRuntime([]));
    const queued2 = service2.enqueue('crm-wh2', [fragment2.id]);
    await waitDraftJob(db, queued2[0].jobId);
    const batch2 = db.listDraftBatches('crm-wh2')[0];
    const workhour2 = batch2.items!.find((item) => item.type === 'workhour')!;
    assert.equal(workhour2.targetTool, 'mcp__ones__add_workhour_in_summary_mode');
    // 模式与工具不一致（summary 草稿 + simple 实例）在预检报错，不允许带错工具写入。
    mcp.currentMode = 'simple';
    const mismatchPreview = await service2.preview(batch2.id, [workhour2.id]);
    assert.ok(mismatchPreview.items[0].validationErrors.some((message) => message.includes('与草稿绑定工具不一致')));
    // 把已生成草稿的工具改成历史误绑的 create_new_issue：validate 必须拒绝。
    const legacyBound = db.updateDraftItem(workhour2.id, workhour2.version, { targetTool: 'mcp__ones__create_new_issue' })!;
    const legacyPreview = await service2.preview(batch2.id, [legacyBound.id]);
    assert.ok(legacyPreview.items[0].validationErrors.some((message) => message.includes('add_workhour_in_')));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: ONES business failure marks the draft failed and retryable instead of fake written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workhour-fail-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-fail', name: '客户费', sourceObject: 'object_Umwnn__c' });
    manhourIssue(db, 'crm-fail');
    const fragment = segment(db, 'crm-fail', 'rf:a', 'rf', '故障排查', '2026-08-25T06:00:00Z', '排查线上故障，投入一小时');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T06:00:00Z','$.endAt','2026-08-25T07:00:00Z') WHERE id=?").run(fragment.id);
    // ONES 以 isError=false 的正常内容返回业务失败（真实事故载荷）。
    const mcp = fakeOnesWorkhourMcp({ mode: 'simple',
      writeResponse: '{"result":"FAIL","errorCode":"InvalidParameter","errorMsg":"InvalidParameter issue title empty"}' });
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([]));
    const queued = service.enqueue('crm-fail', [fragment.id]);
    await waitDraftJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-fail')[0];
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    const preview = await service.preview(batch.id, [workhour.id]);
    const result = await service.confirm(batch.id, preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    assert.equal(result.items[0].status, 'failed');
    assert.match(result.items[0].error ?? '', /ONES 回写业务失败 FAIL/);
    assert.match(result.items[0].error ?? '', /issue title empty/);
    // 失败草稿可重试（仍失败但不再卡死在 written）。
    const retried = await service.retry(workhour.id);
    assert.equal(retried.status, 'failed');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: workhour mode fetch failure only degrades that draft, not the batch job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workhour-mode-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-mode', name: '客户莫', sourceObject: 'object_Umwnn__c' });
    manhourIssue(db, 'crm-mode');
    const fragment = segment(db, 'crm-mode', 'rm:a', 'rm', '续约沟通', '2026-08-25T08:00:00Z', '沟通续约意向，投入半小时');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T08:00:00Z','$.endAt','2026-08-25T08:30:00Z') WHERE id=?").run(fragment.id);
    const mcp = fakeOnesWorkhourMcp({ failModeCall: true });
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([]));
    const queued = service.enqueue('crm-mode', [fragment.id]);
    await waitDraftJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-mode')[0];
    // 生成任务整体成功；工时草稿带“无法获取工时模式”校验错误。
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    assert.equal(workhour.status, 'draft');
    assert.ok(workhour.validationErrors.some((message) => message.includes('无法获取 ONES 工时模式')));
    // 其余草稿照常生成，不受工时模式获取失败影响。
    const followup = batch.items!.find((item) => item.type === 'followup')!;
    assert.ok(!followup.validationErrors.some((message) => message.includes('工时模式')));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// 「生成时缺售后客户匹配 → 定向刷新 ONES 同步 → 重查自愈」的注入回调：模拟同步期间入表新售后客户工作项。
// verifyReal=false 时复现 ONES 端确实没有该工作项（刷新后重查仍无）。
function manhourRefreshCallback(db: WorkbenchDatabase, options: { issueId?: string; fail?: boolean; delayMs?: number; calls?: string[] } = {}) {
  return async (customerId: string): Promise<number> => {
    options.calls?.push(customerId);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.fail) throw new Error('ONES MCP 未连接');
    if (options.issueId) {
      db.upsertSourceEvent({ customerId, sourceSystem: 'ones', sourceType: 'customer_manhour', externalId: options.issueId,
        title: '售后客户', occurredAt: '2026-08-26T00:00:00Z', attributionStatus: 'confirmed', payload: {} });
    }
    return 1;
  };
}

test('workbench: missing manhour issue triggers ONES refresh and the regenerated draft binds the new issue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workhour-heal-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-heal', name: '客户和', sourceObject: 'object_Umwnn__c' });
    const fragment = segment(db, 'crm-heal', 'rh:a', 'rh', '上线沟通', '2026-08-25T05:00:00Z', '与客户沟通上线排期，投入一小时');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T05:00:00Z','$.endAt','2026-08-25T06:00:00Z') WHERE id=?").run(fragment.id);
    const refreshCalls: string[] = [];
    const mcp = fakeOnesWorkhourMcp({ mode: 'simple' });
    // 本地无匹配 + 刷新回调模拟 ONES 同步拉到新建的售后客户工作项 KHGS-9100。
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([]), manhourRefreshCallback(db, { issueId: 'KHGS-9100', calls: refreshCalls }));
    const queued = service.enqueue('crm-heal', [fragment.id]);
    await waitDraftJob(db, queued[0].jobId);
    assert.deepEqual(refreshCalls, ['crm-heal']);
    const batch = db.listDraftBatches('crm-heal')[0];
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    // 刷新入表后重查命中：issueID 绑定新工作项，无「客户未绑定」校验错误。
    assert.equal(workhour.targetArguments.issueID, 'KHGS-9100');
    assert.ok(!workhour.validationErrors.some((message) => message.includes('客户未绑定')), JSON.stringify(workhour.validationErrors));
    const preview = await service.preview(batch.id, [workhour.id]);
    assert.equal(preview.items[0].validationErrors.length, 0);
    // 刷新后仍无匹配（ONES 端确实没建）：清掉 part1 刷新入库的工作项再重建，模拟重新生成时依旧缺匹配。
    db.db.prepare("DELETE FROM source_events WHERE source_system='ones' AND source_type='customer_manhour'").run();
    const refreshCalls2: string[] = [];
    const service2 = new HemoryDraftService(db, mcp, fakeModelRuntime([]), manhourRefreshCallback(db, { calls: refreshCalls2 }));
    const forced = service2.regenerate(batch.id);
    await waitDraftJob(db, forced[0].jobId);
    assert.deepEqual(refreshCalls2, ['crm-heal']);
    const healed = db.listDraftBatches('crm-heal').find((item) => item.id !== batch.id)!;
    const stillMissing = healed.items!.find((item) => item.type === 'workhour')!;
    assert.equal(stillMissing.targetArguments.issueID, '');
    assert.ok(stillMissing.validationErrors.some((message) => message.includes('已自动刷新 ONES 同步仍无匹配')), JSON.stringify(stillMissing.validationErrors));
    assert.ok(stillMissing.validationErrors.some((message) => message.includes('重新生成')));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: ONES refresh failure degrades to a validation error without failing the job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workhour-refresh-fail-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-rf', name: '客户任弗', sourceObject: 'object_Umwnn__c' });
    const fragment = segment(db, 'crm-rf', 'rrf:a', 'rrf', '故障复盘', '2026-08-25T06:00:00Z', '与客户复盘故障处理，投入两小时');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T06:00:00Z','$.endAt','2026-08-25T07:00:00Z') WHERE id=?").run(fragment.id);
    const service = new HemoryDraftService(db, fakeOnesWorkhourMcp({ mode: 'simple' }), fakeModelRuntime([]), manhourRefreshCallback(db, { fail: true }));
    const queued = service.enqueue('crm-rf', [fragment.id]);
    await waitDraftJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-rf')[0];
    // 生成任务整体成功；工时草稿带刷新失败与未绑定两条校验错误（降级不失败，与工时模式失败同哲学）。
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    assert.equal(workhour.status, 'draft');
    assert.ok(workhour.validationErrors.some((message) => message.includes('自动刷新 ONES 同步失败')));
    assert.ok(workhour.validationErrors.some((message) => message.includes('客户未绑定')));
    const followup = batch.items!.find((item) => item.type === 'followup')!;
    assert.ok(!followup.validationErrors.some((message) => message.includes('ONES 同步失败')));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: existing manhour match skips the ONES refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workhour-skip-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-skip', name: '客户司', sourceObject: 'object_Umwnn__c' });
    manhourIssue(db, 'crm-skip');
    const fragment = segment(db, 'crm-skip', 'rs:a', 'rs', '续约谈判', '2026-08-25T07:00:00Z', '与客户谈判续约条款，投入三小时');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T07:00:00Z','$.endAt','2026-08-25T08:00:00Z') WHERE id=?").run(fragment.id);
    const refreshCalls: string[] = [];
    const service = new HemoryDraftService(db, fakeOnesWorkhourMcp({ mode: 'simple' }), fakeModelRuntime([]), manhourRefreshCallback(db, { calls: refreshCalls }));
    const queued = service.enqueue('crm-skip', [fragment.id]);
    await waitDraftJob(db, queued[0].jobId);
    // 本地已有匹配：绝不发起定向刷新。
    assert.deepEqual(refreshCalls, []);
    const workhour = db.listDraftBatches('crm-skip')[0].items!.find((item) => item.type === 'workhour')!;
    assert.equal(workhour.targetArguments.issueID, 'KHGS-9001');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: concurrent same-customer jobs share one ONES refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workhour-dedupe-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-dp', name: '客户迪', sourceObject: 'object_Umwnn__c' });
    const day1 = segment(db, 'crm-dp', 'rdp:a', 'rdp', '部署方案', '2026-08-24T05:00:00Z', '与客户对齐部署方案，投入一小时');
    const day2 = segment(db, 'crm-dp', 'rdp:b', 'rdp', '验收准备', '2026-08-25T06:00:00Z', '与客户准备验收材料，投入两小时');
    // 跨天两个任务并发处理：刷新回调延迟 80ms 确保重叠窗口，两任务应共享同一次刷新。
    const refreshCalls: string[] = [];
    const service = new HemoryDraftService(db, fakeOnesWorkhourMcp({ mode: 'simple' }), fakeModelRuntime([]),
      manhourRefreshCallback(db, { issueId: 'KHGS-9200', delayMs: 80, calls: refreshCalls }));
    const queued = service.enqueue('crm-dp', [day1.id, day2.id]);
    assert.equal(queued.length, 2);
    await Promise.all(queued.map((job) => waitDraftJob(db, job.jobId)));
    assert.equal(refreshCalls.length, 1);
    for (const batch of db.listDraftBatches('crm-dp')) {
      const workhour = batch.items!.find((item) => item.type === 'workhour')!;
      assert.equal(workhour.targetArguments.issueID, 'KHGS-9200');
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: reopening the database repairs fake-written drafts with failure payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-draft-repair-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-rep', name: '客户任' });
    const batch = db.createDraftBatch({ customerId: 'crm-rep', fingerprint: 'fp-repair-1', sourceEventIds: [], generationVersion: 'v', generator: 'test' });
    const base = { batchId: batch.id, customerId: 'crm-rep', type: 'workhour' as const, title: '工时', summary: 's',
      fields: {}, targetSystem: 'ones', targetObject: '客户工时管理 / 售后客户', targetTool: 'mcp__ones__create_new_issue',
      targetArguments: { issueID: 'KHGS-9001' }, evidenceRefs: [], unknowns: [], validationErrors: [] };
    // 历史事故两例：ONES FAIL 载荷与 CRM save_status 未落库，均被标为 written。
    const badOnes = db.createDraftItem({ ...base,
      status: 'written', result: { response: '{"result":"FAIL","errorCode":"InvalidParameter","errorMsg":"InvalidParameter issue title empty"}' } });
    const badCrm = db.createDraftItem({ ...base, type: 'followup', targetSystem: 'crm', status: 'written',
      result: { response: '{"resultCode":"SUCCESS","data":{"save_status":"VALIDATION_BLOCKED","failure_reason":"validation blocked"}}' } });
    const good = db.createDraftItem({ ...base, status: 'written', result: { response: '{"result":"SUCCESS","data":{}}' } });
    db.close();

    const reopened = new WorkbenchDatabase(dir);
    assert.equal(reopened.getDraftItem(badOnes.id)?.status, 'failed');
    assert.match(reopened.getDraftItem(badOnes.id)?.error ?? '', /InvalidParameter issue title empty/);
    assert.equal(reopened.getDraftItem(badCrm.id)?.status, 'failed');
    assert.match(reopened.getDraftItem(badCrm.id)?.error ?? '', /VALIDATION_BLOCKED/);
    assert.equal(reopened.getDraftItem(good.id)?.status, 'written');
    const repairCount = (row: any) => Number(row.count);
    const first = repairCount((reopened as any).db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='repair_written_draft_status'").get());
    assert.equal(first, 2);
    reopened.close();

    // 幂等：再次打开不重复翻转、不重复审计。
    const again = new WorkbenchDatabase(dir);
    assert.equal(again.getDraftItem(badOnes.id)?.status, 'failed');
    const second = repairCount((again as any).db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='repair_written_draft_status'").get());
    assert.equal(second, 2);
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: parseOnesIssueFields tolerates unknown shapes and flags only caller-provided required fields', () => {
  assert.equal(parseOnesIssueFields('not json'), null);
  assert.equal(parseOnesIssueFields('{"result":"SUCCESS","data":{}}'), null);
  const fields = parseOnesIssueFields(JSON.stringify({ result: 'SUCCESS', data: { list: [
    { uuid: 'field001', name: '标题', required: true, built_in: true, can_be_created: true, field_type_uuid: 'name' },
    { uuid: 'field003', name: '创建者', required: true, built_in: true, can_be_created: true, field_type_uuid: 'creator' },
    { uuid: 'JrvswW8P', name: '客户信息', required: true, built_in: false, can_be_created: true, field_type_uuid: 'single_option',
      options: [{ uuid: 'opt-1', value: '客户一' }] },
    { uuid: 'PYbGEZmN', name: '建议类型', required: true, built_in: false, can_be_created: false, field_type_uuid: 'single_option' },
    { uuid: 'field016', name: '描述', required: true, built_in: true, can_be_created: true, field_type_uuid: 'rich_desc' },
  ] } }))!;
  assert.equal(fields.length, 5);
  assert.deepEqual(fields[2].options, [{ uuid: 'opt-1', value: '客户一' }]);
  // 自动填充（创建者）与 can_be_created=false 的字段不算缺失；描述 field016 必须出现在 fieldValues（无顶层 description 参数）。
  const missing = missingOnesRequiredFields(fields, [{ fieldID: 'JrvswW8P', value: 'opt-1' }, { fieldID: 'field016', value: 'x' }]);
  assert.equal(missing.length, 0);
  // 客户信息/描述缺值时报缺失。
  const missing2 = missingOnesRequiredFields(fields, []);
  assert.deepEqual(missing2.map((field) => field.uuid), ['JrvswW8P', 'field016']);
  // 选项 UUID 失效防护：字段带完整选项表（<30 条，未被 get_issue_fields 截断）时值必须在表内；
  // 客户信息等大选项集字段（30 条截断）无法证伪，跳过。
  assert.deepEqual(invalidOnesOptionValues(fields, [{ fieldID: 'JrvswW8P', value: 'opt-gone' }]), ['客户信息(JrvswW8P)=opt-gone']);
  assert.deepEqual(invalidOnesOptionValues(fields, [{ fieldID: 'JrvswW8P', value: 'opt-1' }]), []);
  const truncated = parseOnesIssueFields(JSON.stringify({ result: 'SUCCESS', data: { list: [
    { uuid: 'field900', name: '大选项集', required: false, built_in: false, can_be_created: true, field_type_uuid: 'single_option',
      options: Array.from({ length: 30 }, (_, i) => ({ uuid: `big-${i}`, value: `选项${i}` })) },
  ] } }))!;
  assert.deepEqual(invalidOnesOptionValues(truncated, [{ fieldID: 'field900', value: 'not-in-list' }]), []);
});

test('workbench: mapOnesDeskRequiredFields maps proposals and applies business defaults', () => {
  // AI 提案按字段名→选项名映射；运维工单缺省兜底（是否客户付费=否、运维工程师=吴孟淋、服务类目=其他）。
  const ops = mapOnesDeskRequiredFields('operations', { '服务类目': '系统巡检' });
  assert.deepEqual(ops, [
    { fieldID: 'KcwE8f1Y', value: 'E8jFkZn6' },
    { fieldID: 'M9vaUBPP', value: 'LLiv2UfC' },
    { fieldID: 'TioFkeZn', value: '5dP9HWdX' },
  ]);
  // 全缺省时兜底仍然生效（服务类目回退「其他」）。
  assert.deepEqual(mapOnesDeskRequiredFields('operations', undefined), [
    { fieldID: 'KcwE8f1Y', value: 'PYmJmnwg' },
    { fieldID: 'M9vaUBPP', value: 'LLiv2UfC' },
    { fieldID: 'TioFkeZn', value: '5dP9HWdX' },
  ]);
  // 无法识别的提案值回退默认值，而不是带病写入。
  assert.deepEqual(mapOnesDeskRequiredFields('operations', { '是否客户付费': '也许' })[1], { fieldID: 'M9vaUBPP', value: 'LLiv2UfC' });
  // 建议和反馈：优先级支持选项名与 UUID 直填。
  const sug = mapOnesDeskRequiredFields('suggestion', { '建议类型': '新需求', '优先级': 'P1', '实例部署类型': '私有云' });
  assert.ok(sug.some((value) => value.fieldID === 'PYbGEZmN' && value.value === '5qUVAY7m'));
  assert.ok(sug.some((value) => value.fieldID === 'field012' && value.value === '762U6awQ'));
  assert.ok(sug.some((value) => value.fieldID === 'HS5u8PNB' && value.value === 'KFewLptQ'));
  // 所属模块名映射到 search_for_modules 验证过的模块 UUID。
  assert.ok(mapOnesDeskRequiredFields('suggestion', { '所属模块': '事件' }).some((value) => value.fieldID === 'field054' && value.value === 'HhvtUuNJ'));
  // 工单：所属产品名映射；成员字段允许 8 位 UUID 直填。
  assert.ok(mapOnesDeskRequiredFields('ticket', { '所属产品': 'Desk 工单管理' }).some((value) => value.fieldID === 'field029' && value.value === 'FFpmuURAFJfgSqQ1'));
  assert.ok(mapOnesDeskRequiredFields('operations', { '运维工程师': 'abcd1234' }).some((value) => value.fieldID === 'TioFkeZn' && value.value === 'abcd1234'));
});

test('workbench: desk required fields never miss — defaults cover module/product, fuzzy labels resolve', () => {
  // 零缺失保证：suggestion/ticket 全缺省时每个规格字段都有兜底值。
  const sug = mapOnesDeskRequiredFields('suggestion', undefined);
  assert.deepEqual(sug.map((value) => value.fieldID).sort(), ['HS5u8PNB', 'PYbGEZmN', 'field012', 'field054']);
  assert.ok(sug.some((value) => value.fieldID === 'field054' && value.value === 'RbrMxh1n'), '所属模块兜底=功能扩展');
  assert.ok(sug.some((value) => value.fieldID === 'field012' && value.value === 'Lv5Tbmih'), '优先级兜底=P2');
  const ticket = mapOnesDeskRequiredFields('ticket', undefined);
  assert.ok(ticket.some((value) => value.fieldID === 'field029' && value.value === 'KuZfE9scKYpijpKk'), '所属产品兜底=Core 基础平台能力');
  assert.ok(ticket.some((value) => value.fieldID === 'CATNfrrF' && value.value === 'JuTTumjJ'), '环境类型兜底=PRD');
  assert.ok(ticket.some((value) => value.fieldID === 'Su4v8xFs' && value.value === 'SyPTtJdW'), '是否稳定复现兜底=偶现');
  // 模糊匹配纠偏：近似 label（模型输出「工时管理」而选项是「工时管理（登记工时&预估工时）」）唯一命中。
  assert.ok(mapOnesDeskRequiredFields('suggestion', { '所属模块': '工时管理' }).some((value) => value.fieldID === 'field054' && value.value === 'AC5rA1w8'));
  // 模糊匹配歧义（「甘特图」同时命中多个甘特图类选项）时回退兜底，不猜。
  const ambiguous = mapOnesDeskRequiredFields('suggestion', { '所属模块': '甘特图' });
  assert.ok(ambiguous.some((value) => value.fieldID === 'field054' && value.value === 'RbrMxh1n'), '歧义 label 回退兜底=功能扩展');
});

test('workbench: module options cover full category tree incl. performance efficiency', () => {
  // 完整类目树：效能管理类目存在且四个叶子都可精确映射（2026-08-28 search_for_modules 141/141 命中）。
  const perf = mapOnesDeskRequiredFields('suggestion', { '所属模块': 'Performance 效能管理' });
  assert.ok(perf.some((value) => value.fieldID === 'field054' && value.value === 'BjkWAPRj'), 'Performance 效能管理');
  for (const [label, uuid] of [['仪表盘', '2xGRM1Dk'], ['数据卡片', 'W1kPUZWx'], ['仪表盘模板&卡片模板', 'Wx5iGww1'], ['效能管理权限', 'XHNdBqX9']] as const) {
    const mapped = mapOnesDeskRequiredFields('suggestion', { '所属模块': label });
    assert.ok(mapped.some((value) => value.fieldID === 'field054' && value.value === uuid), `${label} → ${uuid}`);
  }
  // 「仪表盘」这类宽泛提案不能唯一包含式命中（同时命中 Dashboard 仪表盘/仪表盘/仪表盘模板&卡片模板），回退兜底不猜。
  const vague = mapOnesDeskRequiredFields('suggestion', { '所属模块': '仪表盘模板&卡片模板' });
  assert.ok(vague.some((value) => value.fieldID === 'field054' && value.value === 'Wx5iGww1'), '仪表盘模板&卡片模板精确命中');
  // 其他新增类目抽查：账号安全、系统配置、测试管理。
  assert.ok(mapOnesDeskRequiredFields('suggestion', { '所属模块': '单点登录' }).some((value) => value.fieldID === 'field054' && value.value === 'R72Lci4T'));
  assert.ok(mapOnesDeskRequiredFields('suggestion', { '所属模块': '系统日志' }).some((value) => value.fieldID === 'field054' && value.value === 'AVxWChdy'));
  assert.ok(mapOnesDeskRequiredFields('suggestion', { '所属模块': '用例库' }).some((value) => value.fieldID === 'field054' && value.value === 'WKCt6kV3'));
});

test('workbench: classification hints reference every ticket product option label', () => {
  // 防漂移：product 分类指引必须覆盖所属产品选项表的全部 label 字面值——指引提到选项表里
  // 不存在的名字会把 LLM 引向 invalid label；未来加选项忘更新指引也会在此暴露。
  const productHints = ONES_DESK_CLASSIFICATION_HINTS.product.join('\n');
  const productSpec = ONES_DESK_FIELD_SPECS.ticket.find((spec) => spec.label === '所属产品');
  assert.ok(productSpec?.options, 'ticket 所属产品选项表存在');
  const missing = Object.keys(productSpec.options!).filter((label) => !productHints.includes(label));
  assert.deepEqual(missing, [], `指引未覆盖的所属产品选项: ${missing.join('、')}`);
});

test('workbench: deployment type resolves from CRM usage version deterministically', () => {
  // label 与 CRM 选项 value 两种表示都接受（CRM query 返回的是 value）。
  assert.equal(resolveDeploymentType('公有云版'), '公有云');
  assert.equal(resolveDeploymentType('option1'), '公有云');
  assert.equal(resolveDeploymentType('私有部署按年订阅版'), '私有云');
  assert.equal(resolveDeploymentType('Hox1iRI04'), '私有云');
  assert.equal(resolveDeploymentType('私有部署一次性授权版'), '私有云');
  assert.equal(resolveDeploymentType('E4H2tH6o4'), '私有云');
  assert.equal(resolveDeploymentType(null), '私有云');
  assert.equal(resolveDeploymentType(undefined), '私有云');
  assert.equal(resolveDeploymentType(''), '私有云');
  // 覆盖值：建议/工单都有部署类型覆盖，公有云版解析为公有云 UUID。
  assert.deepEqual(applyDeploymentTypeOverride('suggestion', '公有云版'), [{ fieldID: 'HS5u8PNB', value: 'Fzg8dBCT' }]);
  assert.deepEqual(applyDeploymentTypeOverride('suggestion', 'option1'), [{ fieldID: 'HS5u8PNB', value: 'Fzg8dBCT' }]);
  assert.deepEqual(applyDeploymentTypeOverride('ticket', '私有部署按年订阅版'), [{ fieldID: 'HS5u8PNB', value: 'KFewLptQ' }]);
  assert.deepEqual(applyDeploymentTypeOverride('ticket', 'Hox1iRI04'), [{ fieldID: 'HS5u8PNB', value: 'KFewLptQ' }]);
  assert.deepEqual(applyDeploymentTypeOverride('ticket', null), [{ fieldID: 'HS5u8PNB', value: 'KFewLptQ' }]);
  // 运维工单没有实例部署类型字段，无覆盖。
  assert.deepEqual(applyDeploymentTypeOverride('operations', '公有云版'), []);
});

test('workbench: missingOnesDeskSpecFields gates the approval of agent-session drafts', () => {
  // 完整 fieldValues（客户信息 + 4 个规格字段）→ 无缺失。
  const full = [
    { fieldID: 'JrvswW8P', value: 'opt1' },
    { fieldID: 'PYbGEZmN', value: '5qUVAY7m' },
    { fieldID: 'HS5u8PNB', value: 'Fzg8dBCT' },
    { fieldID: 'field054', value: 'RbrMxh1n' },
    { fieldID: 'field012', value: 'Lv5Tbmih' },
  ];
  assert.deepEqual(missingOnesDeskSpecFields('suggestion', full), []);
  // 缺所属模块与优先级 → 报这两个字段。
  const partial = full.filter((value) => value.fieldID !== 'field054' && value.fieldID !== 'field012');
  assert.deepEqual(missingOnesDeskSpecFields('suggestion', partial).map((spec) => spec.label), ['所属模块', '优先级']);
  // 空值视为缺失（value 为空字符串）。
  assert.ok(missingOnesDeskSpecFields('suggestion', [...full.slice(0, 2), { fieldID: 'field054', value: '' }]).some((spec) => spec.uuid === 'field054'));
  // 非 ONES Desk 类型（followup/workhour/case/未知）不校验。
  assert.deepEqual(missingOnesDeskSpecFields('followup', []), []);
  assert.deepEqual(missingOnesDeskSpecFields('case', []), []);
  assert.deepEqual(missingOnesDeskSpecFields('unknown-type', []), []);
});

test('workbench: desk description must land on field016 and unknown field IDs are rejected', () => {
  // 真实验收形态：模型把完整描述写进发明的 field002，规格字段齐全——描述落点与未知字段都必须拦下。
  const acceptedTicket = [
    { fieldID: 'JrvswW8P', value: 'opt1' },
    { fieldID: 'CATNfrrF', value: 'JuTTumjJ' },
    { fieldID: 'HS5u8PNB', value: 'Fzg8dBCT' },
    { fieldID: 'Su4v8xFs', value: 'M1eT99eW' },
    { fieldID: 'field029', value: 'UPYjaEgNQX1K9R3L' },
    { fieldID: 'field002', value: '## 问题描述\n导出测试报告 500' },
  ];
  assert.equal(missingOnesDeskDescription('ticket', acceptedTicket), true, '描述未写 field016 应判缺失');
  assert.deepEqual(unknownOnesDeskFieldIds('ticket', acceptedTicket), ['field002'], '未知字段 field002 应被点名');
  // 描述移到 field016 后两者都通过。
  const corrected = acceptedTicket.filter((value) => value.fieldID !== 'field002').concat([{ fieldID: 'field016', value: '## 问题描述\n导出测试报告 500' }]);
  assert.equal(missingOnesDeskDescription('ticket', corrected), false);
  assert.deepEqual(unknownOnesDeskFieldIds('ticket', corrected), []);
  // 空白描述值视为缺失。
  assert.equal(missingOnesDeskDescription('ticket', [...corrected.filter((v) => v.fieldID !== 'field016'), { fieldID: 'field016', value: '  ' }]), true);
  // 非 ONES Desk 类型不校验。
  assert.equal(missingOnesDeskDescription('followup', []), false);
  assert.deepEqual(unknownOnesDeskFieldIds('case', [{ fieldID: 'anything', value: '1' }]), []);
});

test('workbench: parseOnesManhourMode tolerates ONES status envelopes', () => {
  // 历史事故：真实返回是状态信封（result=SUCCESS、模式值嵌在 data 里），只读顶层 result 永远识别失败。
  assert.equal(parseOnesManhourMode('{"result":"summary"}'), 'summary');
  assert.equal(parseOnesManhourMode('{"result":"simple"}'), 'simple');
  assert.equal(parseOnesManhourMode('{"result":"SUCCESS","data":{"mode":"summary"}}'), 'summary');
  assert.equal(parseOnesManhourMode('{"result":"SUCCESS","data":{"result":"simple"}}'), 'simple');
  assert.equal(parseOnesManhourMode('{"result":"SUCCESS","data":"summary"}'), 'summary');
  assert.equal(parseOnesManhourMode('{"result":"SUCCESS","data":{"workhourMode":{"value":"summary"}}}'), 'summary');
  // FAIL 信封与无法识别的形状都返回 null，由调用方决定按业务失败还是降级。
  assert.equal(parseOnesManhourMode('{"result":"FAIL","errorCode":"X"}'), null);
  assert.equal(parseOnesManhourMode('{"result":"SUCCESS"}'), null);
  assert.equal(parseOnesManhourMode('not json'), null);
});

test('workbench: fitFollowupSections keeps every section within the budget', () => {
  // 真实事故：13 节合计约 3300 字，`.slice(0, 3000)` 尾部截断把第 13 节整节丢掉、第 12 节拦腰截断。
  const sections = Array.from({ length: 13 }, (_, i) => ({ title: `话题${i + 1}`, body: '字'.repeat(260) }));
  const fitted = fitFollowupSections(sections, 3000);
  // 每一节的标题都必须在场——预算内靠压缩最长节正文，绝不丢节。
  for (let i = 1; i <= 13; i++) assert.ok(fitted.includes(`【话题${i}】`), `话题${i} 不得丢失`);
  assert.ok(fitted.length <= 3000, `总长 ${fitted.length} 应在预算内`);
  // 轻度超预算只压最长节，短节正文原样保留。
  const mild = [{ title: '长节', body: '长'.repeat(2000) }, { title: '短节', body: '短'.repeat(200) }];
  const fittedMild = fitFollowupSections(mild, 2100);
  assert.ok(fittedMild.includes('【短节】\n短'.repeat(1)));
  assert.ok(fittedMild.includes('长…'));
  // 预算内不改动。
  const small = [{ title: '小节', body: '一句话。' }];
  assert.equal(fitFollowupSections(small, 3000), '【小节】\n一句话。');
});

test('workbench: followup sections map each fragment to its own summary without repetition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-sections-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-sec', name: '客户简' });
    const f1 = segment(db, 'crm-sec', 'rsec:a', 'rsec', '话题A', '2026-08-25T05:00:00Z', '讨论了报表插件的方案', '分段器摘要A：客户确认插件方案');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T05:00:00Z','$.endAt','2026-08-25T05:30:00Z') WHERE id=?").run(f1.id);
    const f2 = segment(db, 'crm-sec', 'rsec2:a', 'rsec2', '话题B', '2026-08-25T07:00:00Z', '讨论了索引问题', '分段器摘要B：约定重建索引');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T07:00:00Z','$.endAt','2026-08-25T07:20:00Z') WHERE id=?").run(f2.id);
    const f3 = segment(db, 'crm-sec', 'rsec3:a', 'rsec3', '话题C', '2026-08-25T09:00:00Z', '演示了工作台功能', '分段器摘要C：演示个人工作台');
    // LLM 提供了 f1/f2 的分节摘要但没有 f3：f3 应回退分段器摘要，绝不能用全天综述句充当分节正文。
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'followup', title: '沟通记录', summary: '围绕报表与索引等多个话题进行了全天沟通。',
        fields: { one_line_summary: '围绕报表插件与索引问题进行了沟通',
          sections: [{ evidence_id: f1.id, summary: 'LLM 摘要A：质量部提出累积趋势报表需求并确认插件方案' },
            { evidence_id: f2.id, summary: 'LLM 摘要B：客户反馈效能慢查询，双方约定重建索引' }] },
        evidence_refs: [f1.id, f2.id, f3.id] },
    ]));
    const queued = service.enqueue('crm-sec', [f1.id, f2.id, f3.id]);
    await waitForJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-sec').find((item) => item.status !== 'stale')!;
    const followup = batch.items!.find((item) => item.type === 'followup')!;
    const sections = followup.summary.split('\n\n');
    assert.equal(sections.length, 3);
    assert.match(sections[0], /【话题A】\nLLM 摘要A：质量部提出累积趋势报表需求并确认插件方案/);
    assert.match(sections[1], /【话题B】\nLLM 摘要B：客户反馈效能慢查询，双方约定重建索引/);
    // f3 无 LLM 分节条目 → 回退分段器摘要，而不是全天综述或转写原文。
    assert.match(sections[2], /【话题C】\n分段器摘要C：演示个人工作台/);
    // 分节正文互不相同，全天综述句只出现在 one_line_summary 语境外不进任何一节。
    assert.doesNotMatch(followup.summary, /全天沟通/);
    assert.equal(new Set(sections.map((section) => section.split('\n').slice(1).join('\n'))).size, 3);
    // 工时描述仍取一句话总结。
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    assert.equal(workhour.targetArguments.description, '围绕报表插件与索引问题进行了沟通');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: ONES work-item proposals without business signals are dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-gate-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-gate', name: '客户门', sourceObject: 'object_Umwnn__c' });
    // 无缺陷信号、无运维请求、无产品不满足诉求的普通沟通片段。
    const plain = segment(db, 'crm-gate', 'rgate:a', 'rgate', '方案讨论', '2026-08-25T05:00:00Z', '双方讨论了报表的实现路径和交付节奏', '双方讨论了报表的实现路径');
    // LLM 误将普通讨论提案为 operations/ticket，门控必须丢弃。
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'operations', title: '误判运维工单', summary: '讨论报表方案', evidence_refs: [plain.id] },
      { type: 'ticket', title: '误判工单', summary: '讨论报表方案', evidence_refs: [plain.id] },
      { type: 'suggestion', title: '误判建议', summary: '讨论报表方案', evidence_refs: [plain.id] },
    ]));
    const queued = service.enqueue('crm-gate', [plain.id]);
    await waitForJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-gate').find((item) => item.status !== 'stale')!;
    assert.ok(!batch.items!.some((item) => item.type === 'operations'), '无运维请求信号不得生成运维工单');
    assert.ok(!batch.items!.some((item) => item.type === 'ticket'), '无缺陷信号不得生成工单');
    assert.ok(!batch.items!.some((item) => item.type === 'suggestion'), '无产品不满足诉求不得生成建议');
    // 沟通记录与连带工时不受门控影响，正常生成。
    assert.ok(batch.items!.some((item) => item.type === 'followup'));
    assert.ok(batch.items!.some((item) => item.type === 'workhour'));

    // 带明确信号的证据：产品不满足诉求保留 suggestion，缺陷保留 ticket，运维操作请求保留 operations。
    db.upsertCustomer({ id: 'crm-gate2', name: '客户阈', sourceObject: 'object_Umwnn__c' });
    const sug = segment(db, 'crm-gate2', 'rgate2:a', 'rgate2', '报表诉求', '2026-08-25T05:00:00Z', '客户说这个累计趋势报表现在标品还不支持，希望以后能支持');
    const ticket = segment(db, 'crm-gate2', 'rgate2:b', 'rgate2', '缺陷反馈', '2026-08-25T06:00:00Z', '客户反馈统计数字算错了，这不符合预期，像个 bug');
    const ops = segment(db, 'crm-gate2', 'rgate2:c', 'rgate2', '运维请求', '2026-08-25T07:00:00Z', '客户要求帮忙做一次数据迁移，把测试环境重装');
    const service2 = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'suggestion', title: '累计趋势报表诉求', summary: '标品还不支持', evidence_refs: [sug.id] },
      { type: 'ticket', title: '统计缺陷', summary: '数据算错', evidence_refs: [ticket.id] },
      { type: 'operations', title: '数据迁移请求', summary: '环境重装与数据迁移', evidence_refs: [ops.id] },
    ]));
    const queued2 = service2.enqueue('crm-gate2', [sug.id, ticket.id, ops.id]);
    await waitForJob(db, queued2[0].jobId);
    const batch2 = db.listDraftBatches('crm-gate2').find((item) => item.status !== 'stale')!;
    assert.ok(batch2.items!.some((item) => item.type === 'suggestion'), '标品不满足诉求应保留建议草稿');
    assert.ok(batch2.items!.some((item) => item.type === 'ticket'), '明确缺陷指认应保留工单草稿');
    assert.ok(batch2.items!.some((item) => item.type === 'operations'), '明确运维操作请求应保留运维工单草稿');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: workhour drafts bind summary-mode tool from ONES status envelope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workhour-envelope-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-env', name: '客户恩', sourceObject: 'object_Umwnn__c' });
    manhourIssue(db, 'crm-env');
    const fragment = segment(db, 'crm-env', 'renv:a', 'renv', '插件方案', '2026-08-25T05:00:00Z', '与客户讨论了插件方案，投入一小时');
    db.db.prepare("UPDATE source_events SET payload_json=json_set(payload_json,'$.startAt','2026-08-25T05:00:00Z','$.endAt','2026-08-25T06:00:00Z') WHERE id=?").run(fragment.id);
    // 真实事故形状：result=SUCCESS 状态信封、模式值嵌在 data.mode，旧解析只读顶层 result 导致绑定失败。
    const mcp = fakeOnesWorkhourMcp({ modeResponse: '{"result":"SUCCESS","data":{"mode":"summary"}}' });
    const service = new HemoryDraftService(db, mcp, fakeModelRuntime([]));
    const queued = service.enqueue('crm-env', [fragment.id]);
    await waitDraftJob(db, queued[0].jobId);
    const batch = db.listDraftBatches('crm-env')[0];
    const workhour = batch.items!.find((item) => item.type === 'workhour')!;
    assert.equal(workhour.targetTool, 'mcp__ones__add_workhour_in_summary_mode');
    assert.ok(!workhour.validationErrors.length, JSON.stringify(workhour.validationErrors));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// 模拟 ONES search_for_issue_field_options：按输入返回固定选项集，覆盖客户名称/售后客户名称两级解析。
function fakeOnesOptionSearchMcp(optionsByInput: Record<string, Array<{ uuid: string; name: string }>>): any {
  const calls: Array<{ publicName: string; args: any }> = [];
  return {
    listTools: () => [],
    isWrite: () => false,
    resolve: () => undefined,
    call: async (publicName: string, args: any) => {
      calls.push({ publicName, args });
      const options = optionsByInput[String(args?.input ?? '')] ?? [];
      return { text: JSON.stringify({ result: 'SUCCESS', data: options.map((option) => ({ uuid: option.uuid, name: option.name })) }), isError: false };
    },
    calls,
  };
}

test('workbench: ONES customer option resolves per name variant; dual options both resolved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-option-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 场景一（常态）：客户名称（field_n1qN0__c__r 全称）与 ONES 选项精确一致；简称变体同步解析（搜不到也无妨）。
    db.upsertCustomer({ id: 'crm-hd', name: '北京华大九天科技股份有限公司', shortName: '华大九天', sourceObject: 'object_Umwnn__c' });
    const mcp = fakeOnesOptionSearchMcp({
      '北京华大九天科技股份有限公司': [{ uuid: 'BJY0WFZJ', name: '北京华大九天科技股份有限公司' }],
      '华大九天': [],
    });
    const sync = new PortfolioSyncService(db, mcp, async () => []);
    const optionIds = await (sync as any).resolveOnesCustomerOptions(db.getCustomer('crm-hd'), { userId: 0, username: 'system', mcp });
    assert.deepEqual(optionIds, ['BJY0WFZJ']);
    const identity = db.listIdentities('crm-hd').find((item) => item.system === 'ones_customer_option');
    assert.equal(identity?.external_id, 'BJY0WFZJ');
    assert.equal(identity?.label, '北京华大九天科技股份有限公司');
    assert.equal(identity?.status, 'confirmed');
    // 两个名称变体都被搜索（简称搜不到选项、不落候选）。
    assert.deepEqual(mcp.calls.map((call) => call.args.input), ['北京华大九天科技股份有限公司', '华大九天']);

    // 场景二：全称搜不到精确选项时简称精确唯一命中（历史行为保留）。
    db.upsertCustomer({ id: 'crm-ai', name: '北京通用人工智能研究院', shortName: '通用AI研究院', sourceObject: 'object_Umwnn__c' });
    const mcp2 = fakeOnesOptionSearchMcp({
      '北京通用人工智能研究院': [
        { uuid: 'v8Goci1j', name: '北京智源人工智能研究院' },
        { uuid: 'gJDSkP9x', name: '武汉人工智能研究院' },
      ],
      '通用AI研究院': [{ uuid: 'tyy8tinj', name: '通用AI研究院' }],
    });
    const sync2 = new PortfolioSyncService(db, mcp2, async () => []);
    const optionIds2 = await (sync2 as any).resolveOnesCustomerOptions(db.getCustomer('crm-ai'), { userId: 0, username: 'system', mcp: mcp2 });
    assert.deepEqual(optionIds2, ['tyy8tinj']);
    assert.equal(db.listIdentities('crm-ai').find((item) => item.system === 'ones_customer_option')?.external_id, 'tyy8tinj');

    // 场景二b：客户名称与简称都无法精确唯一匹配 → 未归属、落候选事件。
    db.upsertCustomer({ id: 'crm-ai2', name: '某研究院', shortName: '智源', sourceObject: 'object_Umwnn__c' });
    const mcp2b = fakeOnesOptionSearchMcp({
      '某研究院': [],
      '智源': [{ uuid: 'v8Goci1j', name: '智源研究院' }],
    });
    const sync2b = new PortfolioSyncService(db, mcp2b, async () => []);
    const optionIds2b = await (sync2b as any).resolveOnesCustomerOptions(db.getCustomer('crm-ai2'), { userId: 0, username: 'system', mcp: mcp2b });
    assert.deepEqual(optionIds2b, []);
    assert.equal(db.listIdentities('crm-ai2').filter((item) => item.system === 'ones_customer_option').length, 0);
    assert.ok(db.listSourceEvents('ones', 'customer_option_candidate', 'crm-ai2').length >= 1);

    // 场景三：两个名称都无法精确唯一匹配 → 保持未归属，写候选事件。
    db.upsertCustomer({ id: 'crm-xx', name: '某集团', shortName: '简称客户', sourceObject: 'object_Umwnn__c' });
    const mcp3 = fakeOnesOptionSearchMcp({
      '某集团': [{ uuid: 'opt-b', name: '某集团有限公司' }, { uuid: 'opt-c', name: '某集团股份' }],
      '简称客户': [{ uuid: 'opt-a', name: '简称客户集团' }],
    });
    const sync3 = new PortfolioSyncService(db, mcp3, async () => []);
    const optionIds3 = await (sync3 as any).resolveOnesCustomerOptions(db.getCustomer('crm-xx'), { userId: 0, username: 'system', mcp: mcp3 });
    assert.deepEqual(optionIds3, []);
    assert.equal(db.listIdentities('crm-xx').filter((item) => item.system === 'ones_customer_option').length, 0);
    const candidates = db.listSourceEvents('ones', 'customer_option_candidate', 'crm-xx');
    assert.ok(candidates.length >= 2, '歧义候选应写入 source_events');

    // 场景四（双选项核心）：全称与简称在 ONES 各有一个独立选项（敏锐达/思灵真实事故形状）——
    // 两个都要解析成功并都用于同步查询；缓存里已有简称时，实时补解析全称。
    db.upsertCustomer({ id: 'crm-md', name: '北京敏锐达致机器人科技有限责任公司', shortName: '北京思灵机器人科技有限责任公司', sourceObject: 'object_Umwnn__c' });
    db.upsertIdentity('crm-md', 'ones_customer_option', '87pQMH70', '北京思灵机器人科技有限责任公司', 'confirmed');
    const mcp4 = fakeOnesOptionSearchMcp({
      '北京敏锐达致机器人科技有限责任公司': [{ uuid: '6iioSn0M', name: '北京敏锐达致机器人科技有限责任公司' }],
      // 简称已命中缓存，不再实时搜索。
    });
    const sync4 = new PortfolioSyncService(db, mcp4, async () => []);
    const optionIds4 = await (sync4 as any).resolveOnesCustomerOptions(db.getCustomer('crm-md'), { userId: 0, username: 'system', mcp: mcp4 });
    // 全称（primary）在前，简称在后，两者都参与 ONESQL IN 查询。
    assert.deepEqual(optionIds4, ['6iioSn0M', '87pQMH70']);
    assert.deepEqual(mcp4.calls.map((call) => call.args.input), ['北京敏锐达致机器人科技有限责任公司']);
    const identities4 = db.listIdentities('crm-md').filter((item) => item.system === 'ones_customer_option');
    assert.equal(identities4.length, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: dual-option customer syncs the manhour issue bound to the secondary option', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-option-sync-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 端到端：售后客户工作项挂在简称选项名下（或反之），IN 查询必须把它拉进来。
    db.upsertCustomer({ id: 'crm-dual', name: '北京敏锐达致机器人科技有限责任公司', shortName: '北京思灵机器人科技有限责任公司', sourceObject: 'object_Umwnn__c' });
    const mcp = fakeOnesOptionSearchMcp({
      '北京敏锐达致机器人科技有限责任公司': [{ uuid: 'opt-full', name: '北京敏锐达致机器人科技有限责任公司' }],
      '北京思灵机器人科技有限责任公司': [{ uuid: 'opt-short', name: '北京思灵机器人科技有限责任公司' }],
    });
    const issues = [{
      uuid: 'KHGS-2282803', display_id: 'KHGS-2282803', field001: '北京敏锐达致机器人科技有限责任公司',
      field005: { name: '进行中' }, field006: { name: '客户工时管理' }, field007: { name: '售后客户' },
      JrvswW8P: { name: '北京敏锐达致机器人科技有限责任公司' }, field009: '2026-08-28 10:00:00',
    }];
    let capturedQuery = '';
    const onesMcp: any = {
      listTools: () => [], isWrite: () => false, resolve: () => undefined,
      call: async (publicName: string, args: any) => {
        if (publicName === 'mcp__ones__query_issues_by_onesql') {
          capturedQuery = String(args?.query ?? '');
          return { text: JSON.stringify({ result: 'SUCCESS', data: issues, page_info: { has_next_page: false } }), isError: false };
        }
        if (publicName === 'mcp__ones__search_for_issue_field_options') return mcp.call(publicName, args);
        if (publicName === 'mcp__ones__get_onesql_grammar_help') return { text: '{}', isError: false };
        return { text: '{}', isError: false };
      },
    };
    const sync = new PortfolioSyncService(db, onesMcp, async () => []);
    const count = await (sync as any).syncOnesCustomer(db.getCustomer('crm-dual'), { userId: 0, username: 'system', mcp: onesMcp });
    assert.ok(count >= 1);
    // ONESQL 查询必须同时含两个选项 ID。
    assert.match(capturedQuery, /JrvswW8P IN \('opt-full', 'opt-short'\)/);
    // 全称选项名下的售后客户工作项成功归属入库，findCustomerManhourIssue 命中。
    const manhour = db.findCustomerManhourIssue('crm-dual');
    assert.equal(manhour?.externalId, 'KHGS-2282803');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: resolveOnesOption prefers the full-name identity deterministically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-option-draft-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 双身份并存时（简称先插入），草稿/校验侧仍确定性优先全称。
    db.upsertCustomer({ id: 'crm-pick', name: '北京敏锐达致机器人科技有限责任公司', shortName: '北京思灵机器人科技有限责任公司', sourceObject: 'object_Umwnn__c' });
    db.upsertIdentity('crm-pick', 'ones_customer_option', '87pQMH70', '北京思灵机器人科技有限责任公司', 'confirmed');
    db.upsertIdentity('crm-pick', 'ones_customer_option', '6iioSn0M', '北京敏锐达致机器人科技有限责任公司', 'confirmed');
    const picked = resolveOnesOption(db, db.getCustomer('crm-pick'));
    assert.deepEqual(picked, { id: '6iioSn0M', label: '北京敏锐达致机器人科技有限责任公司' });
    // 别名身份（品牌名选项）与简称同层：全称身份缺失、简称失效时确定性回退到别名选项。
    db.setCustomerAliases('crm-pick', ['青禾晶元']);
    db.upsertIdentity('crm-pick', 'ones_customer_option', 'alias-opt', '青禾晶元', 'confirmed');
    db.db.prepare("DELETE FROM external_identities WHERE external_id='6iioSn0M'").run();
    db.db.prepare("UPDATE customers SET short_name=NULL WHERE id='crm-pick'").run();
    const byAlias = resolveOnesOption(db, db.getCustomer('crm-pick'));
    assert.deepEqual(byAlias, { id: 'alias-opt', label: '青禾晶元' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── Hemory 事件级切片 v2 ──

function v2Lines() {
  return [
    { spokenAt: '2026-08-25T05:00:00Z', speaker: '客户', text: '先说人为效能项目的延期问题，二期功能上不了线。' },
    { spokenAt: '2026-08-25T05:00:20Z', speaker: 'CSM', text: '延期原因是接口联调卡住了，我们本周内给出新的排期。' },
    { spokenAt: '2026-08-25T05:00:40Z', speaker: '客户', text: '好，延期结论请同步给张总并更新项目计划。' },
    { spokenAt: '2026-08-25T05:01:00Z', speaker: '客户', text: '还有一件事，BI 报表的配色方案需要调整，太刺眼了。' },
    { spokenAt: '2026-08-25T05:01:20Z', speaker: 'CSM', text: '配色我们换成柔和的默认主题，下周发一版预览。' },
    { spokenAt: '2026-08-25T05:01:40Z', speaker: '客户', text: '预览确认后再全量切换，顺便看下加载速度。' },
  ];
}

test('workbench: v2 review stage splits mixed segments and keeps single-event reasoning together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v2-split-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = v2Lines();
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-v2',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'rec-v2', lines }, attributionStatus: 'unattributed' });
    const mixed = { segments: [{ start_index: 0, end_index: 5, topic: '项目延期与BI配色', summary: '混合话题。', subject: '人为效能项目', focus: '延期与配色', topic_key: 'mixed', include: true }] };
    const split = { segments: [
      { start_index: 0, end_index: 2, topic: '人为效能项目延期', summary: '延期原因与处理计划。', subject: '人为效能项目', focus: '二期功能延期排期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: 'BI 报表配色调整', summary: '配色改为柔和主题并预览确认。', subject: 'BI 报表', focus: '配色方案调整', topic_key: 'bi-color', include: true },
    ] };
    const fake = fakeSegmentationRuntime([mixed, split]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const fragments = await service.segmentRecording(recording);
    assert.equal(fragments.length, 2);
    assert.equal(fragments[0].payload?.topicKey, 'delay');
    assert.equal(fragments[1].payload?.topicKey, 'bi-color');
    assert.equal(fragments[0].payload?.topicGroupId, 'rec-v2:delay');
    assert.equal(fragments[1].payload?.topicGroupId, 'rec-v2:bi-color');
    // 单事件内的原因/方案/决定保持在一段：第一个片段 0-2 不再被拆。
    assert.equal(fragments[0].payload?.startIndex, 0);
    assert.equal(fragments[0].payload?.endIndex, 2);
    assert.equal(fake.calls(), 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: A-B-A recurring events keep separate fragments sharing one topic group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v2-aba-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = v2Lines();
    const recurring = { segments: [
      { start_index: 0, end_index: 2, topic: '人为效能项目延期', summary: '延期原因与处理计划。', subject: '人为效能项目', focus: '二期功能延期排期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: 'BI 报表配色调整', summary: '配色改为柔和主题。', subject: 'BI 报表', focus: '配色方案调整', topic_key: 'bi-color', include: true },
    ] };
    const linesAba = [...lines,
      { spokenAt: '2026-08-25T05:02:00Z', speaker: '客户', text: '回到刚才的延期问题，新的排期确定后要同步项目群。' },
      { spokenAt: '2026-08-25T05:02:20Z', speaker: 'CSM', text: '排期确定当天我会把更新计划发到群里。' },
      { spokenAt: '2026-08-25T05:02:40Z', speaker: '客户', text: '好的，延期这块就按这个方式跟进。' }];
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-aba',
      title: '原始转写', occurredAt: linesAba[0].spokenAt, payload: { recordingId: 'rec-aba', lines: linesAba }, attributionStatus: 'unattributed' });
    const result = { segments: [
      { start_index: 0, end_index: 2, topic: '人为效能项目延期', summary: '延期原因与处理计划。', subject: '人为效能项目', focus: '二期功能延期排期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: 'BI 报表配色调整', summary: '配色改为柔和主题。', subject: 'BI 报表', focus: '配色方案调整', topic_key: 'bi-color', include: true },
      { start_index: 6, end_index: 8, topic: '人为效能项目延期（回访）', summary: '排期确定后的同步方式。', subject: '人为效能项目', focus: '二期功能延期排期', topic_key: 'delay', include: true },
    ] };
    const fake = fakeSegmentationRuntime([recurring, result]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const fragments = await service.segmentRecording(recording);
    assert.equal(fragments.length, 3);
    const delayFragments = fragments.filter((item) => item.payload?.topicKey === 'delay');
    assert.equal(delayFragments.length, 2);
    assert.deepEqual(delayFragments.map((item) => item.payload?.topicPartIndex), [1, 2]);
    assert.ok(delayFragments.every((item) => item.payload?.topicPartCount === 2));
    assert.ok(delayFragments.every((item) => item.payload?.topicGroupId === 'rec-aba:delay'));
    assert.equal(fragments.filter((item) => item.payload?.topicKey === 'bi-color')[0]?.payload?.topicPartCount, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: short topics are discarded independently instead of merged into neighbors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v2-short-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = [
      { spokenAt: '2026-08-25T05:00:00Z', speaker: '客户', text: '对了。' },
      { spokenAt: '2026-08-25T05:00:05Z', speaker: 'CSM', text: '嗯。' },
      { spokenAt: '2026-08-25T05:00:30Z', speaker: '客户', text: '当前上线流程在审批节点经常被阻塞，需要排查权限配置。' },
      { spokenAt: '2026-08-25T05:00:50Z', speaker: 'CSM', text: '我们会收集报错时间和操作路径，先定位具体失败环节。' },
      { spokenAt: '2026-08-25T05:01:10Z', speaker: '客户', text: '请把排查结论和后续处理计划同步给项目负责人。' },
    ];
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-short',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'rec-short', lines }, attributionStatus: 'unattributed' });
    const output = { segments: [
      { start_index: 0, end_index: 1, topic: '零散寒暄', summary: '零散对话。', subject: '通话', focus: '寒暄', topic_key: 'chatter', include: true },
      { start_index: 2, end_index: 4, topic: '审批阻塞排查', summary: '审批阻塞的排查安排。', subject: '上线流程', focus: '审批节点阻塞排查', topic_key: 'approval', include: true },
    ] };
    const fake = fakeSegmentationRuntime([output]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const fragments = await service.segmentRecording(recording);
    // 0-1 段低于门槛（2 条有效发言）被独立丢弃，绝不并入相邻片段。
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].payload?.startIndex, 2);
    assert.equal(fragments[0].payload?.endIndex, 4);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: validation failures retry the stage with the error appended and fail after 3 attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v2-retry-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = v2Lines();
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-retry',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'rec-retry', lines }, attributionStatus: 'unattributed' });
    // 阶段 1 三次都输出缺口分段（1-5，缺 0），阶段 2 不应被调用。
    const broken = { segments: [{ start_index: 1, end_index: 5, topic: '缺口', summary: '缺口分段。', subject: 'x', focus: 'y', topic_key: 'gap', include: true }] };
    const prompts: string[] = [];
    let calls = 0;
    const runtime = { models: { complete: async (_model: unknown, request: any) => {
      calls++;
      prompts.push(request.messages[0].content);
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(broken) }] };
    } }, model: {}, llm: { provider: 'fake', model: 'segmenter' } } as any;
    const service = new HemorySegmentationService(db, runtime);
    await assert.rejects(() => service.segmentRecording(recording), /事件分区失败（已重试 3 次）/);
    assert.equal(calls, 3);
    // 第二、三次调用把上一次校验错误带进了提示词。
    assert.match(prompts[1], /模型分段没有覆盖完整转写/);
    assert.match(prompts[2], /模型分段没有覆盖完整转写/);
    const jobs = db.listPendingHemorySegmentationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'failed');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: adjacent same-topic_key segments are defensively merged; v2 ids stay independent of v1 rows until a real generation switch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v2-version-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = v2Lines();
    const output = { segments: [
      { start_index: 0, end_index: 1, topic: '人为效能项目延期', summary: '延期原因。', subject: '人为效能项目', focus: '二期功能延期排期', topic_key: 'delay', include: true },
      { start_index: 2, end_index: 2, topic: '人为效能项目延期（续）', summary: '处理计划。', subject: '人为效能项目', focus: '二期功能延期排期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: 'BI 报表配色调整', summary: '配色调整。', subject: 'BI 报表', focus: '配色方案调整', topic_key: 'bi-color', include: true },
    ] };
    const fake = fakeSegmentationRuntime([output]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-ver',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'rec-ver', lines }, attributionStatus: 'unattributed' });
    const fragments = await service.segmentRecording(recording);
    // 相邻同 key 防御合并为一段。
    assert.equal(fragments.length, 2);
    assert.equal(fragments[0].payload?.startIndex, 0);
    assert.equal(fragments[0].payload?.endIndex, 2);

    // 同边界、不同 ID、未参与当前代际的 v1 遗留行不改变 v2 片段的归属状态：
    // 继承只发生在真实代际切换（activateHemoryFragments 停用旧行）时，upsert 侧不受影响。
    db.upsertCustomer({ id: 'crm-x', name: '客户X' });
    db.upsertSourceEvent({ customerId: 'crm-x', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
      externalId: `rec-ver:${lines[0].spokenAt}:0:${lines[2].spokenAt}:2`, title: 'v1 片段', occurredAt: lines[0].spokenAt,
      attributionStatus: 'confirmed', payload: { recordingId: 'rec-ver' } });
    db.attributeHemoryFragments([db.findSourceEvent('hemory', 'ai_topic_segment', `rec-ver:${lines[0].spokenAt}:0:${lines[2].spokenAt}:2`)!.id],
      'crm-x', {}, 'csm');
    assert.ok(fragments[0].externalId.startsWith('v3.2:rec-ver:'));
    assert.notEqual(fragments[0].attributionStatus, 'confirmed');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 重切换代：归属继承 + 跳过闸门 + 孪生消费台账 ──

// 两轮分段：第一轮 1 段（用户确认归属客户），转写漂移（speaker 名修正）后重切成两段——
// 第一段与旧段时间重叠、第二段是真新内容；继承只作用于时间重叠片段。
function inheritanceLines(): Array<{ spokenAt: string; speaker: string; text: string }> {
  return [
    { spokenAt: '2026-08-25T05:00:00Z', speaker: '客户', text: '人为效能项目二期功能上不了线，需要给个说法。' },
    { spokenAt: '2026-08-25T05:00:20Z', speaker: 'CSM', text: '延期原因是接口联调卡住了，本周内给出新的排期。' },
    { spokenAt: '2026-08-25T05:00:40Z', speaker: '客户', text: '延期结论请同步给张总并更新项目计划。' },
    { spokenAt: '2026-08-25T05:01:00Z', speaker: '客户', text: '另外 BI 报表的配色方案需要调整，太刺眼了。' },
    { spokenAt: '2026-08-25T05:01:20Z', speaker: 'CSM', text: '配色我们换成柔和的默认主题，下周发一版预览。' },
    { spokenAt: '2026-08-25T05:01:40Z', speaker: '客户', text: '预览确认后再全量切换，顺便看下加载速度。' },
  ];
}

test('workbench: re-segmentation inherits confirmed and ignored attribution onto overlapping twins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-inherit-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-inh', name: '继承客户' });
    const lines = [
      { spokenAt: '2026-08-25T05:00:00Z', speaker: '客户', text: '人为效能项目二期功能上不了线，需要给个说法。' },
      { spokenAt: '2026-08-25T05:00:20Z', speaker: 'CSM', text: '延期原因是接口联调卡住了，本周内给出新的排期。' },
      { spokenAt: '2026-08-25T05:00:40Z', speaker: '客户', text: '延期结论请同步给张总并更新项目计划。' },
      { spokenAt: '2026-08-25T05:01:00Z', speaker: '客户', text: '另外 BI 报表的配色方案需要调整，太刺眼了。' },
      { spokenAt: '2026-08-25T05:01:20Z', speaker: 'CSM', text: '配色我们换成柔和的默认主题，下周发一版预览。' },
      { spokenAt: '2026-08-25T05:01:40Z', speaker: '客户', text: '预览确认后再全量切换，顺便看下加载速度。' },
      { spokenAt: '2026-08-25T05:02:00Z', speaker: '客户', text: '私有云实例的扩容需求这个季度也要落地。' },
      { spokenAt: '2026-08-25T05:02:20Z', speaker: 'CSM', text: '我先确认当前资源水位和扩容窗口。' },
      { spokenAt: '2026-08-25T05:02:40Z', speaker: '客户', text: '确认后把扩容计划发给运维负责人。' },
    ];
    // 第一轮：全量一段（0-8，05:00:00–05:02:40 共 160s），用户确认归属客户。
    const firstOutput = { segments: [{ start_index: 0, end_index: 8, topic: '综合沟通', summary: '全量一段。', subject: '综合', focus: '综合沟通', topic_key: 'all', include: true }] };
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-inh',
      title: '原始转写', occurredAt: lines[0]!.spokenAt, payload: { recordingId: 'rec-inh', lines }, attributionStatus: 'unattributed' });
    const fake = fakeSegmentationRuntime([firstOutput, firstOutput]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const old = await service.segmentRecording(recording);
    assert.equal(old.length, 1);
    db.attributeHemoryFragments([old[0]!.id], 'crm-inh', {}, 'csm');

    // 转写漂移 + 后补三行（新增行数超容差 2 → 实质增长，闸门放行重切）；新一轮切成两段：
    // [0] 0-5（05:00:00–05:01:40，100s/160s = 0.625 ≥ 0.6 达标）；
    // [1] 6-11 尾部新内容对旧片段覆盖率不足：真新内容保持待归属。
    const drifted = [...lines.map((line, index) => ({ ...line, speaker: index % 2 === 0 ? '张炎' : line.speaker })),
      { spokenAt: '2026-08-25T05:03:00Z', speaker: '客户', text: '扩容预算走今年的框架合同，不再额外审批。' },
      { spokenAt: '2026-08-25T05:03:20Z', speaker: 'CSM', text: '预算内我们先出扩容方案初稿。' },
      { spokenAt: '2026-08-25T05:03:40Z', speaker: '客户', text: '方案初稿下周内部评审后推进。' }];
    const driftedRecording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-inh',
      title: '原始转写', occurredAt: drifted[0]!.spokenAt, payload: { recordingId: 'rec-inh', lines: drifted }, attributionStatus: 'unattributed' });
    const secondOutput = { segments: [
      { start_index: 0, end_index: 5, topic: '人为效能项目延期与配色', summary: '延期处理与配色。', subject: '人为效能项目', focus: '二期延期与配色', topic_key: 'delay', include: true },
      { start_index: 6, end_index: 11, topic: '私有云扩容', summary: '扩容计划与预算。', subject: '私有云实例', focus: '扩容落地', topic_key: 'scale', include: true },
    ] };
    const fake2 = fakeSegmentationRuntime([secondOutput, secondOutput]);
    const service2 = new HemorySegmentationService(db, fake2.runtime);
    const current = await service2.segmentRecording(driftedRecording);
    assert.equal(current.length, 2);
    // 重叠覆盖率达标（0.625 ≥ 0.6）：confirmed 连客户一起继承，不回待归属。
    assert.equal(current[0]!.attributionStatus, 'confirmed');
    assert.equal(current[0]!.customerId, 'crm-inh');
    // 尾部新内容覆盖率 0.25 < 0.6：保持待归属。
    assert.equal(current[1]!.attributionStatus, 'unattributed');
    // 待归属列表只剩真新内容；继承不产生收件箱打扰。
    const pending = db.listHemoryFragments({ status: 'pending', days: 0 });
    assert.deepEqual(pending.map((item) => item.id), [current[1]!.id]);
    // 继承走 hemory_attributions override：与人工归属同路径，后续重同步回放保持。
    const override = db.getHemoryAttribution(current[0]!.id);
    assert.equal(override?.status, 'confirmed');
    assert.equal(override?.actor, 'agent');
    // 继承写入审计。
    const audits = db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='inherit_hemory_attribution'").get() as { n: number };
    assert.equal(audits.n, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: fully processed recording with cosmetic transcript drift skips re-segmentation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-skip-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-skip', name: '跳过客户' });
    const lines = inheritanceLines();
    const single = { segments: [{ start_index: 0, end_index: 5, topic: '综合沟通', summary: '全量一段。', subject: '综合', focus: '综合沟通', topic_key: 'all', include: true }] };
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-skip',
      title: '原始转写', occurredAt: lines[0]!.spokenAt, payload: { recordingId: 'rec-skip', lines }, attributionStatus: 'unattributed' });
    const fake = fakeSegmentationRuntime([single, single]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const first = await service.segmentRecording(recording);
    assert.equal(first.length, 1);
    db.attributeHemoryFragments([first[0]!.id], 'crm-skip', {}, 'csm');
    // 转写仅发生 speaker 名漂移（行数与结束时刻不变）→ 已处理完的录音必须跳过重切。
    const drifted = lines.map((line, index) => ({ ...line, speaker: index % 2 === 0 ? '张炎' : line.speaker }));
    const driftedRecording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-skip',
      title: '原始转写', occurredAt: drifted[0]!.spokenAt, payload: { recordingId: 'rec-skip', lines: drifted }, attributionStatus: 'unattributed' });
    // 模型一旦被调用立即失败，证明跳过路径没有打模型。
    const strict = { models: { complete: async () => { throw new Error('闸门失效：跳过路径不得调用模型'); } },
      model: {}, llm: { provider: 'strict', model: 'none' } } as any;
    const strictService = new HemorySegmentationService(db, strict);
    const result = await strictService.segmentRecordingDetailed(driftedRecording);
    assert.equal(result.skipped, true);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.attributionStatus, 'confirmed');
    // job 落 skipped 终态：后续同步按指纹命中即短路。
    const jobs = db.listRecentHemorySegmentationJobs();
    assert.ok(jobs.some((job) => job.status === 'skipped' && job.generator === 'skip:fully-processed'));
    const again = await strictService.segmentRecordingDetailed(driftedRecording);
    assert.equal(again.skipped, undefined);
    assert.equal(again.events.length, 1);
    // 跳过审计存在。
    const audits = db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='skip_hemory_resegment'").get() as { n: number };
    assert.equal(audits.n, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: pending fragments or transcript growth defeat the skip gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-skip-gate-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-gate', name: '闸门客户' });
    const lines = inheritanceLines();
    const single = { segments: [{ start_index: 0, end_index: 5, topic: '综合沟通', summary: '全量一段。', subject: '综合', focus: '综合沟通', topic_key: 'all', include: true }] };
    const grown = [...lines,
      { spokenAt: '2026-08-25T05:02:00Z', speaker: '客户', text: '回到刚才的延期问题，新的排期确定后要同步项目群。' },
      { spokenAt: '2026-08-25T05:02:20Z', speaker: 'CSM', text: '排期确定当天我会把更新计划发到群里。' },
      { spokenAt: '2026-08-25T05:02:40Z', speaker: '客户', text: '好的，延期这块就按这个方式跟进。' }];
    const grownSingle = { segments: [{ start_index: 0, end_index: 8, topic: '综合沟通（含回访）', summary: '全量一段。', subject: '综合', focus: '综合沟通', topic_key: 'all', include: true }] };
    const fake = fakeSegmentationRuntime([single, single, single, single, grownSingle, grownSingle]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-gate',
      title: '原始转写', occurredAt: lines[0]!.spokenAt, payload: { recordingId: 'rec-gate', lines }, attributionStatus: 'unattributed' });
    const first = await service.segmentRecording(recording);
    assert.equal(first.length, 1);
    db.attributeHemoryFragments([first[0]!.id], 'crm-gate', {}, 'csm');

    // ① 有待处理片段（清除归属）+ 转写漂移（指纹变化但未增长）：闸门因有待处理片段放行重切。
    db.attributeHemoryFragments([first[0]!.id], null, {}, 'csm');
    const driftedPending = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-gate',
      title: '原始转写', occurredAt: lines[0]!.spokenAt,
      payload: { recordingId: 'rec-gate', lines: lines.map((line, index) => ({ ...line, speaker: index % 2 === 0 ? '张炎' : line.speaker })) }, attributionStatus: 'unattributed' });
    const stillPending = await service.segmentRecordingDetailed(driftedPending);
    assert.equal(stillPending.skipped, undefined);
    assert.equal(stillPending.events[0]!.attributionStatus, 'unattributed');

    // ② 重新确认后再发生实质增长（+3 行、结束时刻后移）：必须重切并继承归属。
    db.attributeHemoryFragments([stillPending.events[0]!.id], 'crm-gate', {}, 'csm');
    const grownRecording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-gate',
      title: '原始转写', occurredAt: grown[0]!.spokenAt, payload: { recordingId: 'rec-gate', lines: grown }, attributionStatus: 'unattributed' });
    const regrown = await service.segmentRecordingDetailed(grownRecording);
    assert.equal(regrown.skipped, undefined);
    assert.equal(regrown.events.length, 1);
    assert.equal(regrown.events[0]!.attributionStatus, 'confirmed');
    assert.equal(regrown.events[0]!.customerId, 'crm-gate');
    // ③ 已处理完 + 再次漂移（第三种 speaker 名 → 新指纹、未增长）→ 闸门跳过。
    const driftedAgain = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-gate',
      title: '原始转写', occurredAt: lines[0]!.spokenAt,
      payload: { recordingId: 'rec-gate', lines: lines.map((line, index) => ({ ...line, speaker: index % 2 === 0 ? '李炎' : line.speaker })) }, attributionStatus: 'unattributed' });
    const skipped = await service.segmentRecordingDetailed(driftedAgain);
    assert.equal(skipped.skipped, true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: re-segmentation inherits ignored status onto overlapping twins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-inherit-ignored-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = inheritanceLines();
    const single = { segments: [{ start_index: 0, end_index: 5, topic: '综合沟通', summary: '全量一段。', subject: '综合', focus: '综合沟通', topic_key: 'all', include: true }] };
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-ign',
      title: '原始转写', occurredAt: lines[0]!.spokenAt, payload: { recordingId: 'rec-ign', lines }, attributionStatus: 'unattributed' });
    const fake = fakeSegmentationRuntime([single, single]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const old = await service.segmentRecording(recording);
    db.ignoreHemoryFragments([old[0]!.id], {}, 'csm');

    // 转写漂移 + 重切边界一致：ignored 同样按时间重叠继承，不再回待归属骚扰。
    const drifted = lines.map((line, index) => ({ ...line, speaker: index % 2 === 0 ? '张炎' : line.speaker }));
    const driftedRecording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-ign',
      title: '原始转写', occurredAt: drifted[0]!.spokenAt, payload: { recordingId: 'rec-ign', lines: drifted }, attributionStatus: 'unattributed' });
    const fake2 = fakeSegmentationRuntime([single, single]);
    const current = await new HemorySegmentationService(db, fake2.runtime).segmentRecording(driftedRecording);
    assert.equal(current.length, 1);
    assert.equal(current[0]!.attributionStatus, 'ignored');
    assert.equal(current[0]!.customerId, null);
    assert.equal(db.listHemoryFragments({ status: 'pending', days: 0 }).length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: expanded consumption ledger blocks duplicate proposals for re-segmented twins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-twin-consumed-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-twin', name: '孪生客户' });
    const lines = inheritanceLines();
    // 第一轮：两段（0-2 / 3-5），用户确认归属客户；写入 followup 草稿消费第一段。
    const twoParts = { segments: [
      { start_index: 0, end_index: 2, topic: '人为效能项目延期', summary: '延期处理。', subject: '人为效能项目', focus: '二期延期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: 'BI 报表配色调整', summary: '配色调整。', subject: 'BI 报表', focus: '配色', topic_key: 'bi-color', include: true },
    ] };
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-twin',
      title: '原始转写', occurredAt: lines[0]!.spokenAt, payload: { recordingId: 'rec-twin', lines }, attributionStatus: 'unattributed' });
    const fake = fakeSegmentationRuntime([twoParts, twoParts]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const old = await service.segmentRecording(recording);
    assert.equal(old.length, 2);
    db.attributeHemoryFragments([old[0]!.id, old[1]!.id], 'crm-twin', {}, 'csm');
    const batch = db.createDraftBatch({ customerId: 'crm-twin', fingerprint: 'fp-twin-1', sourceEventIds: [old[0]!.id],
      generationVersion: 'v', generator: 'fake' });
    db.createDraftItem({ batchId: batch.id, customerId: 'crm-twin', type: 'followup', title: '沟通记录', summary: 's',
      fields: {}, targetSystem: 'crm', targetObject: '跟进记录', targetTool: 'crm__create', targetArguments: {},
      evidenceRefs: [old[0]!.id], unknowns: [], validationErrors: [], status: 'written' });

    // 转写漂移 + 后补三行（新增超容差 → 实质增长放行闸门）+ 重切成整段（0-8，边界不同 → 全新孪生行）。
    const drifted = [...lines.map((line, index) => ({ ...line, speaker: index % 2 === 0 ? '张炎' : line.speaker })),
      { spokenAt: '2026-08-25T05:02:00Z', speaker: '客户', text: '扩容预算走今年的框架合同，不再额外审批。' },
      { spokenAt: '2026-08-25T05:02:20Z', speaker: 'CSM', text: '预算内我们先出扩容方案初稿。' },
      { spokenAt: '2026-08-25T05:02:40Z', speaker: '客户', text: '方案初稿下周内部评审后推进。' }];
    const driftedRecording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-twin',
      title: '原始转写', occurredAt: drifted[0]!.spokenAt, payload: { recordingId: 'rec-twin', lines: drifted }, attributionStatus: 'unattributed' });
    const whole = { segments: [{ start_index: 0, end_index: 8, topic: '综合沟通', summary: '全量一段。', subject: '综合', focus: '综合沟通', topic_key: 'all', include: true }] };
    const fake2 = fakeSegmentationRuntime([whole, whole]);
    const current = await new HemorySegmentationService(db, fake2.runtime).segmentRecording(driftedRecording);
    assert.equal(current.length, 1);
    assert.notEqual(current[0]!.id, old[0]!.id);
    // 新孪生完整覆盖被消费旧片段（05:00:00–05:00:40 ⊂ 05:00:00–05:02:00）：归属继承 + 台账扩展双双生效。
    assert.equal(current[0]!.attributionStatus, 'confirmed');
    assert.equal(db.writtenEvidenceByType('crm-twin').get('followup')?.has(current[0]!.id), false);
    assert.equal(db.expandedWrittenEvidenceByType('crm-twin').get('followup')?.has(current[0]!.id), true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: timeline and draft regeneration ignore superseded fragments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v2-consistency-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-c', name: '客户丙' });
    const raw = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-old',
      title: '原始转写', occurredAt: '2026-08-25T05:00:00Z', payload: { recordingId: 'rec-old', lines: v2Lines() }, attributionStatus: 'unattributed' });
    // v1 遗留 confirmed 片段。
    const v1 = db.upsertSourceEvent({ customerId: 'crm-c', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
      externalId: 'rec-old:2026-08-25T05:00:00Z:0:2026-08-25T05:00:40Z:2', title: 'v1 话题', occurredAt: '2026-08-25T05:00:00Z',
      attributionStatus: 'confirmed', payload: { recordingId: 'rec-old', topic: 'v1 话题', summary: 'v1 摘要', transcript: '客户丙: 旧内容' } });
    db.activateHemoryFragments(raw.id, 'fp-v1', [v1.id]);
    assert.equal(db.listTimeline('crm-c').filter((item) => item.sourceType === 'ai_topic_segment').length, 1);

    // v2 重切产出新片段后激活：v1 停用，时间线不再显示。
    const v2 = db.upsertSourceEvent({ customerId: 'crm-c', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
      externalId: 'v3.2:rec-old:2026-08-25T05:00:00Z:0:2026-08-25T05:01:40Z:5', title: 'v2 话题', occurredAt: '2026-08-25T05:00:00Z',
      attributionStatus: 'confirmed', payload: { recordingId: 'rec-old', topic: 'v2 话题', summary: 'v2 摘要', transcript: '客户丙: 新内容' } });
    db.activateHemoryFragments(raw.id, 'fp-v2', [v2.id]);
    const timelineTopics = db.listTimeline('crm-c').filter((item) => item.sourceType === 'ai_topic_segment');
    assert.deepEqual(timelineTopics.map((item) => item.id), [v2.id]);

    // 作废批次的再生不得使用停用片段：confirmedSegments 过滤 active=0（同步前置校验直接抛错）。
    const drafts = new HemoryDraftService(db, { call: async () => ({ isError: true, text: 'skip' }) } as any);
    assert.throws(() => drafts.regenerate('missing-batch'), /draft batch not found/);
    assert.equal(db.isHemoryFragmentActive(v1.id), false);
    assert.equal(db.isHemoryFragmentActive(v2.id), true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: resegmentAllHemory backs up, iterates all recordings, and reports statistics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v2-resegment-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const linesA = v2Lines();
    const linesB = [
      { spokenAt: '2026-08-20T05:00:00Z', speaker: '客户', text: '私有云实例的扩容需求这个季度要落地。' },
      { spokenAt: '2026-08-20T05:00:30Z', speaker: 'CSM', text: '我先确认当前资源水位和扩容窗口。' },
      { spokenAt: '2026-08-20T05:01:00Z', speaker: '客户', text: '确认后把扩容计划发给运维负责人。' },
    ];
    db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-a',
      title: '原始转写', occurredAt: linesA[0].spokenAt, payload: { recordingId: 'rec-a', lines: linesA }, attributionStatus: 'unattributed' });
    // 窗口外录音（8 天前）也必须被重切遍历到。
    db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-b',
      title: '原始转写', occurredAt: linesB[0].spokenAt, payload: { recordingId: 'rec-b', lines: linesB }, attributionStatus: 'unattributed' });

    const goodOutput = { segments: [
      { start_index: 0, end_index: 2, topic: '人为效能项目延期', summary: '延期处理。', subject: '人为效能项目', focus: '二期延期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: 'BI 报表配色调整', summary: '配色调整。', subject: 'BI 报表', focus: '配色调整', topic_key: 'bi-color', include: true },
    ] };
    const goodOutputB = { segments: [
      { start_index: 0, end_index: 2, topic: '私有云扩容', summary: '扩容计划。', subject: '私有云实例', focus: '扩容落地', topic_key: 'scale', include: true },
    ] };
    let calls = 0;
    const runtime = { models: { complete: async () => {
      calls++;
      // 录音按 occurred_at 倒序处理（rec-a 在前）：调用 1-2 为 rec-a 分区/复核，调用 3 起 rec-b；
      // rec-a 复核（调用 2 起）连续三次坏输出 → 重试 3 次后该录音失败。
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(calls === 2 || calls === 3 || calls === 4 ? { segments: [] } : goodOutputB) }] };
    } }, model: {}, llm: { provider: 'fake', model: 'segmenter' } } as any;
    const segmenter = new HemorySegmentationService(db, runtime);
    const mcp = { call: async () => ({ text: '# more=false\n', isError: false }) } as any;
    const sync = new PortfolioSyncService(db, mcp, (recording) => segmenter.segmentRecordingDetailed(recording));
    const run = sync.resegmentAllHemory();
    // 与增量同步互斥：运行期间再次触发返回同一 run。
    assert.equal(sync.resegmentAllHemory().id, run.id);
    assert.equal(sync.refreshRecentHemory().id, run.id);
    for (let i = 0; i < 200 && db.getSyncRun(run.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const finished = db.getSyncRun(run.id)!;
    assert.equal(finished.scope, 'hemory:resegment:all');
    // rec-a 分区成功但复核三次失败 → 失败；rec-b 成功 → partial。
    assert.equal(finished.status, 'partial');
    const summary = finished.sourceStatus.hemory as Record<string, unknown>;
    assert.equal(summary.recordings, 2);
    assert.equal(summary.failedRecordings, 1);
    assert.ok(String(summary.backupPath).includes('workbench-backup-'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: resegment-all succeeds when every recording passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v2-resegment-ok-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = v2Lines();
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-ok',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'rec-ok', lines }, attributionStatus: 'unattributed' });
    const output = { segments: [
      { start_index: 0, end_index: 2, topic: '人为效能项目延期', summary: '延期处理。', subject: '人为效能项目', focus: '二期延期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: 'BI 报表配色调整', summary: '配色调整。', subject: 'BI 报表', focus: '配色调整', topic_key: 'bi-color', include: true },
    ] };
    const fake = fakeSegmentationRuntime([output]);
    const segmenter = new HemorySegmentationService(db, fake.runtime);
    const mcp = { call: async () => ({ text: '# more=false\n', isError: false }) } as any;
    const sync = new PortfolioSyncService(db, mcp, (rec) => segmenter.segmentRecordingDetailed(rec));
    const run = sync.resegmentAllHemory();
    for (let i = 0; i < 100 && db.getSyncRun(run.id)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const finished = db.getSyncRun(run.id)!;
    assert.equal(finished.status, 'succeeded');
    const summary = finished.sourceStatus.hemory as Record<string, unknown>;
    assert.equal(summary.recordings, 1);
    assert.equal(summary.failedRecordings, 0);
    assert.equal(summary.count, 2);
    assert.equal(summary.discardedSegments, 0);
    assert.equal(db.listHemoryFragments({ status: 'all' }).length, 2);
    assert.ok(db.listHemoryFragments({ status: 'all' }).every((item) => item.externalId.startsWith('v3.2:rec-ok:')));
    assert.ok(db.findSourceEvent('hemory', 'raw_transcript', 'rec-ok') && recording);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: v3 prompts carry hierarchical slicing rules with anti-over-split guidance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v3-prompts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const lines = v2Lines();
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-p3',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'rec-p3', lines }, attributionStatus: 'unattributed' });
    const prompts: string[] = [];
    const output = { segments: [
      { start_index: 0, end_index: 2, topic: '人为效能项目延期', summary: '延期处理。', subject: '人为效能项目', focus: '二期延期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: 'BI 报表配色调整', summary: '配色调整。', subject: 'BI 报表', focus: '配色调整', topic_key: 'bi-color', include: true },
    ] };
    const runtime = { models: { complete: async (_model: unknown, request: any) => {
      prompts.push(request.messages[0].content);
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(output) }] };
    } }, model: {}, llm: { provider: 'fake', model: 'segmenter' } } as any;
    const service = new HemorySegmentationService(db, runtime);
    await service.segmentRecording(recording);
    assert.equal(prompts.length, 2);
    // 阶段 1：合并优先规则 + 不切割清单 + 长会少切期望（v3.2）。
    assert.match(prompts[0], /主切割边界：业务对象变化/);
    assert.match(prompts[0], /次切割边界：同一对象内开始了明显独立的新请求或新决策流/);
    assert.match(prompts[0], /以下情况一律不切/);
    assert.match(prompts[0], /一场 2 小时会议通常 5~8 个片段/);
    assert.match(prompts[0], /单段一般不超过 100 条发言/);
    assert.match(prompts[0], /合并优先，避免切分过细/);
    // 阶段 2：双向复核（拆混合 + 合并过切）。
    assert.match(prompts[1], /双向调整/);
    assert.match(prompts[1], /合并被过度切分的相邻片段/);
    assert.match(prompts[1], /切分过细是错误/);
    assert.match(prompts[1], /远超 100 条发言/);
    assert.match(prompts[1], /标题里出现两个不相关主题是混合信号/);
    // focus 降级为描述性字段。
    assert.match(prompts[0], /focus.*描述用，不触发切分/s);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: adjacent segments of same object but distinct requests stay separate in v3', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-hemory-v3-boundary-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 同一对象（人为效能项目）内的两个独立请求：延期处理 与 权限模型改造——合法切割，防御合并不得合并。
    const lines = [
      { spokenAt: '2026-08-25T05:00:00Z', speaker: '客户', text: '人为效能项目二期延期了，联调卡住需要新排期。' },
      { spokenAt: '2026-08-25T05:00:20Z', speaker: 'CSM', text: '本周内给出新排期并同步张总。' },
      { spokenAt: '2026-08-25T05:00:40Z', speaker: '客户', text: '延期结论更新到项目计划里。' },
      { spokenAt: '2026-08-25T05:01:00Z', speaker: '客户', text: '另外希望对人为效能项目启动权限模型改造，按部门隔离数据。' },
      { spokenAt: '2026-08-25T05:01:20Z', speaker: 'CSM', text: '权限改造我先出方案初稿，下周评审。' },
      { spokenAt: '2026-08-25T05:01:40Z', speaker: '客户', text: '方案确认后再评估改造周期。' },
    ];
    const recording = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-b3',
      title: '原始转写', occurredAt: lines[0].spokenAt, payload: { recordingId: 'rec-b3', lines }, attributionStatus: 'unattributed' });
    const output = { segments: [
      { start_index: 0, end_index: 2, topic: '人为效能项目二期延期', summary: '延期排期安排。', subject: '人为效能项目', focus: '二期延期排期', topic_key: 'delay', include: true },
      { start_index: 3, end_index: 5, topic: '人为效能项目权限模型改造', summary: '权限改造新请求。', subject: '人为效能项目', focus: '权限模型改造', topic_key: 'perm-redesign', include: true },
    ] };
    const fake = fakeSegmentationRuntime([output]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const fragments = await service.segmentRecording(recording);
    assert.equal(fragments.length, 2);
    assert.notEqual(fragments[0].payload?.topicKey, fragments[1].payload?.topicKey);
    assert.equal(fragments[0].payload?.topicGroupId, 'rec-b3:delay');
    assert.equal(fragments[1].payload?.topicGroupId, 'rec-b3:perm-redesign');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: fragment list filters by customer for the attributed view', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-fa', name: '客户甲' });
  db.upsertCustomer({ id: 'crm-fb', name: '客户乙' });
  const raw = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'r-cfilter', title: '原始转写',
    occurredAt: '2026-08-25T05:00:00Z', payload: { recordingId: 'r-cfilter' }, attributionStatus: 'unattributed' });
  const a1 = segment(db, 'crm-fa', 'r-cfilter:t1', 'r-cfilter', '甲话题', '2026-08-25T05:00:00Z', '甲的沟通');
  const b1 = segment(db, 'crm-fb', 'r-cfilter:t2', 'r-cfilter', '乙话题', '2026-08-25T06:00:00Z', '乙的沟通');
  const pending = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r-cfilter:t3',
    title: '待归属', occurredAt: '2026-08-25T07:00:00Z', payload: { recordingId: 'r-cfilter', transcript: '待归属内容' }, attributionStatus: 'unattributed' });
  db.activateHemoryFragments(raw.id, 'fingerprint-cfilter', [a1.id, b1.id, pending.id]);
  const fa = db.listHemoryFragments({ status: 'confirmed', customerId: 'crm-fa' }).map((item) => item.id);
  assert.deepEqual(fa, [a1.id]);
  const fb = db.listHemoryFragments({ status: 'confirmed', customerId: 'crm-fb' }).map((item) => item.id);
  assert.deepEqual(fb, [b1.id]);
  // 不带客户过滤仍返回两个客户的全部已归属片段。
  assert.deepEqual(db.listHemoryFragments({ status: 'confirmed' }).map((item) => item.id).sort(), [a1.id, b1.id].sort());
  // 客户过滤与待归属状态组合只影响归属维度，不把 pending 误收进来。
  assert.deepEqual(db.listHemoryFragments({ status: 'pending', customerId: 'crm-fa' }).map((item) => item.id), []);
}));

test('workbench: regenerateByEventIds rebuilds per customer-day and rejects invalid fragments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-regen-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-ra', name: '客户甲' });
    db.upsertCustomer({ id: 'crm-rb', name: '客户乙' });
    // 客户甲 8-25 与 8-26 各一片段 + 客户乙 8-25 一片段；另备一个待归属与一个未知 ID 用于校验路径。
    const a1 = segment(db, 'crm-ra', 'r-a:t1', 'r-a', '甲话题一', '2026-08-25T05:00:00Z', '甲的沟通一');
    const a2 = segment(db, 'crm-ra', 'r-a:t2', 'r-a', '甲话题二', '2026-08-26T05:00:00Z', '甲的沟通二');
    const b1 = segment(db, 'crm-rb', 'r-b:t1', 'r-b', '乙话题', '2026-08-25T05:00:00Z', '乙的沟通');
    const pending = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r-c:t1',
      title: '待归属', occurredAt: '2026-08-25T08:00:00Z', payload: { recordingId: 'r-c', transcript: '待归属内容' }, attributionStatus: 'unattributed' });
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    // 非法输入逐条列明原因：未知 ID / 待归属片段。
    assert.throws(() => service.regenerateByEventIds(['evt-missing']), /evt-missing: 片段不存在/);
    assert.throws(() => service.regenerateByEventIds([pending.id]), /不是已归属状态/);
    // 混合客户跨天：选中的三个片段对应 3 个「客户+上海日」。
    const { jobs, days } = service.regenerateByEventIds([a1.id, a2.id, b1.id]);
    assert.deepEqual(days.sort((x, y) => `${x.customerId}:${x.dateKey}`.localeCompare(`${y.customerId}:${y.dateKey}`)),
      [{ customerId: 'crm-ra', dateKey: '2026-08-25' }, { customerId: 'crm-ra', dateKey: '2026-08-26' }, { customerId: 'crm-rb', dateKey: '2026-08-25' }].sort((x, y) => `${x.customerId}:${x.dateKey}`.localeCompare(`${y.customerId}:${y.dateKey}`)));
    assert.equal(jobs.length, 3);
    for (const job of jobs) await waitForJob(db, job.jobId);
    // 每个客户各得到一个非 stale 批次，且批次来源覆盖该客户当天全部片段。
    assert.equal(db.listDraftBatches('crm-ra').filter((batch) => batch.status !== 'stale').length, 2);
    assert.equal(db.listDraftBatches('crm-rb').filter((batch) => batch.status !== 'stale').length, 1);
    // 强制重生成语义：再次触发同片段会换盐指纹重建，旧非 stale 批次被置 stale。
    const again = service.regenerateByEventIds([a1.id]);
    assert.equal(again.days.length, 1);
    await waitForJob(db, again.jobs[0]!.jobId);
    const raBatches = db.listDraftBatches('crm-ra');
    // 8-25 产生新旧两代批次，8-26 保持一代。
    assert.equal(raBatches.filter((batch) => batch.status !== 'stale').length, 2);
    assert.equal(raBatches.filter((batch) => batch.status === 'stale').length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 实施周报（weekly reports） ──

import { WeeklyReportService, weekMonday, weekRange, weeklyFingerprint, renderWeeklyMarkdown, weeklyContentWarnings, WEEKLY_REPORT_GENERATION_VERSION } from '../src/workbench/weekly.js';

function fakeWeeklyModel(content: unknown): any {
  return {
    llm: { provider: 'fake', model: 'fake-model' },
    models: { complete: async () => ({ content: [{ type: 'text', text: JSON.stringify(content) }], stopReason: 'stop' }) },
  };
}

const WEEKLY_CONTENT = {
  summary: '本周双方完成报表导出性能问题定位与方案确认，整体交付按计划推进。',
  accomplishments: [
    { category: '问题与支持', date: '2026-08-25', text: '双方已确认导出性能问题的定位结论与优化方案', source: '08-25 会议' },
    { category: '问题与支持', date: '2026-08-26', text: '导出超时问题已完成修复验证', source: '工单 T-2001' },
  ],
  next_week_plan: [{ text: '双方按约定完成导出性能复测，预计周四前出结论', source: '08-25 会议约定' }],
  risks: [{ text: '【风险】导出性能复测结果尚待确认，若未达预期可能影响后续验收节点。项目组已准备备选优化方案，届时将与贵方确认调整安排。', source: '08-25 电话' }],
};

test('workbench: week helpers align to Monday and compute Shanghai week bounds', () => {
  assert.equal(weekMonday('2026-08-28'), '2026-08-24');
  assert.equal(weekMonday('2026-08-24'), '2026-08-24');
  assert.equal(weekMonday('2026-08-23'), '2026-08-17');
  assert.equal(weekMonday('2026-08-30'), '2026-08-24');
  assert.equal(weekMonday(new Date('2026-08-28T01:30:00Z')), '2026-08-24');
  const range = weekRange('2026-08-24');
  assert.equal(range.weekEnd, '2026-08-30');
  assert.equal(range.start, '2026-08-23T16:00:00.000Z');
  assert.equal(range.end, '2026-08-30T15:59:59.999Z');
});

test('workbench: listSourceEventsInRange filters by time window and excludes snapshots and inactive fragments', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-w1', name: '周报客户一' });
  const inWeek = db.upsertSourceEvent({ customerId: 'crm-w1', sourceSystem: 'ones', sourceType: 'support_ticket',
    externalId: 'ticket-1', title: '导出超时', occurredAt: '2026-08-25T03:00:00Z',
    payload: { field005: { name: '已完成' }, field009: '2026-08-25T03:00:00Z', field010: '2026-08-26T03:00:00Z' } });
  // 周界之外（8-22 周六属于上一周）。
  db.upsertSourceEvent({ customerId: 'crm-w1', sourceSystem: 'ones', sourceType: 'support_ticket',
    externalId: 'ticket-0', title: '上周工单', occurredAt: '2026-08-22T03:00:00Z' });
  // 元数据快照不算业务事件。
  db.upsertSourceEvent({ customerId: 'crm-w1', sourceSystem: 'crm', sourceType: 'customer_snapshot',
    externalId: 'snap-1', title: '客户资料', occurredAt: '2026-08-25T03:00:00Z' });
  // naive 时间格式的 ONES 历史行（无时区后缀，实为上海时间 8-25 12:00）。
  const naive = db.upsertSourceEvent({ customerId: 'crm-w1', sourceSystem: 'ones', sourceType: 'suggestion_feedback',
    externalId: 'sug-1', title: '希望支持 CSV 导出', occurredAt: '2026-08-25 12:00:00' });
  // 无客户归属的事件不出现。
  db.upsertSourceEvent({ customerId: null, sourceSystem: 'ones', sourceType: 'support_ticket',
    externalId: 'ticket-2', title: '别人的工单', occurredAt: '2026-08-25T03:00:00Z' });
  const range = weekRange('2026-08-24');
  const events = db.listSourceEventsInRange('crm-w1', { since: range.start, until: range.end });
  assert.deepEqual(events.map((event) => event.externalId).sort(), ['sug-1', 'ticket-1']);
  assert.ok(events.find((event) => event.id === naive.id), 'naive 上海时间必须落入周窗');
  const filtered = db.listSourceEventsInRange('crm-w1', { since: range.start, until: range.end, sourceTypes: ['support_ticket'] });
  assert.deepEqual(filtered.map((event) => event.externalId), ['ticket-1']);
}));

test('workbench: weekly report generation uses full-context model call and persists stats/content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-weekly-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-w2', name: '周报客户二' });
    db.upsertSourceEvent({ customerId: 'crm-w2', sourceSystem: 'ones', sourceType: 'support_ticket',
      externalId: 'w2-ticket-1', title: '导出超时', occurredAt: '2026-08-25T03:00:00Z',
      payload: { field005: { name: '已完成' }, field009: '2026-08-25T03:00:00Z', field010: '2026-08-26T03:00:00Z' } });
    db.upsertSourceEvent({ customerId: 'crm-w2', sourceSystem: 'ones', sourceType: 'support_ticket',
      externalId: 'w2-ticket-2', title: '登录偶发失败', occurredAt: '2026-08-26T03:00:00Z',
      payload: { field005: { name: '阻塞中' }, field009: '2026-08-26T03:00:00Z' } });
    segment(db, 'crm-w2', 'w2-r1:t1', 'w2-r1', '性能沟通', '2026-08-25T05:00:00Z', '客户反馈导出超时，约定周四复测');
    // listHemoryFragments 走 INNER JOIN 代际登记表（真实链路由分段服务登记），测试手动登记录音事件。
    const w2Recording = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'raw_transcript',
      externalId: 'w2-r1', title: '录音 w2-r1', occurredAt: '2026-08-25T05:00:00Z', payload: {} });
    db.activateHemoryFragments(w2Recording.id, 'fp-w2', [db.findSourceEvent('hemory', 'ai_topic_segment', 'w2-r1:t1')!.id]);
    let capturedPrompt = '';
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        capturedPrompt = input.messages[0].content;
        return { content: [{ type: 'text', text: JSON.stringify(WEEKLY_CONTENT) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new WeeklyReportService(db, { listTools: () => [], call: async () => ({ text: '', isError: false }) } as any, runtime,
      async () => ({ records: [{ startTime: '2026-08-25T10:00:00+08:00', hours: 2, description: '问题排查' }] }));
    const result = service.generate('crm-w2', '2026-08-28');
    assert.equal(result.weekStart, '2026-08-24');
    assert.ok(result.jobId);
    await waitForJob(db, result.jobId!);
    const report = db.getWeeklyReportByWeek('crm-w2', '2026-08-24')!;
    assert.ok(report, '周报必须落库');
    assert.equal(report.content.summary, WEEKLY_CONTENT.summary);
    assert.equal(report.stats.communications, 1, '单录音一场沟通');
    assert.equal(report.stats.newTickets, 2);
    assert.equal(report.stats.resolvedTickets, 1);
    assert.equal(report.stats.resolvedSuggestions, 0);
    assert.equal(report.stats.blockedTickets, 1);
    assert.equal(report.stats.openTickets, 1);
    assert.equal(report.stats.workhours, 2);
    // 全量上下文注入：工单、片段转写、工时记录都在 prompt 里。
    assert.match(capturedPrompt, /导出超时/);
    assert.match(capturedPrompt, /阻塞中/);
    assert.match(capturedPrompt, /created_in_week/);
    assert.match(capturedPrompt, /约定周四复测/);
    assert.match(capturedPrompt, /问题排查/);
    assert.match(capturedPrompt, /next_week_plan/);
    // 客户版定位与章节规则：面向外部客户、结果导向、合并会议流水、禁内部统计/评级、风险不隐藏且中性可行动、source 仅内部依据。
    assert.match(capturedPrompt, /面向外部客户/);
    assert.match(capturedPrompt, /直接复制或发布给外部客户/);
    assert.match(capturedPrompt, /项目成果、已确认结论/);
    assert.match(capturedPrompt, /合并后的项目进展/);
    assert.match(capturedPrompt, /逐场复述会议流水/);
    assert.match(capturedPrompt, /内部统计/);
    assert.match(capturedPrompt, /风险评级/);
    assert.match(capturedPrompt, /不能为了让周报显得积极而隐藏真实风险/);
    assert.match(capturedPrompt, /客观、克制、透明、可行动/);
    assert.match(capturedPrompt, /【风险】/);
    assert.match(capturedPrompt, /【阻塞】/);
    assert.match(capturedPrompt, /【待确认】/);
    assert.match(capturedPrompt, /仅供内部审核的证据标注/);
    assert.match(capturedPrompt, /不进入客户版正文/);
    // 近音词规则注入。
    assert.match(capturedPrompt, /发音相近/);
    for (const alias of ['万死', '万斯', 'vans']) assert.ok(capturedPrompt.includes(alias), `周报提示词必须包含近音词 ${alias}`);
    assert.match(capturedPrompt, /优先理解为并写作 ONES/);
    assert.match(capturedPrompt, /适用于全部正文与 source/);
    // 幂等：同指纹再次生成复用任务，不新建。
    const again = service.generate('crm-w2', '2026-08-26');
    assert.equal(again.jobId, result.jobId);
    // 客户版 Markdown：新标题格式 + 四个编号章节；条目统一阿拉伯有序编号；不含统计与来源。
    const markdown = renderWeeklyMarkdown(report, '周报客户二');
    assert.match(markdown, /# 周报客户二 ONES 项目实施周报/);
    assert.match(markdown, /周报周期：2026-08-24 至 2026-08-30/);
    assert.match(markdown, /## 一、本周工作概览/);
    assert.match(markdown, /## 二、本周关键进展/);
    assert.match(markdown, /## 三、下周工作计划/);
    assert.match(markdown, /## 四、风险与待协调事项/);
    assert.match(markdown, /^1\. /m);
    assert.doesNotMatch(markdown, /^- /m);
    assert.doesNotMatch(markdown, /（\d{2}-\d{2} 会议）/);
    assert.doesNotMatch(markdown, /【问题与支持】/);
    // 生成版本锁定：回退版本字符串会让旧指纹复活幂等短路，旧内容周报无法重建。
    assert.equal(WEEKLY_REPORT_GENERATION_VERSION, 'weekly-report-v3-customer-facing');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: weekly report failure marks job failed and manual regenerate is not short-circuited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-weekly-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-w3', name: '周报客户三' });
    segment(db, 'crm-w3', 'w3-r1:t1', 'w3-r1', '风险沟通', '2026-08-25T05:00:00Z', '客户表达担忧');
    const badModel = {
      llm: { provider: 'fake', model: 'broken' },
      models: { complete: async () => ({ content: [{ type: 'text', text: '服务暂时不可用' }], stopReason: 'stop' }) },
    } as any;
    const mcp = { listTools: () => [], call: async () => ({ text: '', isError: false }) } as any;
    const service = new WeeklyReportService(db, mcp, badModel);
    const first = service.generate('crm-w3', '2026-08-25');
    // badModel 返回非 JSON，会走满 3 次重试（指数退避 5s+15s）：等待窗口放宽到 75 秒。
    for (let i = 0; i < 3750 && db.getDraftJob(first.jobId!)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(db.getDraftJob(first.jobId!)?.status, 'failed');
    assert.match(db.getDraftJob(first.jobId!)?.error ?? '', /模型未生成周报/);
    assert.ok(!db.getWeeklyReportByWeek('crm-w3', '2026-08-24'), '失败任务不得落周报');
    // 手动「再次生成」= force：换盐指纹，不被失败指纹短路。等待其到终态再关库，避免异步任务跨越测试边界。
    const retry = service.generate('crm-w3', '2026-08-25', true);
    assert.notEqual(retry.jobId, first.jobId);
    assert.equal(db.getDraftJob(retry.jobId!)?.kind, 'weekly_report');
    for (let i = 0; i < 3750 && ['pending', 'running'].includes(db.getDraftJob(retry.jobId!)?.status ?? ''); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(db.getDraftJob(retry.jobId!)?.status, 'failed');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: weekly report generation writes stage/model progress without touching attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-weekly-prog-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-wp1', name: '周报进度客户' });
    db.upsertSourceEvent({ customerId: 'crm-wp1', sourceSystem: 'ones', sourceType: 'support_ticket',
      externalId: 'wp1-ticket-1', title: '导出超时', occurredAt: '2026-08-25T03:00:00Z',
      payload: { field005: { name: '已完成' }, field009: '2026-08-25T03:00:00Z' } });
    // 流式假模型：yield 两个 text_delta 后以完整消息收尾，验证进度助手消费增量并统计字数。
    const streamedText = JSON.stringify(WEEKLY_CONTENT);
    const streamRuntime = {
      llm: { provider: 'fake', model: 'fake-stream' },
      models: {
        complete: async () => ({ content: [{ type: 'text', text: streamedText }], stopReason: 'stop' }),
        stream: (_model: unknown, _context: any) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: streamedText.slice(0, Math.ceil(streamedText.length / 2)), partial: {} };
            yield { type: 'text_delta', contentIndex: 0, delta: streamedText.slice(Math.ceil(streamedText.length / 2)), partial: {} };
          },
          result: async () => ({ content: [{ type: 'text', text: streamedText }], stopReason: 'stop' }),
        }),
      },
    } as any;
    const service = new WeeklyReportService(db, { listTools: () => [], call: async () => ({ text: '', isError: false }) } as any, streamRuntime);
    const result = service.generate('crm-wp1', '2026-08-28');
    await waitForJob(db, result.jobId!);
    const job = db.getDraftJob(result.jobId!)!;
    assert.equal(job.status, 'succeeded');
    // 流式路径生效：进度文案含模型输出字数（而非只有 complete 兜底）。
    assert.match(job.progress ?? '', /模型撰写中… 已输出 \d+ 字/);
    // 进度写入不动 attempts：成功任务恰好 running 一次。
    assert.equal(job.attempts, 1);
    // updateDraftJobProgress 独立于状态机：直接调用不改变 status。
    db.updateDraftJobProgress(result.jobId!, '手动进度');
    assert.equal(db.getDraftJob(result.jobId!)?.status, 'succeeded');
    assert.equal(db.getDraftJob(result.jobId!)?.progress, '手动进度');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: heretry draft generation writes stage/model progress without touching attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-prog-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-hp1', name: '草稿进度客户' });
    const event = segment(db, 'crm-hp1', 'hp1:t1', 'hp1r', '报错需求跟进', '2026-08-25T05:00:00Z', '客户提到工单报错需要跟进');
    const fakeMcp = { listTools: () => [], isWrite: () => false, resolve: () => undefined,
      call: async () => ({ text: '', isError: false }) } as any;
    // 流式假模型：两个 text_delta 之间挂 1.6s（> 1.5s 节流窗），流式 tick 才会真正落库——
    // 生产模型输出以秒/分钟计自然满足；瞬时吐完的假流只在收尾 force 一次，会被后续阶段文案覆盖。
    const streamedText = JSON.stringify({ drafts: [{ type: 'followup', title: '沟通记录', summary: '全天综述。',
      fields: { one_line_summary: '跟进报错需求' }, evidence_refs: [event.id] }] });
    const streamRuntime = {
      llm: { provider: 'fake', model: 'fake-stream' },
      models: {
        complete: async () => ({ content: [{ type: 'text', text: streamedText }], stopReason: 'stop' }),
        stream: (_model: unknown, _context: any) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: streamedText.slice(0, Math.ceil(streamedText.length / 2)), partial: {} };
            await new Promise((resolve) => setTimeout(resolve, 1600));
            yield { type: 'text_delta', contentIndex: 0, delta: streamedText.slice(Math.ceil(streamedText.length / 2)), partial: {} };
          },
          result: async () => ({ content: [{ type: 'text', text: streamedText }], stopReason: 'stop' }),
        }),
      },
    } as any;
    const service = new HemoryDraftService(db, fakeMcp, streamRuntime);
    const queued = service.enqueue('crm-hp1', [event.id]);
    assert.equal(queued.length, 1);
    let sawStage = false;
    let sawModelChars = false;
    for (let i = 0; i < 1500 && !(sawStage && sawModelChars); i++) {
      const job = db.getDraftJob(queued[0].jobId);
      if (job?.progress?.includes('证据就绪')) sawStage = true;
      if (job?.progress && /模型撰写中… 已输出 \d+ 字/.test(job.progress)) sawModelChars = true;
      if (!sawStage || !sawModelChars) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(sawStage, '草稿生成进度必须含证据就绪阶段文案');
    assert.ok(sawModelChars, '流式进度必须出现「模型撰写中… 已输出 N 字」');
    // 流式挂起 1.6s 超出共用 waitForJob 的 1s 上限，这里放宽等待终态。
    for (let i = 0; i < 600 && db.getDraftJob(queued[0].jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const job = db.getDraftJob(queued[0].jobId)!;
    assert.equal(job.status, 'succeeded');
    // 进度写入不动 attempts：成功任务恰好 running 一次。
    assert.equal(job.attempts, 1);
    assert.match(job.progress ?? '', /已解析 \d+ 条草稿提案/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: heretry draft retry reports delay in progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-retry-prog-'));
  const db = new WorkbenchDatabase(dir);
  const previousBaseMs = draftModelRetryDelays.baseMs;
  draftModelRetryDelays.baseMs = 1;
  try {
    db.upsertCustomer({ id: 'crm-hp2', name: '草稿重试进度客户' });
    const event = segment(db, 'crm-hp2', 'hp2:t1', 'hp2r', '报错需求跟进', '2026-08-25T05:00:00Z', '客户提到工单报错需要跟进');
    const fakeMcp = { listTools: () => [], isWrite: () => false, resolve: () => undefined,
      call: async () => ({ text: '', isError: false }) } as any;
    // 第一次 provider 故障（stopReason=error）、第二次正常：重试提示必须落进 progress。
    let calls = 0;
    const flakyRuntime = {
      llm: { provider: 'fake', model: 'flaky' },
      models: { complete: async () => {
        calls++;
        if (calls === 1) return { content: [], stopReason: 'error', errorMessage: 'connect timeout' };
        return { content: [{ type: 'text', text: JSON.stringify({ drafts: [] }) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new HemoryDraftService(db, fakeMcp, flakyRuntime);
    const queued = service.enqueue('crm-hp2', [event.id]);
    // 退避 1ms + 解析瞬时完成：重试提示可能只存在几毫秒就被后续文案覆盖，逐轮抓取仍可能错过；
    // 这里用挂起的第二次 complete 放大窗口，重试提示必然可观测。
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sawRetry = false;
    const watcher = (async () => {
      for (let i = 0; i < 2000 && !sawRetry; i++) {
        const job = db.getDraftJob(queued[0].jobId);
        if (job?.progress?.includes('秒后自动重试')) sawRetry = true;
        else await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release?.();
    await watcher;
    assert.ok(sawRetry, '模型重试的退避提示必须写进任务进度');
    await waitForJob(db, queued[0].jobId);
    assert.equal(db.getDraftJob(queued[0].jobId)?.status, 'succeeded');
  } finally { draftModelRetryDelays.baseMs = previousBaseMs; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case generation writes web-search stage progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-prog-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const fetcher: HttpPost = async () => JSON.stringify({ results: [
      { title: '案例客户一需求管理实践报道', url: 'https://news.example.com/1', published_date: '2026-02-01', content: '案例客户一引入需求管理平台' },
    ] });
    const service = new CaseService(db, caseMcp(), fakeCaseModel(CASE_CONTENT, true), {
      getApiKey: () => 'tvly-test', getMaxResults: () => 5, getKeylessEnabled: () => true, fetcher,
    });
    const result = service.generate('crm-c1');
    // 检索阶段完成前轮询进度：5 个角度逐个出现在任务进度里。
    let sawAngle = false;
    for (let i = 0; i < 500 && !sawAngle; i++) {
      const job = db.getDraftJob(result.jobId!);
      if (job?.progress?.includes('联网检索公开动态（')) sawAngle = true;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(sawAngle, '案例生成进度必须含逐角度检索文案');
    await waitForJob(db, result.jobId!);
    const job = db.getDraftJob(result.jobId!)!;
    assert.equal(job.status, 'succeeded');
    // v5 流水线进度：规划/章节阶段都有流式字数 tick（最后一次 tick 保留在 progress 列）。
    assert.match(job.progress ?? '', /已输出 \d+ 字/);
    assert.equal(job.attempts, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case and weekly services expose in-process processing for stalled decoration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-processing-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    // 闸门模型：首个 complete 调用挂起，保证观察窗口内任务必然处于 running 且在本进程处理集合中。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = fakeCaseModel(CASE_CONTENT);
    const service = new CaseService(db, caseMcp(), {
      ...base,
      models: { complete: async (model: unknown, input: any) => { await gate; return base.models.complete(model, input); } },
    } as any);
    const result = service.generate('crm-c1');
    let sawProcessing = false;
    for (let i = 0; i < 200 && !sawProcessing; i++) {
      if (db.getDraftJob(result.jobId!)?.status === 'running' && service.isJobProcessing(result.jobId!)) sawProcessing = true;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release();
    assert.ok(sawProcessing, '在途 running 任务必须命中 isJobProcessing（stalled 装饰数据源）');
    await waitForJob(db, result.jobId!);
    assert.equal(service.isJobProcessing(result.jobId!), false, '终态后应移出处理集合');
    // 孤儿：库里 running 但不在本进程处理集合（服务重启遗留、attempts 耗尽不再认领）——stalled 依据。
    const caseOrphan = db.createDraftJob('crm-c1', 'fp-case-orphan', [], 'case_report');
    db.updateDraftJob(caseOrphan.id, 'running');
    assert.equal(db.getDraftJob(caseOrphan.id)?.status, 'running');
    assert.equal(service.isJobProcessing(caseOrphan.id), false);
    const weekly = new WeeklyReportService(db, { listTools: () => [], call: async () => ({ text: '', isError: false }) } as any);
    const weeklyOrphan = db.createDraftJob('crm-c1', 'fp-weekly-orphan', [], 'weekly_report');
    db.updateDraftJob(weeklyOrphan.id, 'running');
    assert.equal(weekly.isJobProcessing(weeklyOrphan.id), false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: listActiveDraftJobsByCustomer returns only in-flight jobs of that customer', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-j1', name: '任务客户一' });
  db.upsertCustomer({ id: 'crm-j2', name: '任务客户二' });
  db.upsertSourceEvent({ customerId: 'crm-j1', sourceSystem: 'ones', sourceType: 'support_ticket',
    externalId: 'j1-ticket-1', title: '导出超时', occurredAt: '2026-08-25T03:00:00Z', payload: {} });
  const active = db.createDraftJob('crm-j1', 'fp-active-weekly', ['evt-1'], 'weekly_report');
  db.createDraftJob('crm-j2', 'fp-active-case', ['evt-2'], 'case_report');
  const finished = db.createDraftJob('crm-j1', 'fp-failed-case', ['evt-1'], 'case_report');
  db.updateDraftJob(finished.id, 'failed', '模型未返回可解析的案例 JSON');
  const mine = db.listActiveDraftJobsByCustomer('crm-j1');
  assert.deepEqual(mine.map((job) => job.id), [active.id]);
  assert.equal(mine[0].kind, 'weekly_report');
  assert.equal(mine[0].status, 'pending');
  // progress 列随任务行往返。
  db.updateDraftJobProgress(active.id, '模型撰写中… 已输出 100 字');
  assert.equal(db.getDraftJob(active.id)?.progress, '模型撰写中… 已输出 100 字');
  assert.equal(db.getDraftJob(active.id)?.attempts, 0, '进度写入不得累计 attempts');
}));

test('workbench: weekly report edit uses optimistic lock and publish goes through hash gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-weekly-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-w4', name: '周报客户四' });
    segment(db, 'crm-w4', 'w4-r1:t1', 'w4-r1', '交付沟通', '2026-08-25T05:00:00Z', '交付顺利');
    const service = new WeeklyReportService(db,
      { listTools: () => [], call: async () => ({ text: '{"result":"SUCCESS","data":{"pageID":"page-77"}}', isError: false }) } as any,
      fakeWeeklyModel(WEEKLY_CONTENT));
    const queued = service.generate('crm-w4', '2026-08-25');
    await waitForJob(db, queued.jobId!);
    let report = db.getWeeklyReportByWeek('crm-w4', '2026-08-24')!;
    // 乐观锁：错误版本拒绝。
    assert.equal(service.update(report.id, report.version + 5, WEEKLY_CONTENT), null);
    const edited = { ...WEEKLY_CONTENT, summary: '编辑后的摘要' };
    report = service.update(report.id, report.version, edited)!;
    assert.equal(report.version, 2);
    assert.equal(report.content.summary, '编辑后的摘要');
    // 发布哈希门：preview → 篡改内容后 hash 不匹配 → publish 拒绝。
    const preview = service.publishPreview(report.id, 'parent-1');
    assert.equal(preview.args.parentPageID, 'parent-1');
    assert.match(String(preview.args.title), /周报客户四 ONES 项目实施周报/);
    // 客户版发布正文：无来源括号、无内部统计。
    assert.match(String(preview.args.content), /# 周报客户四 ONES 项目实施周报/);
    assert.doesNotMatch(String(preview.args.content), /（08-25/);
    assert.doesNotMatch(String(preview.args.content), /沟通 \d+ 场/);
    const stale = db.updateWeeklyReport(report.id, report.version, { ...edited, summary: '偷改后的摘要' })!;
    assert.equal(stale.version, 3);
    await assert.rejects(() => service.publish(report.id, preview.report.version, 'parent-1', preview.approvalHash), /版本或批准内容已变化/);
    // 正确路径：以最新版本重新 preview → publish 成功 → 状态与页面 ID 落库。
    const fresh = service.publishPreview(stale.id, 'parent-1');
    const published = await service.publish(stale.id, fresh.report.version, 'parent-1', fresh.approvalHash);
    assert.equal(published.status, 'published');
    assert.equal(published.publishedPageId, 'page-77');
    // 已发布的周报不可再 preview。
    assert.throws(() => service.publishPreview(published.id, 'parent-1'), /不可发布/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: customer-facing markdown excludes internal evidence and stats while keeping real risks', () => {
  // 新版生成的干净周报：内部证据只在 source/category/stats 里，正文为客户版表达。
  // （正文残留内部措辞的场景由 legacy 兼容测试的 warnings 覆盖——渲染器不改写正文。）
  const report = {
    id: 'wr-x', customerId: 'crm-x', weekStart: '2026-08-24', weekEnd: '2026-08-30', version: 1, status: 'draft' as const,
    content: {
      summary: '本周双方完成需求调研初步对齐并确认部署窗口，项目整体按计划推进。',
      accomplishments: [
        { category: '需求调研', date: '2026-08-25', text: '完成需求调研初步对齐', source: 'Hemory 片段 08-25' },
      ],
      next_week_plan: [{ text: '双方完成部署方案确认', source: '行动事项' }],
      risks: [
        { text: '【风险】服务器资源到位时间尚待确认，可能影响部署节点。双方将于下周确认资源清单。', source: '08-26 电话' },
        { text: '【阻塞】第三方接口未开通导致联调暂停。项目组已同步替代验证方案。', source: '工单 T-2005' },
        { text: '【待确认】数据库选型尚需双方确认，项目组将给出建议方案。', source: '08-27 会议' },
      ],
    },
    stats: { communications: 3, newSuggestions: 0, newTickets: 0, newOperations: 0, resolvedSuggestions: 0, resolvedTickets: 0, resolvedOperations: 0, blockedTickets: 1, openTickets: 2, workhours: 0, actionsCompleted: 0, notes: [] },
    generator: 'fake/model', fingerprint: 'fp-x', createdAt: '2026-08-31T00:00:00Z', updatedAt: '2026-08-31T00:00:00Z',
  };
  const markdown = renderWeeklyMarkdown(report as any, '测试客户');
  // 四章节标题与条目保留；条目统一阿拉伯有序编号（无 `- ` 圆点）。
  assert.match(markdown, /## 一、本周工作概览/);
  assert.match(markdown, /## 二、本周关键进展/);
  assert.match(markdown, /## 三、下周工作计划/);
  assert.match(markdown, /## 四、风险与待协调事项/);
  assert.match(markdown, /【风险】服务器资源到位时间尚待确认/);
  assert.match(markdown, /【阻塞】第三方接口未开通/);
  assert.match(markdown, /【待确认】数据库选型/);
  assert.match(markdown, /^1\. 【风险】服务器资源到位时间/m);
  assert.doesNotMatch(markdown, /^- /m);
  // 客户版正文不得包含的内部证据：source 括号、Hemory/CRM/行动事项、统计、[分类] 前缀、unknown。
  assert.ok(!/Hemory/.test(markdown), 'markdown 不得包含 Hemory');
  assert.ok(!/CRM 跟进/.test(markdown), 'markdown 不得包含 CRM 跟进');
  assert.ok(!/行动事项/.test(markdown), 'markdown 不得包含行动事项来源');
  assert.ok(!/风险评级|评分/.test(markdown), 'markdown 不得包含风险评级');
  assert.ok(!/沟通 \d+ 场/.test(markdown), 'markdown 不得包含沟通场次统计');
  assert.ok(!/新增工单 \d+/.test(markdown), 'markdown 不得包含工单统计');
  assert.ok(!/工时 0\.0h/.test(markdown), 'markdown 不得包含工时统计');
  assert.ok(!/（08-25|（08-26|（08-27|（工单/.test(markdown), 'markdown 不得包含来源括号');
  assert.ok(!/unknown/.test(markdown), 'markdown 不得包含 unknown 占位词');
  // 干净内容不告警。
  assert.deepEqual(weeklyContentWarnings(report.content), []);
  // 空风险章节输出固定兜底句。
  const noRiskReport = { ...report, content: { ...report.content, risks: [] } };
  assert.match(renderWeeklyMarkdown(noRiskReport as any, '测试客户'), new RegExp('当前暂无影响项目计划的重大风险或阻塞'));
});

test('workbench: legacy weekly reports render and publish under the customer-facing contract with warnings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-weekly-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-w9', name: '周报客户九' });
    segment(db, 'crm-w9', 'w9-r1:t1', 'w9-r1', '周会', '2026-08-25T05:00:00Z', '推进顺利');
    // 直接落一份「旧版提示词口径」的历史周报：正文残留内部统计、Hemory 引用与情绪记录，source 为内部证据。
    const legacyContent = {
      summary: '本周沟通 2 场（详见 Hemory 片段），工时 0.0h，客户对进度表示不满，整体基调平稳。',
      accomplishments: [{ category: '沟通与会议', date: '2026-08-25', text: '完成周度例会', source: 'Hemory 片段 08-25' }],
      next_week_plan: [{ text: '推进部署准备', source: '行动事项' }],
      risks: [{ text: '客户担忧资源到位时间', source: '风险评级 medium' }],
    };
    const legacyReport = db.upsertWeeklyReport({ customerId: 'crm-w9', weekStart: '2026-08-24', weekEnd: '2026-08-30',
      content: legacyContent as any, stats: { communications: 2, newSuggestions: 0, newTickets: 0, newOperations: 0, resolvedSuggestions: null, resolvedTickets: null, resolvedOperations: null, blockedTickets: 0, openTickets: 0, workhours: 0, actionsCompleted: 0, notes: [] }, generator: 'old/model', fingerprint: 'fp-legacy-9' });
    // 读取正常（历史周报兼容），详情出口的 markdown 已剥离结构性内部证据。
    const detail = new WeeklyReportService(db, { listTools: () => [], call: async () => ({ text: '', isError: false }) } as any).detailWithMarkdown(legacyReport.id);
    assert.ok(detail, '历史周报必须能通过详情出口读取');
    assert.match(detail!.markdown, /# 周报客户九 ONES 项目实施周报/);
    assert.ok(!/（Hemory 片段 08-25）/.test(detail!.markdown), '历史周报的 source 括号必须被剥离');
    assert.ok(!/（风险评级 medium）/.test(detail!.markdown), '历史周报的风险评级来源必须被剥离');
    // warnings 检出正文残留的内部信息（工时统计/Hemory/客户情绪），提示 CSM 修正。
    assert.ok(detail!.warnings.some((warning) => /内部工时统计/.test(warning)), '必须检出正文工时统计残留');
    assert.ok(detail!.warnings.some((warning) => /Hemory/.test(warning)), '必须检出正文 Hemory 残留');
    assert.ok(detail!.warnings.some((warning) => /客户情绪内部记录/.test(warning)), '必须检出客户情绪记录残留');
    // 新版干净内容不告警（在下一周 2026-08-31 生成，不覆盖 legacy 周报）。
    const clean = await (async () => {
      segment(db, 'crm-w9', 'w9-r2:t1', 'w9-r2', '下周会', '2026-09-01T05:00:00Z', '推进顺利');
      const service = new WeeklyReportService(db, { listTools: () => [], call: async () => ({ text: '', isError: false }) } as any, fakeWeeklyModel(WEEKLY_CONTENT));
      const queued = service.generate('crm-w9', '2026-08-31', true);
      await waitForJob(db, queued.jobId!);
      return db.getWeeklyReportByWeek('crm-w9', '2026-08-31')!;
    })();
    assert.deepEqual(weeklyContentWarnings(clean.content), []);
    // 发布哈希门照常工作（preview 返回 warnings；篡改内容后旧批准哈希失效）。
    const service = new WeeklyReportService(db,
      { listTools: () => [], call: async () => ({ text: '{"result":"SUCCESS","data":{"pageID":"page-99"}}', isError: false }) } as any);
    const preview = service.publishPreview(legacyReport.id, 'parent-9');
    assert.ok(Array.isArray(preview.warnings) && preview.warnings.length > 0, '历史周报 preview 必须带 warnings');
    await assert.rejects(() => service.publish(legacyReport.id, preview.report.version + 1, 'parent-9', preview.approvalHash), /版本或批准内容已变化/);
    const published = await service.publish(legacyReport.id, preview.report.version, 'parent-9', preview.approvalHash);
    assert.equal(published.status, 'published');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: weekly fingerprint is deterministic per customer-week-eventset', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-w5', name: '周报客户五' });
  const a = segment(db, 'crm-w5', 'w5:t1', 'w5-r1', '话题', '2026-08-25T05:00:00Z', '内容');
  const b = segment(db, 'crm-w5', 'w5:t2', 'w5-r1', '话题二', '2026-08-26T05:00:00Z', '内容二');
  const same = db.getSourceEvent(a.id)!;
  assert.equal(weeklyFingerprint('crm-w5', '2026-08-24', [a], []), weeklyFingerprint('crm-w5', '2026-08-24', [same], []));
  assert.notEqual(weeklyFingerprint('crm-w5', '2026-08-24', [a], []), weeklyFingerprint('crm-w5', '2026-08-24', [a, b], []));
  assert.notEqual(weeklyFingerprint('crm-w5', '2026-08-24', [a], []), weeklyFingerprint('crm-w6', '2026-08-24', [a], []));
}));

test('workbench: weekly jobs are isolated from daily draft jobs by kind', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-w6', name: '周报客户六' });
  segment(db, 'crm-w6', 'w6:t1', 'w6-r1', '话题', '2026-08-25T05:00:00Z', '内容');
  const hemoryJob = db.createDraftJob('crm-w6', 'fp-h-1', ['evt-1']);
  const weeklyJob = db.createDraftJob('crm-w6', 'fp-w-1', ['evt-2'], 'weekly_report');
  assert.equal(hemoryJob.kind, 'hemory');
  assert.equal(weeklyJob.kind, 'weekly_report');
  assert.ok(db.listPendingDraftJobs().every((job) => job.kind === 'hemory'), 'hemory resume 不得认领周报任务');
  assert.ok(db.listPendingDraftJobs('weekly_report').every((job) => job.kind === 'weekly_report'));
  assert.ok(!db.listPendingDraftJobs('weekly_report').some((job) => job.id === hemoryJob.id));
  assert.ok(!db.listPendingDraftJobs().some((job) => job.id === weeklyJob.id));
}));

test('workbench: weekly report surfaces real model error and retries transient failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-weekly-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-w7', name: '周报客户七' });
    segment(db, 'crm-w7', 'w7-r1:t1', 'w7-r1', '沟通', '2026-08-25T05:00:00Z', '内容');
    const mcp = { listTools: () => [], call: async () => ({ text: '', isError: false }) } as any;
    // 场景一：provider 错误（complete 不抛异常，返回 stopReason=error）——错误消息必须透出真实原因，
    // 不再被「模型未返回可解析的周报 JSON」掩盖；且重试 3 次都失败后任务 failed。
    let errorCalls = 0;
    const failing = {
      llm: { provider: 'fake', model: 'relay' },
      models: { complete: async () => { errorCalls++; return { stopReason: 'error', errorMessage: 'Request timed out.', content: [] }; } },
    } as any;
    const failingService = new WeeklyReportService(db, mcp, failing);
    const job1 = failingService.generate('crm-w7', '2026-08-25');
    // 指数退避 5s+15s+45s（4 次尝试）：等待窗口放宽到 150 秒。
    for (let i = 0; i < 7500 && db.getDraftJob(job1.jobId!)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(errorCalls, 3, '必须自动重试满 3 次');
    const failed = db.getDraftJob(job1.jobId!)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /模型调用失败（第 3\/3 次）: Request timed out\./);
    // 场景二：首次连接超时、重试成功——一次瞬时故障不应导致任务失败。
    let flakyCalls = 0;
    const flaky = {
      llm: { provider: 'fake', model: 'relay' },
      models: { complete: async () => {
        flakyCalls++;
        if (flakyCalls === 1) return { stopReason: 'error', errorMessage: 'Request timed out.', content: [] };
        return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(WEEKLY_CONTENT) }] };
      } },
    } as any;
    const flakyService = new WeeklyReportService(db, mcp, flaky);
    const job2 = flakyService.generate('crm-w7', '2026-08-25', true);
    // 首次失败后要等 5s 退避间隔再重试：窗口放宽到 75 秒。
    for (let i = 0; i < 3750 && db.getDraftJob(job2.jobId!)?.status !== 'succeeded'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (db.getDraftJob(job2.jobId!)?.status === 'failed') break;
    }
    assert.equal(db.getDraftJob(job2.jobId!)?.status, 'succeeded');
    const report = db.getWeeklyReportByWeek('crm-w7', '2026-08-24')!;
    assert.ok(report, '瞬时故障重试后周报必须成功落库');
    assert.equal(report.content.summary, WEEKLY_CONTENT.summary);
    assert.equal(flakyCalls, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: weekly report aggregates work items by update time across weeks and counts recordings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-weekly-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-w8', name: '周报客户八' });
    // 上周创建、本周解决（field010 本周且已完成）：必须进本周周报（newTickets=0、resolvedTickets=1）。
    db.upsertSourceEvent({ customerId: 'crm-w8', sourceSystem: 'ones', sourceType: 'support_ticket',
      externalId: 'T-old-1', displayId: 'T-old-1', title: '上周创建本周解决的工单', occurredAt: '2026-08-18T03:00:00Z',
      payload: { field001: '上周创建本周解决的工单', field005: { name: '已完成' }, field009: '2026-08-18 11:00:00', field010: '2026-08-26 11:00:00' } });
    // 上周创建、本周无更新（field010 上周）：不得进本周周报。
    db.upsertSourceEvent({ customerId: 'crm-w8', sourceSystem: 'ones', sourceType: 'support_ticket',
      externalId: 'T-old-2', displayId: 'T-old-2', title: '上周创建无更新的工单', occurredAt: '2026-08-19T03:00:00Z',
      payload: { field001: '上周创建无更新的工单', field005: { name: '进行中' }, field009: '2026-08-19 11:00:00', field010: '2026-08-20 11:00:00' } });
    // 同一场录音的两个片段（rec-8）+ 另一场录音一个片段（rec-9）：沟通 = 2 场。
    const rec8 = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'raw_transcript',
      externalId: 'rec-8', title: '录音 rec-8', occurredAt: '2026-08-25T05:00:00Z', payload: {} });
    const rec9 = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'raw_transcript',
      externalId: 'rec-9', title: '录音 rec-9', occurredAt: '2026-08-26T05:00:00Z', payload: {} });
    const f1 = db.upsertSourceEvent({ customerId: 'crm-w8', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
      externalId: 'rec-8:t1', title: '话题一', occurredAt: '2026-08-25T05:00:00Z', attributionStatus: 'confirmed',
      payload: { recordingId: 'rec-8', transcript: '话题一内容' } });
    const f2 = db.upsertSourceEvent({ customerId: 'crm-w8', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
      externalId: 'rec-8:t2', title: '话题二', occurredAt: '2026-08-25T05:30:00Z', attributionStatus: 'confirmed',
      payload: { recordingId: 'rec-8', transcript: '话题二内容' } });
    const f3 = db.upsertSourceEvent({ customerId: 'crm-w8', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
      externalId: 'rec-9:t1', title: '话题三', occurredAt: '2026-08-26T05:00:00Z', attributionStatus: 'confirmed',
      payload: { recordingId: 'rec-9', transcript: '话题三内容' } });
    db.activateHemoryFragments(rec8.id, 'fp-w8-8', [f1.id, f2.id]);
    db.activateHemoryFragments(rec9.id, 'fp-w8-9', [f3.id]);
    let capturedPrompt = '';
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        capturedPrompt = input.messages[0].content;
        return { content: [{ type: 'text', text: JSON.stringify(WEEKLY_CONTENT) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new WeeklyReportService(db, { listTools: () => [], call: async () => ({ text: '', isError: false }) } as any, runtime);
    const queued = service.generate('crm-w8', '2026-08-28');
    await waitForJob(db, queued.jobId!);
    const report = db.getWeeklyReportByWeek('crm-w8', '2026-08-24')!;
    assert.ok(report, '周报必须落库');
    // 沟通按录音场数：2 场（rec-8 的两个片段只算一场）。
    assert.equal(report.stats.communications, 2);
    // 跨周聚合：本周没有新建工单，但有 1 条本周解决的旧工单。
    assert.equal(report.stats.newTickets, 0);
    assert.equal(report.stats.resolvedTickets, 1);
    // 上下文：本周解决的旧工单在场（created_in_week=false），上周无更新的不在场。
    assert.match(capturedPrompt, /上周创建本周解决的工单/);
    assert.match(capturedPrompt, /"created_in_week":false/);
    assert.doesNotMatch(capturedPrompt, /上周创建无更新的工单/);
    // 每个片段注入时带 recording_id，LLM 可感知同场关系。
    assert.match(capturedPrompt, /rec-8/);
    assert.match(capturedPrompt, /rec-9/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: segmentation resume failure does not become an unhandled rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-seg-resume-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-seg', name: '分段客户' });
    const recording = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'raw_transcript',
      externalId: 'r-seg', title: '录音', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r-seg', lines: [{ speaker: 'CSM', text: '内容', spokenAt: '2026-08-25T05:00:00+08:00' }] } });
    // 建一个 pending 任务模拟服务重启后的 resume；模型恒超时 → process rethrow。
    db.createHemorySegmentationJob(recording.id, 'fp-seg-resume');
    let rejections = 0;
    const onUnhandled = () => { rejections++; };
    process.on('unhandledRejection', onUnhandled);
    const badRuntime = {
      llm: { provider: 'fake', model: 'broken' },
      models: { complete: async () => ({ stopReason: 'error', errorMessage: 'Request timed out.', content: [] }) },
    } as any;
    const service = new HemorySegmentationService(db, badRuntime);
    // resumePending 内部吞掉失败（job 已落 failed）；这里等待任务终态，断言无 unhandledRejection。
    service.resumePending();
    for (let i = 0; i < 400 && db.listPendingHemorySegmentationJobs().some((job) => job.status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const jobs = db.listPendingHemorySegmentationJobs();
    assert.ok(jobs.some((job) => job.status === 'failed'), '分段任务应落 failed');
    assert.equal(rejections, 0, 'resumePending 不得产生 unhandledRejection（会打崩服务进程）');
    process.off('unhandledRejection', onUnhandled);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 草稿结构化编辑契约与权威合并（Web 编辑弹窗 / 会话确认卡 / CLI draft edit 三端共用）──

test('workbench: draft edit contract exposes Chinese form fields with locked deployment type', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-edit-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-e1', name: '客户壹', sourceObject: 'object_Umwnn__c' });
    db.upsertIdentity('crm-e1', 'ones_customer_option', 'opt-1', '客户壹', 'confirmed');
    const event = db.upsertSourceEvent({ customerId: 'crm-e1', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r30:t1:x',
      title: '客户反馈需求', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r30', speaker: 'CSM', transcript: '客户希望支持批量导出的需求' }, attributionStatus: 'confirmed' });
    const service = new HemoryDraftService(db, fakeOnesMcp(), fakeModelRuntime([
      { type: 'suggestion', title: '支持批量导出', summary: '客户希望支持批量导出的需求', evidence_refs: [event.id],
        fields: { ones_required: { '建议类型': '新需求', '实例部署类型': '私有云', '所属模块': '导入导出', '优先级': 'P2' } } },
    ]));
    const queued = service.enqueue('crm-e1', [event.id]);
    await waitDraftJob(db, queued[0].jobId);
    const suggestion = db.listDraftBatches('crm-e1')[0].items!.find((item) => item.type === 'suggestion')!;
    const customer = db.getCustomer('crm-e1')!;
    const contract = draftEditContract(db, suggestion, customer)!;
    // 可编辑字段：标题 + 规格表除部署类型外的中文下拉 + 描述；实例部署类型进 locked（CRM 确定性判定）。
    assert.deepEqual(contract.fields.map((field) => field.label), ['标题', '建议类型', '所属模块', '优先级', '描述']);
    const priority = contract.fields.find((field) => field.key === 'field:field012')!;
    assert.equal(priority.type, 'select');
    assert.ok(priority.options!.some((option) => option.label === 'P1' && option.value === '762U6awQ'));
    assert.equal(contract.locked.length, 1);
    assert.equal(contract.locked[0].label, '实例部署类型');
    assert.match(contract.locked[0].reason, /CRM 使用版本/);
    // 只读区：所属项目/工作项类型/客户信息/目标工具——结构化信息不进可编辑区。
    assert.ok(contract.readonly.some((item) => item.label === '客户信息' && item.value.includes('客户壹')));
    assert.ok(contract.readonly.some((item) => item.label === '目标工具' && item.value.includes('create_new_issue')));
    // 运维工单：运维工程师是成员字段（text + hint，非下拉）；描述必填。
    const opsEvent = db.upsertSourceEvent({ customerId: 'crm-e1', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r31:t1:x',
      title: '运维操作', occurredAt: '2026-08-25T06:00:00Z',
      payload: { recordingId: 'r31', speaker: 'CSM', transcript: '客户说需要数据备份与恢复，我们协助处理了' }, attributionStatus: 'confirmed' });
    const opsService = new HemoryDraftService(db, fakeOnesMcp(), fakeModelRuntime([
      { type: 'operations', title: '数据备份协助', summary: '帮客户做备份', evidence_refs: [opsEvent.id], fields: {} },
    ]));
    const opsQueued = opsService.enqueue('crm-e1', [opsEvent.id]);
    await waitDraftJob(db, opsQueued[0].jobId);
    const operations = db.listDraftBatches('crm-e1').find((batch) => batch.items!.some((item) => item.type === 'operations'))!.items!.find((item) => item.type === 'operations')!;
    const opsContract = draftEditContract(db, operations, customer)!;
    const engineer = opsContract.fields.find((field) => field.label === '运维工程师')!;
    assert.equal(engineer.type, 'text');
    assert.match(engineer.hint ?? '', /用户 UUID/);
    assert.equal(opsContract.fields.find((field) => field.key === 'desc')!.required, true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: applyDraftEdits merges field edits into targetArguments without breaking structure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-merge-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-e2', name: '客户贰', sourceObject: 'object_Umwnn__c' });
    db.upsertIdentity('crm-e2', 'ones_customer_option', 'opt-2', '客户贰', 'confirmed');
    const event = db.upsertSourceEvent({ customerId: 'crm-e2', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r32:t1:x',
      title: '客户反馈缺陷', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r32', speaker: 'CSM', transcript: '客户希望支持批量导出的需求' }, attributionStatus: 'confirmed' });
    const service = new HemoryDraftService(db, fakeOnesMcp(), fakeModelRuntime([
      { type: 'suggestion', title: '支持批量导出', summary: '客户希望支持批量导出的需求', evidence_refs: [event.id],
        fields: { ones_required: { '建议类型': '新需求', '实例部署类型': '私有云', '所属模块': '导入导出', '优先级': 'P2' } } },
    ]));
    const queued = service.enqueue('crm-e2', [event.id]);
    await waitDraftJob(db, queued[0].jobId);
    const suggestion = db.listDraftBatches('crm-e2')[0].items!.find((item) => item.type === 'suggestion')!;
    const before = JSON.parse(JSON.stringify(suggestion.targetArguments));
    // 中文选项标签输入 → 翻译成选项 UUID；描述/标题同步落位。
    const { patch, errors } = applyDraftEdits(suggestion, { 'field:field012': 'P1', 'desc': '编辑后的描述', title: '新标题' }, '私有部署按年订阅版');
    assert.deepEqual(errors, []);
    const args = patch.targetArguments!;
    assert.equal(args.title, '新标题');
    assert.equal(patch.title, '新标题');
    const values = args.fieldValues as Array<Record<string, string>>;
    assert.ok(values.some((value) => value.fieldID === 'field012' && value.value === '762U6awQ'), '中文标签 P1 必须翻译成选项 UUID');
    assert.ok(values.some((value) => value.fieldID === 'field016' && value.value === '编辑后的描述'));
    // 实例部署类型每次合并按 CRM 使用版本确定性重置（本例非公有云版→私有云 UUID）。
    assert.ok(values.some((value) => value.fieldID === 'HS5u8PNB' && value.value === 'KFewLptQ'));
    // 结构化字段（项目/类型/客户字段/建议类型等未编辑项）原样保留。
    assert.equal(args.projectID, before.projectID);
    assert.equal(args.issueTypeID, before.issueTypeID);
    const beforeCustomer = (before.fieldValues as Array<Record<string, string>>).find((value) => value.fieldID === 'JrvswW8P')!;
    assert.ok(values.some((value) => value.fieldID === 'JrvswW8P' && value.value === beforeCustomer.value));
    const beforeType = (before.fieldValues as Array<Record<string, string>>).find((value) => value.fieldID === 'PYbGEZmN')!;
    assert.ok(values.some((value) => value.fieldID === 'PYbGEZmN' && value.value === beforeType.value));
    // 未知选项必须报错并给合法选项，不产出 args。
    const bad = applyDraftEdits(suggestion, { 'field:field012': 'P9' });
    assert.ok(bad.errors.some((message) => message.includes('优先级') && message.includes('P0')));
    assert.equal(bad.patch.targetArguments, undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: applyDraftEdits validates workhour and preserves followup CRM structure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-edit2-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 工时：非法小时数报错；合法编辑（小时数 + 上海墙钟时间）落到参数。
    const hoursItem = {
      id: 'wh-1', batchId: 'b-1', customerId: 'crm-e3', version: 1, type: 'workhour' as const, status: 'ready' as const,
      title: '工时', summary: '沟通工时', fields: {},
      targetSystem: 'ones' as const, targetObject: '客户工时管理 / 售后客户', targetTool: 'mcp__ones__add_workhour_in_simple_mode',
      targetArguments: { issueID: 'ISSUE-9', hours: 0.2, startTime: '2026-08-25T14:30:00+08:00', description: '沟通' },
      evidenceRefs: [], unknowns: [], validationErrors: [], createdAt: '2026-08-25T00:00:00Z', updatedAt: '2026-08-25T00:00:00Z',
    };
    const badHours = applyDraftEdits(hoursItem, { hours: 'abc' });
    assert.ok(badHours.errors.some((message) => message.includes('正数')));
    const badTime = applyDraftEdits(hoursItem, { startTime: '不是时间' });
    assert.ok(badTime.errors.some((message) => message.includes('开始时间')));
    const merged = applyDraftEdits(hoursItem, { hours: '1.5', startTime: '2026-08-26 09:05', description: '新描述' });
    assert.deepEqual(merged.errors, []);
    assert.equal(merged.patch.targetArguments!.hours, 1.5);
    assert.equal(merged.patch.targetArguments!.startTime, '2026-08-26T09:05:00+08:00');
    assert.equal(merged.patch.targetArguments!.issueID, 'ISSUE-9');
    // 跟进：内容/下一步合并进 object_data，CRM 结构（apiName/object_api_name/客户绑定）原样保留。
    const followupArgs = { apiName: 'CreateRecordsByData', object_api_name: 'ActiveRecordObj',
      object_data: { active_record_content: '旧内容', field_oUaZx__c: '2026-08-25T05:00:00.000Z', field_wYlhw__c: '2026-08-25T06:00:00.000Z',
        field_MIe19__c: 'option1', related_api_names: ['object_Umwnn__c'], active_record_type: '1cbaf4b4110c4a9d836867492e833d9e',
        related_object_data: [{ describe_api_name: 'object_Umwnn__c', id: 'crm-e3', name: '客户叁' }] } };
    const followupItem = {
      id: 'fu-1', batchId: 'b-2', customerId: 'crm-e3', version: 1, type: 'followup' as const, status: 'ready' as const,
      title: '跟进', summary: '沟通记录', fields: {},
      targetSystem: 'crm' as const, targetObject: 'CRM / 销售记录（跟进）', targetTool: 'mcp__crm__data_record_create',
      targetArguments: followupArgs, evidenceRefs: [], unknowns: [], validationErrors: [], createdAt: '2026-08-25T00:00:00Z', updatedAt: '2026-08-25T00:00:00Z',
    };
    const mergedFollowup = applyDraftEdits(followupItem, { content: '新跟进内容', next_steps: '下周回访', end: '2026-08-25 14:00' });
    assert.deepEqual(mergedFollowup.errors, []);
    const args = mergedFollowup.patch.targetArguments!;
    assert.equal(args.apiName, 'CreateRecordsByData');
    assert.equal(args.object_api_name, 'ActiveRecordObj');
    assert.equal(args.object_data.active_record_content, '新跟进内容');
    assert.equal(args.object_data.field_9qb16__c, '下周回访');
    assert.equal(args.object_data.related_object_data[0].id, 'crm-e3');
    // datetime-local 值按上海时间解释：14:00 → 06:00Z。
    assert.equal(args.object_data.field_wYlhw__c, '2026-08-25T06:00:00.000Z');
    // 跟进内容清空必须报错（CRM 必填）。
    const emptyContent = applyDraftEdits(followupItem, { content: '' });
    assert.ok(emptyContent.errors.some((message) => message.includes('跟进内容')));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: confirm draft edit contract and merge for interactive agent drafts', () => {
  const deskDraft = {
    target_system: 'ones', target_object: 'ONES Desk / 工单', record_type: 'ticket', title: '导出失败',
    summary: '导出报错', fields: { customer_id: 'crm-e4', customer_name: '客户肆' },
    target_tool: 'mcp__ones__create_new_issue',
    target_arguments: { projectID: 'GL3ysesFPdnAQNIU', issueTypeID: '7sxvwZMY', title: '导出失败',
      fieldValues: [
        { fieldID: 'JrvswW8P', value: 'opt-4' },
        { fieldID: 'CATNfrrF', value: 'JuTTumjJ' },
        { fieldID: 'HS5u8PNB', value: 'KFewLptQ' },
        { fieldID: 'Su4v8xFs', value: 'SyPTtJdW' },
        { fieldID: 'field029', value: 'KuZfE9scKYpijpKk' },
        { fieldID: 'field016', value: '描述' },
      ] },
  } as any;
  // 会话契约：字段与 Hemory 同构；部署类型锁定并显示 CRM 解析值（草稿现值漂移时也按 CRM 展示）。
  const contract = confirmDraftEditContract(deskDraft, '公有云版')!;
  assert.deepEqual(contract.fields.map((field) => field.label), ['标题', '环境类型', '是否稳定复现', '所属产品', '描述']);
  assert.equal(contract.locked[0].label, '实例部署类型');
  assert.equal(contract.locked[0].value, '公有云');
  // 合并：中文标签翻译成 UUID，部署类型按 CRM（公有云版→公有云）重置。
  const merged = applyConfirmDraftEdits(deskDraft, { 'field:CATNfrrF': 'UAT（用户验收环境）', 'field:field012': undefined } as any, '公有云版');
  assert.deepEqual(merged.errors, []);
  const values = merged.draft!.target_arguments.fieldValues as Array<Record<string, string>>;
  assert.ok(values.some((value) => value.fieldID === 'CATNfrrF' && value.value === 'SMti68WG'));
  assert.ok(values.some((value) => value.fieldID === 'HS5u8PNB' && value.value === 'Fzg8dBCT'), '部署类型必须按 CRM 公有云版重置为公有云 UUID');
  // case/profile 无契约 → null（前端回退 JSON 编辑）。
  assert.equal(confirmDraftEditContract({ ...deskDraft, record_type: 'case' }), null);
  // 未知选项报错且不产出草稿。
  const bad = applyConfirmDraftEdits(deskDraft, { 'field:CATNfrrF': '不存在环境' });
  assert.ok(bad.errors.length > 0);
  assert.equal(bad.draft, null);
});

// ── 客户案例：黑盒叙事生成管线（周报同款任务/指纹/重试骨架） ──
import { CaseService, CASE_GENERATION_VERSION, CASE_SECTIONS, CASE_WEB_ANGLES, buildCaseFigurePrompt, caseFingerprint, caseContentWarnings, caseCoverage, caseDeliveryStats, caseFiguresOf, caseFragmentSignals, caseInternalEvidenceLabel, createCaseProgressLog, caseModelRetryDelays, caseNarrativeWarnings, caseQualityReview, caseSectionTexts, coverageNeedsEnrichment, coverageSummary, parseCaseContent, renderCaseMarkdown, sanitizeCaseSvg, searchCaseWebContext } from '../src/workbench/cases.js';
import { ARCHITECTURE_FIGURE_PALETTE, parseArchitectureGraph, renderArchitectureSvg, type ArchitectureGraph } from '../src/workbench/case-architecture-figure.js';
import { CAPABILITY_MAP_PALETTE, parseCapabilityMapBlueprint, renderCapabilityMapSvg, type CapabilityMapBlueprint } from '../src/workbench/case-capability-map-figure.js';
import { parseValueMapBlueprint, renderValueMapSvg, type ValueMapBlueprint } from '../src/workbench/case-value-map-figure.js';
import { CASE_FIGURE_SHELL_PALETTE, findFigureEdgeTextOverlaps, relayerFigureEdges, styleCaseFigureSvg } from '../src/workbench/case-figure-shell.js';
import { Resvg } from '@resvg/resvg-js';
import { mergeCaseEnrichment, resolveCaseSourceRef } from '../src/workbench/cases.js';
import type { HttpPost } from '../src/tools/websearch.js';

/** 从任一阶段 prompt 尾部的上下文 JSON 中解析 allowed_source_refs/source_catalog（规划/章节/补写共用同一份注入）。 */
function casePromptContext(prompt: string): any {
  const contextText = prompt.slice(prompt.indexOf('上下文：') + '上下文：'.length);
  return JSON.parse(contextText);
}

/** 整稿 JSON（补写路径/旧契约兼容）：从上下文解析真实 source_ref，为各章正文生成 claim_evidence。 */
function publicCaseModelContent(content: any, prompt: string): any {
  const context = casePromptContext(prompt);
  const refs = context.allowed_source_refs as string[];
  const sourceCatalog = new Map((context.source_catalog as any[]).map((item) => [item.source_ref, item]));
  const profileRef = refs.find((ref) => ref.startsWith('customer:')) ?? refs[0];
  const factRef = refs.find((ref) => !ref.startsWith('customer:') && sourceCatalog.get(ref)?.source_type !== 'ai_topic_segment')
    ?? refs.find((ref) => !ref.startsWith('customer:')) ?? profileRef;
  const excerptFor = (ref: string) => String(sourceCatalog.get(ref)?.speaker_lines?.[0]?.text ?? sourceCatalog.get(ref)?.excerpt ?? sourceCatalog.get(ref)?.title ?? 'source');
  const claims = [
    { section: 'intro', claim: content.company_info, source_refs: [profileRef], excerpt: excerptFor(profileRef), speaker_role: 'unknown', status_category: 'unknown', confidence: 0.9 },
    ...(content.business_scope ? [{ section: 'intro', claim: content.business_scope, source_refs: [profileRef], excerpt: excerptFor(profileRef), speaker_role: 'unknown', status_category: 'unknown', confidence: 0.9 }] : []),
    ...(content.competitive_strategy ? [{ section: 'intro', claim: content.competitive_strategy, source_refs: [profileRef], excerpt: excerptFor(profileRef), speaker_role: 'unknown', status_category: 'unknown', confidence: 0.9 }] : []),
    { section: 'intro', claim: content.project_background, source_refs: [profileRef], excerpt: excerptFor(profileRef), speaker_role: 'unknown', status_category: 'unknown', confidence: 0.9 },
    ...content.business_status.map((claim: string) => ({ section: 'status', claim, source_refs: [factRef], excerpt: excerptFor(factRef), speaker_role: 'customer', status_category: 'unknown', confidence: 0.8 })),
    ...content.demands.map((claim: string) => ({ section: 'demands', claim, source_refs: [factRef], excerpt: excerptFor(factRef), speaker_role: 'customer', status_category: 'unknown', confidence: 0.8 })),
    ...content.solution_sections.map((section: any) => ({ section: 'solution', claim: section.text, source_refs: [factRef], excerpt: excerptFor(factRef), speaker_role: 'unknown', status_category: 'done', confidence: 0.8 })),
    ...content.value_items.map((claim: string) => ({ section: 'value', claim, source_refs: [factRef], excerpt: excerptFor(factRef), speaker_role: 'customer', status_category: 'unknown', confidence: 0.8 })),
    ...content.lessons.map((claim: string) => ({ section: 'value', claim, source_refs: [factRef], excerpt: excerptFor(factRef), speaker_role: 'customer', status_category: 'unknown', confidence: 0.8 })),
    { section: 'summary', claim: content.summary, source_refs: [factRef], excerpt: excerptFor(factRef), speaker_role: 'unknown', status_category: 'done', confidence: 0.8 },
  ];
  return { ...content, claim_evidence: claims };
}

function caseEnrichmentContent(content: any, prompt: string): any {
  const first = JSON.parse(prompt.split('- 第一稿正文：\n')[1].split('\n')[0]);
  const mappings = publicCaseModelContent(content, prompt).claim_evidence;
  const changes: any[] = [];
  for (const [field, value] of Object.entries(content)) {
    if (!(field in first) || field === 'title') continue;
    const values = Array.isArray(value) ? value : [value];
    const before = Array.isArray(first[field]) ? first[field] : [first[field]];
    values.forEach((item: any, index) => {
      if (JSON.stringify(item) === JSON.stringify(before[index])) return;
      const text = typeof item === 'string' ? item : item.text;
      const evidence = mappings.find((claim: any) => claim.claim === text);
      changes.push({ field, index: Array.isArray(value) && index < before.length ? index : null,
        text, ...(typeof item === 'object' ? { title: item.title } : {}),
        evidence: { source_refs: evidence.source_refs, excerpt: evidence.excerpt } });
    });
  }
  return { changes };
}

/** 规划阶段产物：从上下文解析真实 source_ref，为 CASE_CONTENT 六章节生成带证据的 plan 骨架。 */
function casePlanContent(content: any, prompt: string): any {
  const context = casePromptContext(prompt);
  const refs = context.allowed_source_refs as string[];
  const sourceCatalog = new Map((context.source_catalog as any[]).map((item) => [item.source_ref, item]));
  const profileRef = refs.find((ref) => ref.startsWith('customer:')) ?? refs[0];
  // 事实引用固定取首个非档案来源（不轮换）：多片段客户的价值/痛点信号引用率保持低值，覆盖度补写测试才有触发空间。
  const factRef = refs.find((ref) => !ref.startsWith('customer:') && sourceCatalog.get(ref)?.source_type !== 'ai_topic_segment')
    ?? refs.find((ref) => !ref.startsWith('customer:')) ?? profileRef;
  const excerptFor = (ref: string) => String(sourceCatalog.get(ref)?.speaker_lines?.[0]?.text ?? sourceCatalog.get(ref)?.excerpt ?? sourceCatalog.get(ref)?.title ?? 'source');
  const item = (idea: string, ref: string, extra: Record<string, unknown> = {}) =>
    ({ idea, excerpt: excerptFor(ref), source_refs: [ref], speaker_role: 'customer', status_category: 'unknown', confidence: 0.8, ...extra });
  return {
    title: content.title,
    plan: [
      { section: 'intro', items: [
        item(content.company_info, profileRef, { slot: 'company_info', speaker_role: 'unknown' }),
        item(content.business_scope, profileRef, { slot: 'business_scope', speaker_role: 'unknown' }),
        item(content.competitive_strategy, profileRef, { slot: 'competitive_strategy', speaker_role: 'unknown' }),
        item(content.project_background, profileRef, { slot: 'project_background', speaker_role: 'unknown' }),
      ] },
      { section: 'status', items: content.business_status.map((claim: string) => item(claim, factRef)) },
      { section: 'demands', items: content.demands.map((claim: string) => item(claim, factRef)) },
      { section: 'solution', items: content.solution_sections.map((section: any) => item(section.title || section.text, factRef, { status_category: 'done' })) },
      { section: 'value', items: [
        ...content.value_items.map((claim: string) => item(claim, factRef, { slot: 'value' })),
        ...content.lessons.map((claim: string) => item(claim, factRef, { slot: 'lesson' })),
      ] },
      { section: 'summary', items: [item(content.summary, factRef, { status_category: 'done' })] },
    ],
    unknowns: content.unknowns,
  };
}

/** 章节阶段产物：按 prompt 声明的章节 label 返回对应形态 JSON，正文取自 CASE_CONTENT。 */
function caseChapterContent(content: any, prompt: string): any {
  const labels: Record<string, string> = { intro: '客户及背景介绍', status: '业务现状', demands: '业务诉求', solution: '业务解决方案', value: '方案价值概述', summary: '项目总结' };
  const section = Object.keys(labels).find((key) => prompt.includes(`「${labels[key]}」章节`));
  if (!section) return { text: content.company_info };
  if (section === 'intro') return { company_info: content.company_info, business_scope: content.business_scope, competitive_strategy: content.competitive_strategy, project_background: content.project_background };
  if (section === 'status') return { texts: content.business_status };
  if (section === 'demands') return { texts: content.demands };
  if (section === 'solution') return { sections: content.solution_sections };
  if (section === 'value') return { texts: content.value_items, lessons: content.lessons };
  return { text: content.summary };
}

/**
 * 阶段感知路由（v5 分章节流水线）：按 prompt 特征区分四类模型调用——
 * 素材摘要（超预算才触发）、规划（章节骨架 plan）、章节生成（单章正文）、补写（整稿第二遍）。
 * 自定义 runtime 的测试统一复用本函数，避免每个测试重复实现阶段判断。
 */
function casePhaseRespond(content: any, prompt: string, opts: { enrichContent?: (prompt: string) => any } = {}): any {
  const body = String(prompt);
  if (body.includes('压缩为一份保真的分块摘要')) return { text: '# communications\n- 摘要内容（source_ref: fake）' };
  if (body.includes('规划客户成功案例草稿的章节结构')) return casePlanContent(content, body);
  if (body.includes('补充完善客户成功案例草稿')) return caseEnrichmentContent(opts.enrichContent?.(body) ?? content, body);
  if (body.includes('只写这一个章节')) return caseChapterContent(content, body);
  return publicCaseModelContent(content, body);
}

function fakeCaseModel(content: unknown, streaming = false): any {
  const respond = (prompt: string) => casePhaseRespond(content, prompt);
  const runtime: any = {
    llm: { provider: 'fake', model: 'fake-model' },
    models: { complete: async (_model: unknown, input: any) => ({
      content: [{ type: 'text', text: JSON.stringify(respond(input.messages[0].content)) }], stopReason: 'stop' }) },
  };
  if (streaming) {
    // 流式包装：stream 转发 complete 的最终输出为一次性 delta，验证进度助手对流式模型的消费。
    runtime.models.stream = (_model: unknown, input: any) => ({
      async *[Symbol.asyncIterator]() {
        const text = JSON.stringify(respond(input.messages[0].content));
        yield { type: 'text_delta', contentIndex: 0, delta: text, partial: {} };
      },
      result: async () => runtime.models.complete(_model, input),
    });
  }
  return runtime;
}

const CASE_CONTENT = {
  title: '制造客户数字化实践案例',
  company_info: '客户戊是装备制造行业的骨干企业，成立超过二十年，产品覆盖多个细分领域，长期服务于国内头部制造集团。',
  business_scope: '公司业务覆盖装备研发、生产制造与售后运维三大板块，在全国设有多条产线与服务中心。',
  competitive_strategy: '公司以智能制造与数字化转型为战略主线，持续推进研发流程标准化与数据治理。',
  project_background: '客户戊于 2025 年 3 月启动研发管理数字化建设，目标是统一管理研发项目与交付流程，替代分散的表格与文档协作方式。',
  business_status: ['跨部门项目进度缺乏统一视图，各团队依赖人工周报汇总，信息滞后且口径不一，管理层难以及时掌握整体进展。', '工单处理状态不透明，客户反复催问处理进度，跨部门流转依赖邮件与口头跟进，缺少可追溯的记录。'],
  demands: ['统一项目与工单管理平台，覆盖研发与售后两条线', '关键节点自动提醒与汇报'],
  solution_sections: [
    { title: '流程调研与分阶段落地', text: '项目组从流程调研切入，先梳理研发与售后协同断点，再分阶段部署项目管理与工单模块，通过双周对齐机制持续校准方案。' },
    { title: '关键节点自动提醒', text: '围绕客户关注的关键交付节点配置自动提醒与汇总汇报，减少人工盯催。' },
  ],
  value_items: ['项目进度汇总从人工周报升级为实时看板', '工单平均响应时间显著缩短'],
  lessons: ['迁移过渡期保留双周人工核对，保障了统计口径的平稳切换。'],
  summary: '通过与 ONES 合作，客户戊完成了研发管理数字化的第一步：统一平台承接项目与工单协同，进度透明可追溯，为后续深度应用奠定了基础。',
  unknowns: ['量化基线数据待客户确认'],
};

function caseMcp(pageId = 'page-c1'): any {
  return { listTools: () => [], call: async () => ({ text: `{"result":"SUCCESS","data":{"pageID":"${pageId}"}}`, isError: false }) } as any;
}

function seedCaseCustomer(db: WorkbenchDatabase): void {
  db.upsertCustomer({ id: 'crm-c1', name: '案例客户一' });
  db.upsertSourceEvent({ customerId: 'crm-c1', sourceSystem: 'ones', sourceType: 'support_ticket',
    externalId: 'case-T-1', displayId: 'T-2001', title: '导出超时', occurredAt: '2026-03-10T03:00:00Z',
    payload: { field005: { name: '已完成', category: 'done' }, field009: '2026-03-10 11:00:00', field010: '2026-03-12 11:00:00' } });
  segment(db, 'crm-c1', 'case-r1:t1', 'case-r1', '启动会', '2026-03-05T05:00:00Z', '客户提出希望统一管理研发项目，并与 OA 系统打通单点登录');
  const recording = db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'raw_transcript',
    externalId: 'case-r1', title: '录音 case-r1', occurredAt: '2026-03-05T05:00:00Z', payload: {} });
  db.activateHemoryFragments(recording.id, 'fp-case-r1', [db.findSourceEvent('hemory', 'ai_topic_segment', 'case-r1:t1')!.id]);
}

test('workbench: case generation runs full-context model job and persists narrative draft', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const prompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    assert.ok(result.jobId, '首次生成必须返回任务');
    assert.equal(result.fingerprint.length, 64);
    await waitForJob(db, result.jobId!);
    // v8 流水线调用序：规划 1 次 + 六章节各 1 次（素材未超预算不触发摘要、覆盖度达标不触发补写）。
    assert.equal(prompts.length, 7, '规划 + 6 章节共 7 次模型调用');
    assert.match(prompts[0], /规划客户成功案例草稿的章节结构/, '首调用必须是规划阶段');
    assert.match(prompts[1], /只写这一个章节/);
    // v7 前序章节注入（v8 沿用；v8.1 起第二波并行，波内两章只见首章锚点——与波次语义一致）：
    // 首章（客户及背景介绍）无锚点块；业务现状/业务诉求都锚定客户及背景介绍章。
    assert.ok(!prompts[1].includes('此前章节已定稿正文'), '首章（客户及背景介绍）不得注入前序章节块');
    const statusPrompt = prompts.find((prompt) => prompt.includes('「业务现状」章节'))!;
    const demandsPrompt = prompts.find((prompt) => prompt.includes('「业务诉求」章节'))!;
    for (const anchored of [statusPrompt, demandsPrompt]) {
      assert.match(anchored, /此前章节已定稿正文/, '第 2 波章节须注入前序章节锚点');
      assert.match(anchored, /【客户及背景介绍】/, '锚点带章节标签');
      assert.ok(anchored.includes(CASE_CONTENT.company_info), '锚点含客户及背景介绍章定稿正文');
      assert.match(anchored, /专有名词、产品模块名、客户称谓必须与前章用词保持一致/);
    }
    // 末章（项目总结，独立波次）锚点含全部前序五章定稿文本。
    const summaryPrompt = prompts.find((prompt) => prompt.includes('「项目总结」章节'))!;
    assert.ok(summaryPrompt.includes(CASE_CONTENT.summary) && summaryPrompt.includes(CASE_CONTENT.company_info)
      && summaryPrompt.includes(CASE_CONTENT.demands[0]) && summaryPrompt.includes(CASE_CONTENT.solution_sections[0].text), '末章锚点含全部前序五章');
    // v8.1 章节瘦身：章节 prompt 不带规划脚手架，规划 prompt 带全量。
    assert.ok(!statusPrompt.includes('"source_catalog"'), '章节 prompt 不注入来源目录');
    assert.ok(prompts[0].includes('"source_catalog"'), '规划 prompt 保留全量目录');
    // v7 信号表兜底召回（v8 沿用）：规划 prompt 须声明信号表只是线索而非全集。
    assert.match(prompts[0], /信号表兜底/, '规划 prompt 含兜底召回规则');
    assert.match(prompts[0], /不受信号表限制/);
    const capturedPrompt = prompts.join('\n');
    const draft = db.listCaseDrafts('crm-c1')[0];
    assert.ok(draft, '案例草稿必须落库');
    assert.equal(draft.title, CASE_CONTENT.title, '标题取规划 title');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.version, 1);
    assert.equal(draft.generator, 'fake/fake-model');
    assert.equal((draft.fields as any).customer_id, 'crm-c1');
    assert.equal((draft.fields as any).customer_name, '案例客户一');
    assert.equal((draft.fields as any).company_info, CASE_CONTENT.company_info);
    assert.deepEqual((draft.fields as any).demands, CASE_CONTENT.demands);
    assert.deepEqual((draft.fields as any).solution_sections, CASE_CONTENT.solution_sections);
    assert.deepEqual((draft.fields as any).lessons, CASE_CONTENT.lessons);
    // v8 派生数据：系统使用情况表只含有值行；unknowns 追加建议补充行。
    const usageRows = (draft.fields as any).system_usage as any[];
    assert.ok(Array.isArray(usageRows) && usageRows.some((row) => row.item === '客户名称' && row.content === '案例客户一'), '系统使用情况表含客户名称行');
    assert.ok((draft.fields as any).unknowns.some((item: string) => item.includes('购买账号数')), '缺失行提示进 unknowns');
    // seedCaseCustomer 有已交付建议工单（2026-03 交付）→ 派生里程碑至少含合作启动与工单首单。
    const milestones = (draft.fields as any).milestones as any[];
    assert.ok(Array.isArray(milestones) && milestones.length >= 2, '派生服务里程碑');
    assert.ok(milestones.some((item) => item.label.includes('合作启动')));
    const expectedClaims = [CASE_CONTENT.company_info, CASE_CONTENT.business_scope, CASE_CONTENT.competitive_strategy, CASE_CONTENT.project_background,
      ...CASE_CONTENT.business_status, ...CASE_CONTENT.demands, ...CASE_CONTENT.solution_sections.map((section: any) => section.text),
      ...CASE_CONTENT.value_items, ...CASE_CONTENT.lessons, CASE_CONTENT.summary];
    assert.equal((draft.fields as any).claim_evidence.length, expectedClaims.length, '每章正文条目对应一条 claim_evidence');
    assert.ok((draft.fields as any).context_snapshot.digest);
    // 组装契约：claim 与正文逐字一致（服务端对位组装，非模型复写）。
    assert.ok((draft.fields as any).claim_evidence.every((claim: any) => expectedClaims.includes(claim.claim)));
    // 素材未超预算：不落 input_summary 降级轨迹。
    assert.equal((draft.fields as any).input_summary, undefined, '预算内不记录降级轨迹');
    // 证据引用含片段（ONES 工单明细已剔除，不再进证据引用）。
    assert.ok(draft.evidenceRefs.length >= 1);
    // v6 全量上下文注入（v8 沿用）：片段转写与客户档案在 prompt 里；ONES 工单明细不得注入。
    assert.match(capturedPrompt, /统一管理研发项目/);
    assert.match(capturedPrompt, /案例客户一/);
    assert.doesNotMatch(capturedPrompt, /导出超时/, 'ONES 工单明细不得注入案例上下文');
    assert.ok(!capturedPrompt.includes('"delivered_records"'), 'delivered_records 注入块已移除');
    // 交付事实仍以聚合统计形态注入（ONES 数据只经 delivery_stats 参与）。
    assert.ok(capturedPrompt.includes('"delivery_stats"'), '上下文须含交付统计聚合');
    // 叙事契约关键规则（规划与章节 prompt 合并断言）。
    assert.match(capturedPrompt, /客户叙事视角/);
    assert.match(capturedPrompt, /禁止流水账/);
    assert.match(capturedPrompt, /不得虚构数字\/引语\/ROI|禁止虚构/);
    assert.match(capturedPrompt, /收进 unknowns/);
    assert.match(capturedPrompt, /六个章节|四章深结构/);
    // v8 客户简介纪律与复盘纪律。
    assert.match(capturedPrompt, /禁止虚构排名/);
    assert.match(capturedPrompt, /不得负面定性客户/);
    // v2 取材契约：痛点/价值优先客户原话信号、方案级举措主线、联网检索纪律。
    assert.match(capturedPrompt, /pain_point_signals/);
    assert.match(capturedPrompt, /value_signals/);
    assert.match(capturedPrompt, /web_context/);
    assert.match(capturedPrompt, /标题命中客户名不能单独成文/);
    assert.match(capturedPrompt, /同名或业务不符/);
    assert.match(capturedPrompt, /以「我们为客户提供了什么方案」为主线/);
    assert.match(capturedPrompt, /不得写成功能点罗列/);
    assert.ok(capturedPrompt.includes('"pain_point_signals":'), '上下文须含痛点信号块');
    assert.ok(capturedPrompt.includes('"value_signals":'), '上下文须含价值信号块');
    assert.ok(!capturedPrompt.includes('"delivered_records":'), '已交付记录明细块已移除（v6）');
    assert.ok(capturedPrompt.includes('本次生成未联网检索'), '未注入检索依赖时明确告知模型无联网信息');
    // 幂等：同指纹再次生成复用最新草稿。
    const again = service.generate('crm-c1');
    assert.equal(again.jobId, null);
    assert.equal(again.reused, true);
    assert.equal(again.draftId, draft.id);
    // force 重新生成：新任务落新草稿（单版本保留：同客户旧行连同旧配图一并删除）。
    const forced = service.generate('crm-c1', true);
    assert.ok(forced.jobId);
    await waitForJob(db, forced.jobId!);
    const drafts = db.listCaseDrafts('crm-c1');
    assert.equal(drafts.length, 1, 'force 生成后同客户仅保留最新一版');
    assert.notEqual(drafts[0].id, draft.id, 'force 生成必须落新行而非原地覆盖');
    assert.equal(db.getCaseDraft(draft.id), undefined, '历史版本行已被删除');
    // 生成版本锁定。
    assert.equal(CASE_GENERATION_VERSION, 'case-v18-incremental-repair');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case detail marks context stale and summarize sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const service = new CaseService(db, caseMcp(), fakeCaseModel(CASE_CONTENT));
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    const detail = service.detail(draft.id)!;
    assert.equal(detail.contextStale, false, '数据未变不提示过期');
    assert.ok(detail.markdown.includes('## 一、客户及背景介绍'));
    assert.ok(detail.contextSummary.some((entry) => entry.system === 'ones'));
    // 数据变化后提示过期（非阻断）。
    db.upsertSourceEvent({ customerId: 'crm-c1', sourceSystem: 'ones', sourceType: 'support_ticket',
      externalId: 'case-T-2', title: '新工单', occurredAt: '2026-04-01T03:00:00Z' });
    const stale = service.detail(draft.id)!;
    assert.equal(stale.contextStale, true, '数据变化必须提示重新生成');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case generation failure marks job failed without draft', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-'));
  const db = new WorkbenchDatabase(dir);
  const previousBaseMs = caseModelRetryDelays.baseMs;
  caseModelRetryDelays.baseMs = 1;
  try {
    seedCaseCustomer(db);
    const failing = {
      llm: { provider: 'fake', model: 'relay' },
      models: { complete: async () => ({ stopReason: 'error', errorMessage: 'Request timed out.', content: [] }) },
    } as any;
    const service = new CaseService(db, caseMcp(), failing);
    const result = service.generate('crm-c1');
    // 指数退避 5s+15s+45s（4 次尝试）：等待窗口放宽到 150 秒。
    for (let i = 0; i < 7500 && db.getDraftJob(result.jobId!)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const job = db.getDraftJob(result.jobId!)!;
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /规划模型调用失败（第 4\/4 次）: Request timed out\./);
    assert.equal(db.listCaseDrafts('crm-c1').length, 0, '失败不落草稿');
    // 失败任务无墓碑指纹：重新 generate 会创建新任务（不因旧任务指纹被幂等短路）——只断言任务创建，
    // 不触发执行（退避中的后台 process 会活过测试关库窗口）。
    const failingDraftsBefore = db.listCaseDrafts('crm-c1').length;
    const jobBefore = db.getDraftJob(result.jobId!)!;
    assert.equal(jobBefore.status, 'failed');
    assert.equal(failingDraftsBefore, 0);
  } finally { caseModelRetryDelays.baseMs = previousBaseMs; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case resume reuses validated stages across restart and rejects source/model drift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-resume-'));
  let db = new WorkbenchDatabase(dir);
  const prompts: string[] = [];
  let failing = true;
  const runtime: any = { llm: { provider: 'fake', model: 'same-model' }, models: { complete: async (_model: unknown, context: any) => {
    const prompt = context.messages[0].content;
    prompts.push(prompt);
    if (failing && prompt.includes('「业务解决方案」章节正文')) return { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] };
    return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }] };
  } } };
  try {
    seedCaseCustomer(db);
    const service = new CaseService(db, caseMcp(), runtime);
    const job = service.generate('crm-c1');
    assert.equal(service.generate('crm-c1', true).jobId, job.jobId, 'repeated clicks share the active customer job');
    await waitForJob(db, job.jobId!, 'failed');
    assert.equal(db.getDraftJob(job.jobId!)!.status, 'failed');
    assert.match(prompts.filter((p) => p.includes('「业务解决方案」章节正文'))[1], /未返回「业务解决方案」小节/);
    assert.equal(db.listCaseCheckpoints(job.jobId!).filter((item) => item.stage.startsWith('chapter:')).length, 3);
    const before = prompts.length;
    db.close();
    db = new WorkbenchDatabase(dir);
    const resumed = new CaseService(db, caseMcp(), runtime);
    assert.equal(resumed.jobDetail(job.jobId!)!.resumable, true, resumed.jobDetail(job.jobId!)!.resumeReason ?? undefined);
    runtime.llm.model = 'changed-model';
    assert.throws(() => resumed.resume(job.jobId!), /模型配置或生成规则已变化/);
    runtime.llm.model = 'same-model';
    failing = false;
    resumed.resume(job.jobId!);
    await waitForJob(db, job.jobId!);
    assert.equal(db.getDraftJob(job.jobId!)!.status, 'succeeded');
    assert.equal(prompts.length - before, 3, 'only solution/value/summary need requests after restart');
    const detail = resumed.jobDetail(job.jobId!)!;
    assert.equal(detail.calls.filter((call) => call.status === 'reused').length, 4, 'plan plus three chapters reused');
    assert.equal(detail.draftId, db.listCaseDrafts('crm-c1')[0].id);
    assert.ok(!JSON.stringify(detail).includes('source_catalog'), 'diagnostics do not expose checkpoint payloads');
    assert.throws(() => resumed.resume(job.jobId!), /已完成/);
    failing = true;
    const next = resumed.generate('crm-c1', true);
    await waitForJob(db, next.jobId!, 'failed');
    db.upsertCustomer({ id: 'crm-c1', name: '更名后的案例客户' });
    assert.throws(() => resumed.resume(next.jobId!), /客户素材已变化/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case source namespaces are restored only for a unique complete ID with valid evidence', async () => {
  const suffix = '0123456789abcdef01234567';
  assert.equal(resolveCaseSourceRef(suffix, new Set([`hemory-${suffix}`])), `hemory-${suffix}`);
  assert.equal(resolveCaseSourceRef(suffix, new Set([`hemory-${suffix}`, `customer:${suffix}`])), suffix, 'ambiguous aliases stay invalid');
  assert.equal(resolveCaseSourceRef(suffix.slice(0, 8), new Set([`hemory-${suffix}`])), suffix.slice(0, 8), 'partial IDs are never guessed');
  for (const invalidExcerpt of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'csm-case-namespace-'));
    const db = new WorkbenchDatabase(dir);
    try {
      seedCaseCustomer(db);
      db.upsertSourceEvent({ id: `hemory-${suffix}`, customerId: 'crm-c1', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
        externalId: 'legacy-source-id', title: '客户希望统一协作', occurredAt: '2026-03-05T05:00:00Z',
        payload: { transcript: '客户希望统一项目协作流程', recordingId: 'legacy-source-id' } });
      let planCalls = 0;
      const runtime: any = { llm: { provider: 'fake', model: 'fixture' }, models: { complete: async (_model: unknown, context: any) => {
        const prompt = context.messages[0].content;
        let value = casePhaseRespond(CASE_CONTENT, prompt);
        if (prompt.includes('规划客户成功案例草稿')) {
          planCalls++;
          const source = casePromptContext(prompt).source_catalog.find((item: any) => item.source_ref === `hemory-${suffix}`);
          value.plan.find((entry: any) => entry.section === 'status').items = [{ idea: '协作问题',
            source_refs: [source.source_ref.replace(/^hemory-/, '')], excerpt: invalidExcerpt ? '找不到的虚构摘录' : source.excerpt }];
        } else if (prompt.includes('「业务现状」章节')) value = { texts: [CASE_CONTENT.business_status[0]] };
        return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(value) }] };
      } } };
      const service = new CaseService(db, caseMcp(), runtime);
      const job = service.generate('crm-c1');
      await waitForJob(db, job.jobId!, invalidExcerpt ? 'failed' : 'succeeded');
      if (invalidExcerpt) assert.equal(db.listCaseDrafts('crm-c1').length, 0, 'ID restoration never bypasses excerpt validation');
      else {
        assert.equal(planCalls, 1, 'a missing namespace does not repeat the full model planning call');
        const claims = db.listCaseDrafts('crm-c1')[0].fields.claim_evidence as any[];
        assert.ok(claims.find((claim) => claim.section === 'status').source_refs[0].startsWith('hemory-'));
      }
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('workbench: enrichment patches retain untouched prose and evidence and reject invalid edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-patch-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const service = new CaseService(db, caseMcp(), fakeCaseModel(CASE_CONTENT));
    const job = service.generate('crm-c1');
    await waitForJob(db, job.jobId!);
    const fields: any = db.listCaseDrafts('crm-c1')[0].fields;
    const options = { requirePublic: true, allowedRefs: new Set<string>(fields.context_snapshot.sources.map((s: any) => s.id)), sources: fields.context_snapshot.sources };
    const first = parseCaseContent(fields, options);
    const proof = first.claim_evidence.find((claim) => claim.section === 'value')!;
    const patch = { changes: [{ field: 'value_items', index: null, text: '新增的有据价值条目', evidence: { source_refs: proof.source_refs, excerpt: proof.excerpt } }] };
    const enriched = mergeCaseEnrichment(first, patch, options);
    assert.deepEqual(enriched.value_items, [...first.value_items, '新增的有据价值条目']);
    assert.equal(enriched.company_info, first.company_info);
    assert.deepEqual(enriched.solution_sections, first.solution_sections);
    for (const claim of first.claim_evidence) assert.deepEqual(enriched.claim_evidence.find((item) => item.section === claim.section && item.claim === claim.claim), claim);
    assert.deepEqual(mergeCaseEnrichment(first, { changes: [] }, options), first);
    assert.throws(() => mergeCaseEnrichment(first, { ...patch, customer_id: 'other' }, options), /只允许 changes/);
    assert.throws(() => mergeCaseEnrichment(first, { changes: [{ ...patch.changes[0], field: 'context_snapshot' }] }, options), /字段不允许/);
    assert.throws(() => mergeCaseEnrichment(first, { changes: [{ ...patch.changes[0], index: 999 }] }, options), /现有条目/);
    assert.throws(() => mergeCaseEnrichment(first, { changes: [{ ...patch.changes[0], text: '' }] }, options), /不允许删除/);
    assert.throws(() => mergeCaseEnrichment(first, { changes: [{ ...patch.changes[0], evidence: { source_refs: ['unknown-source'], excerpt: 'invented' } }] }, options), /未知证据/);
    assert.throws(() => mergeCaseEnrichment(first, { changes: [{ ...patch.changes[0], evidence: { source_refs: proof.source_refs, excerpt: '完全不存在的连续摘录' } }] }, options), /摘录未在引用证据中找到/);
    assert.equal(first.value_items.length, CASE_CONTENT.value_items.length, 'failed or successful patches never mutate the original');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case renderContract v8 four chapters, ordered numbering, legacy fallback and warnings', () => {
  // v8 契约草稿：四章深结构标题 + 子节层级 + 表格 + 里程碑 + 条目阿拉伯编号；内部键不渲染。
  const draft = { id: 'd1', customerId: 'crm-x', version: 1, status: 'draft' as const, title: '案例标题',
    fields: { customer_id: 'crm-x', ...CASE_CONTENT,
      system_usage: [{ item: '客户名称', content: '案例客户一' }, { item: '购买版本', content: '私有部署' }],
      milestones: [{ date: '2026-03', label: '合作启动（据最早服务记录）' }] },
    evidenceRefs: ['evt-1'], createdAt: '', updatedAt: '' };
  const markdown = renderCaseMarkdown(draft as any);
  assert.match(markdown, /# 案例标题/);
  assert.match(markdown, /## 一、客户及背景介绍/);
  assert.match(markdown, /### （一）客户简介/);
  assert.match(markdown, /#### 公司信息/);
  assert.match(markdown, /### （二）项目背景/);
  assert.match(markdown, /### （三）系统使用情况/);
  assert.match(markdown, /\| 项目 \| 内容 \|/);
  assert.match(markdown, /\| 客户名称 \| 案例客户一 \|/);
  assert.match(markdown, /## 二、场景及解决方案/);
  assert.match(markdown, /### （一）业务现状/);
  assert.match(markdown, /### （二）业务诉求/);
  assert.match(markdown, /### （三）业务解决方案/);
  assert.match(markdown, /#### 1、流程调研与分阶段落地/);
  assert.match(markdown, /## 三、方案价值概述/);
  assert.match(markdown, /### 服务里程碑/);
  assert.match(markdown, /- 2026-03 合作启动/);
  assert.match(markdown, /### 价值成效/);
  assert.match(markdown, /### 经验复盘与沉淀/);
  assert.match(markdown, /## 四、项目总结/);
  assert.match(markdown, /^1\. 统一项目与工单管理平台/m);
  assert.doesNotMatch(markdown, /^- 统一/m);
  assert.ok(!markdown.includes('evidence_map'), '内部键不得渲染');
  assert.ok(!markdown.includes('量化基线'), 'unknowns 不得渲染');
  assert.ok(!markdown.includes('evt-1'), '证据引用不得渲染');
  // 可选小节缺省：business_scope/competitive_strategy/lessons 为空时小节整节省略。
  const slim = renderCaseMarkdown({ ...draft, fields: { ...draft.fields, business_scope: '', competitive_strategy: '', lessons: [] } } as any);
  assert.ok(!slim.includes('#### 核心业务范围'), '空小节不渲染标题');
  assert.ok(!slim.includes('### 经验复盘与沉淀'), '空复盘整节约略');
  assert.ok(slim.includes('#### 公司信息'));
  // 存量旧稿（v7 五段）兼容：旧键 pain_points/results 回退映射并按五段渲染。
  const legacy = { ...draft, fields: { customer_id: 'crm-x', customer_name: '旧客户', background: '旧背景',
    pain_points: ['旧痛点'], solution: '旧方案', results: [{ metric: '上线时间', value: '2026-03' }] } };
  const legacyTexts = caseSectionTexts(legacy.fields);
  assert.deepEqual(legacyTexts.challenges, ['旧痛点']);
  assert.deepEqual(legacyTexts.value, ['上线时间: 2026-03']);
  const legacyMarkdown = renderCaseMarkdown(legacy as any);
  assert.match(legacyMarkdown, /## 一、客户背景/);
  assert.match(legacyMarkdown, /## 五、价值与成效/);
  assert.match(legacyMarkdown, /旧痛点/);
  assert.match(legacyMarkdown, /上线时间: 2026-03/);
  // 空章节不再注入内部占位词；质量审查负责提示 CSM。
  const empty = renderCaseMarkdown({ ...draft, fields: { ...CASE_CONTENT, company_info: '', summary: '' } } as any);
  assert.doesNotMatch(empty, /待补充/);
  // 内部信息残留告警（v8）：干净内容不告警，残留命中。
  assert.deepEqual(caseContentWarnings(draft as any), []);
  const dirty = { ...draft, fields: { ...draft.fields, value_items: ['工时 12 小时已节省', '客户不满情绪缓解'] } };
  const warnings = caseContentWarnings(dirty as any);
  assert.ok(warnings.some((warning) => /内部工时统计/.test(warning)), '必须检出工时统计残留');
  assert.ok(warnings.some((warning) => /客户情绪内部记录/.test(warning)), '必须检出客户情绪记录残留');
  // parseCaseContent 校验（requirePublic）：缺 company_info/summary 报错，数组与内部键容错缺省。
  assert.throws(() => parseCaseContent({ project_background: 'x', summary: 's' }, { requirePublic: true }), /公司信息/);
  assert.throws(() => parseCaseContent({ company_info: 'x' }, { requirePublic: true }), /项目总结/);
  const minimal = parseCaseContent({ company_info: 'c', project_background: 'b', business_status: ['s'], demands: ['d'], solution_sections: [{ title: 't', text: 'x' }], value_items: ['v'], summary: 'm' });
  assert.deepEqual([minimal.business_scope, minimal.competitive_strategy, minimal.lessons], ['', '', []]);
  assert.equal(minimal.evidence_map, undefined);
  assert.deepEqual(minimal.claim_evidence, []);
  // 章节契约锁定（v8 六章）。
  assert.deepEqual(CASE_SECTIONS.map((section) => section.key), ['intro', 'status', 'demands', 'solution', 'value', 'summary']);
});

test('workbench: case v8 derived system_usage and milestones plus docx export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-v8-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const service = new CaseService(db, caseMcp(), fakeCaseModel(CASE_CONTENT));
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    // docx 导出：zip 结构合法，含标题/表格行/章标题；SVG 配图无（本例无 figures），正文完整。
    const exported = await service.exportDocx(draft.id)!;
    assert.ok(exported, '导出必须成功');
    assert.ok(exported.filename.endsWith('.docx'));
    assert.ok(exported.buffer.length > 4000, 'docx 非空');
    const Zip = (await import('jszip')).default;
    const zip = await Zip.loadAsync(exported.buffer);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    assert.ok(documentXml.includes(CASE_CONTENT.title), 'docx 含标题');
    assert.ok(documentXml.includes('一、客户及背景介绍'), 'docx 含章标题');
    assert.ok(documentXml.includes('系统使用情况'), 'docx 含系统使用情况表');
    assert.ok(!/<w:script/.test(documentXml), 'docx 无脚本');
    // 不存在的草稿导出返回 undefined。
    assert.equal(await service.exportDocx('nonexistent'), undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case v5 pipeline degrades input budget and summarizes before failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-degrade-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-deg', name: '降级客户' });
    // v6 素材超预算：ONES 明细已剔除，超限主体改为 800 个长转写片段
    // （片段目录行 + communications 转写均摊预算 + 信号扫描共同撑爆 INPUT_BUDGET_TOKENS）。
    for (let i = 1; i <= 800; i++) {
      segment(db, 'crm-deg', `deg:t${i}`, `deg-r${Math.ceil(i / 20)}`, `长话题 ${i}`, '2026-03-05T05:00:00Z',
        `客户反复提到跨部门进度不透明依赖人工汇总。`.repeat(60));
    }
    const prompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-deg');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-deg')[0];
    assert.ok(draft, '降级/摘要后仍须产出草稿');
    const inputSummary = (draft.fields as any).input_summary;
    assert.ok(inputSummary, '超预算必须记录 input_summary 轨迹');
    assert.ok(Array.isArray(inputSummary.trials) && inputSummary.trials.length >= 2, '轨迹须含完整注入与降级/摘要尝试');
    assert.equal(inputSummary.trials[0].action, '完整注入');
    assert.ok(inputSummary.trials[0].tokens > 96_000, '首次估算须确实超预算');
    const contextPrompt = prompts.find((p) => p.includes('规划客户成功案例草稿的章节结构'))!;
    const context = JSON.parse(contextPrompt.slice(contextPrompt.indexOf('上下文：') + '上下文：'.length));
    if (context.input_summary) {
      // 摘要兜底路径：prompt 是摘要形态（input_summary + 收缩目录）。
      assert.ok(context.input_summary.length > 0, '摘要文本非空');
      assert.ok(context.source_catalog.length > 0, '原文目录保留供摘录校验');
      assert.equal(inputSummary.summarized, true);
    } else {
      // 降级路径：素材注入规模收缩（communications ≤150 片段、转写预算 24000）。
      assert.ok(context.communications?.length != null && context.communications.length <= 150, `降级后片段收缩（实际 ${context.communications?.length}）`);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case fingerprint is deterministic per customer-eventset', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-c2', name: '案例客户二' });
  const a = segment(db, 'crm-c2', 'c2:t1', 'c2-r1', '话题', '2026-03-25T05:00:00Z', '内容');
  const b = segment(db, 'crm-c2', 'c2:t2', 'c2-r1', '话题二', '2026-03-26T05:00:00Z', '内容二');
  const same = db.getSourceEvent(a.id)!;
  assert.equal(caseFingerprint('crm-c2', [a], []), caseFingerprint('crm-c2', [same], []));
  assert.notEqual(caseFingerprint('crm-c2', [a], []), caseFingerprint('crm-c2', [a, b], []));
  assert.notEqual(caseFingerprint('crm-c2', [a], []), caseFingerprint('crm-c3', [a], []));
  // timeline 与片段去重后合并。
  assert.equal(caseFingerprint('crm-c2', [a, a], [a]), caseFingerprint('crm-c2', [a], []));
}));

test('workbench: case jobs are isolated from heretry and weekly jobs by kind', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-c3', name: '案例客户三' });
  const heretryJob = db.createDraftJob('crm-c3', 'fp-h-c3', ['evt-1']);
  const caseJob = db.createDraftJob('crm-c3', 'fp-c3', ['evt-2'], 'case_report');
  assert.equal(caseJob.kind, 'case_report');
  assert.ok(db.listPendingDraftJobs().every((job) => job.kind === 'hemory'), 'hemory resume 不得认领案例任务');
  assert.ok(db.listPendingDraftJobs('case_report').every((job) => job.kind === 'case_report'));
  assert.ok(!db.listPendingDraftJobs('case_report').some((job) => job.id === heretryJob.id));
  assert.ok(!db.listPendingDraftJobs().some((job) => job.id === caseJob.id));
}));

test('workbench: case publish hash gate works with narrative markdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const service = new CaseService(db, caseMcp('page-pub-1'), fakeCaseModel(CASE_CONTENT));
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    const preview = service.publishPreview(draft.id, 'parent-1');
    assert.equal(preview.tool, 'mcp__ones__create_page');
    assert.match(preview.args.content as string, /## 一、客户及背景介绍/);
    // 篡改版本后旧批准哈希失效。
    await assert.rejects(() => service.publish(draft.id, draft.version + 1, 'parent-1', preview.approvalHash), /版本或批准内容已变化/);
    // 新增其他客户后，正文命中跨客户名称警告；即使正文和版本不变，旧预览也必须失效。
    db.upsertCustomer({ id: 'crm-other-warning', name: '项目管理' });
    await assert.rejects(() => service.publish(draft.id, draft.version, 'parent-1', preview.approvalHash), /版本或批准内容已变化/);
    const refreshed = service.publishPreview(draft.id, 'parent-1');
    assert.ok(refreshed.warnings.some((warning) => /其他客户名称/.test(warning)));
    const published = await service.publish(draft.id, draft.version, 'parent-1', refreshed.approvalHash);
    assert.equal(published.status, 'published');
    assert.equal(published.publishedPageId, 'page-pub-1');
    // 已发布不可再发布。
    assert.throws(() => service.publishPreview(draft.id, 'parent-1'), /不可发布/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 案例 v2：痛点/价值信号提取 + 联网检索 + 交付记录注入 ──

/** 片段带结构化 evidence 数组（生产切片 v3.2 形态），转写文本即 evidence[].text。 */
function segmentWithEvidence(db: WorkbenchDatabase, customerId: string, externalId: string, recordingId: string, title: string, occurredAt: string, lines: string[]) {
  return db.upsertSourceEvent({ customerId, sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId,
    title, occurredAt, attributionStatus: 'confirmed',
    payload: { recordingId, speakers: ['CSM', '客户'], transcript: lines.map((line, index) => `${index === 0 ? '客户' : 'CSM'}: ${line}`).join('\n'),
      evidence: lines.map((text, index) => ({ spokenAt: occurredAt, speaker: index === 0 ? '客户' : 'CSM', text })) } });
}

test('workbench: caseSpeakerRole classifies anonymous speaker tracks as customer side', () => {
  // 转写系统的匿名分轨（speaker_N）与「我/我们」视角：会议是 CSM 与客户的沟通，
  // 非 CSM 说话人默认客户侧——否则真实会议（华大九天 speaker_2 占多数）客户声音章节全部无法引用。
  assert.equal(caseSpeakerRole('speaker_2', '赵荣泽'), 'customer');
  assert.equal(caseSpeakerRole('speaker_10'), 'customer');
  assert.equal(caseSpeakerRole('我'), 'customer');
  assert.equal(caseSpeakerRole('我们'), 'customer');
  assert.equal(caseSpeakerRole('赵荣泽', '赵荣泽'), 'csm');
  assert.equal(caseSpeakerRole('CSM'), 'csm');
  assert.equal(caseSpeakerRole('客户'), 'customer');
  assert.equal(caseSpeakerRole('客户代表'), 'customer');
  assert.equal(caseSpeakerRole('ONES 实施团队'), 'csm');
  assert.equal(caseSpeakerRole('张三', '赵荣泽'), 'unknown', '未知名真名保持 unknown 待甄别');
  assert.equal(caseSpeakerRole(''), 'unknown');
});

test('workbench: caseFragmentSignals extracts pain/value themes from full fragment text', () => {
  // 前缀填充 300+ 字符把痛点句顶到片段中后部：验证信号扫描的是全文而非 prompt 注入的头部截断。
  const filler = '项目周会上各方对齐了本季度目标与节奏，'.repeat(20);
  const painLine = '我们现在系统和系统之间没打通，数据孤岛很严重，还在通过表格人工管理，协作效率不高';
  const valueLine = '这套需求池用起来挺好的，效率提升了不少，进度也透明多了';
  const noiseLine = '下周三下午三点例会照常进行';
  const fragment = {
    id: 'frag-sig-1', customerId: 'crm-x', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'sig:t1',
    title: '痛点与反馈', occurredAt: '2026-05-12T05:00:00Z', syncedAt: '2026-05-12T06:00:00Z', payloadHash: 'h1',
    attributionStatus: 'confirmed' as const, confidence: 1,
    payload: { recordingId: 'sig-r1', speakers: ['CSM'], transcript: [filler, painLine, noiseLine, valueLine].join('\n'),
      evidence: [filler, painLine, noiseLine, valueLine].map((text, index) => ({ spokenAt: '2026-05-12T05:00:00Z', speaker: index === 2 ? 'CSM' : '客户', text })) },
  } as any;
  const signals = caseFragmentSignals([fragment]);
  // 痛点句命中多主题时取第一个命中主题；信号摘录含原话关键内容。
  assert.equal(signals.painPoints.length, 1, '一条痛点句只记一条信号（首个命中主题）');
  assert.equal(signals.painPoints[0].theme, '系统未打通/数据孤岛');
  assert.ok(signals.painPoints[0].excerpt.includes('没打通'));
  assert.equal(signals.painPoints[0].date, '2026-05-12');
  assert.equal(signals.painPoints[0].fragment_id, 'frag-sig-1');
  assert.equal(signals.values.length, 1, '正面反馈句记一条价值信号');
  assert.equal(signals.values[0].theme, '效率提升');
  assert.ok(signals.values[0].excerpt.includes('挺好'));
  // 无关句不入信号。
  assert.ok(!JSON.stringify(signals).includes('例会'));
  // 转写回退路径（无 evidence 数组）同样可提取：逐行剥离说话人前缀。
  const transcriptOnly = { ...fragment, id: 'frag-sig-2', payload: { recordingId: 'sig-r1', transcript: `客户: 信息不透明，看不到整体进度\nCSM: 我们来梳理一下` } } as any;
  const fallback = caseFragmentSignals([transcriptOnly]);
  assert.equal(fallback.painPoints.length, 1);
  assert.equal(fallback.painPoints[0].theme, '信息不透明');
  // 空片段集返回空信号。
  assert.deepEqual(caseFragmentSignals([]), { painPoints: [], requirements: [], solutions: [], values: [], review: [] });
});

test('workbench: case generation injects web search context and persists audit snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-web-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-web-1', name: '案例客户甲', shortName: '客户甲' });
    db.upsertSourceEvent({ customerId: 'crm-web-1', sourceSystem: 'ones', sourceType: 'suggestion_feedback',
      externalId: 'web-S-1', displayId: 'S-100', title: '需求池功能已完成交付', occurredAt: '2026-03-01T03:00:00Z',
      payload: { field005: { name: '已完成', category: 'done' } } });
    const queries: string[] = [];
    const fetcher: HttpPost = async (url, headers, body) => {
      void url; void headers;
      queries.push(String(body.query));
      return JSON.stringify({ results: [
        { title: '案例客户甲信息化制度建设招标公告', url: 'https://bid.example.com/1', published_date: '2026-01-15', content: '案例客户甲就研发项目管理平台建设公开招标' },
        { title: '某无关公司中标公告', url: 'https://bid.example.com/2', published_date: '2026-02-01', content: 'Another company procurement' },
      ] });
    };
    const prompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime, {
      getApiKey: () => 'tvly-test', getMaxResults: () => 5, getKeylessEnabled: () => true, fetcher,
    });
    const result = service.generate('crm-web-1');
    await waitForJob(db, result.jobId!);
    // 5 个角度各检索一次，查询 = 客户名（简称优先）+ 角度词。
    assert.equal(queries.length, CASE_WEB_ANGLES.length);
    for (const angle of CASE_WEB_ANGLES) assert.ok(queries.includes(`客户甲 ${angle.query}`));
    const capturedPrompt = prompts.join('\n');
    // mentionsCustomer 预过滤：无关公司结果不进上下文。
    assert.ok(capturedPrompt.includes('信息化制度建设招标公告'));
    assert.ok(!capturedPrompt.includes('Another company'));
    assert.ok(capturedPrompt.includes('"web_context"'), '上下文须含 web_context 块');
    // v6：ONES 建议明细不注入，交付事实只经聚合统计参与。
    assert.ok(!capturedPrompt.includes('"delivered_records"'), 'delivered_records 注入块已移除');
    assert.ok(!capturedPrompt.includes('需求池功能已完成交付'), 'ONES 建议明细不得注入');
    assert.ok(capturedPrompt.includes('"delivery_stats"'), '交付统计聚合仍注入');
    // 检索审计快照随草稿落库。
    const draft = db.listCaseDrafts('crm-web-1')[0];
    const webSearch = (draft.fields as any).web_search;
    assert.equal(webSearch.searched, CASE_WEB_ANGLES.length);
    assert.equal(webSearch.results.length, 1, '同一 URL 跨角度只保留一条');
    assert.ok(webSearch.results.every((item: any) => item.title.includes('案例客户甲')));
    assert.equal(webSearch.errors.length, 0);
    // detail 的 contextSummary 含 web 检索行。
    const detail = service.detail(draft.id)!;
    assert.ok(detail.contextSummary.some((entry) => entry.system === 'web' && entry.count === 1));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case web search failure is isolated and never blocks generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-werr-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    let searchCalls = 0;
    // 首角度抛错、其余角度正常返回：单角度失败只记 error，不阻断。
    const fetcher: HttpPost = async (url, headers, body) => {
      void url; void headers;
      const query = String(body.query);
      searchCalls += 1;
      if (query.includes('项目管理')) throw new Error('HTTP 429: rate limit');
      return JSON.stringify({ results: [
        { title: '案例客户一需求管理实践报道', url: 'https://news.example.com/1', published_date: '2026-02-01', content: '案例客户一引入需求管理平台' },
      ] });
    };
    const service = new CaseService(db, caseMcp(), fakeCaseModel(CASE_CONTENT), {
      getApiKey: () => 'tvly-test', getMaxResults: () => 5, getKeylessEnabled: () => true, fetcher,
    });
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    assert.ok(draft, '检索部分失败仍须产出草稿');
    const webSearch = (draft.fields as any).web_search;
    assert.equal(searchCalls, CASE_WEB_ANGLES.length, '失败后继续检索其余角度');
    assert.equal(webSearch.searched, CASE_WEB_ANGLES.length - 1, 'searched 只计成功角度');
    assert.equal(webSearch.errors.length, 1);
    assert.match(webSearch.errors[0], /项目管理: HTTP 429/);
    assert.equal(webSearch.results.length, 1, '其余角度相同 URL 去重保留一条');
    // 检索全挂也不阻断：恒抛错的 fetcher 下任务仍成功。
    const dir2 = mkdtempSync(join(tmpdir(), 'csm-case-werr2-'));
    const db2 = new WorkbenchDatabase(dir2);
    try {
      seedCaseCustomer(db2);
      const failingFetcher: HttpPost = async () => { throw new Error('connection refused'); };
      const service2 = new CaseService(db2, caseMcp(), fakeCaseModel(CASE_CONTENT), {
        getApiKey: () => 'tvly-test', getMaxResults: () => 5, getKeylessEnabled: () => true, fetcher: failingFetcher,
      });
      const result2 = service2.generate('crm-c1');
      await waitForJob(db2, result2.jobId!);
      const draft2 = db2.listCaseDrafts('crm-c1')[0];
      assert.ok(draft2, '检索全失败不阻断生成');
      const webSearch2 = (draft2.fields as any).web_search;
      assert.equal(webSearch2.searched, 0);
      assert.equal(webSearch2.errors.length, CASE_WEB_ANGLES.length);
      assert.equal(webSearch2.results.length, 0);
    } finally { db2.close(); rmSync(dir2, { recursive: true, force: true }); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: delivered_records only includes delivered ones records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-deliv-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-deliv', name: '交付客户' });
    db.upsertSourceEvent({ customerId: 'crm-deliv', sourceSystem: 'ones', sourceType: 'suggestion_feedback',
      externalId: 'deliv-S-1', displayId: 'S-200', title: '需求池模块上线', occurredAt: '2026-03-02T03:00:00Z', payload: { field005: { name: '已完成', category: 'done' } } });
    db.upsertSourceEvent({ customerId: 'crm-deliv', sourceSystem: 'ones', sourceType: 'support_ticket',
      externalId: 'deliv-T-1', displayId: 'T-300', title: '统计报表报错', occurredAt: '2026-03-03T03:00:00Z', payload: { field005: { name: '进行中', category: 'in_progress' } } });
    db.upsertSourceEvent({ customerId: 'crm-deliv', sourceSystem: 'crm', sourceType: 'crm_followup',
      externalId: 'deliv-F-1', title: '完成季度回访', occurredAt: '2026-03-04T03:00:00Z', payload: { active_record_content: '完成季度回访并记录' } });
    let capturedPrompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        capturedPrompts.push(prompt);
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-deliv');
    await waitForJob(db, result.jobId!);
    const capturedPrompt = capturedPrompts.join('\n');
    // v8.1：注入断言解析规划 prompt（章节 prompt 为瘦身形态，无 records/信号表）。
    const planPrompt = capturedPrompts.find((prompt) => prompt.includes('规划客户成功案例草稿的章节结构'))!;
    const context = JSON.parse(planPrompt.slice(planPrompt.indexOf('上下文：') + '上下文：'.length));
    const chapterPrompt = capturedPrompts.find((prompt) => prompt.includes('「业务现状」章节'))!;
    // v6：ONES 记录明细不注入——工单/建议标题不进 prompt，records 只剩 CRM 侧非跟进记录（此处为空）。
    assert.ok(!capturedPrompt.includes('需求池模块上线'), 'ONES 建议明细不得注入');
    assert.ok(!capturedPrompt.includes('统计报表报错'), 'ONES 工单明细不得注入');
    assert.ok(!('delivered_records' in context), 'delivered_records 注入块已移除');
    assert.deepEqual(context.records, [], 'ONES 剔除后 records 只剩 CRM 非跟进记录（此处为空）');
    // 交付事实仍以聚合统计参与：建议共 1 项已完成。
    assert.ok(capturedPrompt.includes('建议与反馈共 1 项，已完成 1 项'), 'delivery_stats 聚合须含 ONES 交付事实');
    assert.ok(context.delivery_stats?.source_ref === 'stats:delivery', 'stats 证据条目保留可引用');
    // CRM 跟进仍作为案例素材注入（规划与章节瘦身形态都保留写作素材块）。
    assert.ok(capturedPrompt.includes('完成季度回访'), 'CRM 跟进仍注入');
    assert.ok(chapterPrompt.includes('完成季度回访'), '章节瘦身形态保留 CRM 跟进素材');
    // 上下文键齐备（v6 口径，规划全量）；章节瘦身形态剥规划脚手架但保留 delivery_stats/communications。
    for (const key of ['pain_point_signals', 'value_signals', 'web_context', 'delivery_stats']) assert.ok(key in context);
    assert.ok(!chapterPrompt.includes('"source_catalog"'), '章节 prompt 不注入来源目录');
    assert.ok(!chapterPrompt.includes('"allowed_source_refs"'), '章节 prompt 不注入规划用 ref 清单');
    assert.ok(chapterPrompt.includes('"communications"'), '章节 prompt 保留转写素材');
    assert.ok(chapterPrompt.includes('"delivery_stats"'), '章节 prompt 保留交付统计');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case signal routing requires customer speaker and respects time/modal conflicts', () => {
  const fragment = {
    id: 'route-1', customerId: 'crm-route', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'route-1',
    title: '案例路由', occurredAt: '2026-08-01T00:00:00Z', syncedAt: '2026-08-01T01:00:00Z', payloadHash: 'route-hash',
    attributionStatus: 'confirmed' as const, payload: { evidence: [
      { speaker: '客户', text: '我们希望 9 月上线，并且需要完成权限集成和验收。' },
      { speaker: '客户', text: '目前模块尚未上线，项目进度依赖人工表格汇总。' },
      { speaker: '客户', text: '项目组已完成上线和权限配置。' },
      { speaker: '客户', text: '目前团队已经全面使用，项目进度更透明。' },
      { speaker: '客户', text: '希望后续全面使用并覆盖所有团队。' },
      { speaker: '客户', text: '过去依赖人工表格的问题已经解决。' },
      { speaker: 'CSM', text: '我认为效率提升了很多。' },
    ] },
  } as any;
  const signals = caseFragmentSignals([fragment]);
  assert.ok(signals.requirements.some((item) => item.excerpt.includes('希望 9 月上线') && item.timeScope === 'future'));
  assert.ok(signals.painPoints.some((item) => item.excerpt.includes('人工表格')));
  assert.ok(!signals.solutions.some((item) => item.excerpt.includes('尚未上线')));
  assert.ok(signals.solutions.some((item) => item.excerpt.includes('已完成上线') && item.timeScope === 'completed'));
  assert.ok(signals.values.some((item) => item.excerpt.includes('全面使用') && item.speakerRole === 'customer'));
  assert.ok(!signals.values.some((item) => item.excerpt.includes('希望后续全面使用')));
  assert.ok(!signals.painPoints.some((item) => item.excerpt.includes('已经解决')));
  assert.ok(!signals.values.some((item) => item.excerpt.includes('我认为')));
  assert.ok(signals.review.some((item) => item.excerpt.includes('我认为') && item.speakerRole === 'csm'));
});

test('workbench: case pain and value keyword coverage includes scattered duplicate governance and reduction', () => {
  const fragment = (id: string, text: string) => ({ id, customerId: 'crm-route', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: id,
    title: id, occurredAt: `2026-08-0${id.slice(-1)}T00:00:00Z`, syncedAt: '2026-08-10T00:00:00Z', payloadHash: id,
    attributionStatus: 'confirmed', payload: { evidence: [{ speaker: '客户', text }] } }) as any;
  const signals = caseFragmentSignals([
    fragment('route-1', '需求和文档分散在多个系统。'),
    fragment('route-2', '同一数据需要重复录入和多头维护。'),
    fragment('route-4', '目前缺少统一规范，也无法追溯。'),
    fragment('route-3', '系统已经上线，统计周期缩短了 2 天，重复工作量也明显减少。'),
  ]);
  assert.ok(signals.painPoints.some((item) => item.theme === '信息或工具分散'));
  assert.ok(signals.painPoints.some((item) => item.theme === '重复工作'));
  assert.ok(signals.painPoints.some((item) => item.theme === '重复工作' && item.timeScope === 'current'));
  assert.ok(signals.painPoints.some((item) => item.theme === '缺少规范或追溯'));
  assert.ok(signals.values.some((item) => item.theme === '周期或成本改善'));
});

test('workbench: customer outcome evidence ignores CSM and unknown speakers', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-speaker', name: '说话人客户', csmName: '小王' });
  const event = db.upsertSourceEvent({ customerId: 'crm-speaker', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'speaker-1',
    title: '效果回访', occurredAt: '2026-08-01T00:00:00Z', attributionStatus: 'confirmed', payload: { evidence: [
      { speaker: '小王', text: '我认为效率提升明显。' },
      { speaker: '发言人2', text: '系统很好用。' },
      { speaker: '客户', text: '平台让进度透明多了，我们认可这个效果。' },
    ] } });
  const sync = new PortfolioSyncService(db, {} as never, async () => ({ events: [], proposedCount: 0, includedCount: 0 }));
  sync.processHemoryEvidence(event);
  const outcomes = db.listEvidence('crm-speaker').filter((item) => item.kind === 'outcome');
  assert.equal(outcomes.length, 1);
  assert.match(outcomes[0].detail, /客户|平台让进度透明/);
  assert.doesNotMatch(outcomes[0].detail, /我认为|系统很好用/);
}));

test('workbench: delivered classification rejects negated and future status text', () => {
  assert.equal(isDeliveredOnesEvent({ sourceType: 'support_ticket', title: '功能未完成', payload: { field005: { name: '进行中', category: 'in_progress' } } }), false);
  assert.equal(isDeliveredOnesEvent({ sourceType: 'suggestion_feedback', title: '模块尚未上线', payload: { field005: { name: '待处理', category: 'to_do' } } }), false);
  assert.equal(isDeliveredOnesEvent({ sourceType: 'support_ticket', title: '任意标题', payload: { field005: { name: '已完成', category: 'done' } } }), true);
  assert.equal(isDeliveredOnesEvent({ sourceType: 'support_ticket', title: '计划上线', payload: { field005: '进行中' } }), false);
  assert.equal(isDeliveredOnesEvent({ sourceType: 'support_ticket', title: '修复完成', payload: { field005: '已完成' } }), true);
  assert.equal(isDeliveredOnesEvent({ sourceType: 'support_ticket', title: '旧数据', payload: { field005: '已交付' } }), true);
});

test('workbench: case fingerprint covers customer profile and evidence changes', () => withDb((db) => {
  const customer = db.upsertCustomer({ id: 'crm-fp', name: '指纹客户', industry: '制造' });
  const event = db.upsertSourceEvent({ customerId: customer.id, sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 'fp-1',
    title: '工单', occurredAt: '2026-08-01T00:00:00Z', payload: { field005: { category: 'done' } } });
  const evidence = { id: 'ev-1', customerId: customer.id, kind: 'outcome', label: '效果', detail: '进度透明', occurredAt: '2026-08-02T00:00:00Z', confidence: 0.8, sourceSystem: 'hemory' };
  const base = caseFingerprint(customer, [event], [], [evidence]);
  assert.notEqual(base, caseFingerprint({ ...customer, industry: '汽车' }, [event], [], [evidence]));
  assert.notEqual(base, caseFingerprint(customer, [event], [], [{ ...evidence, detail: '流程透明' }]));
  const risk = { level: 'medium', coverage: 0.8, dimensions: {}, unknowns: [], ruleVersion: 'v1' } as any;
  const opportunity = { id: 'opp-1', customerId: customer.id, title: '扩展', detail: '知识管理', confidence: 0.7, status: 'hypothesis', evidenceRefs: [] } as any;
  assert.notEqual(base, caseFingerprint(customer, [event], [], [evidence], risk, []));
  assert.notEqual(base, caseFingerprint(customer, [event], [], [evidence], null, [opportunity]));
}));

test('workbench: case web search rejects title-only results, deduplicates URL and grades official domains', async () => {
  const customer = { id: 'crm-web', name: '公开客户', shortName: '公开客户', source: {
    website: 'https://official.example.com', attachment: 'https://example.com/files/a.pdf',
  } } as any;
  const fetcher: HttpPost = async () => JSON.stringify({ results: [
    { title: '公开客户招标公告', url: 'https://example.com/a?utm_source=x', published_date: '2026-01-01', content: '' },
    { title: '公开客户项目公告', url: 'https://example.com/unrelated', published_date: '2026-01-01', content: '这是一段与目标企业没有关系的普通摘要。' },
    { title: '公开客户项目公告', url: 'https://example.com/a', published_date: '2026-01-01', content: '公开客户正在建设研发项目管理平台并开展公开采购。' },
    { title: '公开客户官网新闻', url: 'https://official.example.com/news/1', published_date: '2026-01-02', content: '公开客户官网发布研发管理平台建设进展。' },
  ] });
  const result = await searchCaseWebContext(customer, { getApiKey: () => 'x', getMaxResults: () => 5, getKeylessEnabled: () => false, fetcher });
  assert.equal(result.results.length, 2);
  assert.match(result.results[0].snippet, /研发项目管理平台/);
  assert.equal(result.results[0].url, 'https://example.com/a');
  assert.equal(result.results[0].sourceTier, 'media');
  assert.equal(result.results[1].sourceTier, 'customer_official');
});

test('workbench: case delivery stats compute delivered facts from confirmed events', () => {
  const customer = { id: 'crm-st', name: '统计客户' } as any;
  const event = (id: string, sourceType: string, at: string, payload: Record<string, unknown> = {}): any => ({
    id, sourceSystem: 'ones', sourceType, externalId: id, displayId: '', title: `记录${id}`, occurredAt: at, syncedAt: at,
    attributionStatus: 'confirmed', payload, payloadHash: id,
  });
  const timeline = [
    event('e1', 'support_ticket', '2026-01-01T00:00:00Z', { field005: { name: '已完成', category: 'done' }, field009: '2026-01-01 10:00:00', field010: '2026-01-03 10:00:00' }),
    event('e2', 'support_ticket', '2026-02-01T00:00:00Z', { field005: { name: '已完成', category: 'done' }, field009: '2026-02-01 10:00:00', field010: '2026-02-01 16:00:00' }),
    event('e3', 'support_ticket', '2026-03-01T00:00:00Z', { field005: { name: '处理中', category: 'in_progress' } }),
    event('e4', 'suggestion_feedback', '2026-02-10T00:00:00Z', { field005: { name: '已完成', category: 'done' } }),
    event('e5', 'suggestion_feedback', '2026-02-15T00:00:00Z', { field005: { name: '待处理', category: 'to_do' } }),
    event('e6', 'private_cloud_instance', '2026-02-20T00:00:00Z', { field005: { name: '运行中', category: 'in_progress' } }),
    event('e7', 'customer_manhour', '2026-02-25T00:00:00Z', { field019: 25000000 }),
  ];
  const stats = caseDeliveryStats({ customer, timeline, hemory: [] });
  assert.equal(stats.firstConfirmedAt, '2026-01-01');
  assert.ok(stats.months != null && stats.months >= 6, '合作月数按最早事件推算');
  const tickets = stats.categories.find((category) => category.source_type === 'support_ticket')!;
  assert.equal(tickets.total, 3);
  assert.equal(tickets.done, 2);
  const suggestions = stats.categories.find((category) => category.source_type === 'suggestion_feedback')!;
  assert.equal(suggestions.total, 2);
  assert.equal(suggestions.done, 1);
  assert.equal(stats.privateCloudInstances, 1);
  // 解决时效：2 天（e1）与 0.25 天（e2）→ 偶数样本取下中位（0.3 天）、最快 0.3（一位小数舍入）。
  assert.equal(stats.ticketResolutionDays!.median, 0.3);
  assert.equal(stats.ticketResolutionDays!.min, 0.3);
  assert.equal(stats.registeredHours, 250);
  // 无 ONES 数据的客户：分类全零、时效 null，不产生 stats 事实文本。
  const empty = caseDeliveryStats({ customer, timeline: [], hemory: [] });
  assert.equal(empty.firstConfirmedAt, null);
  assert.equal(empty.ticketResolutionDays, null);
});

test('workbench: case generation injects delivery stats as citable source and coverage field persists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-stats-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const prompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    // 档案摘录是自然语言句（真实验收教训：JSON.stringify 的键值串模型无法逐字抄写，背景主张稳定校验失败）。
    const profileSource = (draft.fields as any).context_snapshot.sources.find((item: any) => String(item.id).startsWith('customer:'));
    assert.ok(profileSource, '档案来源必须进快照');
    assert.doesNotMatch(profileSource.excerpt, /^\{/, '档案摘录不得是 JSON 串');
    assert.match(profileSource.excerpt, /客户名称：/);
    const capturedPrompt = prompts.join('\n');
    // stats 证据条目进入来源目录且 prompt 说明其引用规则。
    assert.ok(capturedPrompt.includes('"delivery_stats"'), '上下文须含交付统计块');
    assert.ok(capturedPrompt.includes('stats:delivery'), 'prompt 须说明 stats 引用 source_ref');
    assert.match(capturedPrompt, /只可作事实陈述/);
    assert.match(capturedPrompt, /不得自行计算百分比/);
    assert.ok((draft.fields as any).context_snapshot.sources.some((item: any) => item.id === 'stats:delivery'), 'stats 条目固化进快照');
    // coverage 内部字段持久化（样本小不触发补写：enriched=false）；v6 无 delivered 池。
    const coverage = (draft.fields as any).coverage;
    assert.ok(coverage, 'coverage 必须落库');
    assert.equal(coverage.enriched, false);
    assert.equal(coverage.delivered, undefined, 'v6 覆盖度不再含交付记录池');
  // 篇幅契约进入 prompt（v8 口径：项目背景 200~500 字、方案小节 250~600 字、诉求条目 60~180 字）。
  assert.match(capturedPrompt, /200~500 字/);
  assert.match(capturedPrompt, /250~600 字/);
  assert.match(capturedPrompt, /60~180 字/);
  assert.match(capturedPrompt, /篇幅契约是质量要求而非硬性字符数/);
    // 摘录抄写规则（防「摘录未在引用证据中找到」复发）。
    assert.match(capturedPrompt, /连续逐字截取/);
    // ONES 明细剔除后，快照来源不含工单条目。
    assert.ok(!(draft.fields as any).context_snapshot.sources.some((item: any) => item.source_system === 'ones'), 'ONES 工单不进快照来源');
    // detail 的 contextSummary 含 stats 行。
    const detail = service.detail(draft.id)!;
    assert.ok(detail.contextSummary.some((entry) => entry.system === 'stats'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case coverage thresholds gate enrichment and uncovered materials feed the second pass', async () => {
  // 覆盖度阈值（v6：只有价值信号池）——value 信号 >4 且引用 <1/4 才补写。
  const cited = (values: number) => ({
    valueSignals: { total: values, cited: 0 },
    painSignals: { total: 0, cited: 0 }, authoritativeWeb: { total: 0, cited: 0 }, fallbackCited: 0,
  });
  assert.equal(coverageNeedsEnrichment({ ...cited(0), valueSignals: { total: 5, cited: 0 } }), true, '价值信号 5 条零引用须触发');
  assert.equal(coverageNeedsEnrichment({ ...cited(0), valueSignals: { total: 5, cited: 2 } }), false, '价值信号引用 2/5 不触发');
  assert.equal(coverageNeedsEnrichment({ ...cited(0), valueSignals: { total: 4, cited: 0 } }), false, '价值信号 4 条（≤阈值下限）不触发');
  assert.equal(coverageNeedsEnrichment(cited(0)), false, '无素材不触发');
  const summary = coverageSummary({ ...cited(5), painSignals: { total: 3, cited: 1 } });
  assert.match(summary, /价值信号 0\/5/);
  assert.match(summary, /痛点信号 1\/3/);
  assert.ok(!summary.includes('交付记录'), 'v6 覆盖率文案不含交付记录');

  // 端到端：多数客户正面反馈未被引用 → 自动追加第二遍模型调用，第二稿须引用更多素材才被采纳。
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-cov-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-cov', name: '覆盖客户' });
    // 6 个含客户说话人正面反馈的片段（valueSignals>4）；假模型第一稿只引用首个片段 → 引用 1/6 <1/4 触发补写。
    for (let i = 1; i <= 6; i++) {
      db.upsertSourceEvent({ customerId: 'crm-cov', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: `cov:t${i}`,
        title: `正面反馈话题 ${i}`, occurredAt: '2026-03-05T05:00:00Z', attributionStatus: 'confirmed',
        payload: { recordingId: `cov-r${i}`, speakers: ['客户'], evidence: [
          { speaker: '客户', text: `客户说这套系统挺好用的，效率提升明显，流程顺畅多了（第${i}次反馈）` }] } });
    }
    let calls = 0;
    const prompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        calls += 1;
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        // 补写阶段产出引用更多证据的第二稿（value_items 增条目，claim_evidence 引用随之增加）。
        const enrichedContent = { ...CASE_CONTENT, value_items: [...CASE_CONTENT.value_items, '客户反馈系统好用且效率显著提升'] };
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(calls >= 8 ? enrichedContent : CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-cov');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-cov')[0];
    assert.ok(draft, '触发补写的生成仍须产出草稿');
    assert.equal(calls, 8, '规划+6 章节后覆盖不足须追加一次补写调用');
    const enrichPrompt = prompts.find((prompt) => prompt.includes('未引用素材清单'))!;
    assert.match(enrichPrompt, /未引用素材清单/, '补写 prompt 须含未引用素材清单');
    assert.match(enrichPrompt, /正面反馈话题/, '补写 prompt 须列出未引用的客户正面反馈');
    const coverage = (draft.fields as any).coverage;
    assert.equal(coverage.enriched, true, 'coverage.enriched 须记录补写发生');
    assert.ok((draft.fields as any).value_items.includes('客户反馈系统好用且效率显著提升'), '采纳第二稿正文');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: failed enrichment keeps first draft and job still succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-covfail-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-cf', name: '补写失败客户' });
    for (let i = 1; i <= 6; i++) {
      db.upsertSourceEvent({ customerId: 'crm-cf', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: `cf:t${i}`,
        title: `补写失败反馈话题 ${i}`, occurredAt: '2026-03-05T05:00:00Z', attributionStatus: 'confirmed',
        payload: { recordingId: `cf-r${i}`, speakers: ['客户'], evidence: [
          { speaker: '客户', text: `客户说这套系统挺好用的，效率提升明显（第${i}次反馈）` }] } });
    }
    let calls = 0;
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        calls += 1;
        // 第 8 次调用起（规划+6 章节后）模拟补写模型连续失败：任务仍须成功并保留第一稿。
        if (calls >= 8) return { stopReason: 'error', errorMessage: 'relay down', content: [] };
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, input.messages[0].content)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-cf');
    // 补写自身重试含 5s 退避：等待窗口放宽到 30 秒。
    for (let i = 0; i < 6000 && db.getDraftJob(result.jobId!)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const job = db.getDraftJob(result.jobId!)!;
    assert.equal(job.status, 'succeeded', '补写失败不判任务失败');
    const draft = db.listCaseDrafts('crm-cf')[0];
    assert.ok(draft, '补写失败仍保留第一稿');
    assert.equal((draft.fields as any).coverage.enriched, false);
    assert.equal((draft.fields as any).company_info, CASE_CONTENT.company_info, '保留第一稿正文');
    assert.equal(calls, 9, '补写尝试 2 次（第 8 次失败后退避、第 9 次仍失败即止）');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case coverage counts fallback cited fragments outside keyword signal sets', () => {
  const fragment = (id: string, text: string) => ({ id, customerId: 'crm-fb', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: id,
    title: id, occurredAt: '2026-08-01T00:00:00Z', syncedAt: '2026-08-10T00:00:00Z', payloadHash: id,
    attributionStatus: 'confirmed', payload: { evidence: [{ speaker: '客户', text }] } }) as any;
  // fb-signal 命中价值关键词；fb-quiet 是行业化表述（兜底召回场景）——正文引用了它。
  const input = { customer: { csmName: '小王' }, hemory: [fragment('fb-signal', '客户说系统很好用，效率提升明显。'),
    fragment('fb-quiet', '客户说现在线上线下一套账，不用再靠人盯了。')], webContext: null } as any;
  const coverage = caseCoverage({ claim_evidence: [
    { source_refs: ['fb-signal'] }, { source_refs: ['fb-quiet'] }, { source_refs: ['customer:crm-fb'] },
  ] }, input);
  assert.ok(coverage.valueSignals.total >= 1, '关键词信号进入分母');
  assert.equal(coverage.valueSignals.cited, 1);
  // 兜底计数：被引用、不在价值/痛点信号集内的片段 = fb-quiet（customer 档案引用不计入）。
  assert.equal(coverage.fallbackCited, 1, '信号表外被引用片段计入 fallbackCited');
  // 触发逻辑与兜底无关：fallbackCited 不改变补写判定（只统计、不进分母）。
  assert.equal(coverageNeedsEnrichment(coverage), false);
  assert.match(coverageSummary({ ...coverage, fallbackCited: 2 }), /兜底引用片段 2/);
  assert.ok(!coverageSummary({ ...coverage, fallbackCited: 0 }).includes('兜底引用'), '零兜底不显示该段文案');
});

/** 干净可放行的示例 SVG（含节点框/文本/连线/kebab-case 属性）。 */
const CLEAN_CASE_FIGURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 480">'
  + '<rect x="20" y="20" width="160" height="48" rx="8" fill="#eef3fb" stroke="#3a6ea5" stroke-width="2"/>'
  + '<text x="100" y="48" font-size="14" text-anchor="middle" fill="#1c2b3a">需求提出</text>'
  + '<path d="M180 44 H 240" stroke="#3a6ea5" stroke-width="2" marker-end="url(#arrow)"/></svg>';

test('workbench: sanitizeCaseSvg rejects unsafe structures and strips non-allowlisted attributes', () => {
  // 干净 SVG 原样放行（kebab-case 绘制属性不被误剥）。
  assert.equal(sanitizeCaseSvg(CLEAN_CASE_FIGURE_SVG), CLEAN_CASE_FIGURE_SVG);
  // 非白名单属性剥离：on* 事件、style、href/xlink:href、data-* 移除，白名单属性保留。
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)" style="fill:red">'
    + '<rect x="0" y="0" width="4" height="4" fill="#fff" href="https://evil.example/x" xlink:href="https://evil.example/y" data-track="1"/>'
    + '<text x="1" y="2" font-size="12">节点</text></svg>';
  const cleaned = sanitizeCaseSvg(dirty)!;
  assert.ok(cleaned, '含危险属性的 SVG 剥离后仍可放行');
  assert.ok(!/onload|style=|href|data-track/.test(cleaned), 'on*/style/href/data-* 全部剥离');
  assert.match(cleaned, /font-size="12"/);
  assert.match(cleaned, /<rect [^>]*fill="#fff"/);
  // 危险结构整图拒绝：script / foreignObject / DOCTYPE / 实体 / 非 svg 根 / 缺 viewBox / 超尺寸 / 白名单外标签。
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>'), null);
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><foreignObject><body>x</body></foreignObject></svg>'), null);
  assert.equal(sanitizeCaseSvg('<!DOCTYPE svg><svg viewBox="0 0 10 10"><rect width="1" height="1"/></svg>'), null);
  assert.equal(sanitizeCaseSvg('<!ENTITY x "y"><svg viewBox="0 0 10 10"></svg>'), null);
  assert.equal(sanitizeCaseSvg('<div><svg viewBox="0 0 10 10"></svg></div>'), null, '非 svg 根拒绝');
  assert.equal(sanitizeCaseSvg('<svg><rect width="1" height="1"/></svg>'), null, '缺 viewBox 拒绝');
  assert.equal(sanitizeCaseSvg(`<svg viewBox="0 0 10 10">${'x'.repeat(65_600)}</svg>`), null, '超尺寸拒绝');
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><image href="https://evil.example/x.png" x="0" y="0" width="4" height="4"/></svg>'), null, 'image 标签不在白名单');
  // 图内文本禁区词：明文与实体编码（&#72;emory → Hemory）都拒绝。
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2">来自 Hemory 的记录</text></svg>'), null);
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2">来自 &#72;emory 的记录</text></svg>'), null, '实体编码不得绕过禁区词');
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2">合同金额 100 万</text></svg>'), null, '金额禁区词拒绝');
  // 叠字防御（真实验收教训：<text> 内裸换行多行文字栅格化后叠在同一基线不可读）。
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2">系统直接提报\n原始需求</text></svg>'), null, 'text 内裸换行拒绝');
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2"><tspan x="1">第一行</tspan><tspan x="1">第二行</tspan></text></svg>'), null, '第二个起 tspan 缺 dy/y 拒绝');
  assert.equal(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2">裸文字<tspan x="1" dy="18">第二行</tspan></text></svg>'), null, '裸文字与带 x/y 定位 tspan 混用拒绝（同位叠加）');
  // v10.2：裸前缀 + 无 x/y 定位的 tspan = 合法行内接排（带状板分组头「模块名·副题」常见写法），放行。
  assert.ok(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2">ONES Project·<tspan font-weight="bold">工作项管理</tspan></text></svg>'), '行内接排 tspan（无定位）放行');
  assert.ok(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2"><tspan x="1">第一行</tspan><tspan x="1" dy="18">第二行</tspan></text></svg>'), '规范 tspan 拆行放行');
  // dy 属性必须在消毒后存活（真实验收教训：dy 被当未知属性剥离 → 落库 SVG 多行叠在同一基线）。
  assert.match(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2"><tspan x="1">第一行</tspan><tspan x="1" dy="18">第二行</tspan></text></svg>')!, /dy="18"/, 'dy 不得被属性白名单剥离');
  assert.ok(sanitizeCaseSvg('<svg viewBox="0 0 10 10"><text x="1" y="2">单行文字</text></svg>'), '单行 text 放行');
});

test('workbench: legacy figure shell adds stable titles, padding, and blue palette', () => {
  const source = CLEAN_CASE_FIGURE_SVG.replace('#eef3fb', '#FCE9E7').replace('#3a6ea5', '#F0605C');
  const sanitized = sanitizeCaseSvg(source);
  assert.ok(sanitized, '源 SVG 先通过消毒');
  const current = styleCaseFigureSvg({ kind: 'flow_current', svg: sanitized!, caption: '现状流程' });
  assert.ok(current, '现状流程外壳生成');
  assert.match(current!, /viewBox="0 0 848 560"/, '按源 viewBox 比例扩展画布');
  assert.match(current!, /现状流程/);
  assert.match(current!, new RegExp(`fill="${CASE_FIGURE_SHELL_PALETTE.panel}"`), '统一区域底色');
  assert.match(current!, new RegExp(`fill="${CASE_FIGURE_SHELL_PALETTE.primary}"`), '统一主蓝');
  assert.ok(current!.includes('需求提出'), '保留原节点文字');
  assert.ok(current!.includes('#FCE9E7') === false && current!.includes('#F0605C') === false, '常见高饱和色已安全重着色');
  assert.equal(styleCaseFigureSvg({ kind: 'flow_current', svg: sanitized!, caption: '现状流程' }), current, '同输入输出稳定');
  for (const kind of ['flow_target', 'milestone'] as const) {
    const styled = styleCaseFigureSvg({ kind, svg: sanitized!, caption: kind });
    assert.ok(styled && styled.includes(kind === 'flow_target' ? '目标流程' : '服务里程碑'));
  }
  assert.equal(styleCaseFigureSvg({ kind: 'flow_current', svg: '<svg viewBox="0 0 5001 1"></svg>', caption: 'x' }), null, '异常尺寸 viewBox 被拒绝');
});

// ── 业务解决方案图 1（capability_map）v12：内容蓝图 + 服务端确定性渲染 ──

test('workbench: model figure edges sink below shapes with halo (v17)', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'
    + '<rect x="0" y="0" width="400" height="300" fill="#ffffff"/>'
    + '<text x="100" y="60" font-size="14" text-anchor="middle" fill="#1c2b3a">流程说明</text>'
    + '<rect x="60" y="120" width="80" height="30" fill="#ffffff" stroke="#3a6ea5" stroke-width="2"/>'
    + '<line x1="140" y1="135" x2="260" y2="135" stroke="#3a6ea5" stroke-width="2" marker-end="url(#a)"/>'
    + '<rect x="260" y="120" width="80" height="30" fill="#ffffff" stroke="#3a6ea5" stroke-width="2"/>'
    + '<text x="300" y="140" font-size="14" text-anchor="middle">归档节点</text>'
    + '</svg>';
  const relayered = relayerFigureEdges(source);
  const inner = relayered.slice(relayered.indexOf('>') + 1, relayered.lastIndexOf('</svg>'));
  // 连线（含 halo）沉底：背景之后先是 halo+线，文字与节点矩形都在其后绘制（节点盖线、文字不被压）。
  const haloAt = inner.indexOf('stroke-linecap="round"');
  const edgeAt = inner.indexOf('marker-end');
  const firstText = inner.indexOf('<text');
  const firstNode = inner.indexOf('<rect x="60"');
  assert.ok(haloAt > -1 && edgeAt > -1 && haloAt < edgeAt, 'halo 垫在连线正下方');
  assert.ok(edgeAt < firstNode && edgeAt < firstText, '连线先于节点/文字绘制');
  assert.match(relayered, new RegExp(`stroke="${CASE_FIGURE_SHELL_PALETTE.panel}"`), 'halo 使用面板底色');
  assert.match(relayered, /stroke-width="8"/, 'halo 在原线宽 2 上加宽 6');
  assert.ok(!/stroke-linecap="round"[^>]*marker-end/.test(relayered), 'halo 剥离箭头');
  assert.ok(/\bfill="none"[^>]*stroke-linecap="round"|stroke-linecap="round"[^>]*\bfill="none"|fill="none"[^>]*stroke="#F3F8FE"/.test(relayered) || relayered.includes('fill="none"'), 'halo 透明填充');
  for (const label of ['流程说明', '归档节点', '<rect x="60"', '<rect x="260"']) assert.ok(relayered.includes(label), `内容守恒：${label}`);
  // 无边元素时原样返回（不过度重排）；无背景块但有边时仍安全沉底（外壳面板先于内容绘制）。
  const noEdge = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="#ffffff"/><text x="5" y="5">x</text></svg>';
  assert.equal(relayerFigureEdges(noEdge), noEdge, '无边时原样返回');
  const noBackground = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect x="60" y="120" width="80" height="30" fill="#ffffff" stroke="#3a6ea5" stroke-width="2"/><line x1="140" y1="135" x2="260" y2="135" stroke="#3a6ea5" stroke-width="2"/></svg>';
  const noBackgroundOut = relayerFigureEdges(noBackground);
  assert.ok(noBackgroundOut.indexOf('stroke-linecap="round"') < noBackgroundOut.indexOf('<rect x="60"'), '无背景块时 halo+连线仍先于节点绘制');
  assert.ok(sanitizeCaseSvg(relayered), '重排产物仍过消毒');
});

test('workbench: figure edge-text overlap detector feeds retry feedback (v17)', () => {
  // 开放空间连线穿过文字 → 检出（反馈重试）；文字整体落在实底节点内 → 由节点遮挡，不算压字。
  const overlapping = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'
    + '<rect x="0" y="0" width="400" height="300" fill="#ffffff"/>'
    + '<text x="180" y="140" font-size="14" text-anchor="middle" fill="#000">提交审批</text>'
    + '<line x1="40" y1="140" x2="360" y2="140" stroke="#333333" stroke-width="2"/>'
    + '</svg>';
  const hits = findFigureEdgeTextOverlaps(overlapping);
  assert.equal(hits.length, 1, '开放空间连线压字被检出');
  assert.match(hits[0]!, /提交审批/);
  const insideNode = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'
    + '<rect x="0" y="0" width="400" height="300" fill="#ffffff"/>'
    + '<rect x="150" y="110" width="90" height="40" fill="#ffffff" stroke="#333333"/>'
    + '<text x="195" y="135" font-size="14" text-anchor="middle" fill="#000">提交审批</text>'
    + '<line x1="40" y1="130" x2="360" y2="130" stroke="#333333" stroke-width="2"/>'
    + '</svg>';
  assert.equal(findFigureEdgeTextOverlaps(insideNode).length, 0, '节点内文字由节点遮挡，不算压字');
  assert.equal(findFigureEdgeTextOverlaps('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').length, 0, '无文字/无连线安全返回');
});

const CAPABILITY_BLUEPRINT: CapabilityMapBlueprint = {
  topBand: { kind: 'goals', items: ['降低协作成本', '提升交付质量', '加快产品上市'] },
  stages: [
    { label: '需求收集', module: 'ONES Project', capabilities: ['外链表单提报', '自定义必填项', '需求统一入池', '提报记录留痕'] },
    { label: '登记准入审批', module: '流程自动化', capabilities: ['状态发起审批', '登记准入流转', '部门领导背书', '负责人留痕'] },
    { label: '分析拆分关联', module: '需求管理', capabilities: ['拆分敏稳态需求', '双向关联原始需求', '列表快速跳转', '数据权限隔离'] },
    { label: '纳入年度计划', module: '项目管理', capabilities: ['立项审批通过', '纳入年度计划', '标记纳入年份', '进度趋势分析'] },
    { label: '单点登录同步', module: 'ONES Account', capabilities: ['OAuth2 单点认证', '内网账号直登', '组织通讯录同步', '离职账号停用'] },
    { label: '测试验收', module: 'ONES TestCase', capabilities: ['用例覆盖需求', '缺陷闭环回归', '验收报告留痕'] },
  ],
  platformCapabilities: [
    { title: '权限管理', detail: '五级权限·角色模板' },
    { title: '流程自定义', detail: '工作流与状态流转' },
    { title: '字段自定义', detail: '自定义字段与表单' },
    { title: '流程自动化', detail: '事件触发流转通知' },
  ],
  integrations: ['OA', '统一认证平台', '信宝 APP', '自研业务系统'],
};

const CAPABILITY_BLUEPRINT_RESPONSE = { caption: '映射：需求场景对应产品能力', blueprint: CAPABILITY_BLUEPRINT };

const capabilityBlueprintOf = (value: unknown): CapabilityMapBlueprint => {
  const parsed = parseCapabilityMapBlueprint(value);
  assert.ok('blueprint' in parsed, `blueprint 应合法（实际错误：${'error' in parsed ? parsed.error : '无'}）`);
  return (parsed as { blueprint: CapabilityMapBlueprint }).blueprint;
};

const capabilityErrorOf = (value: unknown): string => {
  const parsed = parseCapabilityMapBlueprint(value);
  assert.ok('error' in parsed, `blueprint 应判非法（实际通过：${JSON.stringify(value).slice(0, 100)}）`);
  return (parsed as { error: string }).error;
};

test('workbench: parseCapabilityMapBlueprint validates and normalizes v17 content contract', () => {
  const parsed = capabilityBlueprintOf({
    ...CAPABILITY_BLUEPRINT,
    stages: CAPABILITY_BLUEPRINT.stages.map((stage, index) => index === 0
      ? { ...stage, label: ' 需求收集 ', capabilities: ['外链表单提报', '外链表单提报', '自定义必填项'] }
      : stage),
  });
  assert.equal(parsed.stages[0].label, '需求收集', '阶段名压空白');
  assert.deepEqual(parsed.stages[0].capabilities, ['外链表单提报', '自定义必填项'], '阶段能力去重');
  // v17：平台支撑/系统集成/组织保障不再由模型提供——解析产物只含场景矩阵（+可选 topBand）。
  assert.ok(!('platformCapabilities' in parsed) && !('integrations' in parsed) && !('assurance' in parsed), '服务端固定分区不出现在模型契约');
  assert.match(capabilityErrorOf({ ...CAPABILITY_BLUEPRINT, stages: CAPABILITY_BLUEPRINT.stages.slice(0, 4) }), /6~8/, '阶段不足（恒 6~8）');
  assert.match(capabilityErrorOf({ ...CAPABILITY_BLUEPRINT, stages: CAPABILITY_BLUEPRINT.stages.map((stage, index) => index === 0 ? { ...stage, label: '一'.repeat(11) } : stage) }), /超过 10 字宽/, '阶段名超宽');
  assert.match(capabilityErrorOf({ ...CAPABILITY_BLUEPRINT, stages: CAPABILITY_BLUEPRINT.stages.map((stage, index) => index === 0 ? { ...stage, capabilities: ['只有一项'] } : stage) }), /至少 2 项/, '能力不足');
  assert.match(capabilityErrorOf({ ...CAPABILITY_BLUEPRINT, topBand: { kind: 'other', items: ['目标一', '目标二'] } }), /goals 或 core_scenarios/, '顶部类型非法');
  const guarded = parseCapabilityMapBlueprint({ ...CAPABILITY_BLUEPRINT, stages: CAPABILITY_BLUEPRINT.stages.map((stage, index) => index === 0 ? { ...stage, module: 'CRM 同步' } : stage) }, { textGuard: caseInternalEvidenceLabel });
  assert.ok('error' in guarded && /内部信息/.test(guarded.error), '内部信息禁区命中');
});

test('workbench: renderCapabilityMapSvg creates deterministic adaptive blueprint', () => {
  const svg = renderCapabilityMapSvg(CAPABILITY_BLUEPRINT)!;
  assert.match(svg, /viewBox="0 0 1440 720"/, '固定 2:1 画布');
  assert.ok(svg.includes('id="cap-top"') && svg.includes('id="cap-main"') && svg.includes('id="cap-platform"')
    && svg.includes('id="cap-integrations"'), '四个分区均出现（v17 无组织保障侧栏）');
  assert.ok(!svg.includes('组织保障'), '组织保障分区已移除');
  assert.ok(svg.includes('平台支撑') && svg.includes('系统集成'), '平台支撑/系统集成底带存在');
  assert.ok(svg.includes(`fill="${CAPABILITY_MAP_PALETTE.primary}"`) && svg.includes(`fill="${CAPABILITY_MAP_PALETTE.module}"`)
    && svg.includes(`fill="${CAPABILITY_MAP_PALETTE.panel}"`), '固定蓝图主题色');
  assert.equal((svg.match(/marker-end="url\(#cap-arrow\)"/g) ?? []).length, CAPABILITY_BLUEPRINT.stages.length - 1, '箭头只连接相邻阶段标题');
  assert.equal((svg.match(/id="cap-stage-/g) ?? []).length, CAPABILITY_BLUEPRINT.stages.length, '阶段列数与蓝图一致');
  for (const match of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    const [x, y, w, h] = match.slice(1).map(Number);
    assert.ok(x >= 0 && y >= 0 && x + w <= 1440.6 && y + h <= 720.6, `矩形越界：${[x, y, w, h].join(',')}`);
  }
  assert.ok(sanitizeCaseSvg(svg), '服务端模板产物通过 SVG 消毒');
  assert.equal(renderCapabilityMapSvg(CAPABILITY_BLUEPRINT), svg, '同输入输出稳定');

  // 阶段恒 6~8：少于 6 列直接拒绝渲染（用户拍板：不画空槽、必须写满）。
  assert.equal(renderCapabilityMapSvg({ stages: CAPABILITY_BLUEPRINT.stages.slice(0, 5).map((stage) => ({ ...stage, capabilities: stage.capabilities.slice(0, 2) })) }), null, '5 阶段拒绝');
  const sparse = renderCapabilityMapSvg({ stages: CAPABILITY_BLUEPRINT.stages.map((stage) => ({ ...stage, capabilities: stage.capabilities.slice(0, 2) })) })!;
  assert.ok(!sparse.includes('id="cap-top"') && !sparse.includes('id="cap-platform"') && !sparse.includes('id="cap-integrations"'), '未注入的底带省略');
  assert.ok(sanitizeCaseSvg(sparse), '纯六阶段矩阵图合法');
  const dense = renderCapabilityMapSvg({ ...CAPABILITY_BLUEPRINT, topBand: { kind: 'core_scenarios', items: ['场景一', '场景二', '场景三', '场景四', '场景五', '场景六'] }, stages: [
    ...CAPABILITY_BLUEPRINT.stages,
    { label: '运营持续改进', module: 'ONES Performance', capabilities: ['交付效能分析', '质量趋势分析', '过程效能分析', '仪表盘展示', '多项目对比', '持续优化复盘'] },
  ] })!;
  assert.ok(dense && sanitizeCaseSvg(dense), '七阶段六能力密集图可渲染');
});

test('workbench: value map blueprint enforces 3~5 paired items and deterministic three-zone render', () => {
  const item = (index: number) => ({ title: `信息割裂${index}`, detail: `现状问题说明${index}，需要集中治理` });
  const value = (index: number) => ({ title: `效率提升${index}`, detail: `已确认改善结果${index}，便于持续跟踪` });
  const blueprint: ValueMapBlueprint = { painPoints: [1, 2, 3, 4].map(item), values: [1, 2, 3, 4].map(value) };
  const parsed = parseValueMapBlueprint(blueprint);
  assert.ok('blueprint' in parsed, '四条痛点/价值通过校验');
  const svg = renderValueMapSvg((parsed as { blueprint: ValueMapBlueprint }).blueprint)!;
  // v17：画布高度动态（以中间嵌入的解决方案架构图为锚），不再固定 720。
  const dims = svg.match(/viewBox="0 0 1440 (\d+)"/)!;
  const canvasH = Number(dims[1]);
  assert.ok(canvasH >= 460 && canvasH < 720, `动态画布高（${canvasH}）：以架构图为锚、消除上下留白`);
  assert.ok(svg.includes('痛点及挑战') && svg.includes('id="value-map-solution-content"'), '三分区标题与方案槽位存在');
  const columnHeights = [...svg.matchAll(/x="(24|340|1116)" y="32" width="(300|760)" height="(\d+)"/g)].map((m) => Number(m[3]));
  assert.equal(columnHeights.length, 3, '三列齐全');
  assert.ok(new Set(columnHeights).size === 1 && columnHeights[0] === canvasH - 32 - 24, `三列同高且与画布联动（${columnHeights.join(',')}）`);
  // 行对齐映射：第 i 行痛点卡与第 i 行价值卡 y/height 完全一致（水平对位）。
  const painCards = [...svg.matchAll(/<rect x="40" y="([\d.]+)" width="268" height="([\d.]+)" rx="8"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const valueCards = [...svg.matchAll(/<rect x="1132" y="([\d.]+)" width="268" height="([\d.]+)" rx="7" fill="#FFFFFF"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(painCards.length, 4, '四张痛点卡');
  for (let index = 0; index < 4; index += 1) {
    assert.equal(painCards[index][0], valueCards[index][0], `第 ${index + 1} 行痛点/价值卡 y 对齐`);
    assert.equal(painCards[index][1], valueCards[index][1], `第 ${index + 1} 行痛点/价值卡行高一致`);
  }
  // 列表整列垂直居中：富余空间上下均分（顶部 36 为标题牌设计区、底部 28 为设计留白，容差 1px）。
  const extraTop = painCards[0][0] - 32 - 36;
  const extraBottom = 32 + columnHeights[0] - 28 - (painCards[3][0] + painCards[3][1]);
  assert.ok(Math.abs(extraTop - extraBottom) <= 1, `富余空间上下均分（上 ${extraTop} vs 下 ${extraBottom}）`);
  assert.equal((svg.match(/信息割裂[1-4]/g) ?? []).length, 4);
  assert.equal((svg.match(/效率提升[1-4]/g) ?? []).length, 4);
  assert.equal(renderValueMapSvg(blueprint), svg, '同输入输出稳定');
  assert.ok(sanitizeCaseSvg(svg), '确定性模板产物可消毒');
  assert.match((parseValueMapBlueprint({ ...blueprint, painPoints: [1, 2].map(item) }) as { error: string }).error, /3~5/);
  assert.match((parseValueMapBlueprint({ ...blueprint, values: [1, 2, 3].map(value) }) as { error: string }).error, /数量必须相等/);
  // v17 措辞词库：痛点标题必含负向词、价值标题必含正向词（命中即反馈重试）。
  const plainPain = { ...blueprint, painPoints: [1, 2, 3, 4].map((index) => ({ title: `现状描述${index}`, detail: `说明${index}` })) };
  assert.match((parseValueMapBlueprint(plainPain) as { error: string }).error, /负向措辞/, '痛点标题缺负向词拒绝');
  const plainValue = { ...blueprint, values: [1, 2, 3, 4].map((index) => ({ title: `结果描述${index}`, detail: `说明${index}` })) };
  assert.match((parseValueMapBlueprint(plainValue) as { error: string }).error, /正向措辞/, '价值标题缺正向词拒绝');
  const five = { painPoints: [1, 2, 3, 4, 5].map(item), values: [1, 2, 3, 4, 5].map(value) };
  const fiveSvg = renderValueMapSvg(five)!;
  assert.ok(fiveSvg, '五条密集图可渲染');
  assert.ok(Number(fiveSvg.match(/viewBox="0 0 1440 (\d+)"/)![1]) > canvasH, '五条列表更高时画布随之长高');
  // 行首标点防御：断行点落在全角标点前时，标点吸附上一行行尾，不落在行首。
  const punct = { painPoints: [1, 2, 3].map((i) => ({ title: `信息割裂${i}`, detail: `${'一'.repeat(17)}，后续说明${i}` })), values: [1, 2, 3].map((i) => ({ title: `效率提升${i}`, detail: `${'二'.repeat(17)}，对应改善${i}` })) };
  const punctSvg = renderValueMapSvg((parseValueMapBlueprint(punct) as { blueprint: ValueMapBlueprint }).blueprint)!;
  for (const line of [...punctSvg.matchAll(/<tspan x="[\d.]+" dy="18">([^<]*)<\/tspan>/g)].map((m) => m[1])) {
    assert.ok(!/^[，。；、！？：）」』]/.test(line), `换行行首不得出现标点：${line}`);
  }
});

// ── 架构图（architecture）v11：内容契约解析 + 服务端确定性模板渲染 ──

/** 图 A 真实内容（回归夹具）：OA 系统 3 模块 ↔ ONES 4 模块、3 条流。 */
const ARCH_GRAPH_OA: ArchitectureGraph = {
  systems: [{ id: 'oa', name: 'OA 系统', modules: ['单点认证', '通讯录用户目录', '需求收集入口'] }],
  hubModules: ['用户与组织架构', '流程自动化', '需求管理', '权限管理'],
  flows: [
    { from: 'oa', to: 'ones', label: '认证信息回传', steps: [{ text: '统一认证登录，认证信息回传建立账号映射', fields: ['账号ID'] }] },
    { from: 'oa', to: 'ones', label: '同步用户部门', steps: [{ text: '全量同步用户与部门到组织架构', fields: ['用户ID', '部门ID'] }] },
    { from: 'oa', to: 'ones', label: '提交需求', steps: [{ text: 'H5 链接直达需求收集入口提交需求' }] },
  ],
};

const archGraphOf = (value: unknown): ArchitectureGraph => {
  const parsed = parseArchitectureGraph(value);
  assert.ok('graph' in parsed, `graph 应合法（实际错误：${'error' in parsed ? parsed.error : '无'}）`);
  return (parsed as { graph: ArchitectureGraph }).graph;
};

const archErrorOf = (value: unknown): string => {
  const parsed = parseArchitectureGraph(value);
  assert.ok('error' in parsed, `graph 应判非法（实际通过了：${JSON.stringify(value).slice(0, 120)}）`);
  return (parsed as { error: string }).error;
};

test('workbench: parseArchitectureGraph validates content contract (v11)', () => {
  // 规整：id 归一小写、文本压空白、重复模块静默去重。
  const graph = archGraphOf({
    systems: [{ id: ' OA ', name: 'OA 系统', modules: ['单点认证', '单点认证', '通讯录用户目录', '需求收集入口'] }],
    hubModules: ['用户与组织架构', '流程自动化', '需求管理', '权限管理'],
    flows: [{ from: 'OA', to: 'ones', label: ' 认证信息回传 ', steps: [{ text: '统一认证登录，回传身份', fields: [' 账号ID '] }] }],
  });
  assert.equal(graph.systems[0].id, 'oa', 'id 归一小写');
  assert.equal(graph.systems[0].modules.length, 3, '重复模块静默去重');
  assert.equal(graph.flows[0].label, '认证信息回传', 'label 压空白');
  assert.equal(graph.flows[0].steps[0].fields?.[0], '账号ID', 'field 压空白');
  // 真实验收回归（中信保首跑 4 连拒根因）：英文混排产品词按显示字宽放行，不按字符个数。
  const oauthGraph = archGraphOf({ systems: [{ id: 'oa', name: '统一认证平台', modules: ['OAuth2 统一认证', '开放 REST API'] }],
    hubModules: ['用户与组织架构', 'SAML 单点登录', '需求管理'], flows: [{ from: 'oa', to: 'ones', label: 'OAuth2 认证回传', steps: [{ text: '统一认证登录，回传用户身份', fields: ['账号ID'] }] }] });
  assert.equal(oauthGraph.systems[0].modules.length, 2, '英文混排模块名按字宽通过');
  // 违规矩阵（每类返回可读错误，供重试日志）。
  const base = () => JSON.parse(JSON.stringify(ARCH_GRAPH_OA)) as Record<string, unknown>;
  assert.match(archErrorOf({ ...base(), systems: [] }), /全空 graph|1~6/, '零系统（素材无对接场景）');
  assert.match(archErrorOf({ ...base(), systems: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, name: `系统${i}`, modules: [] })) }), /1~6/, '系统超上限（v17 上限 6，与集成清单对齐）');
  assert.match(archErrorOf({ ...base(), systems: [{ id: 'ones', name: 'ONES', modules: [] }] }), /保留 id/, '保留 id 不得作外部系统');
  assert.match(archErrorOf({ ...base(), systems: [{ id: 'oa', name: 'OA 系统', modules: [] }, { id: 'oa', name: 'OA 二号', modules: [] }] }), /重复/, 'id 重复');
  assert.match(archErrorOf({ ...base(), systems: [{ id: '数据系统', name: 'OA 系统', modules: [] }] }), /小写字母/, 'id 格式非法');
  assert.match(archErrorOf({ ...base(), systems: [{ id: 'oa', name: '一二三四五六七八九十壹贰叁', modules: [] }] }), /1~12 字宽/, '系统名超宽（13 汉字 > 12 字宽）');
  assert.match(archErrorOf({ ...base(), systems: [{ id: 'oa', name: 'OA 系统', modules: ['一二三四五六七八九十壹贰'] }] }), /超过 11 字宽/, '模块名超宽');
  assert.match(archErrorOf({ ...base(), hubModules: ['需求管理', '权限管理'] }), /3~8/, '枢纽模块不足');
  assert.match(archErrorOf({ ...base(), flows: [] }), /1~10/, '零流');
  assert.match(archErrorOf({ ...base(), flows: [{ from: 'oa', to: 'ghost', label: '对接', steps: [{ text: '数据' }] }] }), /引用存在的系统 id/, '未知引用');
  const twoSystems = { ...base(), systems: [{ id: 'oa', name: 'OA 系统', modules: [] }, { id: 'erp', name: 'ERP 系统', modules: [] }] } as Record<string, unknown>;
  assert.match(archErrorOf({ ...twoSystems, flows: [{ from: 'oa', to: 'erp', label: '直连', steps: [{ text: '数据' }] }] }), /必须有一端是 "ones"/, '外部系统间直连拒绝');
  assert.match(archErrorOf({ ...base(), flows: [{ from: 'oa', to: 'ones', to: 'ones', label: '对接', steps: [] }] }), /steps 至少 1 条|无合法 steps/, '零 step');
  assert.match(archErrorOf({ ...base(), flows: [{ from: 'oa', to: 'ones', label: '一二三四五六七八九十壹贰叁', steps: [{ text: '数据' }] }] }), /label 须为 1~12 字宽/, 'label 超宽');
  assert.match(archErrorOf({ ...base(), flows: [{ from: 'oa', to: 'ones', label: '对接', steps: [{ text: '一'.repeat(37) }] }] }), /1~36 字宽/, 'step 超宽');
  assert.match(archErrorOf({ ...base(), flows: [{ from: 'oa', to: 'ones', label: '对接', steps: [{ text: '数据', fields: ['一'.repeat(15)] }] }] }), /超过 14 字宽/, 'field 超宽');
  assert.match(archErrorOf({ ...base(), flows: [{ from: 'oa', to: 'ones', label: '对接', steps: [{ text: '数据', fields: ['a', 'b', 'c', 'd', 'e'] }] }] }), /fields 超过 4 个/, 'fields 超限');
  // 禁区词：textGuard 注入案例正文内部证据检查。
  assert.ok('graph' in parseArchitectureGraph(ARCH_GRAPH_OA, { textGuard: caseInternalEvidenceLabel }), '干净内容过禁区词');
  const withCrm = JSON.parse(JSON.stringify(ARCH_GRAPH_OA));
  withCrm.hubModules[0] = 'CRM 同步';
  const guarded = parseArchitectureGraph(withCrm, { textGuard: caseInternalEvidenceLabel });
  assert.ok('error' in guarded && /内部信息/.test(guarded.error), `禁区词命中拒绝（实际：${'error' in guarded ? guarded.error : '通过'}` + '）');
  // v17 两图同源：systems 必须与规划期集成系统清单完全一致（名称逐字、数量相等、不得增删）。
  assert.ok('graph' in parseArchitectureGraph(ARCH_GRAPH_OA, { requiredSystemNames: ['OA 系统'] }), '清单一致通过');
  const mismatched = parseArchitectureGraph(ARCH_GRAPH_OA, { requiredSystemNames: ['OA 系统', 'ERP 系统'] });
  assert.ok('error' in mismatched && /集成系统清单完全一致/.test(mismatched.error) && /缺少 ERP 系统/.test(mismatched.error), '清单缺项拒绝');
  const renamed = parseArchitectureGraph(ARCH_GRAPH_OA, { requiredSystemNames: ['OA'] });
  assert.ok('error' in renamed && /多出 OA 系统/.test(renamed.error), '名称不一致拒绝（逐字比对）');
});

/** 从 SVG 提取全部矩形 [x,y,w,h]（按圆角半径分组，用于几何不变量断言）。 */
function archRects(svg: string, rx: string): Array<[number, number, number, number]> {
  return [...svg.matchAll(new RegExp(`<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)" rx="${rx}"`, 'g'))]
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number]);
}

const rectsOverlap = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

test('workbench: renderArchitectureSvg deterministic template invariants (v11)', () => {
  const svg = renderArchitectureSvg(ARCH_GRAPH_OA)!;
  assert.ok(svg, '单系统图渲染成功');
  const dims = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!;
  const [width, height] = [Number(dims[1]), Number(dims[2])];
  assert.ok(width >= 1100 && width <= 1800 && height >= 520 && height <= 920, `画布自适应（${width}×${height}）`);
  // 所有矩形完整落在画布内。
  for (const rect of [...archRects(svg, '5'), ...archRects(svg, '6'), ...archRects(svg, '8'), ...archRects(svg, '12'), ...archRects(svg, '14')]) {
    assert.ok(rect[0] >= 0 && rect[1] >= 0 && rect[0] + rect[2] <= width + 0.6 && rect[1] + rect[3] <= height + 0.6,
      `矩形 (${rect.join(',')}) 越出画布 ${width}×${height}`);
  }
  // 三明治成型：标题牌/实心块（rx=8）与模块卡（rx=5）互不相交（视觉评审踩坑：枢纽下半行 y 传参错误压牌）。
  for (const plate of archRects(svg, '8')) {
    for (const cardBox of archRects(svg, '5')) {
      assert.ok(!rectsOverlap(plate, cardBox), `标题牌 ${plate.join(',')} 与卡片 ${cardBox.join(',')} 重叠`);
    }
  }
  // 走廊注释框（rx=6）不侵入系统容器（rx=12）与枢纽容器（rx=14）。
  for (const box of archRects(svg, '6')) {
    for (const container of [...archRects(svg, '12'), ...archRects(svg, '14')]) {
      assert.ok(!rectsOverlap(box, container), `注释框 ${box.join(',')} 侵入容器 ${container.join(',')}`);
    }
  }
  // 每条流恰一条带箭头连线；线色 = 数据发出方主题色（oa=首位=珊瑚红）。
  assert.equal((svg.match(/marker-end=/g) ?? []).length, ARCH_GRAPH_OA.flows.length, '连线数=流数且必带箭头');
  const coral = ARCHITECTURE_FIGURE_PALETTE.externals[0].solid;
  assert.equal((svg.match(new RegExp(`<path [^>]*stroke="${coral}"`, 'g')) ?? []).length, 3, 'oa 发出流线色=其主题色');
  // v17：注释卡按系统聚合（一系统一张，垫在其卡下方），流编号写进卡内行。
  assert.equal((svg.match(new RegExp(`rx="6" fill="#FFFFFF" stroke="${coral}"`, 'g')) ?? []).length, 1, '注释卡数=系统数且描边同色');
  assert.ok(svg.includes('1、认证信息回传') && svg.includes('3、提交需求'), '编号注释行存在');
  assert.ok(svg.includes('>ONES 平台<'), '枢纽标题牌存在');
  // 模块无重复（视觉评审踩坑：系统上半行 slice 多拿一格导致上下重复出现）。
  for (const label of [...ARCH_GRAPH_OA.systems[0].modules, ...ARCH_GRAPH_OA.hubModules]) {
    assert.equal(svg.split(`>${label}<`).length - 1, 1, `模块「${label}」恰好出现一次`);
  }
  // 服务端产物仍过消毒（结构/tspan 规则/禁区词）且消毒幂等。
  const sanitized = sanitizeCaseSvg(svg);
  assert.ok(sanitized, '渲染产物过 sanitizeCaseSvg');
  assert.equal(sanitizeCaseSvg(sanitized!), sanitized, '消毒幂等');
  // 换行质量：ASCII 词不被拆行（视觉评审：账号ID 拆成 账号I / D）、全角左括号行首。
  const bodyBlocks = [...svg.matchAll(/font-size="13"[^>]*>(.*?)<\/text>/g)].map((m) => m[1]);
  for (const block of bodyBlocks) {
    const lines = [...block.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
    for (let i = 0; i + 1 < lines.length; i += 1) {
      assert.ok(!(/[A-Za-z]$/.test(lines[i]) && /^[A-Za-z]/.test(lines[i + 1])),
        `ASCII 词被拆行：「${lines[i]}」/「${lines[i + 1]}」`);
    }
  }
  assert.ok(bodyBlocks.some((block) => block.includes('（关联字段：')), '关联字段写入注释框');
  assert.ok(bodyBlocks.flatMap((block) => [...block.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]))
    .filter((line) => line.includes('关联字段')).every((line) => line.startsWith('（')), '（关联字段 整段从行首开始');
});

test('workbench: renderArchitectureSvg multi-system layout and density fallback (v17)', () => {
  const graph: ArchitectureGraph = {
    systems: [
      { id: 'erp', name: 'ERP 系统', modules: ['物料主数据', '采购订单', '工单管理', '成本核算'] },
      { id: 'crm', name: 'CRM 系统', modules: ['客户管理', '商机管理', '合同管理', '报价管理'] },
      { id: 'ehr', name: 'EHR 系统', modules: ['组织架构', '员工档案', '考勤管理'] },
      { id: 'pdm', name: 'PDM 系统', modules: ['产品文档', '图纸管理', '变更管理'] },
      { id: 'oa', name: 'OA 系统', modules: ['流程审批', '统一待办', '公告发布'] },
      { id: 'svn', name: 'SVN 系统', modules: [] },
    ],
    hubModules: ['项目管理', '需求管理', '测试管理', '工时管理', '效能度量', '知识库'],
    flows: [
      { from: 'erp', to: 'ones', label: '物料关联', steps: [{ text: '物料与项目信息关联核算成本', fields: ['项目ID', '物料ID'] }] },
      { from: 'crm', to: 'ones', label: '客户商机', steps: [{ text: '客户与商机信息关联项目上下文' }] },
      { from: 'ehr', to: 'ones', label: '组织同步', steps: [{ text: '组织架构与人员全量同步', fields: ['用户ID'] }] },
      { from: 'pdm', to: 'ones', label: '文档挂接', steps: [{ text: '产品文档与需求任务挂接' }] },
      { from: 'oa', to: 'ones', label: '审批联动', steps: [{ text: '审批通过自动创建需求与任务' }] },
      { from: 'ones', to: 'oa', label: '待办推送', steps: [{ text: '任务分配与到期提醒推送统一待办' }] },
      { from: 'ones', to: 'svn', label: '代码关联', steps: [{ text: '需求任务关联代码提交记录' }] },
    ],
  };
  const svg = renderArchitectureSvg(graph)!;
  assert.ok(svg, '六系统图渲染成功');
  const dims = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!;
  assert.equal(Number(dims[1]), 1440, '系统集成图固定 1440 宽');
  assert.equal(Number(dims[2]), 720, '固定 720 高');
  // 左右两列系统与居中枢纽互不重叠。
  const hub = archRects(svg, '14')[0];
  for (const container of [...archRects(svg, '12'), ...archRects(svg, '8').filter((rect) => rect[2] > 350)]) {
    assert.ok(!rectsOverlap(container, hub), `容器 ${container.join(',')} 与枢纽 ${hub.join(',')} 重叠`);
  }
  // 双向流：ONES 发出的线用枢纽蓝。
  assert.ok(/<path [^>]*stroke="#1665D8"[^>]*marker-end/.test(svg), 'ONES 发出流用枢纽主题色');
  // 无模块系统与有模块系统同为「tint 容器 + 标题牌」形态（v17 统一视觉语言，不再画实心色块）。
  assert.equal(archRects(svg, '12').length, 6, '六系统容器齐全且形态统一');
  // 1~6 系统全部布局档可渲染（左右两列轮转：1→右、2→1+1、3→2+1、4→2+2、5→3+2、6→3+3）。
  for (let count = 1; count <= 6; count += 1) {
    const sized: ArchitectureGraph = {
      systems: Array.from({ length: count }, (_, i) => ({ id: `sys${i}`, name: `系统${i}`, modules: ['模块一', '模块二', '模块三', '模块四', '模块五', '模块六'] })),
      hubModules: ['项目管理', '需求管理', '测试管理', '工时管理', '效能度量', '知识库'],
      flows: Array.from({ length: count }, (_, i) => ({ from: i % 2 ? 'ones' : `sys${i}`, to: i % 2 ? `sys${i}` : 'ones', label: `对接${i}`, steps: [{ text: '数据对接内容' }] })),
    };
    const sizedSvg = renderArchitectureSvg(sized);
    assert.ok(sizedSvg, `${count} 系统布局档渲染成功`);
    assert.equal((sizedSvg!.match(/marker-end=/g) ?? []).length, count, `${count} 系统档连线数=流数`);
  }
  // 压力规模（6 系统 × 6 模块）在列预算+密度降档内仍可渲染——模型按 prompt 上限如实输出不能丢图。
  const stress: ArchitectureGraph = {
    systems: Array.from({ length: 6 }, (_, i) => ({ id: `sys${i}`, name: `系统${i}`, modules: ['模块一', '模块二', '模块三', '模块四', '模块五', '模块六'] })),
    hubModules: ['项目管理', '需求管理', '测试管理', '工时管理', '效能度量', '知识库', '流水线', '代码库'],
    flows: Array.from({ length: 6 }, (_, i) => ({ from: i % 2 ? 'ones' : `sys${i}`, to: i % 2 ? `sys${i}` : 'ones', label: `对接${i}`, steps: [{ text: '数据对接内容' }] })),
  };
  assert.ok(renderArchitectureSvg(stress), '压力规模渲染成功（列预算+密度降档兜底）');
});

test('workbench: renderArchitectureSvg corridor boxes never overlap or exceed canvas (v11.2)', () => {
  // 真实验收回归（中信保二跑）：同一系统多条流的注释框期望位聚集在系统纵向中心附近，
  // 正向下推溢出画布底部后，旧实现用底部 clamp 无条件回拉 → 框对框完全叠画。
  const dense: ArchitectureGraph = {
    systems: [{ id: 'oa', name: 'OA 系统', modules: ['单点认证', '通讯录用户目录', '需求收集入口'] }],
    hubModules: ['用户与组织架构', '流程自动化', '需求管理', '权限管理'],
    flows: [
      { from: 'oa', to: 'ones', label: '认证回传', steps: [{ text: '统一认证登录，认证信息回传建立账号映射' }, { text: '账号映射关系定期校准', fields: ['账号ID'] }] },
      { from: 'oa', to: 'ones', label: '同步用户组织', steps: [{ text: 'OA 通讯录接口每次返回全量有效人员数据，平台逐轮比对' }, { text: '已不在通讯录的人员账号自动软删除', fields: ['部门', '职位'] }, { text: '历史数据完整保留' }] },
      { from: 'ones', to: 'oa', label: '输出提单链接', steps: [{ text: '链接指向配置完成的敏态需求表单' }] },
      { from: 'oa', to: 'ones', label: '提交敏态需求', steps: [{ text: '员工点击 H5 链接进入填报页面完成提交' }] },
    ],
  };
  const svg = renderArchitectureSvg(dense)!;
  assert.ok(svg, '密集流夹具渲染成功');
  const dims = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!;
  const [, height] = [Number(dims[1]), Number(dims[2])];
  const boxes = archRects(svg, '6');
  // v17：注释卡按系统聚合（一系统一张，卡内行数按列预算钳制），卡与卡之间天然不叠画。
  assert.equal(boxes.length, 1, '注释卡数=系统数');
  for (const box of boxes) {
    assert.ok(box[1] + box[3] <= height + 0.6, `框 (${box.join(',')}) 越出画布底部 ${height}`);
  }
  for (let a = 0; a < boxes.length; a += 1) {
    for (let b = a + 1; b < boxes.length; b += 1) {
      assert.ok(!rectsOverlap(boxes[a], boxes[b]), `注释框 ${a} 与 ${b} 重叠（${boxes[a].join(',')} vs ${boxes[b].join(',')}）`);
    }
  }
  // tspan 续排语义防线：多行正文从第 2 行起必须带 x 回行首——不带 x 会从上一行末尾阶梯续排
  // 溢出框外（真实验收三连败根因；坐标估算按每行从 text x 起算、对此盲视）。
  for (const textMatch of svg.matchAll(/<text\b[^>]*>((?:<tspan[\s\S]*?<\/tspan>)+)<\/text>/g)) {
    const tspans = [...textMatch[1].matchAll(/<tspan\b([^>]*)>/g)].map((m) => m[1]);
    for (let index = 1; index < tspans.length; index += 1) {
      assert.ok(/\bx\s*=/.test(tspans[index]), `第 ${index + 1} 个 tspan 缺 x（阶梯续排风险）：${tspans[index]}`);
    }
  }
  // 像素级防线（resvg 实渲 + 扫描框右真空带）：注释框右缘与相邻容器之间的空隙里
  // 不得出现正文色（#1F2329）文字像素——估算器与渲染语义脱节时这层测试直接报警。
  // 按 viewBox 宽 1:1 渲染：fitTo 固定 1800 会把窄画布（如 solo 1422）放大，
  // SVG 坐标系与像素坐标系错位——真空带扫描会把框内文字误判为溢出（本测试首版的假阳性根因）。
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: Number(svg.match(/viewBox="0 0 (\d+) /)![1]) }, font: { loadSystemFonts: true, defaultFontFamily: 'PingFang SC' }, background: 'rgba(255,255,255,1)' }).render();
  const { width: rw, pixels } = rendered;
  const hubRect = archRects(svg, '14')[0];
  const columnRects = archRects(svg, '12');
  for (const box of boxes) {
    const right = Math.round(box[0] + box[2]);
    const gapEnd = hubRect && right < hubRect[0] ? hubRect[0]
      : (columnRects.filter((rect) => rect[0] > right).sort((a, b) => a[0] - b[0])[0]?.[0] ?? right + 40);
    for (let x = right + 2; x < gapEnd; x += 1) {
      for (let y = Math.round(box[1]); y < Math.round(box[1] + box[3]); y += 1) {
        const i = (y * rw + x) * 4;
        assert.ok(!(Math.abs(pixels[i] - 31) < 30 && Math.abs(pixels[i + 1] - 35) < 30 && Math.abs(pixels[i + 2] - 41) < 30 && pixels[i + 3] > 128),
          `注释框右真空带 (${x},${y}) 出现正文色文字像素（框 ${box.join(',')} 右缘外溢出）`);
      }
    }
  }
});

/** 规划产物附带 figures 骨架（含非法 kind/非法章节组合与合法条目——非法条目须被丢弃）。 */
function casePlanContentWithFigures(content: any, prompt: string): any {
  const plan = casePlanContent(content, prompt);
  const context = casePromptContext(prompt);
  const refs = context.allowed_source_refs as string[];
  const factRef = refs.find((ref: string) => !ref.startsWith('customer:')) ?? refs[0];
  return { ...plan, figures: [
    { section: 'status', kind: 'flow_current', idea: '客户现状：三套系统并行、人工汇总对齐', source_refs: [factRef] },
    { section: 'value', kind: 'flow_current', idea: '非法组合（value 章只允许 milestone/value_map）', source_refs: [factRef] },
    { section: 'status', kind: 'photo', idea: '非法 kind', source_refs: [factRef] },
  ] };
}

test('workbench: case figures generated, sanitized, persisted and rendered as markdown placeholder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-fig-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const prompts: string[] = [];
    const figureSvg = CLEAN_CASE_FIGURE_SVG.replace('需求提出', '客户提出需求');
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        if (prompt.includes('章节配图')) {
          // 模型返回带危险属性的 SVG：服务端消毒后落库（剥离 onload/href，保留绘制属性）。
          const svg = figureSvg.replace('<rect x="20"', '<rect onload="alert(1)" href="https://evil.example/x" x="20"');
          return { content: [{ type: 'text', text: JSON.stringify({ svg, caption: '客户现状：三套系统并行、人工汇总对齐' }) }], stopReason: 'stop' };
        }
        const plan = prompt.includes('规划客户成功案例草稿的章节结构') ? casePlanContentWithFigures(CASE_CONTENT, prompt) : casePhaseRespond(CASE_CONTENT, prompt);
        return { content: [{ type: 'text', text: JSON.stringify(plan) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    // 规划 + 6 章节 + 1 张合法配图（两条非法 figures 条目被丢弃，不产生模型调用）；
    // v8.1 并行化后 prompt 顺序不再确定（配图与后续波次章节重叠），按内容定位断言。
    assert.equal(prompts.length, 8, '规划+6章+1图共 8 次模型调用');
    const figurePrompt = prompts.find((prompt) => prompt.includes('章节配图'))!;
    assert.ok(figurePrompt, '逐图生成调用必须存在');
    assert.match(figurePrompt, /绘图规范/, '图 prompt 含画法规范');
    assert.match(figurePrompt, /不得虚构环节、模块或数字/, '图内容事实边界');
    // v9：规划与章节 prompt 注入 ONES 能力图谱（模块命名依据 + 交付证据护栏）。
    const planPrompt = prompts.find((prompt) => prompt.includes('规划客户成功案例草稿的章节结构'))!;
    assert.ok(planPrompt.includes('【ONES 产品能力图谱'), '规划 prompt 注入能力图谱');
    const solutionPrompt = prompts.find((prompt) => prompt.includes('「业务解决方案」章节正文'))!;
    assert.ok(solutionPrompt.includes('【ONES 产品能力图谱'), '章节 prompt 注入能力图谱');
    assert.ok(solutionPrompt.includes('不构成交付证据'), '图谱交付证据护栏');
    const draft = db.listCaseDrafts('crm-c1')[0];
    assert.ok(draft, '带图生成必须产出草稿');
    const figures = (draft.fields as any).figures;
    assert.equal(figures.length, 1, '非法 figures 条目被丢弃、只保留 1 张');
    assert.equal(figures[0].kind, 'flow_current');
    assert.equal(figures[0].section, 'status');
    assert.equal(figures[0].caption, '客户现状：三套系统并行、人工汇总对齐');
    assert.ok(figures[0].svg.startsWith('<svg') && figures[0].svg.includes('viewBox'), '落库的是消毒后 SVG');
    assert.ok(!/onload|href=/.test(figures[0].svg), '落库 SVG 已剥离危险属性');
    assert.ok(figures[0].id.startsWith('figure:'), '图 id 为确定性指纹');
    // Markdown 以图注占位（与复制/Wiki 发布同源），位置在业务现状小节末尾。
    const markdown = renderCaseMarkdown(draft);
    assert.match(markdown, /> 图：客户现状：三套系统并行、人工汇总对齐（图示详见工作台）/, '图注占位');
    assert.ok(markdown.indexOf('（一）业务现状') < markdown.indexOf('> 图：'), '占位位于对应小节内');
    // 图级证据：来源被正文引用 → 不触发图文不一致警告。
    const detail = service.detail(draft.id)!;
    assert.ok(!detail.qualityReview.warnings.some((warning) => /配图/.test(warning)), `图相关警告不应出现: ${detail.qualityReview.warnings.join('；')}`);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: figure generation failure discards figure without failing the job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-figfail-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    // 1ms 退避加速图生成重试（默认 5s/15s/45s）。
    const previousBaseMs = caseModelRetryDelays.baseMs;
    caseModelRetryDelays.baseMs = 1;
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        if (prompt.includes('章节配图')) return { content: [{ type: 'text', text: '不是 JSON' }], stopReason: 'stop' };
        const plan = prompt.includes('规划客户成功案例草稿的章节结构') ? casePlanContentWithFigures(CASE_CONTENT, prompt) : casePhaseRespond(CASE_CONTENT, prompt);
        return { content: [{ type: 'text', text: JSON.stringify(plan) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    for (let i = 0; i < 6000 && db.getDraftJob(result.jobId!)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const job = db.getDraftJob(result.jobId!)!;
    assert.equal(job.status, 'succeeded', '图生成失败不判任务失败');
    const draft = db.listCaseDrafts('crm-c1')[0];
    assert.ok(draft, '各章正文照常成稿');
    assert.equal((draft.fields as any).figures, undefined, '失败的图不落库');
    assert.equal((draft.fields as any).company_info, CASE_CONTENT.company_info, '正文不受影响');
    assert.ok(!renderCaseMarkdown(draft).includes('> 图：'), 'Markdown 无图注占位');
    caseModelRetryDelays.baseMs = previousBaseMs;
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: milestone figure kind planned for value chapter and validated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-milefig-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const prompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        if (prompt.includes('章节配图')) {
          return { content: [{ type: 'text', text: JSON.stringify({ svg: CLEAN_CASE_FIGURE_SVG.replace('需求提出', '合作启动'), caption: '服务里程碑：合作启动到工单闭环' }) }], stopReason: 'stop' };
        }
        if (prompt.includes('规划客户成功案例草稿的章节结构')) {
          const base = casePlanContent(CASE_CONTENT, prompt);
          // milestone 挂 value 章合法（source_refs 用 stats:delivery——快照内的确定性事实来源）。
          const statsRef = casePromptContext(prompt).allowed_source_refs.find((ref: string) => ref === 'stats:delivery');
          if (statsRef) base.figures = [{ section: 'value', kind: 'milestone', idea: '合作里程碑时间轴', source_refs: [statsRef] }];
          return { content: [{ type: 'text', text: JSON.stringify(base) }], stopReason: 'stop' };
        }
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    const figures = (draft.fields as any).figures ?? [];
    if (figures.length) {
      // 快照含 stats 来源时 milestone 图合法落库（value 章），图注占位渲染在服务里程碑小节。
      assert.equal(figures[0].kind, 'milestone');
      assert.equal(figures[0].section, 'value');
      const markdown = renderCaseMarkdown(draft);
      assert.ok(markdown.indexOf('### 服务里程碑') < markdown.indexOf('> 图：'), 'milestone 图注位于服务里程碑小节');
    } else {
      // 无 stats 来源（seed 数据无 ONES 统计文本）时规划缺 stats:delivery → 图被丢弃不阻断。
      assert.ok(db.getDraftJob(result.jobId!)?.status === 'succeeded');
    }
    void prompts;
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: figure prompts carry kind-specific rules and ONES capability map (v17)', () => {
  const base = { customerName: '示例客户', idea: '方案总览', chapterAnchor: '定稿正文', materials: ['[f1] 素材原文'], integrationSystems: [] as string[] };
  const architecture = buildCaseFigurePrompt({ ...base, sectionLabel: '业务解决方案', kind: 'architecture' });
  assert.match(architecture, /系统集成架构图/, '架构图 brief 保留（测试路由短语）');
  assert.match(architecture, /不得虚构环节、模块或数字/, '事实边界原句保留');
  assert.match(architecture, /本图不画 SVG/, '架构图只提取内容、由服务端模板渲染');
  assert.match(architecture, /只输出 JSON：\{"caption":"\.\.\.","graph":\{\.\.\.\}/, 'graph 内容契约出厂');
  assert.match(architecture, /from=数据发出方、to=数据接收方/, '流方向语义');
  assert.match(architecture, /每条流必须有一端是 "ones"/, '流必须触达 ONES（kind 业务契约）');
  assert.match(architecture, /字宽口径：文本长度按显示字宽计/, '字宽口径说明（真实验收教训：按字符数卡死 OAuth2 类产品词）');
  assert.match(architecture, /不超过 12 字宽/, '系统名字宽界');
  assert.match(architecture, /每个不超过 11 字宽/, '模块字宽界');
  assert.match(architecture, /开放 API、单点登录等集成机制按实际采用可列入/, '集成机制可作枢纽模块');
  assert.match(architecture, /关联\/对应字段时放进同条 step 的 fields/, '关联字段写法');
  assert.match(architecture, /必须与下方集成系统清单完全一致/, 'v17：systems 与集成清单同源契约');
  assert.match(architecture, /集成系统清单为空/, '空清单时注入标准集成指引');
  assert.match(architecture, /【ONES 产品能力图谱/, '架构图注入能力图谱');
  assert.match(architecture, /不构成交付证据/, '图谱护栏');
  assert.ok(!architecture.includes('绘图规范'), '架构图不再携带 SVG 绘图规范');
  assert.ok(!architecture.includes('viewBox'), '架构图不再约束画布/坐标');
  assert.ok(!architecture.includes('tspan'), '架构图不再携带 SVG 文字排版规则');
  assert.ok(!architecture.includes('业务场景矩阵'), '与解决方案架构图路由短语互斥');
  const withList = buildCaseFigurePrompt({ ...base, sectionLabel: '业务解决方案', kind: 'architecture', integrationSystems: ['OA 系统', 'ERP 系统'] });
  assert.match(withList, /集成系统清单（规划期从素材提取，唯一事实源）：OA 系统、ERP 系统/, '非空清单逐字注入');
  const capabilityMap = buildCaseFigurePrompt({ ...base, sectionLabel: '业务解决方案', kind: 'capability_map' });
  assert.match(capabilityMap, /解决方案架构图/, 'v17 规范图名');
  assert.match(capabilityMap, /本图不画 SVG/, '解决方案架构图只提取内容、由服务端模板渲染');
  assert.match(capabilityMap, /只输出 JSON：\{"caption":"\.\.\.","blueprint":\{\.\.\.\}/, 'blueprint 内容契约出厂');
  assert.match(capabilityMap, /stages：按客户真实业务先后顺序排列恒 6~8 个阶段/, '阶段规模恒 6~8（不画空槽）');
  assert.match(capabilityMap, /依据下方 ONES 能力图谱按该客户业务域的典型研发现状补足到 6 个/, '素材不足时按图谱补足');
  assert.match(capabilityMap, /平台支撑与系统集成两条底带由服务端固定渲染/, '平台支撑/系统集成服务端固定');
  assert.match(capabilityMap, /topBand 可选/, '顶部带契约保留');
  assert.match(capabilityMap, /字宽口径：文本长度按显示字宽计/, '字宽口径');
  assert.ok(!capabilityMap.includes('绘图规范'), '解决方案架构图不再携带 SVG 绘图规范');
  assert.ok(!capabilityMap.includes('viewBox'), '解决方案架构图不再要求模型处理画布坐标');
  assert.ok(!capabilityMap.includes('tspan'), '解决方案架构图不再要求模型处理 SVG 换行');
  assert.match(capabilityMap, /【ONES 产品能力图谱/, '解决方案架构图注入能力图谱');
  assert.match(capabilityMap, /集成系统清单为空/, '空清单时集成带走标准集成兜底');
  const valueMap = buildCaseFigurePrompt({ ...base, sectionLabel: '方案价值概述', kind: 'value_map' });
  assert.match(valueMap, /方案价值图/, 'v17 规范图名');
  assert.match(valueMap, /痛点及挑战/, '价值图顶部标题固定');
  assert.match(valueMap, /values\[i\] 必须是解决 painPoints\[i\] 的结果/, '痛点价值逐条映射契约');
  assert.match(valueMap, /负向措辞/, '痛点标题负向词库');
  assert.match(valueMap, /正向措辞/, '价值标题正向词库');
  assert.match(valueMap, /从左到右「痛点及挑战｜方案｜价值」三栏/, '价值图左右布局');
  assert.match(valueMap, /以中间嵌入的解决方案架构图为锚/, '画布比例以架构图为锚');
  assert.match(valueMap, /各 3~5 条且数量必须相等/, '痛点与价值数量契约');
  assert.match(valueMap, /【ONES 产品能力图谱/, '价值图注入能力图谱');
  const flow = buildCaseFigurePrompt({ ...base, sectionLabel: '业务现状', kind: 'flow_current' });
  assert.match(flow, /现状流程图/, 'v17 规范图名（流程现状图→现状流程图）');
  assert.match(flow, /节点总数不超过 10 个/, '流程图维持 v7 规模口径');
  assert.match(flow, /服务端会等比嵌入统一视觉外壳/, '流程图由服务端统一外壳');
  assert.match(flow, /高饱和色安全映射/, '流程图统一蓝色主题');
  assert.match(flow, /tspan/, '通用 tspan 规则保留');
  assert.match(flow, /dy=/, '通用 dy 规则保留');
  assert.ok(!flow.includes('【ONES 产品能力图谱'), '流程图不注入图谱（省 token）');
});

test('workbench: solution chapter carries capability_map plus architecture when integration materials exist (v10)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-twofig-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        if (prompt.includes('章节配图')) {
          // 路由按内容契约短语（v17：旧「需求场景-产品能力映射图」短语已随改名退役）。
          const isCapability = prompt.includes('"blueprint"');
          if (isCapability) {
            return { content: [{ type: 'text', text: JSON.stringify(CAPABILITY_BLUEPRINT_RESPONSE) }], stopReason: 'stop' };
          }
          // v17：架构图模型只供内容 graph（systems 与集成清单逐字一致），SVG 由服务端模板渲染。
          return { content: [{ type: 'text', text: JSON.stringify({ caption: '集成：多系统对接 ONES', graph: {
            systems: [{ id: 'oa', name: 'OA 系统', modules: ['单点认证', '通讯录用户目录', '需求收集入口'] }],
            hubModules: ['用户与组织架构', '流程自动化', '需求管理', '权限管理'],
            flows: [{ from: 'oa', to: 'ones', label: '认证信息回传', steps: [{ text: '统一认证登录，回传用户身份' }] }],
          } }) }], stopReason: 'stop' };
        }
        if (prompt.includes('规划客户成功案例草稿的章节结构')) {
          const base = casePlanContent(CASE_CONTENT, prompt);
          const refs = casePromptContext(prompt).allowed_source_refs as string[];
          const factRef = refs.find((ref: string) => !ref.startsWith('customer:')) ?? refs[0];
          // 两图制：capability_map 标配 + 素材含集成表述时 architecture 加画，均挂解决方案章；
          // v17：集成系统清单由规划输出（名称逐字来自素材原文），architecture 图随之规划。
          base.integrationSystems = ['OA 系统'];
          base.figures = [
            { section: 'solution', kind: 'capability_map', idea: '需求场景与产品能力映射', source_refs: [factRef] },
            { section: 'solution', kind: 'architecture', idea: '多系统集成架构：SSO 与数据对接', source_refs: [factRef] },
          ];
          return { content: [{ type: 'text', text: JSON.stringify(base) }], stopReason: 'stop' };
        }
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    const figures = (draft.fields as any).figures ?? [];
    assert.equal(figures.length, 2, '解决方案章两图共存（架构+集成）');
    assert.ok(figures.every((figure: any) => figure.section === 'solution' && figure.svg.includes('viewBox')), '两图均挂解决方案章且为消毒后 SVG');
    const architectureFigure = figures.find((figure: any) => figure.kind === 'architecture');
    assert.ok(architectureFigure, '架构图存在');
    assert.ok(architectureFigure.svg.includes('ONES 平台'), '架构图为服务端模板渲染产物（graph→SVG）');
    assert.ok(architectureFigure.svg.includes('1、认证信息回传'), '编号注释行由服务端生成');
    assert.equal(architectureFigure.caption, '系统集成架构图', 'v17 图注确定性覆盖为规范图名');
    const markdown = renderCaseMarkdown(draft);
    const solutionStart = markdown.indexOf('（三）业务解决方案');
    const valueStart = markdown.indexOf('## 三、方案价值概述');
    for (const caption of ['解决方案架构图', '系统集成架构图']) {
      const noteIndex = markdown.indexOf(`> 图：${caption}`);
      assert.ok(noteIndex > -1, `图注存在: ${caption}`);
      assert.ok(solutionStart < noteIndex && noteIndex < valueStart, `图注在解决方案小节内: ${caption}`);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: integration systems plan contract validates provenance and gates architecture figure (v17)', async () => {
  // 规划前三轮输出未在素材原文出现的系统名（逐字包含性校验拒绝+重试），末轮打捞丢弃非法名照常成稿；
  // 清单为空时 architecture 图按规则不画（解决方案架构图系统集成带落 ONES 标准集成兜底）。
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-intsys-'));
  const db = new WorkbenchDatabase(dir);
  const previousBaseMs = caseModelRetryDelays.baseMs;
  caseModelRetryDelays.baseMs = 1;
  try {
    seedCaseCustomer(db);
    let planCalls = 0;
    let archFigurePromptSeen = false;
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        if (prompt.includes('规划客户成功案例草稿的章节结构')) {
          planCalls += 1;
          const base = casePlanContent(CASE_CONTENT, prompt);
          const refs = casePromptContext(prompt).allowed_source_refs as string[];
          const factRef = refs.find((ref: string) => !ref.startsWith('customer:')) ?? refs[0];
          base.integrationSystems = ['虚构门户系统'];
          base.figures = [
            { section: 'solution', kind: 'capability_map', idea: '方案蓝图', source_refs: [factRef] },
            { section: 'solution', kind: 'architecture', idea: '集成架构', source_refs: [factRef] },
          ];
          return { content: [{ type: 'text', text: JSON.stringify(base) }], stopReason: 'stop' };
        }
        if (prompt.includes('章节配图')) {
          if (prompt.includes('"graph"')) archFigurePromptSeen = true;
          return { content: [{ type: 'text', text: JSON.stringify(CAPABILITY_BLUEPRINT_RESPONSE) }], stopReason: 'stop' };
        }
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    assert.equal(planCalls, 4, '素材外系统名前三轮严格拒绝 + 末轮打捞');
    assert.ok(!archFigurePromptSeen, '清单为空（打捞后丢弃）时 architecture 图不再规划/生成');
    const draft = db.listCaseDrafts('crm-c1')[0];
    const figures = (draft.fields as any).figures ?? [];
    assert.equal(figures.length, 1, '只剩解决方案架构图');
    const capabilityFigure = figures.find((figure: any) => figure.kind === 'capability_map');
    assert.ok(capabilityFigure, '解决方案架构图存在');
    assert.equal(capabilityFigure.caption, '解决方案架构图', 'v17 规范图名');
    assert.ok(capabilityFigure.svg.includes('平台支撑') && capabilityFigure.svg.includes('权限管理') && capabilityFigure.svg.includes('审批中心'), '平台支撑固定词表渲染');
    assert.ok(capabilityFigure.svg.includes('系统集成') && capabilityFigure.svg.includes('企业微信') && capabilityFigure.svg.includes('LDAP/AD'), '空清单落 ONES 标准集成兜底');
    assert.ok(!capabilityFigure.svg.includes('组织保障'), '组织保障分区不再渲染');
    assert.ok((draft.fields as any).unknowns.some((item: string) => item.includes('集成系统名称未通过校验')), '打捞丢弃轨迹进 unknowns');
  } finally { caseModelRetryDelays.baseMs = previousBaseMs; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: value_map merges pain/value anchors and embeds capability_map figure (v10)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-valuemap-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const prompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        if (prompt.includes('章节配图')) {
          // 分发须先判价值图（v17：其专属规范含「解决方案架构图」字样，与解决方案架构图互串）。
          if (prompt.includes('方案价值图：')) {
            return { content: [{ type: 'text', text: JSON.stringify({
              caption: '全景：三痛点对三价值收束',
              painPoints: [
                { title: '进度信息分散', detail: '项目进展依赖人工汇总，延期风险暴露较晚' },
                { title: '质量过程失控', detail: '交付标准缺少统一留痕，问题反复沟通' },
                { title: '资源投入不透明', detail: '预算、工时和资源使用缺乏统一视图' },
              ],
              values: [
                { title: '项目进度可控', detail: '排期、工时与实际进展集中呈现，及时调整' },
                { title: '质量过程规范', detail: '交付标准线上提交与核准，过程记录可追溯' },
                { title: '资源投入透明', detail: '预算、工时与资源饱和度统一查看，提前调度' },
              ],
            }) }], stopReason: 'stop' };
          }
          return { content: [{ type: 'text', text: JSON.stringify(CAPABILITY_BLUEPRINT_RESPONSE) }], stopReason: 'stop' };
        }
        if (prompt.includes('规划客户成功案例草稿的章节结构')) {
          const base = casePlanContent(CASE_CONTENT, prompt);
          const refs = casePromptContext(prompt).allowed_source_refs as string[];
          const factRef = refs.find((ref: string) => !ref.startsWith('customer:')) ?? refs[0];
          base.figures = [
            { section: 'solution', kind: 'capability_map', idea: '需求场景与产品能力映射', source_refs: [factRef] },
            { section: 'value', kind: 'value_map', idea: '方案价值图', source_refs: [factRef] },
            { section: 'solution', kind: 'value_map', idea: '非法组合（value_map 只挂价值章）', source_refs: [factRef] },
            { section: 'value', kind: 'capability_map', idea: '非法组合（capability_map 只挂解决方案章）', source_refs: [factRef] },
          ];
          return { content: [{ type: 'text', text: JSON.stringify(base) }], stopReason: 'stop' };
        }
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    // 规划 + 6 章节 + 2 张合法配图（两条非法 figures 条目被丢弃，不产生模型调用）。
    assert.equal(prompts.length, 9, '规划+6章+2图共 9 次模型调用');
    const draft = db.listCaseDrafts('crm-c1')[0];
    const figures = (draft.fields as any).figures ?? [];
    assert.equal(figures.length, 2, '非法条目（value_map 挂 solution、capability_map 挂 value）被丢弃');
    const capabilityFigure = figures.find((figure: any) => figure.kind === 'capability_map');
    const valueMapFigure = figures.find((figure: any) => figure.kind === 'value_map');
    assert.ok(capabilityFigure && capabilityFigure.section === 'solution', '映射图挂解决方案章');
    assert.ok(valueMapFigure && valueMapFigure.section === 'value', '全景图挂价值章');
    const capabilityPrompt = prompts.find((prompt) => prompt.includes('章节配图') && prompt.includes('"blueprint"'))!;
    assert.ok(capabilityPrompt, 'capability_map 逐图调用存在');
    assert.match(capabilityPrompt, /只输出 JSON：\{"caption":"\.\.\.","blueprint":\{\.\.\.\}/, '映射图 blueprint 内容契约');
    assert.match(capabilityPrompt, /【ONES 产品能力图谱/, '映射图注入能力图谱');
    const figurePrompt = prompts.find((prompt) => prompt.includes('章节配图') && prompt.includes('方案价值图：'))!;
    assert.ok(figurePrompt, 'value_map 逐图调用存在');
    // 锚点：痛点（现状/诉求）+ 价值两段注入；方案正文不再注入（方案区由服务端拼装）。
    assert.match(figurePrompt, /【痛点素材·业务现状】/, '锚点含业务现状定稿');
    assert.match(figurePrompt, /【痛点素材·业务诉求】/, '锚点含业务诉求定稿');
    assert.match(figurePrompt, /【价值正文·方案价值概述】/, '锚点含价值定稿');
    assert.ok(!figurePrompt.includes('【方案正文·业务解决方案】'), '方案正文不再注入锚点');
    assert.match(figurePrompt, /痛点及挑战/, '顶部标题固定');
    assert.match(figurePrompt, /各 3~5 条且数量必须相等/, '痛点与价值数量契约');
    assert.match(figurePrompt, /【ONES 产品能力图谱/, '价值图注入能力图谱');
    // 服务端拼装：value_map 落库 SVG 嵌入「方案」分区框+标题牌+解决方案架构图本体（含其标识内容）。
    assert.ok(valueMapFigure.svg.includes('方案'), '方案区标题牌');
    assert.ok(valueMapFigure.svg.includes('<svg x="348" y="68" width="744" height="372"'), '架构图以中间方案区嵌套 svg 等比嵌入（动态几何）');
    assert.ok(valueMapFigure.svg.includes('需求收集') && valueMapFigure.svg.includes('ONES Project'), '嵌入的是解决方案章架构图本体');
    assert.ok(valueMapFigure.svg.includes('preserveAspectRatio="xMidYMid meet"'), '等比嵌入');
    assert.equal(valueMapFigure.caption, '方案价值图', 'v17 图注确定性覆盖为规范图名');
    // Markdown 占位固定在价值章末尾（价值成效之后、项目总结之前）。
    const markdown = renderCaseMarkdown(draft);
    const noteIndex = markdown.indexOf('> 图：方案价值图（图示详见工作台）');
    assert.ok(noteIndex > -1, '价值图注占位存在');
    assert.ok(markdown.indexOf('### 价值成效') < noteIndex, '占位在价值成效之后');
    assert.ok(noteIndex < markdown.indexOf('## 四、项目总结'), '占位在项目总结之前');
    const capabilityNoteIndex = markdown.indexOf('> 图：解决方案架构图（图示详见工作台）');
    assert.ok(capabilityNoteIndex > -1, '架构图注占位存在');
    assert.ok(markdown.indexOf('（三）业务解决方案') < capabilityNoteIndex && capabilityNoteIndex < markdown.indexOf('## 三、方案价值概述'), '架构图占位在解决方案小节内');
    // docx 导出同位：价值图图注在「四、项目总结」之前。
    const exported = await service.exportDocx(draft.id)!;
    assert.ok(exported, '导出必须成功');
    const Zip = (await import('jszip')).default;
    const zip = await Zip.loadAsync(exported.buffer);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    const docxNoteIndex = documentXml.indexOf('图：方案价值图');
    assert.ok(docxNoteIndex > -1, 'docx 含价值图规范图注');
    assert.ok(docxNoteIndex < documentXml.indexOf('四、项目总结'), 'docx 图注在项目总结之前');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case progress log rolls phase lines and replaces streaming ticks', () => {
  const written: string[] = [];
  const report = createCaseProgressLog((text) => written.push(text));
  report('[0m01s] 阶段一');
  report('[0m02s] 阶段二');
  report('[0m03s] 模型撰写中… 已输出 100 字');
  report('[0m04s] 模型撰写中… 已输出 200 字');
  let last = written[written.length - 1]!;
  assert.equal(last.split('\n').length, 3, '阶段行 + 当前流式 tick');
  assert.match(last.split('\n').at(-1)!, /已输出 200 字/, 'tick 只刷新末行');
  report('[0m05s] 阶段三');
  last = written[written.length - 1]!;
  assert.ok(!last.includes('模型撰写中'), '新阶段行清除流式 tick');
  for (let i = 0; i < 130; i++) report(`[1m00s] 阶段补充${i}`);
  last = written[written.length - 1]!;
  assert.equal(last.split('\n').length, 120, '阶段行滚动保留最近 120 条，逐次调用历史另存');
  assert.ok(last.includes('阶段补充129'), '最早阶段行滚出、最新保留');
});

test('workbench: case model slots release during retry backoff so queued chapters proceed', async () => {
  // 场景：解决方案章两图并发，映射图首试失败后退避睡眠（60ms）、架构图慢流 200ms 占另一路——
  // 旧排程失败图睡眠占槽，排队的价值章要等架构图结束才能开写；新排程退避放槽，价值章在重试前即取到槽。
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-slot-'));
  const db = new WorkbenchDatabase(dir);
  const previousBaseMs = caseModelRetryDelays.baseMs;
  caseModelRetryDelays.baseMs = 60;
  try {
    seedCaseCustomer(db);
    const events: string[] = [];
    const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let capAttempts = 0;
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        if (prompt.includes('章节配图')) {
          if (prompt.includes('"blueprint"')) {
            capAttempts += 1;
            events.push(`figure:cap#${capAttempts}`);
            if (capAttempts === 1) { await nap(40); return { stopReason: 'error', errorMessage: 'relay stall', content: [] }; }
            return { content: [{ type: 'text', text: JSON.stringify(CAPABILITY_BLUEPRINT_RESPONSE) }], stopReason: 'stop' };
          }
          events.push('figure:arch');
          await nap(200);
          // v17：架构图模型只供内容 graph（systems 与集成清单逐字一致），SVG 由服务端模板渲染。
          return { content: [{ type: 'text', text: JSON.stringify({ caption: '集成：多系统对接 ONES', graph: {
            systems: [{ id: 'oa', name: 'OA 系统', modules: ['单点认证', '通讯录用户目录'] }],
            hubModules: ['用户与组织架构', '流程自动化', '需求管理'],
            flows: [{ from: 'oa', to: 'ones', label: '认证信息回传', steps: [{ text: '统一认证登录，回传用户身份' }] }],
          } }) }], stopReason: 'stop' };
        }
        if (prompt.includes('规划客户成功案例草稿的章节结构')) {
          events.push('plan');
          const base = casePlanContent(CASE_CONTENT, prompt);
          const refs = casePromptContext(prompt).allowed_source_refs as string[];
          const factRef = refs.find((ref: string) => !ref.startsWith('customer:')) ?? refs[0];
          base.integrationSystems = ['OA 系统'];
          base.figures = [
            { section: 'solution', kind: 'capability_map', idea: '需求场景与产品能力映射', source_refs: [factRef] },
            { section: 'solution', kind: 'architecture', idea: '多系统集成架构', source_refs: [factRef] },
          ];
          return { content: [{ type: 'text', text: JSON.stringify(base) }], stopReason: 'stop' };
        }
        if (prompt.includes('撰写「方案价值概述」章节正文')) events.push('chapter:value');
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const valueStart = events.indexOf('chapter:value');
    const capRetry = events.lastIndexOf('figure:cap#2');
    assert.ok(valueStart > -1 && capRetry > -1, '价值章与映射图重试均发生');
    assert.ok(events.indexOf('figure:cap#1') < valueStart, '映射图首次尝试先于价值章');
    assert.ok(valueStart < capRetry, '退避睡眠不占槽：排队的价值章在图重试前取到槽开写');
    assert.equal(((db.listCaseDrafts('crm-c1')[0].fields as any).figures ?? []).length, 2, '两图最终均落库');
  } finally { caseModelRetryDelays.baseMs = previousBaseMs; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case figures start per finished chapter instead of waiting for the whole wave', async () => {
  // 业务现状章即时定稿、业务诉求章慢流 150ms：现状流程图应在诉求章仍在撰写时开画（旧排程等整波 settle）。
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-figearly-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const events: string[] = [];
    const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        if (prompt.includes('章节配图')) {
          events.push(prompt.includes('现状流程图') ? 'figure:flow_current' : 'figure:flow_target');
          return { content: [{ type: 'text', text: JSON.stringify({ svg: CLEAN_CASE_FIGURE_SVG, caption: prompt.includes('现状流程图') ? '客户现状：三套系统并行' : '目标：统一平台流转' }) }], stopReason: 'stop' };
        }
        if (prompt.includes('规划客户成功案例草稿的章节结构')) {
          const base = casePlanContent(CASE_CONTENT, prompt);
          const refs = casePromptContext(prompt).allowed_source_refs as string[];
          const factRef = refs.find((ref: string) => !ref.startsWith('customer:')) ?? refs[0];
          base.figures = [
            { section: 'status', kind: 'flow_current', idea: '客户现状流程', source_refs: [factRef] },
            { section: 'demands', kind: 'flow_target', idea: '目标流程', source_refs: [factRef] },
          ];
          return { content: [{ type: 'text', text: JSON.stringify(base) }], stopReason: 'stop' };
        }
        if (prompt.includes('撰写「业务诉求」章节正文')) {
          events.push('chapter:demands');
          await nap(150);
          events.push('chapter:demands:end');
          return { content: [{ type: 'text', text: JSON.stringify(caseChapterContent(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
        }
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    assert.ok(events.indexOf('figure:flow_current') > -1 && events.indexOf('chapter:demands:end') > -1, '流程图与诉求章均完成');
    assert.ok(events.indexOf('figure:flow_current') < events.indexOf('chapter:demands:end'),
      '现状章定稿即开画流程图，不等业务诉求章整波完成');
    assert.equal(((db.listCaseDrafts('crm-c1')[0].fields as any).figures ?? []).length, 2, '两张流程图均落库');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case enrichment runs parallel to remaining figures and reuses generation contextText', async () => {
  // 场景：6 个正面反馈片段触发覆盖度补写、映射图慢流 300ms——补写应与图并行（旧排程等全部图完成），
  // 且补写上下文沿用生成阶段 contextText（修复 inputSummary 键名取错的 level-0 全量回退）。
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-enrichpar-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-ep', name: '补写并行客户' });
    for (let i = 1; i <= 6; i++) {
      db.upsertSourceEvent({ customerId: 'crm-ep', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: `ep:t${i}`,
        title: `正面反馈话题 ${i}`, occurredAt: '2026-03-05T05:00:00Z', attributionStatus: 'confirmed',
        payload: { recordingId: `ep-r${i}`, speakers: ['客户'], evidence: [
          { speaker: '客户', text: `客户说这套系统挺好用的，效率提升明显，流程顺畅多了（第${i}次反馈）` }] } });
    }
    const events: string[] = [];
    const prompts: string[] = [];
    const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const enrichedContent = { ...CASE_CONTENT, value_items: [...CASE_CONTENT.value_items, '客户反馈系统好用且效率显著提升'] };
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        prompts.push(prompt);
        if (prompt.includes('章节配图') && prompt.includes('"blueprint"')) {
          events.push('figure:cap');
          await nap(300);
          events.push('figure:cap:end');
          return { content: [{ type: 'text', text: JSON.stringify(CAPABILITY_BLUEPRINT_RESPONSE) }], stopReason: 'stop' };
        }
        if (prompt.includes('补充完善客户成功案例草稿')) {
          events.push('enrich');
          return { content: [{ type: 'text', text: JSON.stringify(caseEnrichmentContent(enrichedContent, prompt)) }], stopReason: 'stop' };
        }
        if (prompt.includes('规划客户成功案例草稿的章节结构')) {
          const base = casePlanContent(CASE_CONTENT, prompt);
          const refs = casePromptContext(prompt).allowed_source_refs as string[];
          const factRef = refs.find((ref: string) => !ref.startsWith('customer:')) ?? refs[0];
          base.figures = [{ section: 'solution', kind: 'capability_map', idea: '需求场景与产品能力映射', source_refs: [factRef] }];
          return { content: [{ type: 'text', text: JSON.stringify(base) }], stopReason: 'stop' };
        }
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-ep');
    await waitForJob(db, result.jobId!);
    const enrichAt = events.indexOf('enrich');
    const figureEnd = events.indexOf('figure:cap:end');
    assert.ok(enrichAt > -1 && figureEnd > -1, '补写与映射图均发生');
    assert.ok(enrichAt < figureEnd, '补写与剩余配图并行，不等全部图完成才开始');
    const draft = db.listCaseDrafts('crm-ep')[0];
    assert.equal(((draft.fields as any).figures ?? []).length, 1, '第一稿配图保留');
    assert.ok((draft.fields as any).value_items.includes('客户反馈系统好用且效率显著提升'), '采纳补写第二稿正文');
    assert.equal((draft.fields as any).coverage.enriched, true);
    const planPrompt = prompts.find((prompt) => prompt.includes('规划客户成功案例草稿的章节结构'))!;
    const enrichPrompt = prompts.find((prompt) => prompt.includes('未引用素材清单'))!;
    const contextOf = (prompt: string) => prompt.slice(prompt.indexOf('上下文：'));
    assert.equal(contextOf(enrichPrompt), contextOf(planPrompt), '补写上下文=生成阶段同一份 contextText');
    // 滚动进度契约：多行阶段日志 + 调用尺寸观测行落库（事后可还原相位耗时与真实输入规模）。
    const job = db.getDraftJob(result.jobId!)!;
    const lines = String(job.progress ?? '').split('\n');
    assert.ok(lines.length >= 2, 'progress 多行滚动');
    assert.ok(lines.every((line) => line.trim().length > 0), '无空行');
    assert.ok(String(job.progress).includes('补充完善调用（输入 ~'), '补写尺寸观测行保留');
    assert.ok(String(job.progress).includes('配图「解决方案架构图」调用'), '配图尺寸观测行保留（v17 规范图名）');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: plan salvage mode drops drifted items on final attempt instead of failing the job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-salvage-'));  const db = new WorkbenchDatabase(dir);
  // 规划三次尝试之间的指数退避（5s/15s）远超 waitForJob 窗口，测试内加速。
  const previousBaseMs = caseModelRetryDelays.baseMs;
  caseModelRetryDelays.baseMs = 1;
  try {
    seedCaseCustomer(db);
    let planCalls = 0;
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        const prompt = input.messages[0].content;
        if (prompt.includes('规划客户成功案例草稿的章节结构')) {
          planCalls += 1;
          // 每次规划都带一条漂移摘录的业务诉求条目（摘录不在任何来源原文中）——前三次严格拒绝、末次打捞。
          const plan = casePlanContent(CASE_CONTENT, prompt);
          const demands = plan.plan.find((entry: any) => entry.section === 'demands')!;
          demands.items[0].excerpt = '这条摘录不存在于任何来源原文之中用于测试打捞模式';
          return { content: [{ type: 'text', text: JSON.stringify(plan) }], stopReason: 'stop' };
        }
        // 业务诉求章的产出条数与打捞后的规划对位（漂移条目已丢弃）。
        if (prompt.includes('「业务诉求」章节')) {
          return { content: [{ type: 'text', text: JSON.stringify({ texts: CASE_CONTENT.demands.slice(1) }) }], stopReason: 'stop' };
        }
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, prompt)) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-c1');
    await waitForJob(db, result.jobId!);
    const job = db.getDraftJob(result.jobId!)!;
    assert.equal(job.status, 'succeeded', '第 3 次打捞模式不得让任务失败');
    assert.equal(planCalls, 4, '前三次严格拒绝 + 末次打捞');
    const draft = db.listCaseDrafts('crm-c1')[0];
    assert.ok(draft, '打 salvage 后仍须产出草稿');
    // 漂移条目被丢弃：业务诉求只剩 1 条（原 2 条），丢弃轨迹进 unknowns。
    assert.equal((draft.fields as any).demands.length, CASE_CONTENT.demands.length - 1, '漂移条目被丢弃');
    assert.ok((draft.fields as any).unknowns.some((item: string) => item.includes('打捞模式')), '丢弃轨迹进 unknowns');
    // 章节产出与打捞后的规划条目对位（claim_evidence 数 = 打捞后条目数）。
    const expectedAfterSalvage = CASE_CONTENT.demands.length - 1;
    assert.equal((draft.fields as any).demands.length, expectedAfterSalvage);
  } finally { caseModelRetryDelays.baseMs = previousBaseMs; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: enrichment refreshes affected figures and falls back as a complete document on failure', async () => {
  for (const scenario of [
    { field: 'value_items', failFigure: false },
    { field: 'value_items', failFigure: true },
    { field: 'solution_sections', failFigure: false },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'csm-case-figure-refresh-'));
    const db = new WorkbenchDatabase(dir);
    try {
      db.upsertCustomer({ id: 'refresh', name: '配图更新客户' });
      for (let i = 0; i < 6; i++) db.upsertSourceEvent({ customerId: 'refresh', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
        externalId: `refresh-${i}`, title: `反馈 ${i}`, occurredAt: '2026-03-05T05:00:00Z', attributionStatus: 'confirmed',
        payload: { recordingId: `refresh-${i}`, speakers: ['客户'], evidence: [{ speaker: '客户', text: '客户说系统很好用，效率提升明显' }] } });
      const added = '追加验证成效：流程信息集中呈现，协作记录可追溯';
      const refined = scenario.field === 'value_items' ? { ...CASE_CONTENT, value_items: [...CASE_CONTENT.value_items, added] }
        : { ...CASE_CONTENT, solution_sections: [...CASE_CONTENT.solution_sections, { title: '协作信息整合', text: added }] };
      let refreshed = 0;
      const runtime: any = { llm: { provider: 'fake', model: 'fixture' }, models: { complete: async (_model: unknown, context: any) => {
        const prompt = context.messages[0].content;
        let value: any;
        if (prompt.includes('章节配图')) {
          if (prompt.includes(added)) refreshed++;
          if (scenario.failFigure && prompt.includes(added)) value = {};
          else if (prompt.includes('方案价值图：')) value = {
            painPoints: ['信息分散', '流程低效', '协作滞后'].map((title) => ({ title, detail: '不同环节依赖人工核对' })),
            values: ['信息统一', '流程规范', '协作提升'].map((title) => ({ title, detail: '相关信息能够集中查看' })),
          };
          else value = CAPABILITY_BLUEPRINT_RESPONSE;
        } else if (prompt.includes('规划客户成功案例草稿')) {
          value = casePlanContent(CASE_CONTENT, prompt);
          const refs = value.plan.find((item: any) => item.section === 'value').items[0].source_refs;
          value.figures = [
            { section: 'solution', kind: 'capability_map', idea: '业务场景图', source_refs: refs },
            { section: 'value', kind: 'value_map', idea: '价值总览', source_refs: refs },
          ];
        } else value = casePhaseRespond(CASE_CONTENT, prompt, { enrichContent: () => refined });
        return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(value) }] };
      } } };
      const service = new CaseService(db, caseMcp(), runtime);
      const job = service.generate('refresh');
      await waitForJob(db, job.jobId!);
      const fields: any = db.listCaseDrafts('refresh')[0].fields;
      assert.ok(refreshed > 0, 'changed anchors cause a figure request');
      assert.equal(fields.coverage.enriched, !scenario.failFigure, JSON.stringify(service.jobDetail(job.jobId!)!.calls.filter((call) => call.error)));
      assert.equal(fields.figures.length, 2, 'optional enrichment never loses an existing valid figure');
      if (scenario.failFigure) assert.deepEqual(fields.value_items, CASE_CONTENT.value_items, 'failed figure refresh restores the complete first draft');
      else if (scenario.field === 'value_items') assert.ok(fields.value_items.includes(added));
      else assert.ok(fields.solution_sections.some((item: any) => item.text === added));
      const valueFigure = fields.figures.find((item: any) => item.kind === 'value_map');
      assert.ok(new Resvg(valueFigure.svg).render().width > 0, 'recomposition keeps nested SVG well formed');
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('workbench: case ones records excluded from prompt but still feed fingerprint and stats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-budget-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-budget', name: '预算客户' });
    for (let i = 1; i <= 320; i++) {
      db.upsertSourceEvent({ customerId: 'crm-budget', sourceSystem: 'ones', sourceType: 'support_ticket',
        externalId: `bud-T-${i}`, displayId: `T-5${String(i).padStart(3, '0')}`, title: `预算事件 ${i}`,
        occurredAt: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T03:00:00Z`, payload: { field005: { category: 'in_progress' } } });
    }
    let capturedPrompts: string[] = [];
    const runtime = {
      llm: { provider: 'fake', model: 'fake-model' },
      models: { complete: async (_model: unknown, input: any) => {
        capturedPrompts.push(input.messages[0].content);
        return { content: [{ type: 'text', text: JSON.stringify(casePhaseRespond(CASE_CONTENT, capturedPrompts[capturedPrompts.length - 1])) }], stopReason: 'stop' };
      } },
    } as any;
    const service = new CaseService(db, caseMcp(), runtime);
    const result = service.generate('crm-budget');
    await waitForJob(db, result.jobId!);
    const capturedPrompt = capturedPrompts.join('\n');
    // v8.1：章节 prompt 是瘦身形态（无 records/catalog），注入断言统一解析规划 prompt 的全量上下文。
    const planPrompt = capturedPrompts.find((prompt) => prompt.includes('规划客户成功案例草稿的章节结构'))!;
    const context = JSON.parse(planPrompt.slice(planPrompt.indexOf('上下文：') + '上下文：'.length));
    // v6：ONES 明细（数百条工单）不注入——records 为空、目录无工单行，上下文不被工单撑爆。
    assert.deepEqual(context.records, [], 'ONES 工单不进 records');
    assert.ok(!capturedPrompt.includes('预算事件 1'), '工单标题不得注入');
    assert.ok((capturedPrompt.match(/预算事件/g) ?? []).length === 0, '320 条工单明细零注入');
    // 指纹仍基于全量事件（ONES 仍喂 delivery_stats）→ ONES 数据变化必须触发 contextStale。
    const draft = db.listCaseDrafts('crm-budget')[0];
    assert.ok(draft);
    db.upsertSourceEvent({ customerId: 'crm-budget', sourceSystem: 'ones', sourceType: 'support_ticket',
      externalId: 'bud-T-new', title: '新增事件', occurredAt: '2026-08-01T00:00:00Z', payload: {} });
    assert.equal(service.detail(draft.id)!.contextStale, true, 'ONES 明细剔除不影响指纹全量口径');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: narrative warnings guard refine/update writeback without blocking', () => {
  // 干净内容零告警（v8 各章字段）。
  const clean = { company_info: '公司信息', project_background: '项目背景', business_status: ['现状一'], demands: ['诉求一'],
    solution_sections: [{ title: '举措一', text: '方案一' }], value_items: ['价值一'], lessons: [], summary: '总结' };
  assert.deepEqual(caseNarrativeWarnings(clean), []);
  // 条目数失控 + 单条超长 + 占位词 + 内部残留。
  const runaway = { ...clean,
    demands: Array.from({ length: 13 }, (_, i) => `诉求${i}`),
    value_items: ['价值一'.repeat(201)] };
  const warnings = caseNarrativeWarnings(runaway);
  assert.ok(warnings.some((warning) => /业务诉求.*超过 12 条/.test(warning)), '条目超限须告警');
  assert.ok(warnings.some((warning) => /价值成效.*超过 600 字/.test(warning)), '单条超长须告警');
  const overlongSection = caseNarrativeWarnings({ ...clean, solution_sections: [{ title: '举措', text: '方'.repeat(1300) }] });
  assert.ok(overlongSection.some((warning) => /业务解决方案.*超过 1200 字/.test(warning)), '方案小节超长须告警');
  const dirty = { ...clean, business_status: [], company_info: '公司信息待确认', lessons: [] ,
    value_items: ['客户不满意减少了'] };
  const dirtyWarnings = caseNarrativeWarnings(dirty);
  assert.ok(dirtyWarnings.some((warning) => /待确认\/待补充占位词/.test(warning)), '占位词须告警');
  assert.ok(dirtyWarnings.some((warning) => /客户情绪内部记录/.test(warning)), '内部残留须告警');
  // 存量旧稿（五段键）护栏口径不变。
  const legacyWarnings = caseNarrativeWarnings({ background: '背景', solution: '方案', challenges: Array.from({ length: 13 }, (_, i) => `痛点${i}`) });
  assert.ok(legacyWarnings.some((warning) => /痛点、现状与挑战.*超过 12 条/.test(warning)), '旧稿条目超限仍须告警');
});

test('workbench: quality review flags stats citations for disclosure confirmation', () => {
  const sources = [
    { id: 'customer:c1', source_system: 'crm', source_type: 'customer_profile', external_id: 'c1', occurred_at: '2026-01-01', synced_at: '2026-01-01', title: '客户', excerpt: '制造行业', url: '', payload_hash: 'p' },
    { id: 'stats:delivery', source_system: 'internal', source_type: 'stats:delivery', external_id: 'stats:delivery', occurred_at: '2026-03-01', synced_at: '2026-03-01', title: '交付事实统计', excerpt: '工单共 8 项，已完成 8 项', url: '', payload_hash: 's' },
    { id: 'done-1', source_system: 'ones', source_type: 'support_ticket', external_id: 'd1', occurred_at: '2026-02-01', synced_at: '2026-02-01', title: '已完成上线', excerpt: '已完成上线', url: '', payload_hash: 'd', status_category: 'done' },
  ] as any[];
  const fields = { company_info: '制造行业客户', business_scope: '', competitive_strategy: '', project_background: '启动数字化建设',
    business_status: ['流程不透明'], demands: ['统一管理'],
    solution_sections: [{ title: '上线举措', text: '已完成上线' }], value_items: ['累计完成 8 项交付'], lessons: [], summary: '总结',
    context_snapshot: { generated_at: '2026-03-01', internal_digest: 'same', digest: 'snapshot', sources },
    claim_evidence: [
      { section: 'intro', claim: '制造行业客户', source_refs: ['customer:c1'], excerpt: '制造行业' },
      { section: 'intro', claim: '启动数字化建设', source_refs: ['customer:c1'], excerpt: '制造行业' },
      { section: 'status', claim: '流程不透明', source_refs: ['done-1'], excerpt: '已完成上线' },
      { section: 'demands', claim: '统一管理', source_refs: ['done-1'], excerpt: '已完成上线' },
      { section: 'solution', claim: '已完成上线', source_refs: ['done-1'], excerpt: '已完成上线' },
      { section: 'value', claim: '累计完成 8 项交付', source_refs: ['stats:delivery'], excerpt: '工单共 8 项，已完成 8 项', speaker_role: 'unknown' },
      { section: 'summary', claim: '总结', source_refs: ['done-1'], excerpt: '已完成上线' },
    ] };
  const draft = { id: 'case-st', customerId: 'c1', version: 1, status: 'draft', title: '统计引用案例', fields, evidenceRefs: [], createdAt: '2026-03-01', updatedAt: '2026-03-01' } as any;
  const review = caseQualityReview(draft, { now: new Date('2026-08-30T00:00:00Z') });
  assert.ok(review.warnings.some((warning) => /交付统计数字.*披露/.test(warning)), '引用 stats 数字须提示披露口径确认');
});

test('workbench: public case parsing requires traceable excerpts and derives Hemory speaker role', () => {
  const content = { title: '公开案例', company_info: '公司背景事实', business_scope: '', competitive_strategy: '', project_background: '合作背景',
    business_status: ['现状痛点'], demands: ['明确需求'], solution_sections: [{ title: '举措', text: '已落地方案' }], value_items: ['效率提升'], lessons: [], summary: '总结', unknowns: [] };
  const profile = { id: 'customer:c1', source_system: 'crm', source_type: 'customer_profile', external_id: 'c1', occurred_at: '2026-01-01', synced_at: '2026-01-01',
    title: '客户', excerpt: '制造行业客户', url: '', payload_hash: 'p' } as any;
  const done = { id: 'done-1', source_system: 'ones', source_type: 'support_ticket', external_id: 'd1', occurred_at: '2026-02-01', synced_at: '2026-02-01',
    title: '平台已完成上线', excerpt: '平台已完成上线', url: '', payload_hash: 'd', status_category: 'done' } as any;
  const csm = { id: 'voice-1', source_system: 'hemory', source_type: 'ai_topic_segment', external_id: 'v1', occurred_at: '2026-03-01', synced_at: '2026-03-01',
    title: '效果回访', excerpt: 'CSM: 我认为效率提升', url: '', payload_hash: 'v', speaker_lines: [{ speaker: 'CSM', speaker_role: 'csm', text: '我认为效率提升' }] } as any;
  const claims = [
    { section: 'intro', claim: content.company_info, source_refs: [profile.id], excerpt: profile.excerpt },
    { section: 'intro', claim: content.project_background, source_refs: [profile.id], excerpt: profile.excerpt },
    { section: 'status', claim: content.business_status[0], source_refs: [done.id], excerpt: done.excerpt },
    { section: 'demands', claim: content.demands[0], source_refs: [done.id], excerpt: done.excerpt },
    { section: 'solution', claim: content.solution_sections[0].text, source_refs: [done.id], excerpt: done.excerpt },
    { section: 'value', claim: content.value_items[0], source_refs: [csm.id], excerpt: '我认为效率提升', speaker_role: 'customer' },
    { section: 'summary', claim: content.summary, source_refs: [done.id], excerpt: done.excerpt },
  ];
  const sources = [profile, done, csm];
  assert.throws(() => parseCaseContent({ ...content, claim_evidence: claims.map(({ excerpt, ...claim }) => claim) },
    { requirePublic: true, allowedRefs: new Set(sources.map((source) => source.id)), sources }), /缺少原文摘录/);
  // 说话人角色降级为非阻断（真实会议说话人形态多样，逐句角色判定不可靠）：
  // 生成期只阻断「摘录无法定位」（防编造），角色问题由 caseQualityReview 告警 CSM 复核。
  const parsed = parseCaseContent({ ...content, claim_evidence: claims },
    { requirePublic: true, allowedRefs: new Set(sources.map((source) => source.id)), sources });
  assert.equal(parsed.value_items[0], content.value_items[0], 'CSM 说话人摘录不再阻断生成');
});

test('workbench: quality review marks stale web, pre-solution value, other customer and sensitive title', () => {
  const sources = [
    { id: 'customer:c1', source_system: 'crm', source_type: 'customer_profile', external_id: 'c1', occurred_at: '2026-01-01', synced_at: '2026-01-01', title: '目标客户', excerpt: '制造行业', url: '', payload_hash: 'p' },
    { id: 'value-early', source_system: 'hemory', source_type: 'ai_topic_segment', external_id: 'v1', occurred_at: '2026-02-01', synced_at: '2026-02-01', title: '反馈', excerpt: '效率提升', url: '', payload_hash: 'v', speaker_lines: [{ speaker: '客户', speaker_role: 'customer', text: '效率提升' }] },
    { id: 'solution-late', source_system: 'ones', source_type: 'support_ticket', external_id: 's1', occurred_at: '2026-03-01', synced_at: '2026-03-01', title: '已完成上线', excerpt: '已完成上线', url: '', payload_hash: 's', status_category: 'done' },
    { id: 'followup-csm', source_system: 'crm', source_type: 'crm_followup', external_id: 'f1', occurred_at: '2026-01-15', synced_at: '2026-01-15', title: '客户需要统一管理', excerpt: '客户需要统一管理', url: '', payload_hash: 'f' },
  ] as any[];
  const fields = { company_info: '制造行业客户', business_scope: '', competitive_strategy: '', project_background: '合作背景',
    business_status: ['流程不透明'], demands: ['统一管理'],
    solution_sections: [{ title: '上线举措', text: '已完成上线' }], value_items: ['效率提升'], lessons: [], summary: '总结',
    context_snapshot: { generated_at: '2026-03-01', internal_digest: 'same', digest: 'snapshot', sources },
    web_search: { searched: 1, searchedAt: '2026-01-01T00:00:00Z', results: [{ id: 'web-1', angle: '项目管理', title: '报道', snippet: '目标客户公开报道', domain: 'media.example', sourceTier: 'media', url: 'https://media.example/1', date: '2026-01-01' }], errors: [] },
    claim_evidence: [
      { section: 'intro', claim: '制造行业客户', source_refs: ['customer:c1'], excerpt: '制造行业' },
      { section: 'intro', claim: '合作背景', source_refs: ['customer:c1'], excerpt: '制造行业' },
      { section: 'status', claim: '流程不透明', source_refs: ['solution-late'], excerpt: '已完成上线' },
      { section: 'demands', claim: '统一管理', source_refs: ['followup-csm'], excerpt: '客户需要统一管理', speaker_role: 'unknown' },
      { section: 'solution', claim: '已完成上线', source_refs: ['solution-late'], excerpt: '已完成上线' },
      { section: 'value', claim: '效率提升', source_refs: ['value-early'], excerpt: '效率提升', speaker_role: 'customer' },
      { section: 'summary', claim: '总结', source_refs: ['solution-late'], excerpt: '已完成上线' },
    ] };
  const draft = { id: 'case-q', customerId: 'c1', version: 1, status: 'draft', title: '泄漏客户 13800138000', fields,
    evidenceRefs: [], createdAt: '2026-03-01', updatedAt: '2026-03-01' } as any;
  const review = caseQualityReview(draft, { currentInternalDigest: 'same', otherCustomerNames: ['泄漏客户'], now: new Date('2026-08-31T00:00:00Z') });
  assert.equal(review.contextStale, true);
  assert.ok(review.warnings.some((warning) => /公开资料快照已超过/.test(warning)));
  assert.ok(review.warnings.some((warning) => /先方案落地、后价值反馈/.test(warning)));
  assert.ok(review.warnings.some((warning) => /其他客户名称/.test(warning)));
  assert.ok(review.warnings.some((warning) => /手机号码.*案例标题/.test(warning)));
  assert.ok(review.warnings.some((warning) => /CRM 跟进.*缺少明确客户说话人/.test(warning)));
});

test('workbench: case update preserves internal evidence and quality review stays warning-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-update-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    const service = new CaseService(db, caseMcp(), fakeCaseModel(CASE_CONTENT));
    const queued = service.generate('crm-c1');
    await waitForJob(db, queued.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    const snapshot = (draft.fields as any).context_snapshot;
    const claims = (draft.fields as any).claim_evidence;
    const usage = (draft.fields as any).system_usage;
    const milestones = (draft.fields as any).milestones;
    const updated = service.update(draft.id, draft.version, '', { company_info: '', unknowns: [], context_snapshot: {} })!;
    assert.deepEqual((updated.fields as any).context_snapshot, snapshot);
    assert.deepEqual((updated.fields as any).claim_evidence, claims);
    assert.deepEqual((updated.fields as any).system_usage, usage, '未提交的派生表原样保留');
    assert.deepEqual((updated.fields as any).milestones, milestones, '未提交的里程碑原样保留');
    assert.ok((updated.fields as any).unknowns.some((item: string) => item === CASE_CONTENT.unknowns[0]));
    const review = caseQualityReview(updated);
    assert.ok(review.warnings.some((warning) => /标题为空/.test(warning)));
    assert.ok(review.warnings.some((warning) => /公司信息.*为空/.test(warning)));
    assert.ok(review.warnings.some((warning) => /线下确认/.test(warning)));
    assert.ok(service.publishPreview(updated.id, 'parent-warning').approvalHash, '警告不阻断预览');
    // v8 派生字段可编辑：PATCH system_usage/milestones 合并生效。
    const edited = service.update(updated.id, updated.version, undefined as any, {
      system_usage: [{ item: '购买账号数', content: '1500 个' }],
      milestones: [{ date: '2026-03', label: '合作启动' }],
    })!;
    assert.deepEqual((edited.fields as any).system_usage, [{ item: '购买账号数', content: '1500 个' }]);
    assert.deepEqual((edited.fields as any).milestones, [{ date: '2026-03', label: '合作启动' }]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: case publish is idempotent under concurrency and missing page id remains unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-publish-'));
  const db = new WorkbenchDatabase(dir);
  try {
    seedCaseCustomer(db);
    let calls = 0;
    const mcp = { listTools: () => [], call: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { text: '{"result":"SUCCESS","data":{"pageID":"page-once"}}', isError: false };
    } } as any;
    const service = new CaseService(db, mcp, fakeCaseModel(CASE_CONTENT));
    const queued = service.generate('crm-c1');
    await waitForJob(db, queued.jobId!);
    const draft = db.listCaseDrafts('crm-c1')[0];
    const preview = service.publishPreview(draft.id, 'parent-once');
    const results = await Promise.allSettled([
      service.publish(draft.id, draft.version, 'parent-once', preview.approvalHash),
      service.publish(draft.id, draft.version, 'parent-once', preview.approvalHash),
    ]);
    assert.equal(calls, 1);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(db.getCaseDraft(draft.id)?.publishedPageId, 'page-once');

    db.upsertCustomer({ id: 'crm-noid', name: '无 ID 客户' });
    db.upsertSourceEvent({ customerId: 'crm-noid', sourceSystem: 'ones', sourceType: 'support_ticket', externalId: 'noid-1',
      title: '已交付', occurredAt: '2026-08-01T00:00:00Z', payload: { field005: { category: 'done' } } });
    const noIdService = new CaseService(db, { listTools: () => [], call: async () => ({ text: '{"result":"SUCCESS"}', isError: false }) } as any,
      fakeCaseModel(CASE_CONTENT));
    const noIdJob = noIdService.generate('crm-noid');
    await waitForJob(db, noIdJob.jobId!);
    const noIdDraft = db.listCaseDrafts('crm-noid')[0];
    const noIdPreview = noIdService.publishPreview(noIdDraft.id, 'parent-noid');
    await assert.rejects(() => noIdService.publish(noIdDraft.id, noIdDraft.version, 'parent-noid', noIdPreview.approvalHash), /结果未知/);
    assert.equal(db.getCaseDraft(noIdDraft.id)?.status, 'draft');
    assert.equal(db.getCaseDraft(noIdDraft.id)?.publishedPageId ?? null, null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 风险预警名单（customer_alerts）：触发（AND 口径）、状态机与重报抑制 ─────────
import { evaluateCustomerAlerts } from '../src/workbench/alerts.js';

/** ONES 工作项 fixture：field009/field010 为 naive 上海时间（与真实同步写入口径一致）。 */
function onesWorkItemFixture(customerId: string, externalId: string, field009: string, field010: string, payload: Record<string, unknown> = {}) {
  return {
    customerId, sourceSystem: 'ones' as const, sourceType: 'suggestion_feedback', externalId,
    title: `工作项 ${externalId}`, occurredAt: field009, payload: { field009, field010, ...payload },
  };
}

/** CRM 跟进记录 fixture：occurred_at 为跟进时间（field_oUaZx__c 同步后已归一为 ISO）。 */
function crmFollowupFixture(customerId: string, externalId: string, occurredAt: string) {
  return { customerId, sourceSystem: 'crm' as const, sourceType: 'crm_followup', externalId, title: `跟进 ${externalId}`, occurredAt };
}

test('workbench: alert triggers — CRM+ONES both inactive AND negative public signal', () => withDb((db) => {
  const now = new Date('2026-09-02T04:00:00Z'); // 上海 12:00

  // ① 两侧都停滞（最后跟进与最后工作项活动都 >30 天）→ 触发；naive 上海时间按 +08:00 解析。
  db.upsertCustomer({ id: 'crm-a1', name: '沉默客户' });
  db.upsertSourceEvent(onesWorkItemFixture('crm-a1', 'sg-1', '2026-06-10 10:00:00', '2026-07-19 09:00:00'));
  db.upsertSourceEvent(crmFollowupFixture('crm-a1', 'fu-1', '2026-07-01T02:00:00.000Z'));
  const first = evaluateCustomerAlerts(db, 'crm-a1', now);
  assert.ok(first.created.includes('engagement_inactivity'), JSON.stringify(first));
  const inactive = db.activeAlert('crm-a1', 'engagement_inactivity');
  assert.ok(inactive);
  assert.match(inactive!.reasons[0], /近 30 天无 CRM 跟进记录，且无 ONES 工作项新增\/更新与新增工时/);
  assert.equal(inactive!.details.lastOnesActivityAt, '2026-07-19T01:00:00.000Z');
  assert.equal(inactive!.details.lastEngagementAt, '2026-07-19T01:00:00.000Z');

  // ② ONES 活跃（近期有工作项更新）→ 不触发（AND 口径：单侧活跃即豁免）。
  db.upsertCustomer({ id: 'crm-a2', name: 'ONES 活跃' });
  db.upsertSourceEvent(onesWorkItemFixture('crm-a2', 'sg-2', '2026-06-10 10:00:00', '2026-08-25 09:00:00'));
  db.upsertSourceEvent(crmFollowupFixture('crm-a2', 'fu-2', '2026-06-01T02:00:00.000Z'));
  assert.ok(!evaluateCustomerAlerts(db, 'crm-a2', now).created.includes('engagement_inactivity'));

  // ③ CRM 活跃（近期有跟进）→ 不触发。
  db.upsertCustomer({ id: 'crm-a7', name: '跟进活跃' });
  db.upsertSourceEvent(onesWorkItemFixture('crm-a7', 'sg-7', '2026-06-10 10:00:00', '2026-06-15 09:00:00'));
  db.upsertSourceEvent(crmFollowupFixture('crm-a7', 'fu-7', '2026-08-28T02:00:00.000Z'));
  assert.ok(!evaluateCustomerAlerts(db, 'crm-a7', now).created.includes('engagement_inactivity'));

  // ④ ONES 侧仅靠近期工时登记也算活跃 → 不触发（新增工时即活动）。
  db.upsertCustomer({ id: 'crm-a3', name: '工时活跃' });
  db.upsertSourceEvent({
    customerId: 'crm-a3', sourceSystem: 'ones', sourceType: 'customer_manhour', externalId: 'mh-1',
    title: '售后客户工时', occurredAt: '2026-05-01 09:00:00',
    payload: { field009: '2026-05-01 09:00:00', field010: '2026-06-01 09:00:00',
      workhourRecords: [{ id: 'w1', startTime: '2026-08-28', hours: 1.5, description: '支持' }] },
  });
  assert.ok(!evaluateCustomerAlerts(db, 'crm-a3', now).created.includes('engagement_inactivity'));

  // ⑤ 档案「最后联系」兜底：跟进事件很旧但 lastContactAt 较新 → 不触发（跟进同步只拉全局 200 条，档案值防误报）。
  db.upsertCustomer({ id: 'crm-a8', name: '档案兜底', lastContactAt: '2026-08-30T02:00:00.000Z' });
  db.upsertSourceEvent(onesWorkItemFixture('crm-a8', 'sg-8', '2026-06-10 10:00:00', '2026-06-15 09:00:00'));
  db.upsertSourceEvent(crmFollowupFixture('crm-a8', 'fu-8', '2026-06-01T02:00:00.000Z'));
  assert.ok(!evaluateCustomerAlerts(db, 'crm-a8', now).created.includes('engagement_inactivity'));

  // ⑥ 两侧都零历史 → 不触发；单侧零历史不豁免（CRM 从未跟进但 ONES 也停 30 天照常预警）。
  db.upsertCustomer({ id: 'crm-a4', name: '新客户' });
  assert.ok(!evaluateCustomerAlerts(db, 'crm-a4', now).created.includes('engagement_inactivity'));
  db.upsertCustomer({ id: 'crm-a9', name: '仅 ONES 历史' });
  db.upsertSourceEvent(onesWorkItemFixture('crm-a9', 'sg-9', '2026-05-01 10:00:00', '2026-05-01 10:00:00'));
  assert.ok(evaluateCustomerAlerts(db, 'crm-a9', now).created.includes('engagement_inactivity'));

  // ⑦ 负面公开动态触发（含新增关键词：罚款/收入下降）；正向不触发。
  db.upsertCustomer({ id: 'crm-a5', name: '舆情客户' });
  db.addEvidence({ id: 'ev-fine', customerId: 'crm-a5', kind: 'web_signal', label: '因数据违规被罚款 50 万', detail: '[sentiment] 监管处罚', occurredAt: '2026-08-20', confidence: 0.6, sourceSystem: 'web', sourceUrl: 'https://news.example.com/fine' });
  db.addEvidence({ id: 'ev-rev', customerId: 'crm-a5', kind: 'web_signal', label: '季度收入下降 12%', detail: '财报', occurredAt: '2026-08-21', confidence: 0.6, sourceSystem: 'web' });
  const seventh = evaluateCustomerAlerts(db, 'crm-a5', now);
  assert.ok(seventh.created.includes('negative_public_signal'));
  const negative = db.activeAlert('crm-a5', 'negative_public_signal');
  assert.equal(negative?.details.negativeCount, 2);
  assert.match(negative!.reasons.join('\n'), /罚款/);
  assert.match(negative!.reasons.join('\n'), /收入下降/);
  db.upsertCustomer({ id: 'crm-a6', name: '正面客户' });
  db.addEvidence({ id: 'ev-pos', customerId: 'crm-a6', kind: 'web_signal', label: '完成 B 轮融资', detail: '[financing] 融资 2 亿', occurredAt: '2026-08-20', confidence: 0.6, sourceSystem: 'web' });
  assert.ok(!evaluateCustomerAlerts(db, 'crm-a6', now).created.includes('negative_public_signal'));
}));

test('workbench: alert lifecycle — auto resolve on any-side activity, manual resolve, re-fire suppression', () => withDb((db) => {
  const t0 = new Date('2026-09-02T04:00:00Z');
  db.upsertCustomer({ id: 'crm-l1', name: '生命周期' });
  db.upsertSourceEvent(onesWorkItemFixture('crm-l1', 'sg-1', '2026-06-01 10:00:00', '2026-06-15 09:00:00'));
  db.upsertSourceEvent(crmFollowupFixture('crm-l1', 'fu-1', '2026-06-10T02:00:00.000Z'));

  // ① 双侧沉默 → 建单。
  evaluateCustomerAlerts(db, 'crm-l1', t0);
  const first = db.activeAlert('crm-l1', 'engagement_inactivity');
  assert.ok(first);

  // ② ONES 恢复活动（任一侧活跃即不满足 AND）→ 自动解除（resolvedBy=system + 说明）。
  db.upsertSourceEvent(onesWorkItemFixture('crm-l1', 'sg-2', '2026-08-30 10:00:00', '2026-08-30 10:00:00'));
  const afterActivity = evaluateCustomerAlerts(db, 'crm-l1', t0);
  assert.ok(afterActivity.autoResolved.includes('engagement_inactivity'));
  assert.equal(db.activeAlert('crm-l1', 'engagement_inactivity'), null);
  const auto = db.listResolvedAlerts('crm-l1', 'engagement_inactivity')[0];
  assert.equal(auto?.resolvedBy, 'system');
  assert.match(auto?.resolutionNote ?? '', /自动解除/);

  // ③ 之后又双双沉默 30 天 → 重报（lastEngagementAt 前移过）。
  const t1 = new Date('2026-10-05T04:00:00Z');
  const refired = evaluateCustomerAlerts(db, 'crm-l1', t1);
  assert.ok(refired.created.includes('engagement_inactivity'));
  const second = db.activeAlert('crm-l1', 'engagement_inactivity');
  assert.ok(second && second.id !== first!.id);

  // ④ 人工消除（消除原因落库；重复消除返回 null = API 409 语义）。
  assert.ok(db.resolveAlert(second!.id, 'csm', '已上门回访，客户预算冻结属正常周期'));
  assert.equal(db.resolveAlert(second!.id, 'csm', '重复操作'), null);

  // ⑤ 情况无新变化 → 抑制不重报。
  const suppressed = evaluateCustomerAlerts(db, 'crm-l1', t1);
  assert.ok(suppressed.suppressed.includes('engagement_inactivity'));
  assert.equal(db.activeAlert('crm-l1', 'engagement_inactivity'), null);

  // ⑥ CRM 侧出现新跟进后又双双沉默 → 允许重报（任一渠道前移 lastEngagementAt 都算新周期）。
  db.upsertSourceEvent(crmFollowupFixture('crm-l1', 'fu-2', '2026-10-20T02:00:00.000Z'));
  const t2 = new Date('2026-11-25T04:00:00Z');
  const refiredAgain = evaluateCustomerAlerts(db, 'crm-l1', t2);
  assert.ok(refiredAgain.created.includes('engagement_inactivity'));
}));

test('workbench: negative signal alert — re-fire only on new evidence, auto resolve out of window', () => withDb((db) => {
  const t0 = new Date('2026-09-02T04:00:00Z');
  db.upsertCustomer({ id: 'crm-n1', name: '舆情客户' });
  db.addEvidence({ id: 'ev-1', customerId: 'crm-n1', kind: 'web_signal', label: '被处罚', detail: '', occurredAt: '2026-08-20', confidence: 0.6, sourceSystem: 'web' });
  evaluateCustomerAlerts(db, 'crm-n1', t0);
  const first = db.activeAlert('crm-n1', 'negative_public_signal');
  assert.ok(first);
  assert.deepEqual(first!.details.negativeEvidenceIds, ['ev-1']);

  // 人工消除后同一证据集不重报。
  db.resolveAlert(first!.id, 'csm', '已核实为同名公司新闻');
  const suppressed = evaluateCustomerAlerts(db, 'crm-n1', t0);
  assert.ok(suppressed.suppressed.includes('negative_public_signal'));

  // 新负面证据出现 → 重报，快照更新为并集。
  db.addEvidence({ id: 'ev-2', customerId: 'crm-n1', kind: 'web_signal', label: '新增投诉', detail: '', occurredAt: '2026-09-01', confidence: 0.6, sourceSystem: 'web' });
  const refired = evaluateCustomerAlerts(db, 'crm-n1', t0);
  assert.ok(refired.created.includes('negative_public_signal'));
  const second = db.activeAlert('crm-n1', 'negative_public_signal');
  assert.deepEqual([...(second!.details.negativeEvidenceIds as string[])].sort(), ['ev-1', 'ev-2']);

  // 证据全部移出 90 天窗口 → 自动解除。
  const t1 = new Date('2026-12-01T04:00:00Z');
  const closed = evaluateCustomerAlerts(db, 'crm-n1', t1);
  assert.ok(closed.autoResolved.includes('negative_public_signal'));
  assert.equal(db.activeAlert('crm-n1', 'negative_public_signal'), null);
}));

test('workbench: alert list joins customer names and counts by status', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-c1', name: '客户一', shortName: '一一' });
  db.upsertCustomer({ id: 'crm-c2', name: '客户二' });
  db.upsertSourceEvent(onesWorkItemFixture('crm-c1', 'sg-1', '2026-06-01 10:00:00', '2026-06-01 10:00:00'));
  db.upsertSourceEvent(onesWorkItemFixture('crm-c2', 'sg-2', '2026-06-01 10:00:00', '2026-06-01 10:00:00'));
  evaluateCustomerAlerts(db, 'crm-c1', new Date('2026-09-02T04:00:00Z'));
  evaluateCustomerAlerts(db, 'crm-c2', new Date('2026-09-02T04:00:00Z'));
  db.resolveAlert(db.activeAlert('crm-c2', 'engagement_inactivity')!.id, 'csm', '已回访');

  const active = db.listAlerts({ status: 'active' });
  assert.equal(active.length, 1);
  assert.equal(active[0].customerName, '客户一');
  assert.equal(active[0].triggerKey, 'engagement_inactivity');
  assert.equal(db.countAlerts('active'), 1);
  assert.equal(db.countAlerts('resolved'), 1);
  const overview = db.overview('crm-c1');
  assert.equal((overview?.alerts as unknown[]).length, 1, 'overview 携带该客户待处理预警（详情横幅数据源）');
  assert.equal((db.overview('crm-c2')?.alerts as unknown[]).length, 0, '已消除预警不进 overview');
}));

test('workbench: legacy ones_inactivity alert rows migrate to engagement_inactivity on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-alert-migrate-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 存量行直接按旧键落库（模拟 de3965a 版本数据），重开库 migrate 改键后由启动对账按新口径重估。
    db.upsertCustomer({ id: 'crm-m1', name: '迁移客户' });
    const alertId = crypto.randomUUID();
    (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
      .prepare(`INSERT INTO customer_alerts(id,customer_id,trigger_key,status,reasons_json,details_json,created_at,updated_at)
        VALUES(?,?,?,'active','["旧口径预警"]','{}',?,?)`).run(alertId, 'crm-m1', 'ones_inactivity', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    db.close();
    const reopened = new WorkbenchDatabase(dir);
    try {
      const migrated = reopened.activeAlert('crm-m1', 'engagement_inactivity');
      assert.equal(migrated?.id, alertId, '旧键行应原位改名为 engagement_inactivity（不建新行）');
      const legacy = reopened.listAlerts({ status: 'all' }).filter((item) => item.triggerKey === ('ones_inactivity' as never));
      assert.equal(legacy.length, 0, '不应残留 ones_inactivity 键的行');
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
