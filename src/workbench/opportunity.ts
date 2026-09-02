import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { extractText } from '../agent.js';
import type { WorkbenchDatabase } from './database.js';
import { summarizeWebSignals } from './risk.js';
import type { Customer, EvidenceInput } from './types.js';

/**
 * 增购机会 v2：LLM 从「会议录音片段 + 公开动态」两类证据中识别机会假设，
 * 数量不固定、按可信度排序、展示侧取前 5。
 * ONES 建议与反馈、CRM 客户需求字段不再作为增购信号来源（业务拍板：建议工单大概率不驱动增购）。
 */

/** 分析版本：提示词/解析契约变更时升版本（参与输入指纹，升版本即触发全量重析）。 */
export const OPPORTUNITY_ANALYSIS_VERSION = 'csm-opportunity-v2';

/** 上次成功后证据有变化时的重析节流（小时）：避免高频同步反复打断点。 */
export const OPPORTUNITY_REFRESH_HOURS = 24;
/** 上次失败后的重试间隔（小时）：比成功门短，当天内可自愈（relay 坏窗口是分钟级）。 */
export const OPPORTUNITY_FAILURE_RETRY_HOURS = 1;

/** 喂给模型的会议证据条数/单条原文截断（字）：控制预算又不丢近期信号。 */
const HEMORY_SIGNAL_LIMIT = 12;
const HEMORY_DETAIL_CHARS = 500;
/** 喂给模型的正向公开动态条数上限。 */
const WEB_SIGNAL_LIMIT = 8;
/** 单次分析允许落库的最大条数（展示侧再取前 5）。 */
const MAX_OPPORTUNITIES = 8;
/** 单条假设最多引用的证据数（detail 概要串随之收敛）。 */
const MAX_REFS_PER_ITEM = 4;

/** 会议证据里兼看客户声音行（风险类转写也可能夹带增购诉求，与 v1 口径一致）。 */
const HEMORY_VOICE_PATTERN = /增购|扩容|采购|需要|模块/;

export interface OpportunitySignalSet {
  hemory: EvidenceInput[];
  web: EvidenceInput[];
}

/** v1 规则双假设的同款信号口径收敛为「只看 hemory + web」两类输入。 */
export function collectOpportunitySignals(evidence: EvidenceInput[], now = new Date()): OpportunitySignalSet {
  const hemory = evidence.filter((item) =>
    item.sourceSystem === 'hemory' && (item.kind === 'opportunity' || (item.kind === 'voice' && HEMORY_VOICE_PATTERN.test(item.detail))));
  const web = summarizeWebSignals(evidence, now).positive;
  return { hemory: hemory.slice(0, HEMORY_SIGNAL_LIMIT), web: web.slice(0, WEB_SIGNAL_LIMIT) };
}

/** 输入指纹：分析版本 + 信号集合（id:日期）。窗口漂移/重切/新动态都会改变集合，纯时间推移不触发。 */
export function opportunityInputFingerprint(signals: OpportunitySignalSet): string {
  const parts = [...signals.hemory, ...signals.web].map((item) => `${item.id}:${item.occurredAt}`).sort();
  return createHash('sha256').update(`${OPPORTUNITY_ANALYSIS_VERSION}|${parts.join('|')}`).digest('hex');
}

