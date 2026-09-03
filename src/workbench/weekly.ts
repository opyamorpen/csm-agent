import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { argumentsHash } from '../approval.js';
import { extractText } from '../agent.js';
import type { McpHub } from '../mcp/index.js';
import { shanghaiDateKey } from './sync.js';
import { onesAsrAliasRule } from './drafts.js';
import { completeModelWithProgress, modelProgressText } from './model-progress.js';
import { WorkbenchDatabase } from './database.js';
import type { Customer, SourceEvent, WeeklyReport, WeeklyReportContent, WeeklyReportStats } from './types.js';

export const WEEKLY_REPORT_GENERATION_VERSION = 'weekly-report-v3-customer-facing';

/**
 * 周报四章节的字段契约（templates/weekly-report.json 同源描述，供前端/CLI 展示）。
 * 标签即客户版正文/复制/发布/CLI 的统一章节标题；description 为该章节的业务含义说明。
 */
export const WEEKLY_REPORT_SECTIONS: Array<{ key: keyof WeeklyReportContent; label: string; description: string }> = [
  { key: 'summary', label: '本周工作概览', description: '2~4 句概括项目阶段、本周推进重点与已确认的关键结论、里程碑' },
  { key: 'accomplishments', label: '本周关键进展', description: '按项目主题归并的进展条目（4~8 条），每条说明完成了什么、确认了什么、形成了什么结果' },
  { key: 'next_week_plan', label: '下周工作计划', description: '客户可确认的关键计划（5~8 条），尽量含计划事项、时间节点、责任方与预期结果' },
  { key: 'risks', label: '风险与待协调事项', description: '客观、可行动的风险/阻塞/待确认事项，使用【风险】【阻塞】【待确认】前缀，不得隐藏真实风险' },
];

/** 空风险章节的固定兜底句（历史周报空数组时同样生效）。 */
export const WEEKLY_NO_RISK_SENTENCE = '当前暂无影响项目计划的重大风险或阻塞。';

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

function nestedStatusCategory(event: SourceEvent): string | null {
  const value = event.payload?.field005;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const category = (value as Record<string, unknown>).category;
    if (typeof category === 'string' && category) return category;
  }
  return null;
}

function isDoneStatus(status: string): boolean {
  return /完成|关闭|已解决|done|closed|resolved/i.test(status);
}

/** 完成判定以状态类型为准（category === 'done'）；旧数据缺 category 时才回退状态名正则。 */
function isDoneEvent(event: SourceEvent): boolean {
  const category = nestedStatusCategory(event);
  return category ? category === 'done' : isDoneStatus(nestedStatus(event));
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
  hemory: SourceEvent[];
  /** 本周有更新（创建或 field010 落在本周）的工作项集合，按 id 去重。 */
  workItems: SourceEvent[];
  stats: WeeklyReportStats;
}

/** 沟通次数 = 去重 recordingId 的录音场数（一场长会切出的多个话题片段只算一次）。 */
function recordingCount(hemory: SourceEvent[]): number {
  return new Set(hemory.map((event) => String(event.payload?.recordingId ?? event.id))).size;
}

