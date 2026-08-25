import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { argumentsHash } from '../approval.js';
import { extractText } from '../agent.js';
import type { McpHub } from '../mcp/index.js';
import { WorkbenchDatabase } from './database.js';
import type { Customer, DraftBatch, DraftItem, DraftItemType, SourceEvent } from './types.js';

export const DRAFT_GENERATION_VERSION = 'hemory-drafts-v1';
const ONES_CUSTOMER_FIELD_ID = process.env.ONES_CUSTOMER_FIELD_ID ?? 'JrvswW8P';
const ONES_DESK_PROJECT_ID = 'GL3ysesFPdnAQNIU';
type OnesDeskDraftType = 'suggestion' | 'ticket' | 'operations';
const ONES_DESK_ISSUE_TYPE_IDS: Record<OnesDeskDraftType, string> = { suggestion: 'A99xMfkg', ticket: '7sxvwZMY', operations: '943qpMX7' };
const ONES_DESK_TARGET_OBJECTS: Record<OnesDeskDraftType, string> = { suggestion: 'ONES Desk / 建议和反馈', ticket: 'ONES Desk / 工单', operations: 'ONES Desk / 运维工单' };
// CRM 跟进记录（销售记录）必须关联的 CSM 售后客户对象；其 _id 是工作台唯一客户主键。
const CRM_AFTER_SALES_OBJECT = 'object_Umwnn__c';
const MAX_DRAFT_ITEMS = 12;

function onesDeskTypeId(type: DraftItemType): OnesDeskDraftType | null {
  return type === 'suggestion' || type === 'ticket' || type === 'operations' ? type : null;
}

interface DraftProposal {
  type: DraftItemType;
  title: string;
  summary: string;
  fields?: Record<string, unknown>;
  evidenceRefs?: string[];
  unknowns?: string[];
}

