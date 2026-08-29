import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { assessRisk } from '../src/workbench/risk.js';
import { buildOnesCustomerQuery, crmCustomer, crmFollowupEvent, nextHemorySlot, onesIssueUrl, onesSourceType, parseOnesIssuePage, parseOnesManhourMode, parseOnesManhourPage, PortfolioSyncService, shanghaiDayBounds } from '../src/workbench/sync.js';
import { applyDeploymentTypeOverride, applyConfirmDraftEdits, applyDraftEdits, computeWorkhours, confirmDraftEditContract, draftDisplayFields, draftEditContract, draftModelRetryDelays, fitFollowupSections, HemoryDraftService, invalidOnesOptionValues, mapOnesDeskRequiredFields, missingOnesDeskSpecFields, missingOnesRequiredFields, ONES_DESK_CLASSIFICATION_HINTS, ONES_DESK_FIELD_SPECS, parseOnesIssueFields, resolveDeploymentType, resolveOnesOption } from '../src/workbench/drafts.js';
import { HemorySegmentationService, isMeaningfulHemoryFragment } from '../src/workbench/hemory.js';

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
  assert.deepEqual(risk.unknowns.sort(), ['合同状态', '客户声音', '工单与交付统计', '最后互动时间', '续约日期'].sort());
  assert.equal(db.listCustomers()[0].id, 'crm-1');
}));

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

test('workbench: action completion is persisted with default and explicit outcomes', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-4', name: '客户丁' });
  const action = db.createAction({ customerId: 'crm-4', title: '确认续约预算', whyNow: '进入续约窗口' });
  const completed = db.completeAction(action.id);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.outcome, 'CSM 在工作台确认完成');
  const explicit = db.createAction({ customerId: 'crm-4', title: '指定结果', whyNow: '进入续约窗口' });
  db.completeAction(explicit.id, '已同步上线');
  assert.equal(db.getAction(explicit.id)?.outcome, '已同步上线');
  assert.equal(db.completeAction('missing-id'), null);
}));

test('workbench: legacy accepted actions are migrated back to new on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-accept-migrate-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-m1', name: '迁移客户' });
    const legacy = db.createAction({ customerId: 'crm-m1', title: '历史已接受行动', whyNow: '原因' });
    db.db.prepare("UPDATE action_items SET status='accepted' WHERE id=?").run(legacy.id);
    db.close();
    const reopened = new WorkbenchDatabase(dir);
    try {
      assert.equal(reopened.getAction(legacy.id)?.status, 'new');
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: bulk complete degrades only failing item and keeps default outcome', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-b2', name: '完成客户' });
  const ok = db.createAction({ customerId: 'crm-b2', title: '普通行动', whyNow: '原因' });
  const linked = db.createAction({ customerId: 'crm-b2', title: '进行中行动', whyNow: '原因' });
  db.updateAction(linked.id, { status: 'in_progress' });
  const snoozed = db.createAction({ customerId: 'crm-b2', title: '已搁置行动', whyNow: '原因' });
  db.updateAction(snoozed.id, { status: 'snoozed' });
  // 待处理/进行中均可直接完成（接受流程已移除），终态与搁置跳过。
  const results = db.bulkCompleteActions([ok.id, linked.id, snoozed.id, 'missing-id']);
  assert.deepEqual(results.map((item) => item.result), ['completed', 'completed', 'skipped', 'failed']);
  assert.equal(results[2].reason, '当前状态 snoozed，仅待处理/进行中可完成');
  assert.equal(results[3].title, null);
  assert.equal(db.getAction(ok.id)?.status, 'completed');
  assert.equal(db.getAction(ok.id)?.outcome, 'CSM 在工作台确认完成');
  assert.equal(db.getAction(linked.id)?.status, 'completed');
  assert.equal(db.getAction(snoozed.id)?.status, 'snoozed');
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
    assert.equal(db.listHemoryFragments({ status: 'pending' }).length, 1);
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
    // 提及客户名的片段与其他片段一样进入待归属列表，等 CSM 人工标记。
    const pending = db.listHemoryFragments({ status: 'pending' });
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

