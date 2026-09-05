import type { Runtime } from '../bootstrap.js';
import { extractText } from '../agent.js';
import { performRawWebSearch, type HttpPost, type WebResult } from '../tools/websearch.js';
import type { WorkbenchDatabase } from './database.js';
import { summarizeWebSignals, webSignalDetailPrefix, webSignalDetailTags, type WebSignalSentiment } from './risk.js';
import type { CompletionRate, Customer, EvidenceInput } from './types.js';

/** 同步路径公开动态检索版本：提示词/解析契约变更时升版本。v2 起 LLM 逐条判定 sentiment 并入库。 */
export const WEB_INTEL_VERSION = 'web-intel-v2';

/** csm-web-intelligence 的 8 个检索角度（顺序即优先级）。 */
export const WEB_INTEL_ANGLES: ReadonlyArray<{ key: string; label: string; query: string }> = [
  { key: 'financing', label: '融资/投资', query: '融资' },
  { key: 'contract', label: '重大合同与中标', query: '中标 签约' },
  { key: 'product', label: '产品发布', query: '发布 新品' },
  { key: 'executive', label: '高管变动', query: '高管 任命' },
  { key: 'org', label: '组织变动与裁员', query: '裁员 组织调整' },
  { key: 'sentiment', label: '负面舆情', query: '处罚 诉讼 投诉' },
  { key: 'hiring', label: '招聘动向', query: '招聘' },
  { key: 'policy', label: '行业政策', query: '政策' },
];

/** 合法角度分类（与 record_web_intelligence 工具一致）。 */
const WEB_INTEL_CATEGORIES = new Set(['financing', 'contract', 'product', 'executive', 'org', 'sentiment', 'hiring', 'policy', 'other']);

/** 公开动态新鲜度门（天）：与自动轮换周期对齐（每日整点 1 客户、约两周轮完全员），窗口内不重复搜。 */
export const WEB_INTEL_REFRESH_DAYS = 14;

/** 每角度取用的最大结果数（进 LLM 分类的候选量）。 */
const PER_ANGLE_LIMIT = 5;

/** 上次成功检索是否仍在新鲜度窗口内：同步路径的门（WebIntelService.isFresh）与轮换队列的入选判断共用同一口径。 */
export function isWebIntelFresh(lastSuccessAt: Date | null, now = new Date()): boolean {
  return lastSuccessAt !== null && now.getTime() - lastSuccessAt.getTime() < WEB_INTEL_REFRESH_DAYS * 86_400_000;
}

export interface WebIntelFinding {
  label: string;
  detail: string;
  occurred_at: string;
  source_url: string;
  category: string;
  /** LLM 判定的情感（公司视角：利空/中性/利好）；缺失时读取端走关键词 + 角度兜底。 */
  sentiment?: WebSignalSentiment | null;
}

export interface WebIntelRunResult {
  customerId: string;
  status: 'succeeded' | 'skipped' | 'failed';
  reason?: string;
  searched: number;
  /** 本轮新增落库条数（同一条旧闻跨轮命中不重复计）。 */
  saved: number;
  /** 本轮分类确认的动态总条数（含跨轮重复命中的旧闻）。 */
  total: number;
  findings: WebIntelFinding[];
}

