import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { argumentsHash } from '../approval.js';
import { extractText } from '../agent.js';
import type { McpHub } from '../mcp/index.js';
import { shanghaiDateKey, shanghaiIsoOffset } from './sync.js';
import { WorkbenchDatabase } from './database.js';
import type { Customer, DraftBatch, DraftItem, DraftItemType, SourceEvent } from './types.js';

export const DRAFT_GENERATION_VERSION = 'hemory-drafts-v2-day-merge';
const ONES_CUSTOMER_FIELD_ID = process.env.ONES_CUSTOMER_FIELD_ID ?? 'JrvswW8P';
const ONES_DESK_PROJECT_ID = 'GL3ysesFPdnAQNIU';
type OnesDeskDraftType = 'suggestion' | 'ticket' | 'operations';
const ONES_DESK_ISSUE_TYPE_IDS: Record<OnesDeskDraftType, string> = { suggestion: 'A99xMfkg', ticket: '7sxvwZMY', operations: '943qpMX7' };
const ONES_DESK_TARGET_OBJECTS: Record<OnesDeskDraftType, string> = { suggestion: 'ONES Desk / 建议和反馈', ticket: 'ONES Desk / 工单', operations: 'ONES Desk / 运维工单' };
// ONES 工时按实例配置的模式二选一写工具；宽松正则匹配曾把 create_new_issue（描述里带 manhour 字样）误当工时工具。
type OnesWorkhourMode = 'simple' | 'summary';
const ONES_WORKHOUR_TOOLS: Record<OnesWorkhourMode, string> = { simple: 'add_workhour_in_simple_mode', summary: 'add_workhour_in_summary_mode' };
// CRM 跟进记录（销售记录）必须关联的 CSM 售后客户对象；其 _id 是工作台唯一客户主键。
const CRM_AFTER_SALES_OBJECT = 'object_Umwnn__c';
const MAX_DRAFT_ITEMS = 12;

function onesDeskTypeId(type: DraftItemType): OnesDeskDraftType | null {
  return type === 'suggestion' || type === 'ticket' || type === 'operations' ? type : null;
}

// 生成与校验共用的客户 option 解析：本客户 confirmed 身份优先；
// 历史草稿可能绑在 AccountObj 旧行上，按名称唯一复用同名售后客户的身份（与 followup 的 afterSales 回退同构）。
function resolveOnesOption(db: WorkbenchDatabase, customer: Customer): { id: string; label: string } | undefined {
  const find = (id: string) => {
    const identity = db.listIdentities(id).find((item) => item.system === 'ones_customer_option' && item.status === 'confirmed');
    return identity?.external_id ? { id: String(identity.external_id), label: String(identity.label ?? '') } : undefined;
  };
  const own = find(customer.id);
  if (own) return own;
  const sameName = db.listCustomers().filter((item) => item.id !== customer.id && item.name === customer.name);
  return sameName.length === 1 ? find(sameName[0].id) : undefined;
}

interface DraftProposal {
  type: DraftItemType;
  title: string;
  summary: string;
  fields?: Record<string, unknown>;
  evidenceRefs?: string[];
  unknowns?: string[];
}

/** 工时草稿的工具绑定依据：实例工时模式；获取失败时以 error 降级为校验错误。 */
interface WorkhourToolBinding {
  mode: OnesWorkhourMode | null;
  error: string | null;
}

export interface OnesIssueField {
  uuid: string;
  name: string;
  required: boolean;
  builtIn: boolean;
  canBeCreated: boolean;
  fieldTypeUuid: string;
  options: Array<{ uuid: string; value: string }>;
}

// get_issue_fields 返回 {result:'SUCCESS', data:{list:[{uuid,name,required,built_in,can_be_created,field_type_uuid,options:[{uuid,value}]}]}}。
// 解析失败返回 null，调用方保持原有“只看 isError”的行为，不因形状变化阻断预检。
export function parseOnesIssueFields(text: string): OnesIssueField[] | null {
  const value = cleanJson(text) as { result?: unknown; data?: { list?: unknown } } | null;
  const list = Array.isArray(value?.data?.list) ? value.data.list : null;
  if (!list) return null;
  const fields: OnesIssueField[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const uuid = typeof item.uuid === 'string' ? item.uuid : null;
    const name = typeof item.name === 'string' ? item.name : null;
    if (!uuid || !name) return null;
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
        const entry = option && typeof option === 'object' && !Array.isArray(option) ? option as Record<string, unknown> : null;
        const optionUuid = typeof entry?.uuid === 'string' ? entry.uuid : null;
        const optionValue = typeof entry?.value === 'string' ? entry.value : null;
        return optionUuid && optionValue ? [{ uuid: optionUuid, value: optionValue }] : [];
      })
      : [];
    fields.push({ uuid, name, required: item.required === true, builtIn: item.built_in === true,
      canBeCreated: item.can_be_created !== false, fieldTypeUuid: typeof item.field_type_uuid === 'string' ? item.field_type_uuid : '', options });
  }
  return fields;
}

// 平台自动填充的字段（创建者/状态等）不必出现在写参数里。
const ONES_AUTOFILLED_FIELD_TYPES = new Set(['creator', 'status', 'assign']);
// 标题/所属项目/工作项类型由 create_new_issue 的顶层参数（summary/projectID/issueTypeID）满足，
// 描述类必填字段由顶层 description（Hemory 摘要）满足，都不必出现在 fieldValues 中。
const ONES_TOP_LEVEL_FIELD_UUIDS = new Set(['field001', 'field006', 'field007']);
// 建议和反馈等类型上标了 required 但 can_be_created=false 的展示字段（如反馈类型），实际由 ONES 内部规则处理，跳过。
export function missingOnesRequiredFields(fields: OnesIssueField[], fieldValues: Array<Record<string, unknown>>, described = true): OnesIssueField[] {
  const provided = new Set(fieldValues.filter((value) => value.value != null && value.value !== '').map((value) => String(value.fieldID)));
  return fields.filter((field) => field.required && field.canBeCreated
    && !ONES_AUTOFILLED_FIELD_TYPES.has(field.fieldTypeUuid)
    && !ONES_TOP_LEVEL_FIELD_UUIDS.has(field.uuid)
    && !(described && /描述|desc/i.test(field.name))
    && !provided.has(field.uuid));
}

