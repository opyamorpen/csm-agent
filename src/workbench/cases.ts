import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { argumentsHash } from '../approval.js';
import { extractText } from '../agent.js';
import type { McpHub } from '../mcp/index.js';
import { onesAsrAliasRule } from './drafts.js';
import { WorkbenchDatabase } from './database.js';
import type { CaseDraft, Customer, EvidenceInput, OpportunityHypothesis, RiskAssessment, SourceEvent } from './types.js';

export const CASE_GENERATION_VERSION = 'case-v1-narrative';

/** 案例五段叙事的字段契约（templates/case.json 同源描述，供前端/CLI 展示）。 */
export interface CaseNarrativeFields {
  background: string;
  challenges: string[];
  requirements: string[];
  solution: string;
  value: string[];
}

export const CASE_SECTIONS: Array<{ key: keyof CaseNarrativeFields; label: string; description: string }> = [
  { key: 'background', label: '客户背景', description: '客户行业、业务概况与合作起点的一段连贯叙述' },
  { key: 'challenges', label: '痛点、现状与挑战', description: '合作前/合作中面临的核心业务痛点、现状困难与挑战' },
  { key: 'requirements', label: '需求与要求', description: '客户明确提出的功能诉求、交付要求与服务标准' },
  { key: 'solution', label: '解决方案', description: '问题如何被分析、设计、实施与协同解决（含关键实施路径与里程碑）' },
  { key: 'value', label: '价值与成效', description: '已确认的客户价值：量化结果优先，无量化写有据定性价值' },
];

/** 章节序号（与 CASE_SECTIONS 顺序对应）。 */
const CASE_SECTION_NUMBERS = ['一', '二', '三', '四', '五'];

/** 转写注入预算：超预算按片段均摊截取（保留每片段开头——背景与诉求信号多出现在对话开头）。 */
const TRANSCRIPT_BUDGET = 36_000;
/** 案例上下文注入的最大 Hemory 片段数（超出的按最早 1/3 + 最近 2/3 保留：背景靠早期证据，价值靠近期证据）。 */
const MAX_CASE_FRAGMENTS = 150;

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

function nestedName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return String(record.name ?? record.value ?? record.label ?? '');
  }
  return '';
}

function textOf(event: SourceEvent): string {
  return String(event.payload?.transcript ?? event.title);
}

/**
 * 读取案例五段正文（含存量草稿兼容）：新键 challenges/value 缺失时回退旧键
 * pain_points/results（旧 results 为 {metric,value} 数组）；requirements 无旧对应，缺省为空。
 */
export function caseSectionTexts(fields: Record<string, unknown>): CaseNarrativeFields {
  const list = (value: unknown): string[] => Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item : `${(item as Record<string, unknown>)?.metric ?? ''}: ${(item as Record<string, unknown>)?.value ?? ''}`.trim())
      .map((item) => item.trim()).filter(Boolean)
    : [];
  return {
    background: typeof fields.background === 'string' ? fields.background.trim() : '',
    challenges: Array.isArray(fields.challenges) ? fields.challenges.map(String).map((item) => item.trim()).filter(Boolean) : list(fields.pain_points),
    requirements: Array.isArray(fields.requirements) ? fields.requirements.map(String).map((item) => item.trim()).filter(Boolean) : [],
    solution: typeof fields.solution === 'string' ? fields.solution.trim() : '',
    value: Array.isArray(fields.value) ? fields.value.map(String).map((item) => item.trim()).filter(Boolean) : list(fields.results),
  };
}

/**
 * 客户版 Markdown 的唯一权威渲染（Web 复制、Wiki 发布正文、CLI 默认输出均复用本函数产物，
 * 不允许任何一端自行拼装第二份格式）。只输出客户可见正文：章节标题用中文数字（一~五），
 * 条目章节统一阿拉伯数字有序编号；evidenceRefs/evidence_map/unknowns 等内部元数据不渲染。
 */