export interface WebIntelDeps {
  getApiKey(): string | undefined;
  getMaxResults(): number;
  getKeylessEnabled(): boolean;
  fetcher?: HttpPost;
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

/** 同步落库与 record_web_intelligence 工具同款 detail 前缀：`[category|sentiment] 详情`（sentiment 缺省退回 `[category]`）。 */
function findingDetail(category: string, sentiment: WebSignalSentiment | null, detail: string): string {
  return webSignalDetailPrefix(category, sentiment, detail);
}

/** 标题/摘要须包含客户全称或简称才进入 LLM 分类（削减同名公司噪音）。 */
export function mentionsCustomer(result: WebResult, names: string[]): boolean {
  const haystack = `${result.title ?? ''} ${result.content ?? ''}`;
  return names.some((name) => name && haystack.includes(name));
}

/** 解析 LLM 分类输出：过滤缺 URL/日期/与客户无关的条目，绝不编造；sentiment 非法值归 null（读取端走兜底）。 */
export function parseWebIntelFindings(text: string): WebIntelFinding[] {
  const value = cleanJson(text) as { findings?: unknown[] } | null;
  if (!value || !Array.isArray(value.findings)) return [];
  const findings: WebIntelFinding[] = [];
  for (const raw of value.findings) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const url = typeof item.source_url === 'string' ? item.source_url.trim() : '';
    const occurredAt = typeof item.occurred_at === 'string' ? item.occurred_at.trim() : '';
    if (!label || !url || !/^\d{4}-\d{2}-\d{2}/.test(occurredAt)) continue; // 只落有来源、有日期的动态
    const category = typeof item.category === 'string' && WEB_INTEL_CATEGORIES.has(item.category.trim()) ? item.category.trim() : 'other';
    const sentiment = typeof item.sentiment === 'string' && ['negative', 'neutral', 'positive'].includes(item.sentiment.trim())
      ? item.sentiment.trim() as WebSignalSentiment
      : null;
    const detail = typeof item.detail === 'string' ? item.detail.trim() : '';
    findings.push({ label, detail, occurred_at: occurredAt.slice(0, 10), source_url: url, category, sentiment });
  }
  return findings;
}

export class WebIntelService {
  constructor(
    private readonly db: WorkbenchDatabase,
    private readonly runtime: Runtime,
    private readonly deps: WebIntelDeps,
  ) {}

  /** 该客户最近一次成功的公开动态检索是否仍在新鲜度窗口内（14 天门，节流全量同步）。 */
  isFresh(customerId: string, now = new Date()): boolean {
    return isWebIntelFresh(this.db.latestWebIntelSyncAt(customerId), now);
  }

  /**
   * 检索并落库一个客户的公开动态。失败抛错由调用方降级（不阻断主同步）；
   * 返回 saved=0 也是合法结果（无近期动态，unknown 口径）。
   */
  async refresh(customer: Customer, options: { force?: boolean } = {}): Promise<WebIntelRunResult> {
    if (!options.force && this.isFresh(customer.id)) {
      return { customerId: customer.id, status: 'skipped', reason: `近 ${WEB_INTEL_REFRESH_DAYS} 天已检索`, searched: 0, saved: 0, total: 0, findings: [] };
    }
    const run = this.db.createSyncRun('web_intelligence', customer.id);
    try {
      // 检索主体优先简称（召回更高），全称一并用于结果预过滤。
      const searchName = customer.shortName?.trim() || customer.name;
      const names = [customer.name, customer.shortName].filter((name): name is string => !!name?.trim());
      const collected: Array<{ angle: string; result: WebResult }> = [];
      let searched = 0;
      for (const angle of WEB_INTEL_ANGLES) {
        const outcome = await performRawWebSearch({
          query: `${searchName} ${angle.query}`,
          maxResults: Math.max(3, Math.min(this.deps.getMaxResults(), PER_ANGLE_LIMIT)),
          apiKey: this.deps.getApiKey(),
          keylessEnabled: this.deps.getKeylessEnabled(),
          topic: 'news',
          days: 90,
          fetcher: this.deps.fetcher,
        });
        searched += 1;
        for (const result of outcome.results) {
          if (mentionsCustomer(result, names)) collected.push({ angle: angle.key, result });
        }
      }

      const findings = collected.length ? await this.classifyWithModel(customer, searchName, collected) : [];
      // 轮次存档（run 即报告）：is_new 标记本轮新增；同一条旧闻跨轮命中不重复落库（自然键去重），只在轮次报告里留痕。
      const archived: Array<WebIntelFinding & { is_new: boolean }> = [];
      let saved = 0;
      for (const finding of findings) {
        const { created } = this.db.addEvidenceIdempotent({
          customerId: customer.id,
          kind: 'web_signal',
          label: finding.label,
          detail: findingDetail(finding.category, finding.sentiment ?? null, finding.detail),
          occurredAt: finding.occurred_at,
          confidence: 0.6,
          sourceSystem: 'web',
          sourceUrl: finding.source_url,
        });
        if (created) saved += 1;
        archived.push({ ...finding, is_new: created });
      }
      this.db.finishSyncRun(run.id, 'succeeded', { web_intelligence: { status: 'succeeded', searched, count: saved, total: findings.length, findings: archived } });
      return { customerId: customer.id, status: 'succeeded', searched, saved, total: findings.length, findings };
    } catch (error) {
      this.db.finishSyncRun(run.id, 'failed', { web_intelligence: { status: 'failed', error: (error as Error).message } }, (error as Error).message);
      throw error;
    }
  }