export interface DraftPreview {
  batchId: string;
  items: Array<{ id: string; version: number; approvalHash: string; validationErrors: string[] }>;
}

export interface DraftDisplayField {
  key: string;
  label: string;
  value: string;
}

const ONES_DESK_PROJECT_LABEL = 'ONES Desk';
const ONES_DESK_TYPE_LABELS: Record<OnesDeskDraftType, string> = { suggestion: '建议和反馈', ticket: '工单', operations: '运维工单' };

/**
 * 草稿确认时的最小必填项展示：每种类型一组键值行，Web 卡片与 CLI 共用同一份结构。
 * ONES 工作项按“所属项目 / 工作项类型 / 标题 / 客户信息 / 描述”展示，Hemory 摘要写入描述。
 */
export function draftDisplayFields(db: WorkbenchDatabase, item: DraftItem, customer: Customer): DraftDisplayField[] {
  const unknown = (value: unknown) => value == null || value === '' || value === 'unknown' ? '待补充' : String(value);
  if (onesDeskTypeId(item.type)) {
    const deskType = onesDeskTypeId(item.type)!;
    const option = resolveOnesOption(db, customer);
    return [
      { key: 'project', label: '所属项目', value: `${ONES_DESK_PROJECT_LABEL}（${String(item.targetArguments.projectID ?? '')}）` },
      { key: 'issueType', label: '工作项类型', value: `${ONES_DESK_TYPE_LABELS[deskType]}（${String(item.targetArguments.issueTypeID ?? '')}）` },
      { key: 'title', label: '标题', value: item.title },
      { key: 'customer', label: '客户信息', value: option
        ? option.label && option.label !== customer.name ? `${customer.name} → ${option.label}` : (option.label || customer.name)
        : `${customer.name}（ONES 客户信息未解析）` },
      { key: 'description', label: '描述', value: String(item.targetArguments.description ?? item.summary) },
    ];
  }
  if (item.type === 'workhour') {
    return [
      { key: 'target', label: '目标工作项', value: item.targetArguments.issueID ? `客户工时管理 / 售后客户（${String(item.targetArguments.issueID)}）` : '客户工时管理 / 售后客户（未绑定）' },
      { key: 'hours', label: '工时时长', value: unknown(item.targetArguments.hours) },
      { key: 'startTime', label: '开始时间', value: String(item.targetArguments.startTime ?? '') },
      { key: 'description', label: '描述', value: String(item.targetArguments.description ?? item.summary) },
    ];
  }
  if (item.type === 'followup') {
    const objectData = item.targetArguments.object_data as Record<string, unknown> | undefined;
    const related = Array.isArray(objectData?.related_object_data) ? objectData.related_object_data as Array<Record<string, unknown>> : [];
    const bound = related.find((entry) => entry?.describe_api_name === CRM_AFTER_SALES_OBJECT);
    return [
      { key: 'target', label: '目标对象', value: 'CRM / 销售记录（跟进）' },
      { key: 'customer', label: '关联客户', value: bound ? `${String(bound.name ?? '')}（${String(bound.id ?? '')}）` : '未绑定 CRM 售后客户' },
      { key: 'title', label: '标题', value: item.title },
      { key: 'summary', label: '当日一句话', value: unknown(String(item.fields?.one_line_summary ?? '')) },
      { key: 'content', label: '跟进内容', value: String(objectData?.active_record_content ?? item.summary) },
    ];
  }
  return [
    { key: 'target', label: '目标', value: item.targetObject },
    { key: 'title', label: '标题', value: item.title },
    { key: 'owner', label: '负责人', value: unknown(item.targetArguments.owner) },
    { key: 'dueAt', label: '截止时间', value: unknown(item.targetArguments.dueAt) },
    { key: 'whyNow', label: '待办背景', value: String(item.targetArguments.whyNow ?? item.summary) },
  ];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function textOf(event: SourceEvent): string {
  return String(event.payload?.transcript ?? event.title);
}

function cleanJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* inspect embedded JSON below */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* invalid model output */ }
  }
  return null;
}

export function classifyDraftTypes(events: SourceEvent[]): DraftItemType[] {
  const text = events.map(textOf).join('\n');
  const types = new Set<DraftItemType>(['followup']);
  if (/(待办|需要|请.{0,12}(负责|跟进|准备|确认)|下周|月底|之前.{0,12}(完成|给到)|action\s*item|todo)/i.test(text)) types.add('internal_todo');
  if (/(工时|小时|人天|投入.{0,8}(时间|天)|耗时|花了.{0,8}(小时|天))/i.test(text)) types.add('workhour');
  if (/(需求|建议|希望|需要.{0,20}(功能|能力|模块|支持)|优化|增购|扩容)/i.test(text)) types.add('suggestion');
  if (/(工单|故障|报错|异常|无法|失败|阻塞|投诉|不可用)/i.test(text)) types.add('ticket');
  if (/(运维|部署|升级|巡检|迁移|上线变更)/i.test(text)) types.add('operations');
  return [...types];
}

