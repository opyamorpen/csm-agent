import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { argumentsHash } from '../approval.js';
import { extractText } from '../agent.js';
import type { McpHub } from '../mcp/index.js';
import { shanghaiDateKey } from './sync.js';
import { WorkbenchDatabase } from './database.js';
import type { Customer, SourceEvent, WeeklyReport, WeeklyReportContent, WeeklyReportStats } from './types.js';

export const WEEKLY_REPORT_GENERATION_VERSION = 'weekly-report-v1';

/** 周报四章节的字段契约（templates/weekly-report.json 同源描述，供前端/CLI 展示）。 */
export const WEEKLY_REPORT_SECTIONS: Array<{ key: keyof WeeklyReportContent; label: string }> = [
  { key: 'summary', label: '本周执行摘要' },
  { key: 'accomplishments', label: '本周完成情况' },
  { key: 'next_week_plan', label: '下周工作计划' },
  { key: 'risks', label: '问题风险与阻塞' },
];

/** 转写注入预算：超预算按片段均摊截取（保留每片段开头——承诺/风险信号多出现在对话开头）。 */
const TRANSCRIPT_BUDGET = 24_000;
/** Hemory 上下文注入的最大片段数（超出的丢最旧）。 */
const MAX_HISTORY_FRAGMENTS = 120;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

/** 周一日期（上海时区）校验与对齐：输入任意日期，返回其所在周的周一 YYYY-MM-DD。 */
export function weekMonday(input: string | Date = new Date()): string {
  const date = typeof input === 'string' ? new Date(`${/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T12:00:00+08:00` : input}`) : input;
  if (Number.isNaN(date.getTime())) throw new Error('日期必须是 YYYY-MM-DD');
  const key = shanghaiDateKey(date);
  const at = new Date(`${key}T12:00:00+08:00`);
  // getUTCDay: 周一=1 … 周日=6；周日的 6 需回退 6 天而不是前进 1 天。
  const back = (at.getUTCDay() + 6) % 7;
  return shanghaiDateKey(new Date(at.getTime() - back * 86_400_000));
}

/** 周界（上海时区）：周一 00:00 到周日 23:59:59.999 的 UTC 闭区间。 */
export function weekRange(weekStart: string): { start: string; end: string; weekEnd: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error('weekStart 必须是 YYYY-MM-DD（周一）');
  const start = new Date(`${weekStart}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) throw new Error('invalid weekStart');
  const end = new Date(start.getTime() + 7 * 86_400_000 - 1);
  return { start: start.toISOString(), end: end.toISOString(), weekEnd: shanghaiDateKey(new Date(start.getTime() + 6 * 86_400_000)) };
}

function textOf(event: SourceEvent): string {
  return String(event.payload?.transcript ?? event.title);
}

function nestedStatus(event: SourceEvent): string {
  const value = event.payload?.field005;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return String(record.name ?? record.value ?? record.label ?? '');
  }
  return '';
}

function isDoneStatus(status: string): boolean {
  return /完成|关闭|已解决|done|closed|resolved/i.test(status);
}

function isBlockedStatus(status: string): boolean {
  return /阻塞|挂起|blocked/i.test(status);
}