  /** 单次模型调用完成「过滤同名公司 + 提炼结构化动态」；模型失败即抛错（宁缺毋滥，不落半批）。 */
  private async classifyWithModel(customer: Customer, searchName: string, collected: Array<{ angle: string; result: WebResult }>): Promise<WebIntelFinding[]> {
    const context = collected.map(({ angle, result }, index) => (
      `${index + 1}. [角度:${angle}] 标题: ${result.title || '(无标题)'}\n   日期: ${result.publishedDate || 'unknown'}\n   来源: ${result.url}\n   摘要: ${(result.content ?? '').slice(0, 300)}`
    )).join('\n');
    const prompt = `检索主体：${customer.name}${customer.shortName && customer.shortName !== customer.name ? `（简称 ${customer.shortName}）` : ''}${customer.industry ? `，行业：${customer.industry}` : ''}

以下是对该公司最近三个月公开动态的联网检索结果（多角度）：

${context}

请完成两件事：
1. 剔除与该公司无关的同名公司结果（行业/地域明显不符）。
2. 把确认相关、有日期的动态提炼为结构化列表。每条动态必须：有来源 URL、有日期（YYYY-MM-DD，取不到精确日期就不采用该条）、label 一句话概括、detail 保留关键事实与数字、category 取 financing|contract|product|executive|org|sentiment|hiring|policy|other 之一、sentiment 取 negative|neutral|positive 之一——站在该公司的立场判断这条动态对公司自身是利空（negative）、利好（positive）还是无明显影响（neutral）。
   sentiment 只看动态与该公司的实质关系，不看字面词：如「推出新产品/获得荣誉/中标」是 positive；「人事任命/组织调整/例行披露」通常是 neutral；「被处罚/败诉/裁员/业绩下滑」是 negative；保险/担保类新闻中出现的「破产」「拖欠」若描述的是承保的风险事故而非公司自身，不是 negative。拿不准取 neutral。
只输出 JSON：{"findings": [{"label": "", "detail": "", "occurred_at": "YYYY-MM-DD", "source_url": "", "category": "", "sentiment": ""}]}
宁缺毋滥：不编造、不推断；提炼不出就输出空列表。`;
    const response = await this.runtime.models.complete(this.runtime.model, {
      systemPrompt: `你是 CSM 工作台的公开动态整理器（${WEB_INTEL_VERSION}）。你只能整理用户提供的检索结果，不执行任何工具或外部写入。检索主体是「${searchName}」。`,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    });
    if (response.stopReason === 'error') {
      throw new Error(`公开动态分类模型调用失败: ${response.errorMessage || '未知错误'}`);
    }
    return parseWebIntelFindings(extractText(response.content));
  }
}

/** 每批补判的最大条数：单客户全量 web_signal 证据分批送 LLM，控制单次调用体积。 */
const RECLASSIFY_BATCH_SIZE = 30;

export interface WebIntelReclassifyResult {
  customerId: string;
  status: 'succeeded' | 'skipped' | 'failed';
  reason?: string;
  /** 缺 sentiment 的候选条数（本轮回填目标）。 */
  candidates: number;
  /** 实际改写 detail 前缀的条数（LLM 未返回或非法值的条目保持原样，可重跑续判）。 */
  updated: number;
  /** 回填前后 90 天窗口内负向条数（读取口径与风险/预警同源）。 */
  negativeBefore: number;
  negativeAfter: number;
}

/** 旧 detail 前缀 `[category] ` 剥离：回填改写时保留原文正文。 */
function stripDetailPrefix(detail: string): string {
  return detail.replace(/^\[[a-z_]+(?:\|[a-z_]+)?\]\s?/, '');
}

