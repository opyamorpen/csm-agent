import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { assessRisk } from '../src/workbench/risk.js';
import { buildOnesCustomerQuery, crmCustomer, nextHemorySlot, onesIssueUrl, onesSourceType, parseOnesIssuePage, parseOnesManhourPage, shanghaiDayBounds } from '../src/workbench/sync.js';
import { classifyDraftTypes, HemoryDraftService } from '../src/workbench/drafts.js';
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
  const input = crmCustomer({ _id: 'crm-stage', name: '阶段客户', field_Kt9bI__c: '续约中', life_status: '正常' });
  assert.equal(input?.afterSalesStage, '续约中');
  assert.equal(input?.contractStatus, '正常');
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