function updatedAtOf(event: SourceEvent): string | null {
  const value = event.payload?.field010;
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * ONES payload 里的 naive 时间（field009/field010 无时区后缀，实为上海时间）解析为毫秒；
 * 与 database.parseOccurredAt 同逻辑。无法解析返回 null。
 */
function parseOnesTime(value: string | null): number | null {
  if (!value) return null;
  const text = value.trim();
  const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? Date.parse(`${text.replace(' ', 'T')}+08:00`) : Date.parse(text);
  return Number.isNaN(at) ? null : at;
}

interface WeeklyContext {
  events: SourceEvent[];
  hermory: SourceEvent[];
  /** 本周有更新（创建或 field010 落在本周）的工作项集合，按 id 去重。 */
  workItems: SourceEvent[];
  stats: WeeklyReportStats;
}

/** 沟通次数 = 去重 recordingId 的录音场数（一场长会切出的多个话题片段只算一次）。 */
function recordingCount(hermory: SourceEvent[]): number {
  return new Set(hermory.map((event) => String(event.payload?.recordingId ?? event.id))).size;
}

function buildStats(weekStart: string, context: { workItems: SourceEvent[]; hermory: SourceEvent[]; workhours: number | null; actionsCompleted: number | null }): WeeklyReportStats {
  const range = weekRange(weekStart);
  const inWeek = (at: number) => at >= Date.parse(range.start) && at <= Date.parse(range.end);
  const of = (type: string) => context.workItems.filter((event) => event.sourceType === type);
  const createdInWeek = (event: SourceEvent) => {
    const at = parseOnesTime(event.payload?.field009 as string ?? event.occurredAt);
    return at != null && inWeek(at);
  };
  // 「本周解决」：field010 更新在本周且当前状态已完成/关闭（快照近似口径）。
  const resolvedInWeek = (event: SourceEvent) => {
    const updated = parseOnesTime(updatedAtOf(event));
    return isDoneStatus(nestedStatus(event)) && updated != null && inWeek(updated);
  };
  const tickets = of('support_ticket');
  return {
    communications: recordingCount(context.hermory),
    newSuggestions: of('suggestion_feedback').filter(createdInWeek).length,
    newTickets: tickets.filter(createdInWeek).length,
    newOperations: of('operations_ticket').filter(createdInWeek).length,
    resolvedSuggestions: of('suggestion_feedback').filter(resolvedInWeek).length,
    resolvedTickets: tickets.filter(resolvedInWeek).length,
    resolvedOperations: of('operations_ticket').filter(resolvedInWeek).length,
    blockedTickets: tickets.filter((event) => isBlockedStatus(nestedStatus(event))).length,
    openTickets: tickets.filter((event) => !isDoneStatus(nestedStatus(event))).length,
    workhours: context.workhours,
    actionsCompleted: context.actionsCompleted,
    notes: ['沟通次数按录音场数计（一场会议的多个话题片段只算一次）', '工作项按本周有更新聚合去重；「解决」按当前状态快照与更新时间近似判定'],
  };
}

interface PromptInput extends WeeklyContext {
  customer: Customer;
  weekStart: string;
  weekEnd: string;
  workhourRecords: Array<{ startTime: string; hours: number; description: string; owner?: string }>;
  actions: Array<{ title: string; status: string; dueAt?: string | null }>;
  risk: { level: string; score: number | null } | null;
}

function renderContext(input: PromptInput): string {
  const { customer, weekStart, weekEnd, hermory, workItems, stats, workhourRecords, actions, risk } = input;
  const range = weekRange(weekStart);
  const itemContext = workItems
    .map((event) => ({ id: event.id, type: event.sourceType, display: event.displayId ?? '', title: event.title,
      occurred_at: event.occurredAt, status: nestedStatus(event) || 'unknown', updated_at: updatedAtOf(event) ?? 'unknown',
      created_in_week: parseOnesTime(event.payload?.field009 as string ?? event.occurredAt) != null
        && parseOnesTime(event.payload?.field009 as string ?? event.occurredAt)! >= Date.parse(range.start)
        && parseOnesTime(event.payload?.field009 as string ?? event.occurredAt)! <= Date.parse(range.end),
      url: event.url ?? '' }));
  const followups = input.events.filter((event) => event.sourceType === 'crm_followup')
    .map((event) => ({ id: event.id, occurred_at: event.occurredAt, title: event.title, content: String(event.payload?.active_record_content ?? event.title).slice(0, 400) }));
  // 转写注入带预算：按片段均摊上限，超预算截取每段开头（约定/风险信号多在对话开头）。
  const fragments = [...hermory].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(-MAX_HISTORY_FRAGMENTS);
  const perFragment = Math.max(400, Math.floor(TRANSCRIPT_BUDGET / Math.max(1, fragments.length)));
  const hermoryContext = fragments.map((event) => ({
    id: event.id, occurred_at: event.occurredAt, topic: event.title, recording_id: String(event.payload?.recordingId ?? ''),
    speakers: Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : [],
    summary: typeof event.payload?.summary === 'string' ? event.payload.summary : '',
    transcript: textOf(event).slice(0, perFragment),
  }));
  return JSON.stringify({
    customer: { id: customer.id, name: customer.name, industry: customer.industry ?? null, usage_version: customer.usageVersion ?? null, csm: customer.csmName ?? null },
    week: { start: weekStart, end: weekEnd },
    stats,
    risk: risk ? { level: risk.level, score: risk.score } : null,
    communications: hermoryContext,
    work_items: itemContext,
    crm_followups: followups,
    workhours: { total: stats.workhours, records: workhourRecords.map((record) => ({ date: record.startTime, hours: record.hours, description: record.description.slice(0, 120), owner: record.owner ?? '' })) },
    actions: actions.map((action) => ({ title: action.title, status: action.status, due: action.dueAt ?? null })),
  });
}

function parseContent(value: unknown): WeeklyReportContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型未返回周报 JSON 对象');
  const raw = value as Record<string, unknown>;
  const entry = (item: unknown, withDate: boolean): { category: string; date: string; text: string; source: string } | { text: string; source: string } | null => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.text !== 'string' || !record.text.trim()) return null;
    const source = typeof record.source === 'string' ? record.source : '';
    return withDate
      ? { category: typeof record.category === 'string' && record.category.trim() ? record.category : '其他', date: typeof record.date === 'string' ? record.date : '', text: record.text, source }
      : { text: record.text, source };
  };
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) throw new Error('模型未返回本周执行摘要');
  const accomplishments = (Array.isArray(raw.accomplishments) ? raw.accomplishments : [])
    .flatMap((item) => { const parsed = entry(item, true); return parsed ? [parsed as { category: string; date: string; text: string; source: string }] : []; });
  const nextWeekPlan = (Array.isArray(raw.next_week_plan) ? raw.next_week_plan : [])
    .flatMap((item) => { const parsed = entry(item, false); return parsed ? [parsed as { text: string; source: string }] : []; });
  const risks = (Array.isArray(raw.risks) ? raw.risks : [])
    .flatMap((item) => { const parsed = entry(item, false); return parsed ? [parsed as { text: string; source: string }] : []; });
  return { summary, accomplishments, next_week_plan: nextWeekPlan, risks };
}

