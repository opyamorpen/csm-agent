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
  const input = crmCustomer({ _id: 'crm-stage', field_83f4l__c: '阶段客户', field_c0avd__c__r: '续约中', life_status__r: '正常' });
  assert.equal(input?.afterSalesStage, '续约中');
  assert.equal(input?.contractStatus, '正常');
  assert.equal(input?.sourceObject, 'object_Umwnn__c');
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