function defaultProposal(type: DraftItemType, customer: Customer, events: SourceEvent[]): DraftProposal {
  const quote = events.map(textOf).join('；').slice(0, 1200);
  const first = events[0];
  const dateKey = events.length ? shanghaiEventDate(events[0]) : shanghaiDateKey();
  const base = { evidence_quotes: events.map(textOf), occurred_at: first?.occurredAt ?? new Date().toISOString() };
  const topics = events.map((event) => event.title);
  const speakers = [...new Set(events.flatMap((event) => (Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : []).filter(Boolean)))];
  if (type === 'internal_todo') return { type, title: first?.title.slice(0, 100) || `跟进 ${customer.name}`,
    summary: quote, fields: { ...base, owner: 'unknown', due_at: 'unknown', expected_outcome: 'unknown' }, unknowns: ['负责人', '截止时间'] };
  if (type === 'workhour') return { type, title: `${customer.name} ${dateKey} 客户沟通工时`, summary: quote,
    fields: { ...base, hours: 'unknown', description: quote, date_key: dateKey }, unknowns: ['工时时长'] };
  if (type === 'suggestion') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户需求`, summary: quote,
    fields: { ...base, description: quote }, unknowns: [] };
  if (type === 'ticket') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户工单`, summary: quote,
    fields: { ...base, description: quote, severity: 'unknown' }, unknowns: ['严重程度'] };
  if (type === 'operations') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户运维事项`, summary: quote,
    fields: { ...base, description: quote, severity: 'unknown' }, unknowns: ['严重程度'] };
  // followup：天粒度合并——全天片段按【话题】分节汇总，标题带日期。
  return { type, title: `${customer.name} ${dateKey} 沟通记录`,
    summary: events.map((event) => `【${event.title}】\n${textOf(event)}`).join('\n\n').slice(0, 3000),
    fields: { ...base, date_key: dateKey, method: '会议', participants: speakers, key_topics: topics,
      one_line_summary: `与${customer.name}就${topics.slice(0, 3).join('、')}等进行沟通`, next_steps: 'unknown' }, unknowns: ['下一步计划'] };
}

async function proposeWithModel(runtime: Runtime, customer: Customer, events: SourceEvent[], unpublishedEvents: SourceEvent[]): Promise<DraftProposal[]> {
  const unpublished = new Set(unpublishedEvents.map((event) => event.id));
  const evidence = events.map((event) => ({ id: event.id, occurred_at: event.occurredAt,
    published: !unpublished.has(event.id),
    speakers: Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : [], text: textOf(event) }));
  const prompt = `为客户当天的全部沟通片段生成结构化草稿。只允许类型 internal_todo、workhour、followup、suggestion、ticket、operations。\n`
    + `followup（沟通记录）必须且只能输出一条：合并当天全部 published=false 的片段，按话题分节汇总全天沟通；其 fields 必须包含 one_line_summary（一句话总结当天沟通）。published=true 的片段已写入 CRM，禁止纳入 followup。\n`
    + `workhour 不必输出（系统按录音时长自动计算并连带生成）。其他类型同一类型可以输出多条草稿，但每条必须对应独立的话题或行动；只返回有证据支持的草稿。\n`
    + `每条草稿的 evidence_refs 必须列出它依据的证据 id。不得猜测负责人、日期、时长或事实，缺失值写 "unknown" 并列入 unknowns。\n`
    + `只输出 JSON：{"drafts":[{"type":"...","title":"...","summary":"...","fields":{},"evidence_refs":["..."],"unknowns":[]}]}。\n`
    + `客户：${customer.name}（CRM ${customer.id}）\n证据：${JSON.stringify(evidence)}`;
  const response = await runtime.models.complete(runtime.model, {
    systemPrompt: '你是 CSM 草稿分类器。你只能整理用户提供的证据，不执行任何工具或外部写入。',
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    tools: [],
  });
  const value = cleanJson(extractText(response.content)) as { drafts?: unknown[] } | null;
  if (!Array.isArray(value?.drafts)) throw new Error('模型未返回 drafts 数组');
  const allowed = new Set<DraftItemType>(['internal_todo', 'workhour', 'followup', 'suggestion', 'ticket', 'operations']);
  return value.drafts.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    if (!allowed.has(item.type as DraftItemType) || typeof item.title !== 'string' || typeof item.summary !== 'string') return [];
    return [{ type: item.type as DraftItemType, title: item.title, summary: item.summary,
      fields: item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields) ? item.fields as Record<string, unknown> : {},
      evidenceRefs: Array.isArray(item.evidence_refs) ? item.evidence_refs.map(String) : undefined,
      unknowns: Array.isArray(item.unknowns) ? item.unknowns.map(String) : [] }];
  });
}

/** 片段所属上海自然日；occurred_at 无效时按当前日期兜底。 */
export function shanghaiEventDate(event: SourceEvent): string {
  const at = new Date(event.occurredAt);
  return shanghaiDateKey(Number.isNaN(at.getTime()) ? new Date() : at);
}

/** 天粒度指纹：同客户同日同片段集合（含内容 hash）复用同一批次，新增/变化片段自然换指纹重建。 */
export function draftFingerprint(customerId: string, dateKey: string, events: SourceEvent[]): string {
  const sources = [...events].sort((a, b) => a.id.localeCompare(b.id)).map((event) => `${event.id}:${event.payloadHash}`);
  return hash(`${DRAFT_GENERATION_VERSION}:${customerId}:${dateKey}:${sources.join('|')}`);
}

export function sortedDraftEvents(events: SourceEvent[]): SourceEvent[] {
  return [...events].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 从片段自带的录音时间计算当天沟通工时：按录音聚合该客户片段的首尾时刻求跨度，跨录音求和（小时，1 位小数）。
 * 任一录音缺 recordingId/时间数据或跨度为零时返回 null，交由“请补充工时时长”校验路径人工处理。
 */
export function computeWorkhours(events: SourceEvent[]): number | null {
  const spans = new Map<string, { start: number; end: number }>();
  for (const event of events) {
    const recordingId = String(event.payload?.recordingId ?? '');
    if (!recordingId) return null;
    const start = new Date(String(event.payload?.startAt ?? event.occurredAt)).getTime();
    const end = new Date(String(event.payload?.endAt ?? event.occurredAt)).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const current = spans.get(recordingId);
    spans.set(recordingId, current ? { start: Math.min(current.start, start), end: Math.max(current.end, end) } : { start, end });
  }
  if (!spans.size) return null;
  let total = 0;
  for (const span of spans.values()) {
    if (span.end <= span.start) return null;
    total += span.end - span.start;
  }
  const hours = Math.round((total / 3_600_000) * 10) / 10;
  return hours > 0 ? hours : null;
}

export class HemoryDraftService {
  private processing = new Set<string>();

  constructor(private readonly db: WorkbenchDatabase, private readonly mcp: McpHub, private readonly runtime?: Runtime) {}

  /** 按客户 + 上海自然日入队：跨天归属每天一个批次；返回当天（各天）的生成任务。 */
  enqueue(customerId: string, eventIds: string[]): Array<{ jobId: string; fingerprint: string }> {
    const events = this.confirmedSegments(customerId, eventIds);
    if (!events.length) return [];
    const days = [...new Set(events.map((event) => shanghaiEventDate(event)))];
    return days.map((dateKey) => this.generateForDay(customerId, dateKey, false))
      .filter((job): job is { jobId: string; fingerprint: string } => !!job);
  }

  regenerate(batchId: string): Array<{ jobId: string; fingerprint: string }> {
    const batch = this.db.getDraftBatch(batchId);
    if (!batch) throw new Error('draft batch not found');
    const days = new Set<string>();
    for (const id of batch.sourceEventIds) {
      const event = this.db.getSourceEvent(id);
      if (event && event.customerId === batch.customerId) days.add(shanghaiEventDate(event));
    }
    if (!days.size) throw new Error('批次没有仍归属于该客户的 Hemory 片段');
    return [...days].map((dateKey) => this.generateForDay(batch.customerId, dateKey, true))
      .filter((job): job is { jobId: string; fingerprint: string } => !!job);
  }

  private confirmedSegments(customerId: string, eventIds: string[]): SourceEvent[] {
    // 停用片段不得再生草稿：重切后被取代的 v1 片段即使仍是 confirmed 也已经不属于当前代际。
    return [...new Set(eventIds)].map((id) => this.db.getSourceEvent(id)).filter((event): event is SourceEvent =>
      !!event && event.customerId === customerId && event.attributionStatus === 'confirmed'
      && event.sourceSystem === 'hemory' && event.sourceType === 'ai_topic_segment' && this.db.isHemoryFragmentActive(event.id));
  }

  // 天粒度批次：同客户同日一条合并沟通记录 + 一条连带工时；旧录音级批次会被同日重建自然取代。
  private generateForDay(customerId: string, dateKey: string, force: boolean): { jobId: string; fingerprint: string } | null {
    const events = this.db.listConfirmedHemorySegmentsForDay(customerId, dateKey);
    if (!events.length) return null;
    const fingerprint = draftFingerprint(customerId, dateKey, events);
    const existing = this.db.findDraftBatchByFingerprint(fingerprint);
    if (existing && !force && existing.status !== 'stale') {
      // 同一天片段集合已有可用批次时保持幂等，直接复用原任务；只有批次已作废才需要换盐重新生成。
      return { jobId: this.db.findDraftJobByFingerprint(fingerprint)?.id ?? '', fingerprint };
    }
    this.db.markDraftsStaleForEvents(events.map((event) => event.id));
    const finalFingerprint = existing || force
      ? hash(`${fingerprint}:regenerate:${Date.now()}:${Math.random()}`)
      : fingerprint;
    return this.createGenerationJob(customerId, events, finalFingerprint);
  }

  private createGenerationJob(customerId: string, events: SourceEvent[], fingerprint: string): { jobId: string; fingerprint: string } {
    const job = this.db.createDraftJob(customerId, fingerprint, events.map((event) => event.id));
    if (job.status !== 'succeeded') void this.process(job.id);
    return { jobId: job.id, fingerprint };
  }

  resumePending(): void {
    for (const job of this.db.listPendingDraftJobs()) if (job.attempts < 3) void this.process(job.id);
  }

  private async process(jobId: string): Promise<void> {
    if (this.processing.has(jobId)) return;
    const job = this.db.getDraftJob(jobId);
    if (!job || job.status === 'succeeded') return;
    this.processing.add(jobId);
    this.db.updateDraftJob(jobId, 'running');
    try {
      const customer = this.db.getCustomer(job.customerId);
      if (!customer) throw new Error('customer not found');
      const seeded = job.sourceEventIds.map((id) => this.db.getSourceEvent(id))
        .filter((event): event is SourceEvent => !!event && event.customerId === customer.id);
      if (!seeded.length) throw new Error('没有仍归属于该客户的 Hemory 片段');
      // 以任务种子推导上海日后取当天全部已确认活跃片段：任务排队期间新归属的同日片段也会并入。
      const dateKey = shanghaiEventDate(seeded[0]);
      const events = this.db.listConfirmedHemorySegmentsForDay(customer.id, dateKey);
      if (!events.length) throw new Error('没有仍归属于该客户的 Hemory 片段');
      // 发布豁免：当天已写入 CRM 的沟通（工作台确认的草稿或 CRM 已有跟进记录）之后才算新沟通。
      const cutoff = this.db.followupPublishedCutoff(customer.id, dateKey);
      const followupEvents = cutoff
        ? events.filter((event) => new Date(event.occurredAt).getTime() > new Date(cutoff).getTime())
        : events;
      let ai: DraftProposal[] = [];
      let generator = 'rules';
      if (this.runtime) {
        try { ai = await proposeWithModel(this.runtime, customer, events, followupEvents); generator = `${this.runtime.llm.provider}/${this.runtime.llm.model}`; }
        catch (error) { generator = `rules-fallback: ${(error as Error).message}`.slice(0, 160); }
      }
      const proposals = this.buildProposals(ai, customer, events, followupEvents, dateKey);
      // 工时草稿的写工具按 ONES 实例工时模式绑定；模式获取失败只降级为该草稿的校验错误，不拖垮整个生成任务。
      let workhourBinding: WorkhourToolBinding = { mode: null, error: null };
      if (proposals.some((proposal) => proposal.type === 'workhour')) {
        const issue = this.db.listTimeline(customer.id, 500).find((event) => event.sourceSystem === 'ones' && event.sourceType === 'customer_manhour');
        if (issue) {
          try {
            const mode = await this.fetchWorkhourMode(issue.externalId);
            workhourBinding = mode ? { mode, error: null } : { mode: null, error: '无法识别 ONES 工时模式（simple/summary），请稍后重新生成' };
          } catch (error) {
            workhourBinding = { mode: null, error: `无法获取 ONES 工时模式: ${(error as Error).message.slice(0, 160)}` };
          }
        }
      }
      const batch = this.db.createDraftBatch({ customerId: customer.id, fingerprint: job.fingerprint,
        sourceEventIds: events.map((event) => event.id), generationVersion: DRAFT_GENERATION_VERSION, generator });
      // 同客户同日只保留一个活跃批次：临创建前作废包含当天片段的其他批次（含并发任务先建者），已写入项不受影响。
      this.db.markDraftsStaleForEvents(events.map((event) => event.id), batch.id);
      if (!batch.items?.length) {
        for (const proposal of proposals) this.createItem(batch, customer, events, proposal, workhourBinding);
      }
      this.db.refreshDraftBatchStatus(batch.id);
      this.db.updateDraftJob(jobId, 'succeeded');
      this.db.audit('agent', 'generate_hemory_drafts', 'draft_batch', batch.id, { customerId: customer.id, sourceEventIds: batch.sourceEventIds, generator, dateKey, followupEventIds: followupEvents.map((event) => event.id) });
    } catch (error) {
      this.db.updateDraftJob(jobId, 'failed', (error as Error).message);
    } finally {
      this.processing.delete(jobId);
    }
  }

  /**
   * 最终提案集合：followup 恒为一条（合并当天全部未发布沟通），有 followup 就连带一条 workhour（录音时长 + 一句话描述）；
   * 其余类型沿用 LLM 提案与关键词兜底，可多条。
   */
  private buildProposals(ai: DraftProposal[], customer: Customer, events: SourceEvent[], followupEvents: SourceEvent[], dateKey: string): DraftProposal[] {
    const proposals: DraftProposal[] = [];
    if (followupEvents.length) {
      const followup = this.mergedFollowupProposal(ai, customer, followupEvents, dateKey);
      proposals.push(followup, this.workhourProposal(customer, followupEvents, dateKey, followup));
    }
    const seen = new Set<string>();
    for (const proposal of ai) {
      if (proposal.type === 'followup' || proposal.type === 'workhour') continue; // 这两类结构化生成，不信任模型多条输出
      const key = `${proposal.type}::${proposal.title}`;
      if (seen.has(key) || proposals.length >= MAX_DRAFT_ITEMS) continue;
      seen.add(key);
      proposals.push(proposal);
    }
    const covered = new Set(proposals.map((proposal) => proposal.type));
    for (const type of classifyDraftTypes(events)) {
      if (type === 'followup' || type === 'workhour') continue;
      if (covered.has(type) || proposals.length >= MAX_DRAFT_ITEMS) continue;
      proposals.push(defaultProposal(type, customer, events));
      covered.add(type);
    }
    return proposals;
  }

  private mergedFollowupProposal(ai: DraftProposal[], customer: Customer, followupEvents: SourceEvent[], dateKey: string): DraftProposal {
    const ids = new Set(followupEvents.map((event) => event.id));
    // 只采信证据仍落在未发布范围内的 LLM 提案，已发布内容绝不重复汇总。
    const valid = ai.filter((proposal) => proposal.type === 'followup'
      && (proposal.evidenceRefs ?? []).some((id) => ids.has(id)));
    const oneLine = valid.map((proposal) => String(proposal.fields?.one_line_summary ?? '')).find(Boolean)
      ?? `与${customer.name}就${followupEvents.map((event) => event.title).slice(0, 3).join('、')}等进行沟通`;
    // 每个片段一节：优先用 LLM 对该片段的摘要，无命中时回退片段原文，保证全天覆盖无遗漏。
    const sections = followupEvents.map((event) => {
      const own = valid.find((proposal) => (proposal.evidenceRefs ?? []).includes(event.id));
      return `【${event.title}】\n${own ? own.summary : textOf(event)}`;
    });
    const speakers = [...new Set(followupEvents.flatMap((event) =>
      (Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : []).filter(Boolean)))];
    return { type: 'followup', title: `${customer.name} ${dateKey} 沟通记录`, summary: sections.join('\n\n').slice(0, 3000),
      fields: { date_key: dateKey, method: '会议', participants: speakers,
        key_topics: followupEvents.map((event) => event.title), one_line_summary: oneLine, next_steps: 'unknown' },
      evidenceRefs: followupEvents.map((event) => event.id), unknowns: ['下一步计划'] };
  }

  private workhourProposal(customer: Customer, followupEvents: SourceEvent[], dateKey: string, followup: DraftProposal): DraftProposal {
    const hours = computeWorkhours(followupEvents);
    const description = String(followup.fields?.one_line_summary ?? followup.summary).slice(0, 300);
    return { type: 'workhour', title: `${customer.name} ${dateKey} 客户沟通工时`, summary: description,
      fields: { date_key: dateKey, hours: hours == null ? 'unknown' : hours, description },
      evidenceRefs: followupEvents.map((event) => event.id),
      unknowns: hours == null ? ['工时时长（录音时间缺失，请人工补充）'] : [] };
  }

  private createItem(batch: DraftBatch, customer: Customer, events: SourceEvent[], proposal: DraftProposal, workhourBinding?: WorkhourToolBinding): DraftItem {
    const available = new Map(events.map((event) => [event.id, event]));
    const itemEvents = (proposal.evidenceRefs ?? []).flatMap((id) => {
      const event = available.get(id);
      return event ? [event] : [];
    });
    // 证据引用缺失或不合法时回退到整批事件，避免草稿失去 evidence_refs。
    const evidence = itemEvents.length ? [...itemEvents].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) : events;
    const evidenceRefs = evidence.map((event) => event.id);
    const fields = { ...(proposal.fields ?? {}), customer_id: customer.id, customer_name: customer.name,
      evidence_refs: evidenceRefs, evidence_quotes: evidence.map(textOf), occurred_at: evidence[0]?.occurredAt ?? new Date().toISOString() };
    const target = this.buildTarget(proposal.type, customer, evidence, proposal, fields, workhourBinding);
    return this.db.createDraftItem({ batchId: batch.id, customerId: customer.id, type: proposal.type,
      status: target.validationErrors.length ? 'draft' : 'ready', title: proposal.title.slice(0, 160), summary: proposal.summary,
      fields, targetSystem: target.system, targetObject: target.object, targetTool: target.tool,
      targetArguments: target.arguments, evidenceRefs, unknowns: proposal.unknowns ?? [], validationErrors: target.validationErrors });
  }

  /** rawName 精确匹配已连接工具；工时/跟进等强契约写入不允许宽松正则误绑。 */
  private exactTool(server: string, rawName: string): string | null {
    return this.mcp.listTools().find((tool) => tool.server === server && tool.rawName === rawName)?.publicName ?? null;
  }

  private findWriteTool(serverHint: string, pattern: RegExp): string | null {
    const candidates = this.mcp.listTools().filter((tool) => (tool.server.toLowerCase().includes(serverHint) || tool.publicName.toLowerCase().includes(serverHint))
      && pattern.test(`${tool.rawName} ${tool.description}`) && this.mcp.isWrite(tool.server, tool.rawName)
      // describe/query 类工具名字里可能带 create（如 get-create-form），只描述表单不写数据，必须排除。
      && !/^(data_)?(describe|query|get|search|list|approval)/i.test(tool.rawName));
    return candidates[0]?.publicName ?? null;
  }

  private findReadTool(serverHint: string, pattern: RegExp): string | null {
    const candidates = this.mcp.listTools().filter((tool) => (tool.server.toLowerCase().includes(serverHint) || tool.publicName.toLowerCase().includes(serverHint))
      && pattern.test(`${tool.rawName} ${tool.description}`) && !this.mcp.isWrite(tool.server, tool.rawName));
    return candidates[0]?.publicName ?? null;
  }

  /** 查询 ONES 实例工时模式；工具缺失或调用报错时抛错，返回值无法识别时为 null，均由调用方降级为校验错误。 */
  private async fetchWorkhourMode(issueId: string): Promise<OnesWorkhourMode | null> {
    const tool = this.findReadTool('ones', /(get.*manhour.*mode|manhour.*mode|工时.*模式)/i);
    if (!tool) throw new Error('未找到 ONES 工时模式查询工具');
    const response = await this.mcp.call(tool, { issueID: issueId });
    if (response.isError) throw new Error(response.text.slice(0, 300));
    const mode = String((cleanJson(response.text) as { result?: unknown } | null)?.result ?? '');
    return mode === 'simple' || mode === 'summary' ? mode : null;
  }

  private buildTarget(type: DraftItemType, customer: Customer, events: SourceEvent[], proposal: DraftProposal, fields: Record<string, unknown>, workhourBinding?: WorkhourToolBinding) {
    const validationErrors: string[] = [];
    if (type === 'internal_todo') return { system: 'local' as const, object: 'CSM Agent / 待办', tool: 'local__create_action_item',
      arguments: { title: proposal.title, whyNow: proposal.summary, owner: fields.owner === 'unknown' ? null : fields.owner ?? null,
        dueAt: fields.due_at === 'unknown' ? null : fields.due_at, expectedOutcome: fields.expected_outcome === 'unknown' ? null : fields.expected_outcome ?? null,
        evidenceRefs: events.map((event) => event.id), sourceMeetingId: events[0]?.payload?.recordingId ?? null }, validationErrors };
    if (type === 'followup') {
      // CRM 跟进记录的真实写路径是通用记录创建工具 data_record_create（执行标识 CreateRecordsByData），
      // 写入销售记录对象 ActiveRecordObj；关联业务对象必须是 CSM 售后客户（object_Umwnn__c）。
      const exact = this.exactTool('crm', 'data_record_create');
      const tool = exact ?? this.findWriteTool('crm', /(record.*create|create.*record|跟进)/i);
      if (!tool) validationErrors.push('未找到 CRM 跟进记录写工具');
      // 客户主键就是售后客户对象的 _id；历史客户可能来自 AccountObj，按名称唯一解析同名售后客户后使用其 _id。
      let afterSales: { id: string; name: string } | undefined
        = customer.sourceObject === CRM_AFTER_SALES_OBJECT ? { id: customer.id, name: customer.name } : undefined;
      if (!afterSales) {
        // listCustomers 只返回售后客户对象（object_Umwnn__c）且已排除流失；同名唯一时复用其 _id。
        const matches = this.db.listCustomers().filter((item) => item.id !== customer.id && item.name === customer.name);
        if (matches.length === 1) afterSales = { id: matches[0].id, name: matches[0].name };
      }
      if (!afterSales) validationErrors.push('客户未解析到 CRM 售后客户（object_Umwnn__c）记录，无法绑定跟进关联');
      // ActiveRecordObj 必填：服务开始/结束时间（覆盖片段首尾时刻）、渠道（线上）、关联业务对象、跟进类型（常规客情维护）。
      const times = events.map((event) => new Date(event.occurredAt).getTime()).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      const startAt = times.length ? new Date(times[0]).toISOString() : new Date().toISOString();
      const endAt = times.length ? new Date(times.at(-1)!).toISOString() : startAt;
      const objectData: Record<string, unknown> = {
        active_record_content: `${proposal.title}\n${proposal.summary}`,
        field_oUaZx__c: startAt,
        field_wYlhw__c: endAt,
        field_MIe19__c: 'option1',
        related_api_names: [CRM_AFTER_SALES_OBJECT],
        active_record_type: '1cbaf4b4110c4a9d836867492e833d9e',
        related_object_data: afterSales ? [{ describe_api_name: CRM_AFTER_SALES_OBJECT, id: afterSales.id, name: afterSales.name }] : [],
      };
      if (fields.next_steps && fields.next_steps !== 'unknown') objectData.field_9qb16__c = String(fields.next_steps);
      return { system: 'crm' as const, object: 'CRM / 销售记录（跟进）', tool,
        arguments: { apiName: 'CreateRecordsByData', object_api_name: 'ActiveRecordObj', object_data: objectData }, validationErrors };
    }
    if (type === 'workhour') {
      const manhour = this.db.listTimeline(customer.id, 500).find((event) => event.sourceSystem === 'ones' && event.sourceType === 'customer_manhour');
      // 工具按实例模式 rawName 精确绑定：宽松正则曾把描述里带 manhour 字样的 create_new_issue 误当工时工具。
      const tool = workhourBinding?.mode ? this.exactTool('ones', ONES_WORKHOUR_TOOLS[workhourBinding.mode]) : null;
      if (!manhour) validationErrors.push('客户未绑定“客户工时管理 / 售后客户”工作项');
      else {
        if (workhourBinding?.error) validationErrors.push(workhourBinding.error);
        if (!tool) validationErrors.push('未找到 ONES 工时登记写工具');
      }
      if (fields.hours === 'unknown' || fields.hours == null) validationErrors.push('请补充工时时长');
      // ONES 工时登记要求 startTime 为带时区偏移的 ISO 8601（如 2026-08-26T14:30:00+08:00），取当天未发布沟通的最早时刻。
      const startAt = new Date(String(fields.occurred_at ?? (events.length ? events[0].occurredAt : new Date().toISOString())));
      return { system: 'ones' as const, object: '客户工时管理 / 售后客户', tool,
        arguments: { issueID: manhour?.externalId ?? '', hours: fields.hours,
          startTime: shanghaiIsoOffset(Number.isNaN(startAt.getTime()) ? new Date() : startAt),
          description: String(fields.description ?? proposal.summary) }, validationErrors };
    }
    const deskType = onesDeskTypeId(type);
    if (!deskType) throw new Error(`未知的草稿目标类型: ${type}`);
    const option = resolveOnesOption(this.db, customer);
    const tool = this.findWriteTool('ones', /(create.*issue|issue.*create|新建.*工作项)/i);
    if (!option) {
      const hint = this.db.listSourceEvents('ones', 'customer_option_candidate', customer.id).length
        ? 'ONES 已有待确认的客户选项，请刷新客户同步以按关联主体名重新解析'
        : '未在 ONES 客户信息选项中找到与客户名或关联主体名精确唯一的匹配，请刷新客户同步';
      validationErrors.push(`客户缺少已确认的 ONES 客户信息 option ID（${hint}）`);
    }
    if (!tool) validationErrors.push('未找到 ONES 新建工作项写工具');
    return { system: 'ones' as const, object: ONES_DESK_TARGET_OBJECTS[deskType], tool,
      arguments: { projectID: ONES_DESK_PROJECT_ID, issueTypeID: ONES_DESK_ISSUE_TYPE_IDS[deskType], summary: proposal.title, description: proposal.summary,
        fieldValues: option ? [{ fieldID: ONES_CUSTOMER_FIELD_ID, value: option.id }] : [] }, validationErrors };
  }

  private validate(item: DraftItem): string[] {
    const errors: string[] = [];
    const customer = this.db.getCustomer(item.customerId);
    if (!customer) return ['customer not found'];
    if (item.fields.customer_id !== customer.id || item.fields.customer_name !== customer.name) errors.push('草稿客户身份与绑定客户不一致');
    if (item.targetSystem === 'local') {
      if (item.type !== 'internal_todo' || item.targetTool !== 'local__create_action_item') errors.push('本地待办目标无效');
      return errors;
    }
    if (!item.targetTool) errors.push('缺少目标写工具');
    else {
      const target = this.mcp.resolve(item.targetTool);
      if (!target || !this.mcp.isWrite(target.server, target.rawName)) errors.push('目标工具不是当前已连接的写工具');
    }
    if (item.type === 'followup') {
      const objectData = item.targetArguments.object_data as Record<string, unknown> | undefined;
      const related = Array.isArray(objectData?.related_object_data) ? objectData.related_object_data as Array<Record<string, unknown>> : [];
      const binding = related.find((entry) => entry?.describe_api_name === CRM_AFTER_SALES_OBJECT);
      const boundCustomer = binding ? this.db.getCustomer(String(binding.id)) : undefined;
      if (!binding || !boundCustomer || boundCustomer.sourceObject !== CRM_AFTER_SALES_OBJECT || boundCustomer.name !== customer.name) {
        errors.push('CRM 回写必须关联当前客户的 CRM 售后客户（object_Umwnn__c）记录');
      }
    }
    if (item.type === 'workhour') {
      const issue = this.db.listTimeline(customer.id, 500).find((event) => event.sourceSystem === 'ones' && event.sourceType === 'customer_manhour');
      if (!issue || item.targetArguments.issueID !== issue.externalId) errors.push('工时参数未绑定当前客户售后工时工作项');
      if (item.targetArguments.hours === 'unknown' || item.targetArguments.hours == null) errors.push('请补充工时时长');
      // 历史草稿曾误绑 create_new_issue：只有两个模式化工时工具是合法写目标。
      const rawName = item.targetTool ? this.mcp.resolve(item.targetTool)?.rawName : null;
      if (rawName !== ONES_WORKHOUR_TOOLS.simple && rawName !== ONES_WORKHOUR_TOOLS.summary) {
        errors.push('工时草稿未绑定 ONES 工时登记工具（add_workhour_in_*_mode），请编辑修正或重新生成');
      }
      if (!item.targetArguments.startTime) errors.push('缺少工时开始时间（startTime，ISO 8601 带时区）');
    }
    if (item.type === 'suggestion' || item.type === 'ticket' || item.type === 'operations') {
      const option = resolveOnesOption(this.db, customer);
      const values = Array.isArray(item.targetArguments.fieldValues) ? item.targetArguments.fieldValues as Array<Record<string, unknown>> : [];
      if (!option || !values.some((value) => value.fieldID === ONES_CUSTOMER_FIELD_ID && value.value === option.id)) errors.push(`ONES 工作项必须包含当前客户字段 ${ONES_CUSTOMER_FIELD_ID}`);
    }
    return errors;
  }

  private async preflight(item: DraftItem, errors: string[]): Promise<void> {
    if (item.type === 'suggestion' || item.type === 'ticket' || item.type === 'operations') {
      const tool = this.findReadTool('ones', /(get.*issue.*fields|issue.*fields|工作项.*字段)/i);
      if (!tool) errors.push('未找到 ONES 工作项字段查询工具');
      else {
        const response = await this.mcp.call(tool, { projectID: ONES_DESK_PROJECT_ID, issueTypeID: onesDeskTypeId(item.type)! });
        if (response.isError) errors.push(`ONES 字段预检失败: ${response.text.slice(0, 300)}`);
        else {
          // 最小必填项校验：标题/项目/类型/描述由 create_new_issue 顶层参数满足，其余必填项必须出现在 fieldValues。
          const fields = parseOnesIssueFields(response.text);
          if (fields) {
            const values = Array.isArray(item.targetArguments.fieldValues) ? item.targetArguments.fieldValues as Array<Record<string, unknown>> : [];
            const missing = missingOnesRequiredFields(fields, values, String(item.targetArguments.description ?? '') !== '');
            if (missing.length) errors.push(`ONES 必填字段未填写: ${missing.map((field) => `${field.name}(${field.uuid})`).join('、')}`);
          }
        }
      }
    }
    if (item.type === 'workhour') {
      const tool = this.findReadTool('ones', /(get.*manhour.*mode|manhour.*mode|工时.*模式)/i);
      if (!tool) errors.push('未找到 ONES 工时模式查询工具');
      else {
        const response = await this.mcp.call(tool, { issueID: item.targetArguments.issueID });
        if (response.isError) errors.push(`ONES 工时模式预检失败: ${response.text.slice(0, 300)}`);
        else {
          // 绑定工具必须与实例当前模式一致（simple/summary 各有专属写工具），不一致宁可拒绝也不让 ONES 端报错。
          const mode = String((cleanJson(response.text) as { result?: unknown } | null)?.result ?? '');
          const rawName = item.targetTool ? this.mcp.resolve(item.targetTool)?.rawName : null;
          if ((mode === 'simple' || mode === 'summary') && rawName && rawName !== ONES_WORKHOUR_TOOLS[mode]) {
            errors.push(`ONES 工时模式（${mode}）与草稿绑定工具不一致，请重新生成`);
          }
        }
      }
    }
  }

  async preview(batchId: string, itemIds: string[]): Promise<DraftPreview> {
    const batch = this.db.getDraftBatch(batchId);
    if (!batch) throw new Error('draft batch not found');
    const selected = new Set(itemIds);
    const items = (batch.items ?? []).filter((item) => selected.has(item.id));
    if (!items.length) throw new Error('未选择可确认草稿');
    const previews: DraftPreview['items'] = [];
    for (const item of items) {
      const validationErrors = this.validate(item);
      if (!validationErrors.length && item.targetSystem === 'ones') await this.preflight(item, validationErrors);
      previews.push({ id: item.id, version: item.version,
        approvalHash: argumentsHash({ draftId: item.id, version: item.version, targetTool: item.targetTool, targetArguments: item.targetArguments }),
        validationErrors });
    }
    return { batchId, items: previews };
  }

  async confirm(batchId: string, approvals: Array<{ id: string; version: number; approvalHash: string }>): Promise<{ items: DraftItem[] }> {
    const preview = await this.preview(batchId, approvals.map((item) => item.id));
    const byId = new Map(approvals.map((item) => [item.id, item]));
    for (const item of preview.items) {
      const supplied = byId.get(item.id);
      if (!supplied || supplied.version !== item.version || supplied.approvalHash !== item.approvalHash) throw new Error(`草稿 ${item.id} 已变化，请重新预览`);
      if (item.validationErrors.length) throw new Error(`草稿 ${item.id} 不可写入: ${item.validationErrors.join('；')}`);
    }
    const results: DraftItem[] = [];
    for (const approved of approvals) results.push(await this.execute(approved.id, approved.approvalHash));
    return { items: results };
  }

  async retry(itemId: string): Promise<DraftItem> {
    const item = this.db.getDraftItem(itemId);
    if (!item || item.status !== 'failed' || !item.approvalHash) throw new Error('只有参数未变化的失败草稿可以重试');
    const expected = argumentsHash({ draftId: item.id, version: item.version, targetTool: item.targetTool, targetArguments: item.targetArguments });
    if (expected !== item.approvalHash) throw new Error('草稿已变化，请重新预览并批准');
    return this.execute(item.id, item.approvalHash);
  }

  private async execute(itemId: string, approvalHash: string): Promise<DraftItem> {
    const item = this.db.getDraftItem(itemId);
    if (!item) throw new Error('draft item not found');
    const expected = argumentsHash({ draftId: item.id, version: item.version, targetTool: item.targetTool, targetArguments: item.targetArguments });
    if (expected !== approvalHash) throw new Error('批准哈希与当前草稿不一致');
    const errors = this.validate(item);
    if (errors.length) throw new Error(errors.join('；'));
    this.db.setDraftItemExecution(item.id, 'writing', { approvalHash });
    try {
      let result: Record<string, unknown>;
      if (item.targetSystem === 'local') {
        const args = item.targetArguments;
        const action = this.db.createAction({ id: `draft-${item.id}`, customerId: item.customerId, title: String(args.title ?? item.title),
          whyNow: String(args.whyNow ?? item.summary), owner: typeof args.owner === 'string' ? args.owner : null,
          dueAt: typeof args.dueAt === 'string' ? args.dueAt : null, expectedOutcome: typeof args.expectedOutcome === 'string' ? args.expectedOutcome : null,
          evidenceRefs: item.evidenceRefs, sourceMeetingId: typeof args.sourceMeetingId === 'string' ? args.sourceMeetingId : null, confidence: 0.75 });
        result = { actionItemId: action.id };
      } else {
        const response = await this.mcp.call(item.targetTool!, item.targetArguments);
        if (response.isError) throw new Error(response.text);
        // ONES 的 MCP 层同样不把业务失败标为 isError，{"result":"FAIL",...} 以正常内容返回；
        // 曾导致工时登记失败仍被标为 written，且不可重试。result 字符串非 SUCCESS 即业务失败。
        if (item.targetSystem === 'ones') {
          const parsed = cleanJson(response.text) as { result?: unknown; errorCode?: unknown; errorMsg?: unknown } | null;
          if (typeof parsed?.result === 'string' && parsed.result !== 'SUCCESS') {
            throw new Error(`ONES 回写业务失败 ${parsed.result}: ${String(parsed.errorMsg ?? parsed.errorCode ?? '').slice(0, 200)}`);
          }
        }
        // CRM 的 MCP 层不把业务失败标为 isError，resultCode/save_status 藏在 payload 里
        //（如 USER_TOOL_NOT_EXIST、VALIDATION_BLOCKED 且 write_db=false）。
        if (item.targetSystem === 'crm') {
          const parsed = cleanJson(response.text) as { resultCode?: unknown; data?: { message?: unknown; error?: unknown; save_status?: unknown; failure_reason?: unknown; feedback?: { items?: Array<{ message?: unknown; code?: unknown }> } } } | null;
          if (parsed?.resultCode && parsed.resultCode !== 'SUCCESS') {
            throw new Error(`CRM 回写业务失败 ${parsed.resultCode}: ${String(parsed.data?.message ?? parsed.data?.error ?? '').slice(0, 200)}`);
          }
          // SAVED 表示已落库（feedback 里可能带 FIELD_NOT_IN_LAYOUT 等非阻断警告）；只有明确未写库的失败态才报错。
          const data = parsed?.data;
          const saveStatus = data?.save_status;
          if (saveStatus && saveStatus !== 'SUCCESS' && saveStatus !== 'SAVED') {
            const fieldErrors = (data?.feedback?.items ?? [])
              .filter((entry) => entry.code !== 'FIELD_NOT_IN_LAYOUT')
              .map((entry) => `${entry.code}: ${entry.message ?? ''}`).join('；');
            throw new Error(`CRM 校验未通过（${saveStatus}，${data?.failure_reason ?? ''}）${fieldErrors.slice(0, 300)}`);
          }
        }
        result = { response: response.text.slice(0, 2000) };
      }
      this.db.audit('csm', 'execute_hemory_draft', 'draft_item', item.id, { approvalHash, targetSystem: item.targetSystem, targetTool: item.targetTool, result });
      return this.db.setDraftItemExecution(item.id, 'written', { approvalHash, result })!;
    } catch (error) {
      return this.db.setDraftItemExecution(item.id, 'failed', { approvalHash, error: (error as Error).message })!;
    }
  }
}