async function proposeWithModel(runtime: Runtime, input: PromptInput): Promise<WeeklyReportContent> {
  const prompt = `为客户「${input.customer.name}」生成 ${input.weekStart} ~ ${input.weekEnd}（周一~周日）的实施周报。`
    + `你是 CSM 实施周报撰写助手，基于下面提供的全量上下文（沟通录音片段、建议、工单、运维工单、CRM 跟进、工时、行动事项、风险评级）写作，不执行任何工具或外部写入。\n`
    + `输出四个章节，只输出 JSON：\n`
    + `{"summary":"...","accomplishments":[{"category":"...","date":"YYYY-MM-DD","text":"...","source":"..."}],"next_week_plan":[{"text":"...","source":"..."}],"risks":[{"text":"...","source":"..."}]}\n`
    + `章节要求：\n`
    + `1. summary（本周执行摘要）：3~6 句总括叙述，引用统计（沟通场数、新增/解决的建议、工单、运维工单、工时合计等），并给出整体基调判断。\n`
    + `2. accomplishments（本周完成情况）：按小类逐条列出本周发生的全部事项，category 从以下选择：沟通与会议、建议与反馈、工单处理、运维事项、私有云实例、CRM 跟进、工时投入；每条 date 为 YYYY-MM-DD，text 写明事项内容与结果，source 标注来源（如 "Hemory 片段 2026-08-25"、"工单 T-2001"、"CRM 跟进"）。工作项（work_items）已按「本周有更新」聚合去重——created_in_week=true 写新增、状态已完成/关闭且 updated_at 在本周写解决，其余按本周状态变化或持续处理描述；上周创建且本周无更新的事项不在列表中，不得凭空提及。建议/工单数量多时同状态的可适当合并成一条概述并注明条数，不必逐条罗列。\n`
    + `3. next_week_plan（下周工作计划）：**主要证据是本周沟通片段（communications 里的 transcript/summary）中双方约定的后续动作与承诺**——复测/验证时间点、答应交付的事项、约定下次沟通主题、正在推进事项的下一步；再合并 actions 里未完成的行动事项与未关闭工单/建议，去重后逐条列出。每条 source 标注依据（如 "08-27 会议约定"、"行动事项"、"工单 T-2005"）。沟通中没有约定的事项不得编造。\n`
    + `4. risks（问题风险与阻塞）：**主要证据是本周沟通片段中客户表达的问题与风险信号**——不满/抱怨、担忧、疑虑、外部依赖（客户机房窗口、第三方配合）、悬而未决的争议点；再合并阻塞工单（status 含阻塞/挂起）与当前风险评级。每条 source 标注依据（如 "08-26 电话"、"工单 T-2005"、"风险评级 medium"）。沟通中没有表达的担忧不得编造。\n`
    + `通用规则：缺失数据按 unknown 表述，不得虚构事实；引用客户原话时保持口语原样可加引号；source 里的日期用 MM-DD。\n`
    + `上下文：${renderContext(input)}`;
  // 中继端点偶发连接超时（undici 10s 连接超时，实测坏窗口可持续数分钟）：complete 不抛异常而是
  // 返回 stopReason='error' + errorMessage，必须显式透出真实原因并自动重试；固定短间隔重试会整个
  // 落在同一坏窗口内，指数退避（5s→15s→45s）才能跨出去。
  const MAX_MODEL_ATTEMPTS = 3;
  const retryDelayMs = (attempt: number) => 5_000 * 3 ** (attempt - 1);
  let lastError = '模型未返回可解析的周报 JSON';
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
    const response = await runtime.models.complete(runtime.model, {
      systemPrompt: '你是 CSM 实施周报撰写助手。你只能基于用户提供的证据写作周报，不执行任何工具或外部写入。',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    });
    if (response.stopReason === 'error') {
      lastError = `模型调用失败（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次）: ${response.errorMessage || '未知错误'}`;
      if (attempt < MAX_MODEL_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      continue;
    }
    const value = cleanJson(extractText(response.content));
    if (value) return parseContent(value);
    lastError = `模型未返回可解析的周报 JSON（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次，stopReason=${response.stopReason}）`;
    if (attempt < MAX_MODEL_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
  }
  throw new Error(lastError);
}

export function renderWeeklyMarkdown(report: WeeklyReport, customerName = '客户'): string {
  const section = (title: string, body: string) => `## ${title}\n\n${body || '待补充'}\n`;
  const accomplishments = report.content.accomplishments.length
    ? report.content.accomplishments.map((item) => `- [${item.category}]${item.date ? ` ${item.date}` : ''} ${item.text}${item.source ? `（${item.source}）` : ''}`).join('\n')
    : '';
  const plan = report.content.next_week_plan.length
    ? report.content.next_week_plan.map((item, index) => `${index + 1}. ${item.text}${item.source ? `（${item.source}）` : ''}`).join('\n')
    : '';
  const risks = report.content.risks.length
    ? report.content.risks.map((item) => `- ${item.text}${item.source ? `（${item.source}）` : ''}`).join('\n')
    : '';
  const statsLine = `沟通 ${report.stats.communications} 场 · 新增建议 ${report.stats.newSuggestions}（解决 ${report.stats.resolvedSuggestions ?? 'unknown'}）· 新增工单 ${report.stats.newTickets}（解决 ${report.stats.resolvedTickets ?? 'unknown'}）· 新增运维 ${report.stats.newOperations}（解决 ${report.stats.resolvedOperations ?? 'unknown'}）· 工时 ${report.stats.workhours == null ? 'unknown' : `${Number(report.stats.workhours).toFixed(1)}h`}`;
  return [
    `# ${customerName} 实施周报（${report.weekStart} ~ ${report.weekEnd}）\n`,
    section('本周执行摘要', `${report.content.summary}\n\n> ${statsLine}`),
    section('本周完成情况', accomplishments),
    section('下周工作计划', plan),
    section('问题风险与阻塞', risks),
  ].join('\n');
}

export class WeeklyReportService {
  private processing = new Set<string>();

  constructor(
    private readonly db: WorkbenchDatabase,
    private readonly mcp: McpHub,
    private readonly runtime?: Runtime,
    private readonly workhours?: (customerId: string) => Promise<{ records: Array<{ startTime: string; hours: number; description: string; owner?: string }> }>,
  ) {}

  list(customerId: string): WeeklyReport[] {
    return this.db.listWeeklyReports(customerId);
  }

  get(reportId: string): WeeklyReport | undefined {
    return this.db.getWeeklyReport(reportId);
  }

  /**
   * 生成（或幂等复用）某客户某周的周报任务。指纹 = 版本:客户:周:事件集哈希；
   * 已有同指纹周报直接返回原任务；force 加盐换指纹强制重建。失败任务不落墓碑指纹，重试不会被幂等短路。
   */
  /**
   * 某客户某周的完整事件上下文：创建在本周的全部事件（Hemory 片段、CRM 跟进、工作项等）
   * + 更新在本周的 ONES 工作项（不限创建时间），工作项按 id 去重。
   */
  private weeklyEvents(customerId: string, weekStart: string): { events: SourceEvent[]; hermory: SourceEvent[]; workItems: SourceEvent[] } {
    const range = weekRange(weekStart);
    const events = this.db.listSourceEventsInRange(customerId, { since: range.start, until: range.end });
    const hermory = this.db.listHemoryFragments({ customerId, status: 'confirmed', since: range.start, until: range.end, limit: 500 });
    const updated = this.db.listOnesWorkItemsUpdatedInRange(customerId, range.start, range.end);
    const seen = new Set(events.map((event) => event.id));
    const workItems = [...events.filter((event) => event.sourceSystem === 'ones'
      && ['suggestion_feedback', 'support_ticket', 'operations_ticket', 'private_cloud_instance'].includes(event.sourceType)),
    ...updated.filter((event) => !seen.has(event.id))];
    return { events, hermory, workItems };
  }

  generate(customerId: string, weekStartInput: string, force = false): { jobId: string | null; fingerprint: string; weekStart: string } {
    const customer = this.db.getCustomer(customerId);
    if (!customer) throw new Error('customer not found');
    const weekStart = weekMonday(weekStartInput);
    const { events, hermory, workItems } = this.weeklyEvents(customerId, weekStart);
    if (!events.length && !hermory.length) throw new Error(`${weekStart} 这一周没有该客户的任何数据（请先同步）`);
    // 指纹覆盖创建在本周的事件 + 更新在本周的工作项（按 id 去重），任一变化都会换指纹重建。
    const all = [...events, ...workItems.filter((item) => !events.some((event) => event.id === item.id))];
    const fingerprint = weeklyFingerprint(customerId, weekStart, all, hermory);
    const existingReport = this.db.getWeeklyReportByWeek(customerId, weekStart);
    if (existingReport && !force && existingReport.fingerprint === fingerprint) {
      const job = this.db.findDraftJobByFingerprint(fingerprint);
      return { jobId: job?.id ?? null, fingerprint, weekStart };
    }
    const finalFingerprint = existingReport || force
      ? hash(`${fingerprint}:regenerate:${Date.now()}:${Math.random()}`)
      : fingerprint;
    const sourceEventIds = [...new Set([...events.map((event) => event.id), ...hermory.map((event) => event.id), ...workItems.map((event) => event.id)])];
    const job = this.db.createDraftJob(customerId, finalFingerprint, sourceEventIds, 'weekly_report');
    if (job.status !== 'succeeded') void this.process(job.id);
    return { jobId: job.id, fingerprint: finalFingerprint, weekStart };
  }

  resumePending(): void {
    for (const job of this.db.listPendingDraftJobs('weekly_report')) if (job.attempts < 3) void this.process(job.id);
  }

  private async process(jobId: string): Promise<void> {
    if (this.processing.has(jobId)) return;
    const job = this.db.getDraftJob(jobId);
    if (!job || job.status === 'succeeded' || job.kind !== 'weekly_report') return;
    this.processing.add(jobId);
    this.db.updateDraftJob(jobId, 'running');
    try {
      const customer = this.db.getCustomer(job.customerId);
      if (!customer) throw new Error('customer not found');
      // 周界从任务种子事件推导（上海时区），任务排队期间新增的数据也会并入。
      const seeded = job.sourceEventIds.map((id) => this.db.getSourceEvent(id))
        .filter((event): event is SourceEvent => !!event && event.customerId === customer.id);
      if (!seeded.length) throw new Error('没有仍归属于该客户的事件');
      const anchor = seeded[0];
      const weekStart = weekMonday(anchor.occurredAt);
      const range = weekRange(weekStart);
      const { events, hermory, workItems } = this.weeklyEvents(customer.id, weekStart);
      if (!events.length && !hermory.length) throw new Error(`${weekStart} 这一周没有该客户的任何数据`);
      // 工时从已同步 payload 取（避免生成路径实时打 ONES MCP）；缺失时按 unknown 处理，不阻塞生成。
      let workhourRecords: Array<{ startTime: string; hours: number; description: string; owner?: string }> = [];
      let workhoursTotal: number | null = null;
      try {
        const data = this.workhours ? await this.workhours(customer.id) : null;
        const inWeek = (data?.records ?? []).filter((record) => {
          const at = Date.parse(record.startTime);
          return !Number.isNaN(at) && at >= Date.parse(range.start) && at <= Date.parse(range.end);
        });
        workhourRecords = inWeek;
        workhoursTotal = inWeek.length ? Math.round(inWeek.reduce((sum, record) => sum + Number(record.hours ?? 0), 0) * 10) / 10 : 0;
      } catch { /* workhours optional */ }
      const actions = this.db.listActions(customer.id);
      const actionsCompleted = actions.filter((action) => {
        const at = Date.parse(action.updatedAt);
        return action.status === 'completed' && !Number.isNaN(at) && at >= Date.parse(range.start) && at <= Date.parse(range.end);
      }).length;
      const riskRow = this.db.latestRisk(customer.id);
      const stats = buildStats(weekStart, { workItems, hermory, workhours: workhoursTotal, actionsCompleted });
      if (!this.runtime) throw new Error('模型未配置，无法生成周报（请检查 LLM 配置后重新生成）');
      let content: WeeklyReportContent;
      try { content = await proposeWithModel(this.runtime, { customer, weekStart, weekEnd: range.weekEnd, events, hermory, workItems, stats, workhourRecords, actions, risk: riskRow ? { level: riskRow.level, score: riskRow.score } : null }); }
      catch (error) { throw new Error(`模型未生成周报: ${(error as Error).message}`); }
      const generator = `${this.runtime.llm.provider}/${this.runtime.llm.model}`;
      const report = this.db.upsertWeeklyReport({ customerId: customer.id, weekStart, weekEnd: range.weekEnd,
        content, stats, generator, fingerprint: job.fingerprint });
      this.db.updateDraftJob(jobId, 'succeeded');
      this.db.audit('agent', 'generate_weekly_report', 'weekly_report', report.id, { customerId: customer.id, weekStart, generator, fingerprint: job.fingerprint });
    } catch (error) {
      this.db.updateDraftJob(jobId, 'failed', (error as Error).message);
    } finally {
      this.processing.delete(jobId);
    }
  }

  update(reportId: string, expectedVersion: number, content: WeeklyReportContent): WeeklyReport | null {
    return this.db.updateWeeklyReport(reportId, expectedVersion, content);
  }

  publishPreview(reportId: string, parentPageID: string): { report: WeeklyReport; tool: string; args: Record<string, unknown>; approvalHash: string } {
    const report = this.db.getWeeklyReport(reportId);
    if (!report || report.status !== 'draft') throw new Error('周报不可发布（不存在或已发布）');
    if (!parentPageID.trim()) throw new Error('缺少 ONES Wiki 父页面 ID');
    const customer = this.db.getCustomer(report.customerId);
    const tool = 'mcp__ones__create_page';
    const args = { parentPageID, title: `${customer?.name ?? '客户'} 实施周报（${report.weekStart} ~ ${report.weekEnd}）`, content: renderWeeklyMarkdown(report, customer?.name) };
    return { report, tool, args, approvalHash: argumentsHash({ reportId, version: report.version, tool, args }) };
  }

  async publish(reportId: string, version: number, parentPageID: string, approvalHash: string): Promise<WeeklyReport> {
    const preview = this.publishPreview(reportId, parentPageID);
    const expected = argumentsHash({ reportId, version, tool: preview.tool, args: preview.args });
    if (preview.report.version !== version || expected !== approvalHash) throw new Error('周报版本或批准内容已变化，请重新确认');
    const result = await this.mcp.call(preview.tool, preview.args);
    if (result.isError) throw new Error(result.text);
    let pageId = '';
    try {
      const parsed = JSON.parse(result.text);
      pageId = String(parsed.pageID ?? parsed.id ?? parsed.data?.pageID ?? '');
    } catch {
      pageId = result.text.match(/[0-9a-f-]{8,}/i)?.[0] ?? '';
    }
    const published = this.db.markWeeklyReportPublished(reportId, version, pageId || 'created-without-returned-id');
    if (!published) throw new Error('周报状态已变化');
    this.db.audit('csm', 'publish_weekly_report', 'weekly_report', reportId, { version, pageId: published.publishedPageId, approvalHash });
    return published;
  }
}

/** 周粒度指纹：同客户同周同事件集合（含内容 hash）复用同一任务；数据变化自然换指纹重建。 */
export function weeklyFingerprint(customerId: string, weekStart: string, events: SourceEvent[], hermory: SourceEvent[]): string {
  const all = [...events, ...hermory].sort((a, b) => a.id.localeCompare(b.id)).map((event) => `${event.id}:${event.payloadHash}`);
  return hash(`${WEEKLY_REPORT_GENERATION_VERSION}:${customerId}:${weekStart}:${all.join('|')}`);
}