async function waitForJob(db: WorkbenchDatabase, jobId: string): Promise<void> {
  for (let i = 0; i < 200 && db.getDraftJob(jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(db.getDraftJob(jobId)?.status, 'succeeded');
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
    const optionIds = await (sync as any).resolveOnesCustomerOptions(db.getCustomer('crm-hd'));
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
    const optionIds2 = await (sync2 as any).resolveOnesCustomerOptions(db.getCustomer('crm-ai'));
    assert.deepEqual(optionIds2, ['tyy8tinj']);
    assert.equal(db.listIdentities('crm-ai').find((item) => item.system === 'ones_customer_option')?.external_id, 'tyy8tinj');

    // 场景二b：客户名称与简称都无法精确唯一匹配 → 未归属、落候选事件。
    db.upsertCustomer({ id: 'crm-ai2', name: '某研究院', shortName: '智源', sourceObject: 'object_Umwnn__c' });
    const mcp2b = fakeOnesOptionSearchMcp({
      '某研究院': [],
      '智源': [{ uuid: 'v8Goci1j', name: '智源研究院' }],
    });
    const sync2b = new PortfolioSyncService(db, mcp2b, async () => []);
    const optionIds2b = await (sync2b as any).resolveOnesCustomerOptions(db.getCustomer('crm-ai2'));
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
    const optionIds3 = await (sync3 as any).resolveOnesCustomerOptions(db.getCustomer('crm-xx'));
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
    const optionIds4 = await (sync4 as any).resolveOnesCustomerOptions(db.getCustomer('crm-md'));
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
    const count = await (sync as any).syncOnesCustomer(db.getCustomer('crm-dual'));
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

test('workbench: adjacent same-topic_key segments are defensively merged; v2 ids never inherit v1 attribution', async () => {
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

    // 模拟 v1 遗留片段：同边界（不同 ID）携带 confirmed 归属；v2 重切后新片段不继承。
    db.upsertCustomer({ id: 'crm-x', name: '客户X' });
    db.upsertSourceEvent({ customerId: 'crm-x', sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
      externalId: `rec-ver:${lines[0].spokenAt}:0:${lines[2].spokenAt}:2`, title: 'v1 片段', occurredAt: lines[0].spokenAt,
      attributionStatus: 'confirmed', payload: { recordingId: 'rec-ver' } });
    db.attributeHemoryFragments([db.findSourceEvent('hemory', 'ai_topic_segment', `rec-ver:${lines[0].spokenAt}:0:${lines[2].spokenAt}:2`)!.id],
      'crm-x', {}, 'csm');
    // v2 片段的外部 ID 带版本前缀，归属状态不受 v1 override 影响。
    assert.ok(fragments[0].externalId.startsWith('v3.2:rec-ver:'));
    assert.notEqual(fragments[0].attributionStatus, 'confirmed');
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

import { WeeklyReportService, weekMonday, weekRange, weeklyFingerprint, renderWeeklyMarkdown } from '../src/workbench/weekly.js';

function fakeWeeklyModel(content: unknown): any {
  return {
    llm: { provider: 'fake', model: 'fake-model' },
    models: { complete: async () => ({ content: [{ type: 'text', text: JSON.stringify(content) }], stopReason: 'stop' }) },
  };
}

const WEEKLY_CONTENT = {
  summary: '本周与客户完成两次关键沟通，围绕报表性能与培训计划达成一致，整体交付平稳。',
  accomplishments: [
    { category: '沟通与会议', date: '2026-08-25', text: '电话沟通报表导出性能问题，定位索引缺失', source: 'Hemory 片段 08-25' },
    { category: '工单处理', date: '2026-08-26', text: '导出超时工单已解决（近似口径）', source: '工单 T-2001' },
  ],
  next_week_plan: [{ text: '跟进导出性能复测结果', source: '08-25 电话约定' }],
  risks: [{ text: '客户对导出性能表达不满，需重点关注', source: '08-25 电话' }],
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
    // 近音词规则与「原话保持口语原样」的订正优先级说明都必须注入周报提示词。
    assert.match(capturedPrompt, /发音相近/);
    for (const alias of ['万死', '万斯', 'vans']) assert.ok(capturedPrompt.includes(alias), `周报提示词必须包含近音词 ${alias}`);
    assert.match(capturedPrompt, /优先理解为并写作 ONES/);
    assert.match(capturedPrompt, /订正优先于/);
    // 幂等：同指纹再次生成复用任务，不新建。
    const again = service.generate('crm-w2', '2026-08-26');
    assert.equal(again.jobId, result.jobId);
    // Markdown 渲染四章节齐全。
    const markdown = renderWeeklyMarkdown(report, '周报客户二');
    assert.match(markdown, /# 周报客户二 实施周报（2026-08-24 ~ 2026-08-30）/);
    assert.match(markdown, /## 一、本周执行摘要|本周执行摘要/);
    assert.match(markdown, /## 下周工作计划/);
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
    assert.match(String(preview.args.title), /周报客户四 实施周报/);
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
    // 指数退避 5s+15s：等待窗口放宽到 75 秒。
    for (let i = 0; i < 3750 && db.getDraftJob(job1.jobId!)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
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