export function renderCaseMarkdown(draft: CaseDraft): string {
  const texts = caseSectionTexts(draft.fields);
  const bodies: Record<keyof CaseNarrativeFields, string> = {
    background: texts.background,
    challenges: texts.challenges.map((item, index) => `${index + 1}. ${item}`).join('\n'),
    requirements: texts.requirements.map((item, index) => `${index + 1}. ${item}`).join('\n'),
    solution: texts.solution,
    value: texts.value.map((item, index) => `${index + 1}. ${item}`).join('\n'),
  };
  return [
    `# ${draft.title}\n`,
    ...CASE_SECTIONS.map((section, index) => `## ${CASE_SECTION_NUMBERS[index]}、${section.label}\n\n${bodies[section.key] || '待补充'}\n`),
  ].join('\n');
}

/** 模型输出契约的结构化校验：background/solution 必须非空字符串，列表缺省为空数组，内部键容错。 */
export function parseCaseContent(value: unknown): { title?: string } & CaseNarrativeFields & { evidence_map?: Record<string, string>; unknowns?: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型未返回案例 JSON 对象');
  const raw = value as Record<string, unknown>;
  const background = typeof raw.background === 'string' ? raw.background.trim() : '';
  const solution = typeof raw.solution === 'string' ? raw.solution.trim() : '';
  if (!background) throw new Error('模型未返回客户背景');
  if (!solution) throw new Error('模型未返回解决方案');
  const list = (input: unknown): string[] => Array.isArray(input) ? input.map(String).map((item) => item.trim()).filter(Boolean) : [];
  let evidenceMap: Record<string, string> | undefined;
  if (raw.evidence_map && typeof raw.evidence_map === 'object' && !Array.isArray(raw.evidence_map)) {
    const entries = Object.entries(raw.evidence_map as Record<string, unknown>)
      .map(([key, item]) => [key, String(item).trim()] as const)
      .filter(([, item]) => item);
    if (entries.length) evidenceMap = Object.fromEntries(entries);
  }
  return {
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined,
    background, challenges: list(raw.challenges), requirements: list(raw.requirements), solution, value: list(raw.value),
    evidence_map: evidenceMap, unknowns: list(raw.unknowns),
  };
}

interface CasePromptInput {
  customer: Customer;
  timeline: SourceEvent[];
  hemory: SourceEvent[];
  evidence: EvidenceInput[];
  risk: RiskAssessment | null;
  opportunities: OpportunityHypothesis[];
}

/** 片段选择：超上限时保留最早 1/3 + 最近 2/3（背景/痛点靠早期证据，价值靠近期证据），再按预算均摊截头。 */
function selectFragments(hemory: SourceEvent[]): SourceEvent[] {
  const sorted = [...hemory].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  if (sorted.length <= MAX_CASE_FRAGMENTS) return sorted;
  const early = Math.max(1, Math.floor(MAX_CASE_FRAGMENTS / 3));
  return [...sorted.slice(0, early), ...sorted.slice(-(MAX_CASE_FRAGMENTS - early))];
}

function renderContext(input: CasePromptInput): string {
  const { customer, timeline, hemory, evidence, risk, opportunities } = input;
  const confirmed = timeline.filter((event) => event.attributionStatus === 'confirmed');
  const records = confirmed
    .filter((event) => event.sourceSystem !== 'hemory' && event.sourceType !== 'crm_followup')
    .map((event) => ({ date: event.occurredAt.slice(0, 10), system: event.sourceSystem, type: event.sourceType,
      display: event.displayId ?? '', title: event.title.slice(0, 120), status: nestedName(event.payload?.field005) || '' }));
  const followups = confirmed
    .filter((event) => event.sourceType === 'crm_followup')
    .map((event) => ({ date: event.occurredAt.slice(0, 10), title: event.title.slice(0, 120),
      content: String(event.payload?.active_record_content ?? event.title).slice(0, 400) }));
  const fragments = selectFragments(hemory);
  const perFragment = Math.max(400, Math.floor(TRANSCRIPT_BUDGET / Math.max(1, fragments.length)));
  const communications = fragments.map((event) => ({
    id: event.id, occurred_at: event.occurredAt, topic: event.title, recording_id: String(event.payload?.recordingId ?? ''),
    speakers: Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : [],
    summary: typeof event.payload?.summary === 'string' ? event.payload.summary : '',
    transcript: textOf(event).slice(0, perFragment),
  }));
  return JSON.stringify({
    customer: { id: customer.id, name: customer.name, industry: customer.industry ?? null, usage_version: customer.usageVersion ?? null,
      products: customer.products ?? [], csm: customer.csmName ?? null, contract_status: customer.contractStatus ?? null,
      renewal_date: customer.renewalDate ?? null, health: customer.health ?? null },
    signals: evidence.map((item) => ({ kind: item.kind, label: item.label, detail: item.detail.slice(0, 200), occurred_at: item.occurredAt })),
    risk: risk ? { level: risk.level, dimensions: Object.keys(risk.dimensions ?? {}) } : null,
    opportunities: opportunities.map((item) => ({ title: item.title, detail: item.detail.slice(0, 200) })),
    communications,
    records,
    crm_followups: followups,
  });
}

