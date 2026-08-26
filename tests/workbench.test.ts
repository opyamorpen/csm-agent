import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { assessRisk } from '../src/workbench/risk.js';
import { buildOnesCustomerQuery, crmCustomer, crmFollowupEvent, nextHemorySlot, onesIssueUrl, onesSourceType, parseOnesIssuePage, parseOnesManhourPage, PortfolioSyncService, shanghaiDayBounds } from '../src/workbench/sync.js';
import { classifyDraftTypes, draftDisplayFields, HemoryDraftService, missingOnesRequiredFields, parseOnesIssueFields } from '../src/workbench/drafts.js';
import { HemorySegmentationService, isMeaningfulHemoryFragment } from '../src/workbench/hemory.js';

function withDb(fn: (db: WorkbenchDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'csm-workbench-'));
  const db = new WorkbenchDatabase(dir);
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
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

test('workbench: ONES CSM sources are selected by customer option and exact issue types', () => {
  const query = buildOnesCustomerQuery('customer-option-1');
  assert.match(query, /JrvswW8P = 'customer-option-1'/);
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

test('workbench: todo intents are one-time and action completion is persisted', () => withDb((db) => {
  db.upsertCustomer({ id: 'crm-4', name: '客户丁' });
  const action = db.createAction({ customerId: 'crm-4', title: '确认续约预算', whyNow: '进入续约窗口', ownerWecomUserid: 'bo' });
  db.updateAction(action.id, { status: 'accepted' });
  const intent = db.createTodoIntent(action.id, 10);
  assert.deepEqual(db.peekTodoIntent(intent.id, intent.token), { actionItemId: action.id });
  assert.deepEqual(db.consumeTodoIntent(intent.id, intent.token), { actionItemId: action.id });
  assert.equal(db.consumeTodoIntent(intent.id, intent.token), null);
  db.linkWecomTodo(action.id, 'todo-1', 'bo', ['bo']);
  db.updateWecomTodoStatus(action.id, 0);
  assert.equal(db.getAction(action.id)?.status, 'completed');
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
      { start_index: 0, end_index: 1, topic: '接通确认', summary: '双方确认音频连接。', include: true },
      { start_index: 2, end_index: 4, topic: '审批阻塞排查', summary: '客户反馈审批阻塞，双方约定收集报错证据并同步处理计划。', include: true },
    ] }]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const fragments = await service.segmentRecording(recording);
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].sourceType, 'ai_topic_segment');
    assert.equal(fragments[0].title, '审批阻塞排查');
    assert.equal(db.listHemoryFragments({ status: 'pending' }).length, 1);
    assert.equal((await service.segmentRecording(recording)).length, 1);
    assert.equal(fake.calls(), 1);
    assert.equal(isMeaningfulHemoryFragment(lines.slice(0, 2)), false);
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
      { segments: [{ start_index: 0, end_index: 2, topic: '交付流程', summary: '整理交付流程。', include: true }] },
      { segments: [{ start_index: 0, end_index: 3, topic: '交付流程评审', summary: '整理交付流程并安排评审。', include: true }] },
    ]);
    const service = new HemorySegmentationService(db, fake.runtime);
    const old = await service.segmentRecording(first);
    const nextLines = [...base, { spokenAt: '2026-08-25T05:01:00Z', speaker: 'CSM', text: '明天下午会组织相关负责人一起完成流程评审。' }];
    const second = db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'recording-2',
      title: '原始转写', occurredAt: base[0].spokenAt, payload: { recordingId: 'recording-2', lines: nextLines }, attributionStatus: 'unattributed' });
    const current = await service.segmentRecording(second);
    assert.notEqual(current[0].id, old[0].id);
    assert.deepEqual(db.listHemoryFragments({ status: 'all' }).map((item) => item.id), [current[0].id]);
    assert.equal(fake.calls(), 2);
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