function buildStats(weekStart: string, context: { workItems: SourceEvent[]; hemory: SourceEvent[]; workhours: number | null; actionsCompleted: number | null }): WeeklyReportStats {
  const range = weekRange(weekStart);
  const inWeek = (at: number) => at >= Date.parse(range.start) && at <= Date.parse(range.end);
  const of = (type: string) => context.workItems.filter((event) => event.sourceType === type);
  const createdInWeek = (event: SourceEvent) => {
    const at = parseOnesTime(event.payload?.field009 as string ?? event.occurredAt);
    return at != null && inWeek(at);
  };
  // 「本周解决」：field010 更新在本周且当前状态类型为已完成（旧数据回退状态名判断，快照近似口径）。
  const resolvedInWeek = (event: SourceEvent) => {
    const updated = parseOnesTime(updatedAtOf(event));
    return isDoneEvent(event) && updated != null && inWeek(updated);
  };
  const tickets = of('support_ticket');
  return {
    communications: recordingCount(context.hemory),
    newSuggestions: of('suggestion_feedback').filter(createdInWeek).length,
    newTickets: tickets.filter(createdInWeek).length,
    newOperations: of('operations_ticket').filter(createdInWeek).length,
    resolvedSuggestions: of('suggestion_feedback').filter(resolvedInWeek).length,
    resolvedTickets: tickets.filter(resolvedInWeek).length,
    resolvedOperations: of('operations_ticket').filter(resolvedInWeek).length,
    blockedTickets: tickets.filter((event) => isBlockedStatus(nestedStatus(event))).length,
    openTickets: tickets.filter((event) => !isDoneEvent(event)).length,
    workhours: context.workhours,
    actionsCompleted: context.actionsCompleted,
    notes: ['沟通次数按录音场数计（一场会议的多个话题片段只算一次）', '工作项按本周有更新聚合去重；「解决」按状态类型=已完成与更新时间近似判定（旧同步数据回退状态名判断）'],
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
  const { customer, weekStart, weekEnd, hemory, workItems, stats, workhourRecords, actions, risk } = input;
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
  const fragments = [...hemory].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(-MAX_HISTORY_FRAGMENTS);
  const perFragment = Math.max(400, Math.floor(TRANSCRIPT_BUDGET / Math.max(1, fragments.length)));
  const hemoryContext = fragments.map((event) => ({
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
    communications: hemoryContext,
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
  if (!summary) throw new Error('模型未返回本周工作概览');
  const accomplishments = (Array.isArray(raw.accomplishments) ? raw.accomplishments : [])
    .flatMap((item) => { const parsed = entry(item, true); return parsed ? [parsed as { category: string; date: string; text: string; source: string }] : []; });
  const nextWeekPlan = (Array.isArray(raw.next_week_plan) ? raw.next_week_plan : [])
    .flatMap((item) => { const parsed = entry(item, false); return parsed ? [parsed as { text: string; source: string }] : []; });
  const risks = (Array.isArray(raw.risks) ? raw.risks : [])
    .flatMap((item) => { const parsed = entry(item, false); return parsed ? [parsed as { text: string; source: string }] : []; });
  return { summary, accomplishments, next_week_plan: nextWeekPlan, risks };
}

async function proposeWithModel(runtime: Runtime, input: PromptInput, onProgress?: (text: string) => void): Promise<WeeklyReportContent> {
  const prompt = `为客户「${input.customer.name}」生成 ${input.weekStart} ~ ${input.weekEnd}（周一~周日）的实施周报。`
    + `这份周报经 CSM 审核后会直接复制或发布给外部客户，是正式、克制、面向外部客户的项目周报。你只能基于下面提供的证据写作，不执行任何工具或外部写入。\n`
    + `输出四个章节，只输出 JSON：\n`
    + `{"summary":"...","accomplishments":[{"category":"...","date":"YYYY-MM-DD","text":"...","source":"..."}],"next_week_plan":[{"text":"...","source":"..."}],"risks":[{"text":"...","source":"..."}]}\n`
    + `写作总则（全部章节适用）：\n`
    + `- 面向外部客户、结果导向：正文围绕项目成果、已确认结论、里程碑、下一步计划与项目风险，使用「双方」「贵方」「ONES 项目组」「项目组」等正式称谓。\n`
    + `- 上下文中的统计、工时、风险评级、待办事项、CRM 跟进等是内部证据，只用于帮助你理解事实，其本身一律不写入正文，仅可在 source 字段标注依据。\n`
    + `- 同一事项经过多次沟通只保留一条合并后的项目进展，不得按日期逐场复述会议流水。\n`
    + `- 缺失信息直接不写或转为「待确认」事项，不得推断责任方、时间或结论，不得虚构事实。\n`
    + `- 正文禁止出现 unknown 等占位词，禁止出现 Hemory、CRM 跟进、待办事项、风险评级、风险评分、内部统计（沟通场次、工时合计、新增/解决工单建议数）等内部信息。\n`
    + `- 不得泄露其他客户、其他项目或无关第三方名称；不得把内部讨论、猜测或未经确认的方案写成双方结论。\n`
    + `- source 字段是仅供内部审核的证据标注（如 "08-27 会议"、"工单 T-2005"），不进入客户版正文；source 里的日期用 MM-DD。\n`
    + `章节要求：\n`
    + `1. summary（本周工作概览）：2~4 句概括项目所处阶段、本周推进重点、双方已确认的关键结论和里程碑，回答「本周项目整体向前推进了什么」。可提及双方已确认的上线、部署、调研、交付等关键日期。不罗列会议场次，不引用任何内部统计与评级，不写客户画像或情绪判断，不把尚未确认的目标写成已承诺的结论。\n`
    + `2. accomplishments（本周关键进展）：4~8 条，按项目主题、阶段成果和交付结果归并（不按小类或日期流水）。每条重点说明「完成了什么、确认了什么、形成了什么结果」，category 从以下选择：需求调研、方案与设计、部署与实施、联调与验证、培训与赋能、计划与协调、问题与支持、其他；date 为该事项最有价值的日期（YYYY-MM-DD）。CRM 跟进记录、沟通片段本身不得单独作为项目进展；对项目有实际价值的日期可保留，但不要写成会议纪要。纯内部动作（内部反馈、内部汇报、准备内部材料）不写。合同法审、付款比例、违约条款等商务细节只在确实影响项目计划且适合客户共同确认时用中性表达。人员证明、着装、安全要求等内容仅在构成明确入场条件时保留并归并为「入场准备」。工作项（work_items）已按「本周有更新」聚合去重——created_in_week=true 写新增、状态已完成/关闭且 updated_at 在本周写解决，其余按本周状态变化或持续处理描述；上周创建且本周无更新的事项不在列表中，不得凭空提及。\n`
    + `3. next_week_plan（下周工作计划）：5~8 条客户能够理解和确认的关键计划，同一目标下的多个内部动作必须合并，不罗列纯内部待办。每条尽量包含计划事项、计划时间或目标节点、已明确的责任方、预期结果。责任方称谓：双方共同推进用「双方」，ONES 侧负责用「ONES 项目组」，客户侧负责且有明确证据时才用「贵方」；责任方、日期或结果没有证据时不得推断。不使用命令式或归责式表达；尚未确认的时间用「计划」「预计」「目标」表述，不能写成确定承诺。细碎待办应归并为客户可识别的项目主题（如现场需求调研、系统部署准备、实施计划与 SOW 确认、Demo 场景完善、二次开发接口梳理、项目启动与沟通机制建立）。主要证据是本周沟通片段（communications 里的 transcript/summary）中双方约定的后续动作与承诺，可合并未完成待办与未关闭工单/建议；沟通中没有约定的事项不得编造。\n`
    + `4. risks（风险与待协调事项）：必须保留真实存在且可能影响项目范围、质量、进度、交付或上线目标的风险与阻塞——不能为了让周报显得积极而隐藏真实风险，但表达必须客观、克制、透明、可行动。仅写有明确证据的风险、阻塞或依赖，不根据客户情绪或内部评分推断。每条以「【风险】」「【阻塞】」「【待确认】」前缀开头，按「当前情况 → 可能影响 → 应对安排（已采取措施或下一步安排）→ 需协同（仅确实需要客户配合时）」组织；有应对方案必须同时写明，不能只提出问题。可以说明对具体里程碑的潜在影响，但不得夸大、施压或制造紧张。不直接引用客户的负面口语，不写「客户不满」「客户抱怨」「客户担忧」「有坑」「差距很大」等内部记录式表达，不把责任单方面归因于客户、ONES 项目组或第三方，用「尚待确认」「需要双方协同」「依赖相关资源到位」等中性表达。有证据时尽量说明责任方和期望完成时间。若本周确实没有风险或阻塞，输出一条文本为「${WEEKLY_NO_RISK_SENTENCE}」的条目。主要证据是本周沟通片段中客户表达的问题与风险信号、外部依赖与悬而未决的争议点，可合并阻塞工单；沟通中没有表达的担忧不得编造。\n`
    + `风险表达转换示例（内部记录 → 客户版表达）：\n`
    + `- 内部：「客户反馈外网 demo 与领导要求差距较大，否则影响下周入场和认可。」→ 客户版：「【风险】当前演示内容与一期目标场景仍需进一步对齐，若范围未及时收敛，可能影响后续方案确认。项目组将在下周现场调研中补充需求管理全流程，并根据双方确认结果完善演示内容。」\n`
    + `- 内部：「客户服务器资源到位、网络协调及第三方接口提供进度存在不确定性。」→ 客户版：「【风险】服务器资源、网络条件及第三方接口信息的到位时间尚待确认，可能影响系统部署和后续联调节点。双方将在下周完成资源清单确认，并根据实际到位时间及时校准实施计划。」\n`
    + `- 内部：「二开涉及六大系统，可能无法在十二月底前全部完成。」→ 客户版：「【风险】二次开发涉及多个外部系统，当前接口范围和依赖条件尚未全部确认，整体交付周期存在不确定性。建议双方优先完成接口清单、优先级和责任边界确认，并据此评估分阶段交付方案。」\n`
    + `- 内部：「数据库选型有坑，高斯没有应答，费用也没有覆盖。」→ 客户版：「【待确认】数据库选型及适配范围尚需进一步确认，不同方案可能对实施工作量和交付周期产生影响。项目组将结合适配条件形成建议方案，并与贵方确认最终选型。」\n`
    + `${onesAsrAliasRule()}该订正适用于全部正文与 source。\n`
    + `上下文：${renderContext(input)}`;
  // 中继端点偶发连接超时（undici 10s 连接超时，实测坏窗口可持续数分钟）：complete 不抛异常而是
  // 返回 stopReason='error' + errorMessage，必须显式透出真实原因并自动重试；固定短间隔重试会整个
  // 落在同一坏窗口内，指数退避（5s→15s→45s）才能跨出去。
  const MAX_MODEL_ATTEMPTS = 3;
  const retryDelayMs = (attempt: number) => 5_000 * 3 ** (attempt - 1);
  let lastError = '模型未返回可解析的周报 JSON';
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
    const response = await completeModelWithProgress(runtime, {
      systemPrompt: '你是 ONES 项目组实施周报撰写助手。你产出的是经 CSM 审核后直接发给外部客户的正式项目周报：只能基于用户提供的证据写作，客观克制、结果导向，不执行任何工具或外部写入。',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    }, onProgress ? (tick) => onProgress(modelProgressText(tick)) : undefined);
    if (response.stopReason === 'error') {
      lastError = `模型调用失败（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次）: ${response.errorMessage || '未知错误'}`;
      if (attempt < MAX_MODEL_ATTEMPTS) {
        onProgress?.(`${lastError}，${Math.round(retryDelayMs(attempt) / 1000)} 秒后自动重试`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      }
      continue;
    }
    const value = cleanJson(extractText(response.content));
    if (value) return parseContent(value);
    lastError = `模型未返回可解析的周报 JSON（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次，stopReason=${response.stopReason}）`;
    if (attempt < MAX_MODEL_ATTEMPTS) {
      onProgress?.(`模型输出未通过校验（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次），正在重写`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  throw new Error(lastError);
}

/**
 * 客户版 Markdown 的唯一权威渲染（Web 复制、Wiki 发布正文、CLI 默认输出均复用本函数产物，
 * 不允许任何一端自行拼装第二份格式）。只输出客户可见正文：章节标题用中文数字（一、二、三、四），
 * 各章节条目统一阿拉伯数字有序编号；source/category/date 降级为内部元数据；不含统计引用块、
 * 来源括号与内部评级。
 */
export function renderWeeklyMarkdown(report: WeeklyReport, customerName = '客户'): string {
  const bodies: Record<keyof WeeklyReportContent, string> = {
    summary: String(report.content.summary ?? '').trim(),
    accomplishments: (report.content.accomplishments ?? []).map((item, index) => `${index + 1}. ${item.text}`).join('\n'),
    next_week_plan: (report.content.next_week_plan ?? []).map((item, index) => `${index + 1}. ${item.text}`).join('\n'),
    risks: (report.content.risks ?? []).map((item, index) => `${index + 1}. ${item.text}`).join('\n') || WEEKLY_NO_RISK_SENTENCE,
  };
  return [
    `# ${customerName} ONES 项目实施周报\n`,
    `周报周期：${report.weekStart} 至 ${report.weekEnd}\n`,
    ...WEEKLY_REPORT_SECTIONS.map((section, index) => `## ${SECTION_NUMBERS[index]}、${section.label}\n\n${bodies[section.key] || '待补充'}\n`),
  ].join('\n');
}

/** 章节序号（与 WEEKLY_REPORT_SECTIONS 顺序对应）。 */
const SECTION_NUMBERS = ['一', '二', '三', '四'];

/**
 * 内部证据残留检测（非阻断）：新版提示词生成的正文不应命中；历史周报（旧版提示词）的
 * 叙述文本可能已把内部统计/评级写进正文，结构性剥离（source/category/统计行）无法覆盖，
 * 发布前向 CSM 提示人工复核。只查客户版正文可见的 summary 与各条目 text，不查 source。
 */
const WEEKLY_INTERNAL_EVIDENCE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /hemory/i, label: 'Hemory' },
  { pattern: /crm\s*跟进/i, label: 'CRM 跟进' },
  { pattern: /行动事项/, label: '行动事项' },
  { pattern: /待办事项/, label: '待办事项' },
  { pattern: /风险评级|风险评分|健康度|评分\s*\d+/, label: '内部风险评级/评分' },
  { pattern: /工时\s*[\d.]+\s*(?:小时|h)/i, label: '内部工时统计' },
  { pattern: /沟通\s*\d+\s*场/, label: '内部沟通场次统计' },
  { pattern: /新增(?:建议|工单|运维)\s*\d+/, label: '内部工单/建议统计' },
  { pattern: /\bunknown\b/i, label: 'unknown 占位词' },
  { pattern: /客户(?:不满|抱怨|担忧|焦虑)/, label: '客户情绪内部记录' },
  { pattern: /有坑/, label: '内部记录式表达「有坑」' },
];

export function weeklyContentWarnings(content: WeeklyReportContent): string[] {
  const textsByKey: Record<keyof WeeklyReportContent, string[]> = {
    summary: [String(content.summary ?? '')],
    accomplishments: (content.accomplishments ?? []).map((item) => String(item.text ?? '')),
    next_week_plan: (content.next_week_plan ?? []).map((item) => String(item.text ?? '')),
    risks: (content.risks ?? []).map((item) => String(item.text ?? '')),
  };
  const warnings: string[] = [];
  for (const { pattern, label } of WEEKLY_INTERNAL_EVIDENCE_PATTERNS) {
    const hits = WEEKLY_REPORT_SECTIONS
      .filter((section) => (textsByKey[section.key] ?? []).some((text) => pattern.test(text)))
      .map((section) => section.label);
    if (hits.length) warnings.push(`客户版正文检出内部信息「${label}」（${hits.join('、')}），请确认已转换为面向客户的表达后再发布`);
  }
  return warnings;
}

export class WeeklyReportService {
  private processing = new Set<string>();

  constructor(
    private readonly db: WorkbenchDatabase,
    private readonly mcp: McpHub,
    private readonly runtime?: Runtime,
    private readonly workhours?: (customerId: string) => Promise<{ records: Array<{ startTime: string; hours: number; description: string; owner?: string }> }>,
  ) {}

  /** 任务是否在本进程处理中：running 状态跨进程不可信（服务重启遗留的孤儿永不终结），stalled 装饰与 heretry 同源。 */
  isJobProcessing(jobId: string): boolean {
    return this.processing.has(jobId);
  }

  list(customerId: string): WeeklyReport[] {
    return this.db.listWeeklyReports(customerId);
  }

  get(reportId: string): WeeklyReport | undefined {
    return this.db.getWeeklyReport(reportId);
  }

  /** 详情出口：附服务端权威渲染的客户版 Markdown 与内部证据残留警告（Web 复制/CLI 默认输出共用）。 */
  detailWithMarkdown(reportId: string): { report: WeeklyReport; markdown: string; warnings: string[] } | undefined {
    const report = this.db.getWeeklyReport(reportId);
    if (!report) return undefined;
    const customer = this.db.getCustomer(report.customerId);
    return { report, markdown: renderWeeklyMarkdown(report, customer?.name), warnings: weeklyContentWarnings(report.content) };
  }

  /**
   * 生成（或幂等复用）某客户某周的周报任务。指纹 = 版本:客户:周:事件集哈希；
   * 已有同指纹周报直接返回原任务；force 加盐换指纹强制重建。失败任务不落墓碑指纹，重试不会被幂等短路。
   */
  /**
   * 某客户某周的完整事件上下文：创建在本周的全部事件（Hemory 片段、CRM 跟进、工作项等）
   * + 更新在本周的 ONES 工作项（不限创建时间），工作项按 id 去重。
   */
  private weeklyEvents(customerId: string, weekStart: string): { events: SourceEvent[]; hemory: SourceEvent[]; workItems: SourceEvent[] } {
    const range = weekRange(weekStart);
    const events = this.db.listSourceEventsInRange(customerId, { since: range.start, until: range.end });
    const hemory = this.db.listHemoryFragments({ customerId, status: 'confirmed', since: range.start, until: range.end, limit: 500 });
    const updated = this.db.listOnesWorkItemsUpdatedInRange(customerId, range.start, range.end);
    const seen = new Set(events.map((event) => event.id));
    const workItems = [...events.filter((event) => event.sourceSystem === 'ones'
      && ['suggestion_feedback', 'support_ticket', 'operations_ticket', 'private_cloud_instance'].includes(event.sourceType)),
    ...updated.filter((event) => !seen.has(event.id))];
    return { events, hemory, workItems };
  }

  generate(customerId: string, weekStartInput: string, force = false): { jobId: string | null; fingerprint: string; weekStart: string } {
    const customer = this.db.getCustomer(customerId);
    if (!customer) throw new Error('customer not found');
    const weekStart = weekMonday(weekStartInput);
    const { events, hemory, workItems } = this.weeklyEvents(customerId, weekStart);
    if (!events.length && !hemory.length) throw new Error(`${weekStart} 这一周没有该客户的任何数据（请先同步）`);
    // 指纹覆盖创建在本周的事件 + 更新在本周的工作项（按 id 去重），任一变化都会换指纹重建。
    const all = [...events, ...workItems.filter((item) => !events.some((event) => event.id === item.id))];
    const fingerprint = weeklyFingerprint(customerId, weekStart, all, hemory);
    const existingReport = this.db.getWeeklyReportByWeek(customerId, weekStart);
    if (existingReport && !force && existingReport.fingerprint === fingerprint) {
      const job = this.db.findDraftJobByFingerprint(fingerprint);
      return { jobId: job?.id ?? null, fingerprint, weekStart };
    }
    const finalFingerprint = existingReport || force
      ? hash(`${fingerprint}:regenerate:${Date.now()}:${Math.random()}`)
      : fingerprint;
    const sourceEventIds = [...new Set([...events.map((event) => event.id), ...hemory.map((event) => event.id), ...workItems.map((event) => event.id)])];
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
    const report_ = (text: string) => this.db.updateDraftJobProgress(jobId, text);
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
      report_(`正在汇总 ${weekStart.slice(5)} 周上下文…`);
      const { events, hemory, workItems } = this.weeklyEvents(customer.id, weekStart);
      if (!events.length && !hemory.length) throw new Error(`${weekStart} 这一周没有该客户的任何数据`);
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
      const stats = buildStats(weekStart, { workItems, hemory, workhours: workhoursTotal, actionsCompleted });
      if (!this.runtime) throw new Error('模型未配置，无法生成周报（请检查 LLM 配置后重新生成）');
      report_(`证据就绪（${workItems.length} 个工作项 / ${hemory.length} 个沟通片段），模型撰写中…`);
      let content: WeeklyReportContent;
      try { content = await proposeWithModel(this.runtime, { customer, weekStart, weekEnd: range.weekEnd, events, hemory, workItems, stats, workhourRecords, actions, risk: riskRow ? { level: riskRow.level, score: riskRow.score } : null }, report_); }
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

  publishPreview(reportId: string, parentPageID: string): { report: WeeklyReport; tool: string; args: Record<string, unknown>; approvalHash: string; warnings: string[] } {
    const report = this.db.getWeeklyReport(reportId);
    if (!report || report.status !== 'draft') throw new Error('周报不可发布（不存在或已发布）');
    if (!parentPageID.trim()) throw new Error('缺少 ONES Wiki 父页面 ID');
    const customer = this.db.getCustomer(report.customerId);
    const tool = 'mcp__ones__create_page';
    const args = { parentPageID, title: `${customer?.name ?? '客户'} ONES 项目实施周报（${report.weekStart} ~ ${report.weekEnd}）`, content: renderWeeklyMarkdown(report, customer?.name) };
    // warnings 是非阻断提示（历史周报正文可能残留内部信息），不参与 approvalHash——哈希只锚定发布参数。
    return { report, tool, args, approvalHash: argumentsHash({ reportId, version: report.version, tool, args }), warnings: weeklyContentWarnings(report.content) };
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
export function weeklyFingerprint(customerId: string, weekStart: string, events: SourceEvent[], hemory: SourceEvent[]): string {
  const all = [...events, ...hemory].sort((a, b) => a.id.localeCompare(b.id)).map((event) => `${event.id}:${event.payloadHash}`);
  return hash(`${WEEKLY_REPORT_GENERATION_VERSION}:${customerId}:${weekStart}:${all.join('|')}`);
}