async function proposeCaseWithModel(runtime: Runtime, input: CasePromptInput): Promise<ReturnType<typeof parseCaseContent>> {
  const prompt = `为客户「${input.customer.name}」生成一篇客户成功案例草稿。这份案例经 CSM 审核后会用于对外展示与复用，是正式的客户叙事型案例。你只能基于下面提供的上下文证据写作，不执行任何工具或外部写入。\n`
    + `按固定叙事路径输出五个章节，只输出 JSON：\n`
    + `{"title":"...","background":"...","challenges":["..."],"requirements":["..."],"solution":"...","value":["..."],"evidence_map":{"background":"...","challenges":"..."},"unknowns":["..."]}\n`
    + `写作总则（全部章节适用）：\n`
    + `- 客户叙事视角：客户是主角，按「背景 → 痛点/现状/挑战 → 需求/要求 → 解决方案 → 价值」的故事路径组织；不按 CRM、ONES、会议记录等数据来源罗列过程。\n`
    + `- 多个系统中同一件事必须合并为一条叙述，禁止会议流水账与工单流水账。\n`
    + `- 只写有证据的事实；上下文中的风险评级、健康度、工时、行动事项等内部信号只用于帮助你理解事实，一律不写入正文。\n`
    + `- 价值纪律：优先使用已确认的量化结果；没有量化证据时只写有证据支持的定性价值，禁止虚构 ROI、百分比或任何数字。\n`
    + `- 未确认的内容标记为「待确认」或直接不写，禁止推断补全；无法确定的关键信息写入 unknowns。\n`
    + `- 正文禁止出现 unknown 等占位词、内部系统名（Hemory、CRM）、风险评级/评分、工时统计、行动事项等内部信息，禁止出现联系人姓名、联系方式、合同金额，不得泄露其他客户或其他项目的信息。\n`
    + `章节要求：\n`
    + `1. background（客户背景）：一段连贯叙述——客户所处行业、业务概况、与 ONES 合作的起点与目标。依据客户档案与早期沟通记录。\n`
    + `2. challenges（痛点、现状与挑战）：3~6 条，客户在合作前或合作中面临的核心业务痛点、现状困难与挑战，来自工单/建议/运维记录与会议中客户表达的诉求。\n`
    + `3. requirements（需求与要求）：2~6 条，客户明确提出的需求与要求（功能诉求、交付要求、服务标准）；有明确时间节点的要求保留节点。\n`
    + `4. solution（解决方案）：一段连贯叙述，说明客户的问题如何被分析、设计、实施与协同解决，包含关键实施路径与里程碑（可换行分自然段），但不得退化为按日期罗列的事件流水。\n`
    + `5. value（价值与成效）：2~6 条，客户获得的已确认价值——量化结果优先（上线时间、效率改善、问题下降等），无量化写有证据支持的定性价值（流程改善、能力提升、用户反馈）。\n`
    + `内部字段（不进入正文）：evidence_map 为每个章节一条简短依据说明（如 "背景依据客户档案与 03 月启动会议；痛点来自工单 T-2001~T-2004"）；unknowns 为 CSM 需补充确认的关键信息清单。\n`
    + `title：案例标题，概括客户从痛点到价值的实践，也可朴素地写「${input.customer.name}客户成功案例」。\n`
    + `${onesAsrAliasRule()}该订正适用于全部正文。\n`
    + `上下文：${renderContext(input)}`;
  // 中继端点偶发连接超时（undici 10s 连接超时，实测坏窗口可持续数分钟）：complete 不抛异常而是
  // 返回 stopReason='error' + errorMessage，必须显式透出真实原因并自动重试；固定短间隔重试会整个
  // 落在同一坏窗口内，指数退避（5s→15s→45s）才能跨出去。
  const MAX_MODEL_ATTEMPTS = 3;
  const retryDelayMs = (attempt: number) => 5_000 * 3 ** (attempt - 1);
  let lastError = '模型未返回可解析的案例 JSON';
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
    const response = await runtime.models.complete(runtime.model, {
      systemPrompt: '你是 ONES 客户成功案例撰写助手。你产出的是经 CSM 审核后用于对外复用的客户成功案例正文：只能基于用户提供的证据写作，客观克制、客户叙事视角，不执行任何工具或外部写入。',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    });
    if (response.stopReason === 'error') {
      lastError = `模型调用失败（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次）: ${response.errorMessage || '未知错误'}`;
      if (attempt < MAX_MODEL_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      continue;
    }
    const value = cleanJson(extractText(response.content));
    if (value) return parseCaseContent(value);
    lastError = `模型未返回可解析的案例 JSON（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次，stopReason=${response.stopReason}）`;
    if (attempt < MAX_MODEL_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
  }
  throw new Error(lastError);
}

/**
 * 内部信息残留检测（非阻断）：新版提示词生成的正文不应命中；发布前向 CSM 提示人工复核。
 * 只查客户版正文可见的五段文本，不查 evidence_map/unknowns。
 */
const CASE_INTERNAL_EVIDENCE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /hemory/i, label: 'Hemory' },
  { pattern: /风险评级|风险评分|健康度/, label: '内部风险评级/健康度' },
  { pattern: /工时\s*[\d.]+\s*(?:小时|h)/i, label: '内部工时统计' },
  { pattern: /\bunknown\b/i, label: 'unknown 占位词' },
  { pattern: /客户(?:不满|抱怨|担忧|焦虑)/, label: '客户情绪内部记录' },
  { pattern: /有坑/, label: '内部记录式表达「有坑」' },
];