test('workbench: relevant Hemory evidence creates drafts and approved local todo only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-d', name: '客户岛' });
    const event = db.upsertSourceEvent({ customerId: 'crm-d', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r2:t1:x',
      title: '请小王明天跟进这个报错需求，已经投入两小时', occurredAt: '2026-08-25T05:00:00Z',
      payload: { recordingId: 'r2', speaker: 'CSM', transcript: '请小王明天跟进这个报错需求，已经投入两小时' }, attributionStatus: 'confirmed' });
    assert.deepEqual(new Set(classifyDraftTypes([event])), new Set(['followup', 'internal_todo', 'workhour', 'suggestion', 'ticket']));
    const fakeMcp = { listTools: () => [], isWrite: () => false, resolve: () => undefined,
      call: async () => ({ text: '', isError: false }) } as any;
    const service = new HemoryDraftService(db, fakeMcp);
    const queued = service.enqueue('crm-d', [event.id]);
    assert.ok(queued);
    for (let i = 0; i < 20 && db.getDraftJob(queued!.jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getDraftJob(queued!.jobId)?.status, 'succeeded');
    const batch = db.listDraftBatches('crm-d')[0];
    assert.equal(batch.items?.length, 5);
    assert.equal(service.enqueue('crm-d', [event.id])?.fingerprint, queued!.fingerprint);
    assert.equal(db.listDraftBatches('crm-d').length, 1);
    const todo = batch.items!.find((item) => item.type === 'internal_todo')!;
    const preview = await service.preview(batch.id, [todo.id]);
    const result = await service.confirm(batch.id, preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    assert.equal(result.items[0].status, 'written');
    assert.equal(db.listActions('crm-d').length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

function fakeModelRuntime(drafts: unknown[]): any {
  return {
    llm: { provider: 'fake', model: 'fake-model' },
    models: { complete: async () => ({ content: [{ type: 'text', text: JSON.stringify({ drafts }) }], stopReason: 'stop' }) },
  };
}

function segment(db: WorkbenchDatabase, customerId: string, externalId: string, recordingId: string, title: string, occurredAt: string, transcript: string) {
  return db.upsertSourceEvent({ customerId, sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId,
    title, occurredAt, attributionStatus: 'confirmed', payload: { recordingId, speakers: ['CSM'], transcript } });
}

async function waitForJob(db: WorkbenchDatabase, jobId: string): Promise<void> {
  for (let i = 0; i < 200 && db.getDraftJob(jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(db.getDraftJob(jobId)?.status, 'succeeded');
}

test('workbench: same-recording fragments merge into one batch and multiple drafts of one type survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-m', name: '客户马' });
    const f1 = segment(db, 'crm-m', 'r9:a', 'r9', '话题A', '2026-08-25T01:00:00Z', '先聊聊上线部署的安排');
    const first = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued1 = first.enqueue('crm-m', [f1.id]);
    await waitForJob(db, queued1!.jobId);
    // 分次归属：同录音第二个片段现在才绑定，应并入同一批次而不是新建一个。
    const f2 = segment(db, 'crm-m', 'r9:b', 'r9', '话题B', '2026-08-25T02:00:00Z', '又出现了一个报错工单');
    const queued2 = first.enqueue('crm-m', [f2.id]);
    await waitForJob(db, queued2!.jobId);
    const batches = db.listDraftBatches('crm-m');
    assert.equal(batches.filter((batch) => batch.status !== 'stale').length, 1);
    const merged = batches.find((batch) => batch.status !== 'stale')!;
    assert.deepEqual(merged.sourceEventIds.sort(), [f1.id, f2.id].sort());
    // LLM 返回同类型多条草稿时不能被折叠：两条 ticket 都要保留。
    const third = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([
      { type: 'ticket', title: '工单一', summary: '第一个故障', evidence_refs: [f1.id] },
      { type: 'ticket', title: '工单二', summary: '第二个故障', evidence_refs: [f2.id] },
    ]));
    const regenerated = third.regenerate(merged.id);
    await waitForJob(db, regenerated.jobId);
    const active = db.listDraftBatches('crm-m').filter((batch) => batch.status !== 'stale');
    assert.equal(active.length, 1);
    assert.equal(active[0].items?.filter((item) => item.type === 'ticket').length, 2);
    // 每条草稿只引用自己的证据片段。
    const tickets = active[0].items!.filter((item) => item.type === 'ticket');
    assert.deepEqual(tickets[0].fields.evidence_refs, [tickets[0].title === '工单一' ? f1.id : f2.id]);
    assert.deepEqual(tickets[1].fields.evidence_refs, [tickets[1].title === '工单一' ? f1.id : f2.id]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workbench: stale batch heals on re-enqueue and regenerate works from CLI route semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-drafts-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-s', name: '客户斯' });
    const f1 = segment(db, 'crm-s', 'r5:a', 'r5', '话题A', '2026-08-25T01:00:00Z', '客服反馈一个需求，希望支持批量导出');
    const service = new HemoryDraftService(db, fakeMcpForDrafts(), fakeModelRuntime([]));
    const queued1 = service.enqueue('crm-s', [f1.id]);
    await waitForJob(db, queued1!.jobId);
    const original = db.listDraftBatches('crm-s')[0];
    assert.equal(original.items?.length, 2);
    // 重新归属（内容变化）后旧批次作废。
    const changed = db.upsertSourceEvent({ customerId: 'crm-s', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r5:a',
      title: '话题A', occurredAt: '2026-08-25T01:00:00Z', attributionStatus: 'confirmed',
      payload: { recordingId: 'r5', speakers: ['CSM'], transcript: '客服反馈一个需求，希望支持批量导出，另外下个月要部署升级环境' } });
    const queued2 = service.enqueue('crm-s', [changed.id]);
    await waitForJob(db, queued2!.jobId);
    const stale = db.getDraftBatch(original.id)!;
    assert.equal(stale.status, 'stale');
    const healed = db.listDraftBatches('crm-s').find((batch) => batch.status !== 'stale');
    assert.ok(healed, '重新归属后应生成新批次');
    // 运维关键词在新内容里应被识别。
    assert.ok(healed!.items?.some((item) => item.type === 'operations'), '应生成运维工单草稿');
    // regenerate 强制重新生成。
    const forced = service.regenerate(healed!.id);
    await waitForJob(db, forced.jobId);
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
    const service = new HemoryDraftService(db, mcp);
    const queued = service.enqueue('crm-f', [event.id]);
    for (let i = 0; i < 40 && db.getDraftJob(queued!.jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
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
    const failing = new HemoryDraftService(db, fakeCrmMcp('{"resultCode":"USER_TOOL_NOT_EXIST"}'));
    const queued2 = failing.enqueue('crm-g', [event2.id]);
    for (let i = 0; i < 40 && db.getDraftJob(queued2!.jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
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
    const service = new HemoryDraftService(db, fakeCrmMcp('{"resultCode":"SUCCESS","data":{"id":"rec-2"}}'));
    const queued = service.enqueue('crm-legacy', [event.id]);
    for (let i = 0; i < 40 && db.getDraftJob(queued!.jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
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
    for (let i = 0; i < 40 && db.getDraftJob(queued2!.jobId)?.status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
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
    const service = new HemoryDraftService(db, mcp);
    const queued = service.enqueue('crm-o', [event.id]);
    await waitDraftJob(db, queued!.jobId);
    const batch = db.listDraftBatches('crm-o')[0];
    const suggestion = batch.items!.find((item) => item.type === 'suggestion')!;
    // 最小必填参数集：项目/类型/标题/客户字段/描述（Hemory 摘要）。
    assert.equal(suggestion.targetTool, 'mcp__ones__create_new_issue');
    assert.equal(suggestion.targetArguments.projectID, 'GL3ysesFPdnAQNIU');
    assert.equal(suggestion.targetArguments.issueTypeID, 'A99xMfkg');
    assert.equal(suggestion.targetArguments.summary, suggestion.title);
    assert.deepEqual(suggestion.targetArguments.fieldValues, [{ fieldID: 'JrvswW8P', value: 'opt-77' }]);
    assert.ok(!suggestion.validationErrors.length);
    // 预览触发 get_issue_fields 预检：必填项已覆盖时不报错。
    const preview = await service.preview(batch.id, [suggestion.id]);
    assert.equal(preview.items[0].validationErrors.length, 0);
    // 确认后以最小参数精确调用写工具。
    const written = await service.confirm(batch.id, preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })));
    assert.equal(written.items[0].status, 'written');
    const createCall = mcp.calls.find((call) => call.publicName === 'mcp__ones__create_new_issue')!;
    assert.deepEqual(createCall.args, { projectID: 'GL3ysesFPdnAQNIU', issueTypeID: 'A99xMfkg',
      summary: suggestion.title, description: suggestion.summary, fieldValues: [{ fieldID: 'JrvswW8P', value: 'opt-77' }] });
    // displayFields：最小必填项结构化展示；客户信息在名称与选项名一致时只显示一个名字。
    const customer = db.getCustomer('crm-o')!;
    const fields = draftDisplayFields(db, suggestion, customer);
    assert.deepEqual(fields.map((field) => field.label), ['所属项目', '工作项类型', '标题', '客户信息', '描述']);
    assert.equal(fields.find((field) => field.key === 'customer')!.value, '客户欧');
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
      payload: { recordingId: 'r21', speaker: 'CSM', transcript: '客户遇到一个报错工单无法使用' }, attributionStatus: 'confirmed' });
    const mcp = fakeOnesMcp({ requiredExtra: [{ uuid: 'extra-1', name: '严重程度' }] });
    const service = new HemoryDraftService(db, mcp);
    const queued = service.enqueue('crm-legacy-o', [event.id]);
    await waitDraftJob(db, queued!.jobId);
    const batch = db.listDraftBatches('crm-legacy-o')[0];
    const ticket = batch.items!.find((item) => item.type === 'ticket')!;
    // 同名回退：fieldValues 使用同名售后客户的 option。
    assert.deepEqual(ticket.targetArguments.fieldValues, [{ fieldID: 'JrvswW8P', value: 'opt-88' }]);
    assert.ok(!ticket.validationErrors.length);
    // 预检发现 get_issue_fields 的额外必填字段未填写。
    const preview = await service.preview(batch.id, [ticket.id]);
    assert.ok(preview.items[0].validationErrors.some((message) => /ONES 必填字段未填写: 严重程度\(extra-1\)/.test(message)));
    // 未解析客户 option 的草稿报可操作错误。
    db.upsertCustomer({ id: 'crm-no-opt', name: '客户宁', sourceObject: 'object_Umwnn__c' });
    const event2 = db.upsertSourceEvent({ customerId: 'crm-no-opt', sourceSystem: 'hemory', sourceType: 'ai_topic_segment', externalId: 'r22:t1:x',
      title: '另一个需求', occurredAt: '2026-08-25T06:00:00Z',
      payload: { recordingId: 'r22', speaker: 'CSM', transcript: '客户提出了新功能需求' }, attributionStatus: 'confirmed' });
    const queued2 = service.enqueue('crm-no-opt', [event2.id]);
    await waitDraftJob(db, queued2!.jobId);
    const batch2 = db.listDraftBatches('crm-no-opt')[0];
    const suggestion2 = batch2.items!.find((item) => item.type === 'suggestion')!;
    assert.ok(suggestion2.validationErrors.some((message) => /客户缺少已确认的 ONES 客户信息 option ID（.*请刷新客户同步.*）/.test(message)));
    assert.equal(suggestion2.status, 'draft');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
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
  ] } }))!;
  assert.equal(fields.length, 4);
  assert.deepEqual(fields[2].options, [{ uuid: 'opt-1', value: '客户一' }]);
  // 自动填充（创建者）与 can_be_created=false 的字段不算缺失；客户信息已提供不缺失。
  const missing = missingOnesRequiredFields(fields, [{ fieldID: 'JrvswW8P', value: 'opt-1' }]);
  assert.equal(missing.length, 0);
  // 客户信息缺值时才报缺失。
  const missing2 = missingOnesRequiredFields(fields, []);
  assert.deepEqual(missing2.map((field) => field.uuid), ['JrvswW8P']);
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

test('workbench: ONES customer option resolves by 客户名称 then 售后客户名称, uniquely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-option-'));
  const db = new WorkbenchDatabase(dir);
  try {
    // 场景一（常态）：客户名称（field_n1qN0__c__r 全称）与 ONES 选项精确一致。
    db.upsertCustomer({ id: 'crm-hd', name: '北京华大九天科技股份有限公司', shortName: '华大九天', sourceObject: 'object_Umwnn__c' });
    const mcp = fakeOnesOptionSearchMcp({
      '北京华大九天科技股份有限公司': [{ uuid: 'BJY0WFZJ', name: '北京华大九天科技股份有限公司' }],
    });
    const sync = new PortfolioSyncService(db, mcp, async () => []);
    const optionId = await (sync as any).resolveOnesCustomerOption(db.getCustomer('crm-hd'));
    assert.equal(optionId, 'BJY0WFZJ');
    const identity = db.listIdentities('crm-hd').find((item) => item.system === 'ones_customer_option');
    assert.equal(identity?.external_id, 'BJY0WFZJ');
    assert.equal(identity?.label, '北京华大九天科技股份有限公司');
    assert.equal(identity?.status, 'confirmed');
    // 客户名称直接命中时不再搜索简称。
    assert.deepEqual(mcp.calls.map((call) => call.args.input), ['北京华大九天科技股份有限公司']);

    // 场景二：客户名称在 ONES 侧搜不到精确选项时，回退搜索售后客户名称（简称），精确唯一命中即可确认。
    db.upsertCustomer({ id: 'crm-ai', name: '北京通用人工智能研究院', shortName: '通用AI研究院', sourceObject: 'object_Umwnn__c' });
    const mcp2 = fakeOnesOptionSearchMcp({
      '北京通用人工智能研究院': [
        { uuid: 'v8Goci1j', name: '北京智源人工智能研究院' },
        { uuid: 'gJDSkP9x', name: '武汉人工智能研究院' },
      ],
      '通用AI研究院': [{ uuid: 'tyy8tinj', name: '通用AI研究院' }],
    });
    const sync2 = new PortfolioSyncService(db, mcp2, async () => []);
    const optionId2 = await (sync2 as any).resolveOnesCustomerOption(db.getCustomer('crm-ai'));
    assert.equal(optionId2, 'tyy8tinj');
    assert.equal(db.listIdentities('crm-ai').find((item) => item.system === 'ones_customer_option')?.external_id, 'tyy8tinj');

    // 场景二b：客户名称与简称都无法精确唯一匹配 → 未归属、落候选事件。
    db.upsertCustomer({ id: 'crm-ai2', name: '某研究院', shortName: '智源', sourceObject: 'object_Umwnn__c' });
    const mcp2b = fakeOnesOptionSearchMcp({
      '某研究院': [],
      '智源': [{ uuid: 'v8Goci1j', name: '智源研究院' }],
    });
    const sync2b = new PortfolioSyncService(db, mcp2b, async () => []);
    const optionId2b = await (sync2b as any).resolveOnesCustomerOption(db.getCustomer('crm-ai2'));
    assert.equal(optionId2b, null);
    assert.equal(db.listIdentities('crm-ai2').filter((item) => item.system === 'ones_customer_option').length, 0);
    assert.ok(db.listSourceEvents('ones', 'customer_option_candidate', 'crm-ai2').length >= 1);

    // 场景三：两个名称都无法精确唯一匹配 → 保持未归属，写候选事件。
    db.upsertCustomer({ id: 'crm-xx', name: '某集团', shortName: '简称客户', sourceObject: 'object_Umwnn__c' });
    const mcp3 = fakeOnesOptionSearchMcp({
      '某集团': [{ uuid: 'opt-b', name: '某集团有限公司' }, { uuid: 'opt-c', name: '某集团股份' }],
      '简称客户': [{ uuid: 'opt-a', name: '简称客户集团' }],
    });
    const sync3 = new PortfolioSyncService(db, mcp3, async () => []);
    const optionId3 = await (sync3 as any).resolveOnesCustomerOption(db.getCustomer('crm-xx'));
    assert.equal(optionId3, null);
    assert.equal(db.listIdentities('crm-xx').filter((item) => item.system === 'ones_customer_option').length, 0);
    const candidates = db.listSourceEvents('ones', 'customer_option_candidate', 'crm-xx');
    assert.ok(candidates.length >= 2, '歧义候选应写入 source_events');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
