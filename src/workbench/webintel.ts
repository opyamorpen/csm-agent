import type { Runtime } from '../bootstrap.js';
import { extractText } from '../agent.js';
import { performRawWebSearch, type HttpPost, type WebResult } from '../tools/websearch.js';
import type { WorkbenchDatabase } from './database.js';
import type { CompletionRate, Customer, EvidenceInput } from './types.js';

/** 同步路径公开动态检索版本：提示词/解析契约变更时升版本。 */
export const WEB_INTEL_VERSION = 'web-intel-v1';

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

/** 全量同步的公开动态新鲜度门（天）：窗口内不重复搜，避免每天 × 全客户 × 8 次搜索。 */
export const WEB_INTEL_REFRESH_DAYS = 7;

/** 每角度取用的最大结果数（进 LLM 分类的候选量）。 */
const PER_ANGLE_LIMIT = 5;

export interface WebIntelFinding {
  label: string;
  detail: string;
  occurred_at: string;
  source_url: string;
  category: string;
}

export interface WebIntelRunResult {
  customerId: string;
  status: 'succeeded' | 'skipped' | 'failed';
  reason?: string;
  searched: number;
  saved: number;
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

/** 同步落库与 record_web_intelligence 工具同款 detail 前缀：`[category] 详情`。 */
function findingDetail(category: string, detail: string): string {
  return detail.trim() ? `[${category}] ${detail.trim()}` : `[${category}]`;
}

/** 标题/摘要须包含客户全称或简称才进入 LLM 分类（削减同名公司噪音）。 */
export function mentionsCustomer(result: WebResult, names: string[]): boolean {
  const haystack = `${result.title ?? ''} ${result.content ?? ''}`;
  return names.some((name) => name && haystack.includes(name));
}

/** 解析 LLM 分类输出：过滤缺 URL/日期/与客户无关的条目，绝不编造。 */
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
    const detail = typeof item.detail === 'string' ? item.detail.trim() : '';
    findings.push({ label, detail, occurred_at: occurredAt.slice(0, 10), source_url: url, category });
  }
  return findings;
}

export class WebIntelService {
  constructor(
    private readonly db: WorkbenchDatabase,
    private readonly runtime: Runtime,
    private readonly deps: WebIntelDeps,
  ) {}

  /** 该客户最近一次成功的公开动态检索是否仍在新鲜度窗口内（7 天门，节流全量同步）。 */
  isFresh(customerId: string, now = new Date()): boolean {
    const last = this.db.latestWebIntelSyncAt(customerId);
    return last !== null && now.getTime() - last.getTime() < WEB_INTEL_REFRESH_DAYS * 86_400_000;
  }

  /**
   * 检索并落库一个客户的公开动态。失败抛错由调用方降级（不阻断主同步）；
   * 返回 saved=0 也是合法结果（无近期动态，unknown 口径）。
   */
  async refresh(customer: Customer, options: { force?: boolean } = {}): Promise<WebIntelRunResult> {
    if (!options.force && this.isFresh(customer.id)) {
      return { customerId: customer.id, status: 'skipped', reason: `近 ${WEB_INTEL_REFRESH_DAYS} 天已检索`, searched: 0, saved: 0, findings: [] };
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
      const saved: string[] = [];
      for (const finding of findings) {
        this.db.addEvidence({
          customerId: customer.id,
          kind: 'web_signal',
          label: finding.label,
          detail: findingDetail(finding.category, finding.detail),
          occurredAt: finding.occurred_at,
          confidence: 0.6,
          sourceSystem: 'web',
          sourceUrl: finding.source_url,
        });
        saved.push(finding.label);
      }
      this.db.finishSyncRun(run.id, 'succeeded', { web_intelligence: { status: 'succeeded', count: saved.length } });
      return { customerId: customer.id, status: 'succeeded', searched, saved: saved.length, findings };
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
2. 把确认相关、有日期的动态提炼为结构化列表。每条动态必须：有来源 URL、有日期（YYYY-MM-DD，取不到精确日期就不采用该条）、label 一句话概括、detail 保留关键事实与数字、category 取 financing|contract|product|executive|org|sentiment|hiring|policy|other 之一。
只输出 JSON：{"findings": [{"label": "", "detail": "", "occurred_at": "YYYY-MM-DD", "source_url": "", "category": ""}]}
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