export function caseContentWarnings(draft: CaseDraft): string[] {
  const texts = caseSectionTexts(draft.fields);
  const textsByKey: Record<keyof CaseNarrativeFields, string[]> = {
    background: [texts.background],
    challenges: texts.challenges,
    requirements: texts.requirements,
    solution: [texts.solution],
    value: texts.value,
  };
  const warnings: string[] = [];
  for (const { pattern, label } of CASE_INTERNAL_EVIDENCE_PATTERNS) {
    const hits = CASE_SECTIONS
      .filter((section) => (textsByKey[section.key] ?? []).some((text) => pattern.test(text)))
      .map((section) => section.label);
    if (hits.length) warnings.push(`客户版正文检出内部信息「${label}」（${hits.join('、')}），请确认已转换为面向客户的表达后再发布`);
  }
  return warnings;
}

/** 案例上下文指纹：同客户同事件集合（含内容 hash）复用同一任务；数据变化自然换指纹重建。 */
export function caseFingerprint(customerId: string, timeline: SourceEvent[], hemory: SourceEvent[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const event of [...timeline, ...hemory].sort((a, b) => a.id.localeCompare(b.id))) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    parts.push(`${event.id}:${event.payloadHash}`);
  }
  return hash(`${CASE_GENERATION_VERSION}:${customerId}:${parts.join('|')}`);
}

export interface CaseDetail {
  draft: CaseDraft;
  markdown: string;
  warnings: string[];
  /** 生成后客户数据已变化（实时重算指纹 ≠ 草稿指纹）：非阻断提示「数据已更新，可重新生成」。 */
  contextStale: boolean;
  /** 生成上下文概览：各源条数与最近同步时间（当前实时值，供审核参考）。 */
  contextSummary: Array<{ system: string; count: number; lastSyncedAt: string | null }>;
}