/**
 * 存量情感回填：把缺 sentiment 的 web_signal 证据批给 LLM 判定情感，改写 detail 前缀为
 * `[category|sentiment]`（保留行 id，预警抑制语义不变）。重搜无法回填——addEvidenceIdempotent
 * 同自然键冲突时跳过不更新；本函数是唯一改写路径。风险/预警重算由调用方在回填后触发。
 */
export async function reclassifyWebIntelSentiment(
  db: WorkbenchDatabase,
  runtime: Runtime,
  customer: Customer,
  actor: string,
  now = new Date(),
): Promise<WebIntelReclassifyResult> {
  const negativeBefore = summarizeWebSignals(db.listEvidence(customer.id), now).negative.length;
  const pending = db.listEvidence(customer.id).filter((item) => {
    if (item.kind !== 'web_signal' || !item.id) return false;
    const { category, sentiment } = webSignalDetailTags(item.detail);
    // 只回填带 category 前缀但缺 sentiment 的行；无前缀的旧行保持原样（读取端本就只走关键词兜底）。
    return category !== null && sentiment === null;
  });
  if (!pending.length) {
    return { customerId: customer.id, status: 'skipped', reason: '没有缺情感判定的公开动态记录', candidates: 0, updated: 0, negativeBefore, negativeAfter: negativeBefore };
  }
  const searchName = customer.shortName?.trim() || customer.name;
  let updated = 0;
  for (let start = 0; start < pending.length; start += RECLASSIFY_BATCH_SIZE) {
    const batch = pending.slice(start, start + RECLASSIFY_BATCH_SIZE);
    const context = batch.map((item, index) => (
      `${index + 1}. [id:${item.id}] ${item.label}\n   详情: ${stripDetailPrefix(item.detail).slice(0, 300)}`
    )).join('\n');
    const prompt = `检索主体：${customer.name}${customer.shortName && customer.shortName !== customer.name ? `（简称 ${customer.shortName}）` : ''}

以下是 CSM 工作台已落库的该公司公开动态记录（旧版未判定情感，现逐条补判）：

${context}

请逐条判定 sentiment：站在该公司的立场，这条动态对公司自身是利空（negative）、利好（positive）还是无明显影响（neutral）。
只看动态与该公司的实质关系，不看字面词：「推出新产品/获得荣誉/中标」是 positive；「人事任命/组织调整/例行披露」通常是 neutral；「被处罚/败诉/裁员/业绩下滑/上市破发」是 negative；保险/担保类内容中出现的「破产」「拖欠」若描述的是承保的风险事故而非公司自身，不是 negative。拿不准取 neutral。
只输出 JSON：{"items": [{"id": "输入中的 id", "sentiment": "negative|neutral|positive"}]}
逐条都要覆盖；不编造 id。`;
    const response = await runtime.models.complete(runtime.model, {
      systemPrompt: `你是 CSM 工作台的公开动态情感补判器（${WEB_INTEL_VERSION}）。你只能判定用户提供的记录，不执行任何工具或外部写入。检索主体是「${searchName}」。`,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    });
    if (response.stopReason === 'error') {
      throw new Error(`情感补判模型调用失败: ${response.errorMessage || '未知错误'}`);
    }
    const value = cleanJson(extractText(response.content)) as { items?: unknown[] } | null;
    const byId = new Map(batch.map((item) => [item.id!, item]));
    for (const raw of Array.isArray(value?.items) ? value!.items! : []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const sentiment = typeof item.sentiment === 'string' && ['negative', 'neutral', 'positive'].includes(item.sentiment.trim())
        ? item.sentiment.trim() as WebSignalSentiment
        : null;
      const target = id ? byId.get(id) : undefined;
      if (!target || !sentiment) continue;
      const { category } = webSignalDetailTags(target.detail);
      db.updateEvidenceDetail(id, webSignalDetailPrefix(category ?? 'other', sentiment, stripDetailPrefix(target.detail)));
      updated += 1;
    }
  }
  const negativeAfter = summarizeWebSignals(db.listEvidence(customer.id), now).negative.length;
  db.audit(actor, 'web_intel.reclassify', 'customer', customer.id, { candidates: pending.length, updated, negativeBefore, negativeAfter });
  return { customerId: customer.id, status: 'succeeded', candidates: pending.length, updated, negativeBefore, negativeAfter };
}