export interface ParsedOpportunity {
  summary: string;
  confidence: number;
  evidence: EvidenceInput[];
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

/**
 * 解析模型输出：编号回映射到真实证据、过滤幻觉引用（引用全空的条目丢弃）、
 * confidence 夹取、summary 截断去重，按可信度降序。
 * 结构性不可解析（非 JSON / 无 opportunities 数组）抛错——按失败处理保留旧假设，
 * 不把「模型抽风」误当「确认无机会」清空列表。
 */
export function parseOpportunityAnalysis(text: string, byRef: Map<string, EvidenceInput>): ParsedOpportunity[] {
  const value = cleanJson(text) as { opportunities?: unknown[] } | null;
  if (!value || !Array.isArray(value.opportunities)) throw new Error('模型输出无法解析为增购机会 JSON');
  const parsed: ParsedOpportunity[] = [];
  const seen = new Set<string>();
  for (const raw of value.opportunities) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const summary = typeof item.summary === 'string' ? item.summary.trim().slice(0, 60) : '';
    if (!summary || seen.has(summary)) continue;
    const refs = Array.isArray(item.evidence_ids) ? item.evidence_ids : [];
    // 幻觉编号被映射过滤；同一假设内重复引用同一证据去重；一条假设至少要有一条真实证据支撑。
    const evidence = [...new Set(refs.map((ref) => typeof ref === 'string' && byRef.get(ref.trim())).filter((item): item is EvidenceInput => !!item))];
    if (!evidence.length) continue;
    const rawConfidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? item.confidence : 0.5;
    seen.add(summary);
    parsed.push({ summary, confidence: Math.min(0.95, Math.max(0.05, rawConfidence)), evidence: evidence.slice(0, MAX_REFS_PER_ITEM) });
  }
  return parsed.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_OPPORTUNITIES);
}

function sourceBrief(items: EvidenceInput[]): string {
  return items.map((item) => `${item.sourceSystem === 'hemory' ? '会议录音' : '公开动态'}（${item.occurredAt.slice(0, 10)}）`).join('；');
}

export interface OpportunityRunResult {
  customerId: string;
  status: 'succeeded' | 'skipped' | 'failed';
  reason?: string;
  /** 本次落库的假设条数（succeeded 时有意义）。 */
  generated?: number;
}

export class OpportunityService {
  /** 串行执行队列：全客户共用，避免定时/手动/启动多路触发并发打爆模型。 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 已排队未跑完的自动调度客户（recompute 可能一轮同步内触发多次）。 */
  private scheduled = new Set<string>();

  constructor(
    private readonly db: WorkbenchDatabase,
    private readonly runtime: Runtime,
  ) {}

  /** 自动调度（recompute/启动）：fire-and-forget，同客户去重，失败只记日志。 */
  schedule(customerId: string): void {
    if (this.scheduled.has(customerId)) return;
    this.scheduled.add(customerId);
    void this.analyze(customerId).finally(() => this.scheduled.delete(customerId));
  }

  /** 排队执行一次分析并返回结果（手动刷新与自动调度同一队列）；now 供测试注入时钟。 */
  async analyze(customerId: string, options: { force?: boolean; now?: number } = {}): Promise<OpportunityRunResult> {
    const job = this.chain.then(async (): Promise<OpportunityRunResult> => {
      try {
        return await this.execute(customerId, !!options.force, options.now ?? Date.now());
      } catch (error) {
        const message = (error as Error).message;
        console.warn(`[opportunity] 客户 ${customerId} 增购机会分析失败（保留旧假设）: ${message}`);
        return { customerId, status: 'failed', reason: message };
      }
    });
    this.chain = job.then(() => undefined, () => undefined);
    return job;
  }