export class CaseService {
  private processing = new Set<string>();

  constructor(
    private readonly db: WorkbenchDatabase,
    private readonly mcp: McpHub,
    private readonly runtime?: Runtime,
  ) {}

  /** 案例全量上下文：客户绑定的已确认事件（时间线 + 已确认 Hemory 片段）+ 证据信号 + 风险/机会。 */
  private collectContext(customerId: string): { timeline: SourceEvent[]; hemory: SourceEvent[]; evidence: EvidenceInput[]; risk: RiskAssessment | null; opportunities: OpportunityHypothesis[] } {
    return {
      timeline: this.db.listTimeline(customerId, 500),
      hemory: this.db.listHemoryFragments({ customerId, status: 'confirmed', limit: 500 }),
      evidence: this.db.listEvidence(customerId),
      risk: this.db.latestRisk(customerId),
      opportunities: this.db.listOpportunities(customerId),
    };
  }

  /**
   * 生成（或幂等复用）某客户的案例草稿任务。指纹 = 版本:客户:事件集哈希；
   * 最新草稿为草稿态且指纹一致时直接复用；force 加盐换指纹强制重建。失败任务不落草稿，重试不会被幂等短路。
   */
  generate(customerId: string, force = false): { jobId: string | null; draftId?: string; fingerprint: string; reused?: boolean } {
    const customer = this.db.getCustomer(customerId);
    if (!customer) throw new Error('customer not found');
    const { timeline, hemory, evidence } = this.collectContext(customerId);
    if (!timeline.length && !hemory.length && !evidence.length) throw new Error('该客户没有已同步数据（请先同步）');
    const fingerprint = caseFingerprint(customerId, timeline, hemory);
    const latest = this.db.listCaseDrafts(customerId)[0] ?? null;
    if (latest && !force && latest.status === 'draft' && latest.fingerprint === fingerprint) {
      return { jobId: null, draftId: latest.id, fingerprint, reused: true };
    }
    const finalFingerprint = latest || force
      ? hash(`${fingerprint}:regenerate:${Date.now()}:${Math.random()}`)
      : fingerprint;
    const sourceEventIds = [...new Set([...timeline.map((event) => event.id), ...hemory.map((event) => event.id)])];
    const job = this.db.createDraftJob(customerId, finalFingerprint, sourceEventIds, 'case_report');
    if (job.status !== 'succeeded') void this.process(job.id);
    return { jobId: job.id, fingerprint: finalFingerprint };
  }

  resumePending(): void {
    for (const job of this.db.listPendingDraftJobs('case_report')) if (job.attempts < 3) void this.process(job.id);
  }

  private async process(jobId: string): Promise<void> {
    if (this.processing.has(jobId)) return;
    const job = this.db.getDraftJob(jobId);
    if (!job || job.status === 'succeeded' || job.kind !== 'case_report') return;
    this.processing.add(jobId);
    this.db.updateDraftJob(jobId, 'running');
    try {
      const customer = this.db.getCustomer(job.customerId);
      if (!customer) throw new Error('customer not found');
      // 执行时重新收集全量数据：任务排队期间新同步的数据也会并入。
      const { timeline, hemory, evidence, risk, opportunities } = this.collectContext(customer.id);
      if (!timeline.length && !hemory.length && !evidence.length) throw new Error('该客户没有已同步数据');
      if (!this.runtime) throw new Error('模型未配置，无法生成案例（请检查 LLM 配置后重新生成）');
      let content: ReturnType<typeof parseCaseContent>;
      try { content = await proposeCaseWithModel(this.runtime, { customer, timeline, hemory, evidence, risk, opportunities }); }
      catch (error) { throw new Error(`模型未生成案例: ${(error as Error).message}`); }
      const generator = `${this.runtime.llm.provider}/${this.runtime.llm.model}`;
      const evidenceRefs = [...new Set([...timeline.map((event) => event.id), ...hemory.map((event) => event.id), ...evidence.map((item) => item.id!).filter(Boolean)])];
      const fields: Record<string, unknown> = {
        customer_id: customer.id, customer_name: customer.name,
        background: content.background, challenges: content.challenges, requirements: content.requirements,
        solution: content.solution, value: content.value,
      };
      if (content.evidence_map) fields.evidence_map = content.evidence_map;
      if (content.unknowns?.length) fields.unknowns = content.unknowns;
      const draft = this.db.createCaseDraft(customer.id, content.title ?? `${customer.name}客户成功案例`, fields, evidenceRefs,
        // 存执行时重算的自然指纹（任务指纹在 force 时加盐）：数据不变时再次生成正确走幂等复用。
        { fingerprint: caseFingerprint(customer.id, timeline, hemory), generator });
      this.db.updateDraftJob(jobId, 'succeeded');
      this.db.audit('agent', 'generate_case_draft', 'case_draft', draft.id, { customerId: customer.id, generator, fingerprint: job.fingerprint });
    } catch (error) {
      this.db.updateDraftJob(jobId, 'failed', (error as Error).message);
    } finally {
      this.processing.delete(jobId);
    }
  }