export interface DraftPreview {
  batchId: string;
  items: Array<{ id: string; version: number; approvalHash: string; validationErrors: string[] }>;
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
  const base = { evidence_quotes: events.map(textOf), occurred_at: first?.occurredAt ?? new Date().toISOString() };
  if (type === 'internal_todo') return { type, title: first?.title.slice(0, 100) || `跟进 ${customer.name}`,
    summary: quote, fields: { ...base, owner: 'unknown', due_at: 'unknown', expected_outcome: 'unknown' }, unknowns: ['负责人', '截止时间'] };
  if (type === 'workhour') return { type, title: `${customer.name}客户沟通工时`, summary: quote,
    fields: { ...base, hours: 'unknown', description: quote }, unknowns: ['工时时长'] };
  if (type === 'suggestion') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户需求`, summary: quote,
    fields: { ...base, description: quote }, unknowns: [] };
  if (type === 'ticket') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户工单`, summary: quote,
    fields: { ...base, description: quote, severity: 'unknown' }, unknowns: ['严重程度'] };
  if (type === 'operations') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户运维事项`, summary: quote,
    fields: { ...base, description: quote, severity: 'unknown' }, unknowns: ['严重程度'] };
  return { type, title: `${customer.name}沟通记录`, summary: quote,
    fields: { ...base, method: '会议', participants: [...new Set(events.map((event) => String(event.payload?.speaker ?? '')).filter(Boolean))],
      key_topics: events.map((event) => event.title), next_steps: 'unknown' }, unknowns: ['下一步计划'] };
}

async function proposeWithModel(runtime: Runtime, customer: Customer, events: SourceEvent[]): Promise<DraftProposal[]> {
  const evidence = events.map((event) => ({ id: event.id, occurred_at: event.occurredAt,
    speakers: Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : [], text: textOf(event) }));
  const prompt = `为客户沟通片段生成结构化草稿。只允许类型 internal_todo、workhour、followup、suggestion、ticket、operations；同一类型可以输出多条草稿，但每条必须对应独立的话题或行动；只返回有证据支持的草稿。\n`
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

export function draftFingerprint(customerId: string, events: SourceEvent[]): string {
  const sources = [...events].sort((a, b) => a.id.localeCompare(b.id)).map((event) => `${event.id}:${event.payloadHash}`);
  return hash(`${DRAFT_GENERATION_VERSION}:${customerId}:${sources.join('|')}`);
}

export function sortedDraftEvents(events: SourceEvent[]): SourceEvent[] {
  return [...events].sort((a, b) => a.id.localeCompare(b.id));
}

export class HemoryDraftService {
  private processing = new Set<string>();

  constructor(private readonly db: WorkbenchDatabase, private readonly mcp: McpHub, private readonly runtime?: Runtime) {}

  enqueue(customerId: string, eventIds: string[]): { jobId: string; fingerprint: string } | null {
    const events = this.confirmedSegments(customerId, eventIds);
    if (!events.length) return null;
    return this.generate(customerId, events, false);
  }

  regenerate(batchId: string): { jobId: string; fingerprint: string } {
    const batch = this.db.getDraftBatch(batchId);
    if (!batch) throw new Error('draft batch not found');
    const events = this.confirmedSegments(batch.customerId, batch.sourceEventIds);
    if (!events.length) throw new Error('批次没有仍归属于该客户的 Hemory 片段');
    return this.generate(batch.customerId, events, true);
  }

  private confirmedSegments(customerId: string, eventIds: string[]): SourceEvent[] {
    return [...new Set(eventIds)].map((id) => this.db.getSourceEvent(id)).filter((event): event is SourceEvent =>
      !!event && event.customerId === customerId && event.attributionStatus === 'confirmed' && event.sourceSystem === 'hemory' && event.sourceType === 'ai_topic_segment');
  }

  // 同一录音的片段应进入同一批次，避免分次归属把一场会议拆成多条跟进记录。
  private expandToRecordings(customerId: string, attributed: SourceEvent[]): SourceEvent[] {
    const recordingIds = new Set(attributed.map((event) => String(event.payload?.recordingId ?? '')).filter(Boolean));
    if (!recordingIds.size) return sortedDraftEvents(attributed);
    const expanded = new Map(attributed.map((event) => [event.id, event]));
    for (const event of this.db.listConfirmedHemorySegments(customerId)) {
      if (recordingIds.has(String(event.payload?.recordingId ?? ''))) expanded.set(event.id, event);
    }
    return sortedDraftEvents([...expanded.values()]);
  }

  private generate(customerId: string, attributed: SourceEvent[], force: boolean): { jobId: string; fingerprint: string } {
    const events = this.expandToRecordings(customerId, attributed);
    const fingerprint = draftFingerprint(customerId, events);
    const existing = this.db.findDraftBatchByFingerprint(fingerprint);
    if (existing && !force && existing.status !== 'stale') {
      // 同一批片段已有可用批次时保持幂等，直接复用原任务；只有批次已作废才需要换盐重新生成。
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
      const events = job.sourceEventIds.map((id) => this.db.getSourceEvent(id)).filter((event): event is SourceEvent => !!event && event.customerId === customer.id);
      if (!events.length) throw new Error('没有仍归属于该客户的 Hemory 片段');
      let ai: DraftProposal[] = [];
      let generator = 'rules';
      if (this.runtime) {
        try { ai = await proposeWithModel(this.runtime, customer, events); generator = `${this.runtime.llm.provider}/${this.runtime.llm.model}`; }
        catch (error) { generator = `rules-fallback: ${(error as Error).message}`.slice(0, 160); }
      }
      const seen = new Set<string>();
      const proposals = ai.filter((proposal) => {
        const key = `${proposal.type}::${proposal.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, MAX_DRAFT_ITEMS);
      const covered = new Set(proposals.map((proposal) => proposal.type));
      for (const type of classifyDraftTypes(events)) {
        if (covered.has(type) || proposals.length >= MAX_DRAFT_ITEMS) continue;
        proposals.push(defaultProposal(type, customer, events));
        covered.add(type);
      }
      const batch = this.db.createDraftBatch({ customerId: customer.id, fingerprint: job.fingerprint,
        sourceEventIds: events.map((event) => event.id), generationVersion: DRAFT_GENERATION_VERSION, generator });
      if (!batch.items?.length) {
        for (const proposal of proposals) this.createItem(batch, customer, events, proposal);
      }
      this.db.refreshDraftBatchStatus(batch.id);
      this.db.updateDraftJob(jobId, 'succeeded');
      this.db.audit('agent', 'generate_hemory_drafts', 'draft_batch', batch.id, { customerId: customer.id, sourceEventIds: batch.sourceEventIds, generator });
    } catch (error) {
      this.db.updateDraftJob(jobId, 'failed', (error as Error).message);
    } finally {
      this.processing.delete(jobId);
    }
  }

  private createItem(batch: DraftBatch, customer: Customer, events: SourceEvent[], proposal: DraftProposal): DraftItem {
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
    const target = this.buildTarget(proposal.type, customer, evidence, proposal, fields);
    return this.db.createDraftItem({ batchId: batch.id, customerId: customer.id, type: proposal.type,
      status: target.validationErrors.length ? 'draft' : 'ready', title: proposal.title.slice(0, 160), summary: proposal.summary,
      fields, targetSystem: target.system, targetObject: target.object, targetTool: target.tool,
      targetArguments: target.arguments, evidenceRefs, unknowns: proposal.unknowns ?? [], validationErrors: target.validationErrors });
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

  private buildTarget(type: DraftItemType, customer: Customer, events: SourceEvent[], proposal: DraftProposal, fields: Record<string, unknown>) {
    const validationErrors: string[] = [];
    if (type === 'internal_todo') return { system: 'local' as const, object: 'CSM Agent / 待办', tool: 'local__create_action_item',
      arguments: { title: proposal.title, whyNow: proposal.summary, owner: fields.owner === 'unknown' ? null : fields.owner ?? null,
        dueAt: fields.due_at === 'unknown' ? null : fields.due_at, expectedOutcome: fields.expected_outcome === 'unknown' ? null : fields.expected_outcome ?? null,
        evidenceRefs: events.map((event) => event.id), sourceMeetingId: events[0]?.payload?.recordingId ?? null }, validationErrors };
    if (type === 'followup') {
      // CRM 跟进记录的真实写路径是通用记录创建工具 data_record_create（执行标识 CreateRecordsByData），
      // 写入销售记录对象 ActiveRecordObj；关联业务对象必须是 CSM 售后客户（object_Umwnn__c）。
      const exact = this.mcp.listTools().find((tool) => tool.server === 'crm' && tool.rawName === 'data_record_create');
      const tool = exact?.publicName ?? this.findWriteTool('crm', /(record.*create|create.*record|跟进)/i);
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
      // ActiveRecordObj 必填：服务开始/结束时间、渠道（线上）、关联业务对象、跟进类型（常规客情维护）。
      const occurredAt = String(fields.occurred_at ?? events[0]?.occurredAt ?? new Date().toISOString());
      const objectData: Record<string, unknown> = {
        active_record_content: `${proposal.title}\n${proposal.summary}`,
        field_oUaZx__c: occurredAt,
        field_wYlhw__c: occurredAt,
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
      const tool = this.findWriteTool('ones', /(manhour|work.?log|工时)/i);
      if (!manhour) validationErrors.push('客户未绑定“客户工时管理 / 售后客户”工作项');
      if (!tool) validationErrors.push('未找到 ONES 工时登记写工具');
      if (fields.hours === 'unknown' || fields.hours == null) validationErrors.push('请补充工时时长');
      return { system: 'ones' as const, object: '客户工时管理 / 售后客户', tool,
        arguments: { issueID: manhour?.externalId ?? '', hours: fields.hours, description: proposal.summary,
          date: String(events[0]?.occurredAt ?? '').slice(0, 10) }, validationErrors };
    }
    const deskType = onesDeskTypeId(type);
    if (!deskType) throw new Error(`未知的草稿目标类型: ${type}`);
    const option = this.db.listIdentities(customer.id).find((item) => item.system === 'ones_customer_option' && item.status === 'confirmed');
    const tool = this.findWriteTool('ones', /(create.*issue|issue.*create|新建.*工作项)/i);
    if (!option?.external_id) validationErrors.push('客户缺少已确认的 ONES 客户信息 option ID');
    if (!tool) validationErrors.push('未找到 ONES 新建工作项写工具');
    return { system: 'ones' as const, object: ONES_DESK_TARGET_OBJECTS[deskType], tool,
      arguments: { projectID: ONES_DESK_PROJECT_ID, issueTypeID: ONES_DESK_ISSUE_TYPE_IDS[deskType], summary: proposal.title, description: proposal.summary,
        fieldValues: [{ fieldID: ONES_CUSTOMER_FIELD_ID, value: option?.external_id ?? '' }] }, validationErrors };
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
    }
    if (item.type === 'suggestion' || item.type === 'ticket' || item.type === 'operations') {
      const option = this.db.listIdentities(customer.id).find((identity) => identity.system === 'ones_customer_option' && identity.status === 'confirmed');
      const values = Array.isArray(item.targetArguments.fieldValues) ? item.targetArguments.fieldValues as Array<Record<string, unknown>> : [];
      if (!option || !values.some((value) => value.fieldID === ONES_CUSTOMER_FIELD_ID && value.value === option.external_id)) errors.push(`ONES 工作项必须包含当前客户字段 ${ONES_CUSTOMER_FIELD_ID}`);
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
      }
    }
    if (item.type === 'workhour') {
      const tool = this.findReadTool('ones', /(get.*manhour.*mode|manhour.*mode|工时.*模式)/i);
      if (!tool) errors.push('未找到 ONES 工时模式查询工具');
      else {
        const response = await this.mcp.call(tool, { issueID: item.targetArguments.issueID });
        if (response.isError) errors.push(`ONES 工时模式预检失败: ${response.text.slice(0, 300)}`);
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