  private async execute(customerId: string, force: boolean, now: number): Promise<OpportunityRunResult> {
    const customer = this.db.getCustomer(customerId);
    if (!customer) return { customerId, status: 'skipped', reason: '客户不存在' };
    const signals = collectOpportunitySignals(this.db.listEvidence(customerId), new Date(now));
    const fingerprint = opportunityInputFingerprint(signals);
    const last = this.db.getOpportunityGeneration(customerId);
    if (!force && last) {
      if (last.status === 'succeeded' && last.inputFingerprint === fingerprint) return { customerId, status: 'skipped', reason: '证据无变化' };
      const waitHours = last.status === 'succeeded' ? OPPORTUNITY_REFRESH_HOURS : OPPORTUNITY_FAILURE_RETRY_HOURS;
      const elapsed = now - new Date(last.generatedAt).getTime();
      if (Number.isFinite(elapsed) && elapsed < waitHours * 3_600_000) {
        return { customerId, status: 'skipped', reason: last.status === 'succeeded' ? `距上次分析不足 ${waitHours} 小时` : '距上次失败不足重试间隔' };
      }
    }

    // 无信号是确定性结果：不调模型直接清空（旧假设已无证据支撑），全量替换后记录成功指纹。
    let parsed: ParsedOpportunity[];
    try {
      parsed = signals.hemory.length + signals.web.length === 0 ? [] : await this.callModel(customer, signals);
    } catch (error) {
      // 失败也落生成记录：门控按「失败 1 小时后才可重试」节流，旧假设原样保留。
      this.db.saveOpportunityGeneration(customerId, fingerprint, 'failed', (error as Error).message);
      throw error;
    }
    this.db.replaceOpportunities(customerId, parsed.map((item) => ({
      type: 'signal_expansion', title: item.summary, detail: sourceBrief(item.evidence), confidence: item.confidence,
      status: 'hypothesis' as const, evidenceRefs: item.evidence.map((item2) => item2.id!).filter(Boolean),
      discoveryQuestions: [], recommendedAction: '',
    })));
    this.db.saveOpportunityGeneration(customerId, fingerprint, 'succeeded');
    return { customerId, status: 'succeeded', generated: parsed.length };
  }

  /** 单次模型调用；模型失败即抛错（execute 之外记录失败态、保留旧假设）。 */
  private async callModel(customer: Customer, signals: OpportunitySignalSet): Promise<ParsedOpportunity[]> {
    const byRef = new Map<string, EvidenceInput>();
    const blocks: string[] = [];
    let index = 0;
    if (signals.hemory.length) {
      const lines = signals.hemory.map((item) => {
        const ref = `S${++index}`;
        byRef.set(ref, item);
        return `${ref}. 日期: ${item.occurredAt.slice(0, 10)}\n   原文: ${item.detail.slice(0, HEMORY_DETAIL_CHARS)}`;
      });
      blocks.push(`【会议录音片段（客户在会上的原话摘录）】\n${lines.join('\n')}`);
    }
    if (signals.web.length) {
      const lines = signals.web.map((item) => {
        const ref = `S${++index}`;
        byRef.set(ref, item);
        return `${ref}. 日期: ${item.occurredAt.slice(0, 10)}${item.sourceUrl ? `  来源: ${item.sourceUrl}` : ''}\n   摘要: ${item.label}——${item.detail.slice(0, 200)}`;
      });
      blocks.push(`【公开动态（近 90 天正向动态）】\n${lines.join('\n')}`);
    }
    const prompt = `客户：${customer.name}${customer.shortName && customer.shortName !== customer.name ? `（简称 ${customer.shortName}）` : ''}${customer.industry ? `，行业：${customer.industry}` : ''}

以下是该客户的增购/扩容相关证据：

${blocks.join('\n\n')}

请从上述证据中识别「增购机会假设」：
- summary：一句话（40 字以内）说清机会点——客户可能增购什么、依据是什么。
- confidence：0~1 可信度；证据越直接、越近期、越多源，可信度越高。
- evidence_ids：支撑该假设的证据编号（如 ["S1","S2"]），至少 1 条，只能使用上面出现过的编号。
- 只依据给定证据，不得编造或推断无据可依的机会；同一证据可支撑多条假设。
- 按可信度从高到低输出，最多 ${MAX_OPPORTUNITIES} 条；证据不足以构成机会时输出空列表。
只输出 JSON：{"opportunities": [{"summary": "", "confidence": 0.0, "evidence_ids": []}]}`;

    const response = await this.runtime.models.complete(this.runtime.model, {
      systemPrompt: `你是 CSM 工作台的增购机会分析器（${OPPORTUNITY_ANALYSIS_VERSION}）。你只能基于用户提供的证据分析，不执行任何工具或外部写入。`,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    });
    if (response.stopReason === 'error') {
      throw new Error(`增购机会分析模型调用失败: ${response.errorMessage || '未知错误'}`);
    }
    return parseOpportunityAnalysis(extractText(response.content), byRef);
  }
}