  /** 详情出口：附服务端权威渲染的客户版 Markdown、内部信息残留警告与上下文新鲜度/概览。 */
  detail(draftId: string): CaseDetail | undefined {
    const draft = this.db.getCaseDraft(draftId);
    if (!draft) return undefined;
    const { timeline, hemory } = this.collectContext(draft.customerId);
    const systems = new Map<string, { count: number; lastSyncedAt: string | null }>();
    for (const event of [...timeline, ...hemory]) {
      const current = systems.get(event.sourceSystem) ?? { count: 0, lastSyncedAt: null };
      current.count += 1;
      if (!current.lastSyncedAt || event.syncedAt > current.lastSyncedAt) current.lastSyncedAt = event.syncedAt;
      systems.set(event.sourceSystem, current);
    }
    return {
      draft,
      markdown: renderCaseMarkdown(draft),
      warnings: caseContentWarnings(draft),
      contextStale: !!draft.fingerprint && caseFingerprint(draft.customerId, timeline, hemory) !== draft.fingerprint,
      contextSummary: [...systems.entries()].map(([system, info]) => ({ system, ...info })).sort((a, b) => a.system.localeCompare(b.system)),
    };
  }

  publishPreview(draftId: string, parentPageID: string): { draft: CaseDraft; tool: string; args: Record<string, unknown>; approvalHash: string; warnings: string[] } {
    const draft = this.db.getCaseDraft(draftId);
    if (!draft || draft.status !== 'draft') throw new Error('草稿不可发布（不存在或已发布）');
    if (!parentPageID.trim()) throw new Error('缺少 ONES 案例库父页面 ID');
    const tool = 'mcp__ones__create_page';
    const args = { parentPageID, title: draft.title, content: renderCaseMarkdown(draft) };
    // warnings 是非阻断提示（正文可能残留内部信息），不参与 approvalHash——哈希只锚定发布参数。
    return { draft, tool, args, approvalHash: argumentsHash({ draftId, version: draft.version, tool, args }), warnings: caseContentWarnings(draft) };
  }

  async publish(draftId: string, version: number, parentPageID: string, approvalHash: string): Promise<CaseDraft> {
    const preview = this.publishPreview(draftId, parentPageID);
    const expected = argumentsHash({ draftId, version, tool: preview.tool, args: preview.args });
    if (preview.draft.version !== version || expected !== approvalHash) throw new Error('草稿版本或批准内容已变化，请重新确认');
    const result = await this.mcp.call(preview.tool, preview.args);
    if (result.isError) throw new Error(result.text);
    let pageId = '';
    try {
      const parsed = JSON.parse(result.text);
      pageId = String(parsed.pageID ?? parsed.id ?? parsed.data?.pageID ?? '');
    } catch {
      pageId = result.text.match(/[0-9a-f-]{8,}/i)?.[0] ?? '';
    }
    const published = this.db.markCasePublished(draftId, version, pageId || 'created-without-returned-id');
    if (!published) throw new Error('草稿状态已变化');
    this.db.audit('csm', 'publish_case', 'case_draft', draftId, { version, pageId: published.publishedPageId, approvalHash });
    return published;
  }
}
