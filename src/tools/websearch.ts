import { Type } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';

export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const RECORD_WEB_INTELLIGENCE_TOOL_NAME = 'record_web_intelligence';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 10_000;

/** Local tool: search the public web (Tavily) for customer intelligence. */
export const webSearchTool: Tool = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    '联网搜索客户在互联网上的公开动态（新闻、公告、融资、招聘、产品发布、舆情等）。' +
    '参数：query 检索词（建议组合客户全称/简称 + 角度关键词）；topic 可选 news（新闻，默认）或 general（综合）；' +
    'days 时间窗天数（news 默认 90 天，即最近三个月；general 不限）。返回标题、URL、日期、摘要。' +
    '请在 csm-web-intelligence 工作流指导下从多个角度分别检索。未配置搜索 API key 时会返回明确的配置提示。',
  parameters: Type.Object({
    query: Type.String({ description: '检索词，建议：客户名称 + 角度关键词（如 融资、中标、裁员、新品发布）' }),
    topic: Type.Optional(Type.String({ description: 'news=新闻检索（默认，支持 days 时间窗），general=综合检索' })),
    days: Type.Optional(Type.Number({ minimum: 1, maximum: 365, description: 'news 主题下的时间窗天数，默认 90（最近三个月）' })),
    max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: '返回条数上限，默认取配置值(5)' })),
  }),
};

/** Local tool: persist summarized web intelligence as web_signal evidence. */
export const recordWebIntelligenceTool: Tool = {
  name: RECORD_WEB_INTELLIGENCE_TOOL_NAME,
  description:
    '把联网搜索汇总后的客户公开动态落库为 web_signal 证据，供后续分析直接读取（get_customer_profile 会带回最近记录）。' +
    '每条动态须带日期与来源 URL；只记录有来源依据的内容。这是本地工作台写入，不涉及外部系统，无需 confirm_write。',
  parameters: Type.Object({
    findings: Type.Array(
      Type.Object({
        label: Type.String({ description: '一句话概括该动态，如「完成 B 轮融资」' }),
        detail: Type.String({ description: '动态详情（含关键事实与数字）' }),
        occurred_at: Type.String({ description: '动态发生日期，ISO 格式 YYYY-MM-DD' }),
        source_url: Type.String({ description: '来源 URL' }),
        category: Type.String({ description: '角度分类：financing|contract|product|executive|org|sentiment|hiring|policy|other' }),
      }),
      { description: '本次搜索汇总出的公开动态列表' },
    ),
  }),
};

export interface TavilyResult {
  title?: string;
  url?: string;
  published_date?: string;
  content?: string;
}

/** Search provider abstraction so tests can stub the HTTP call. */
export type SearchFetcher = (body: Record<string, unknown>, apiKey: string, timeoutMs: number) => Promise<TavilyResult[]>;

export async function tavilyFetch(body: Record<string, unknown>, apiKey: string, timeoutMs: number): Promise<TavilyResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tavily HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const data = (await res.json()) as { results?: TavilyResult[] };
    return Array.isArray(data.results) ? data.results : [];
  } finally {
    clearTimeout(timer);
  }
}

export interface WebSearchToolDeps {
  getApiKey(): string | undefined;
  getMaxResults(): number;
  fetcher?: SearchFetcher;
}

export function makeWebSearchHandler(deps: WebSearchToolDeps): (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> {
  return async (args) => {
    const apiKey = deps.getApiKey();
    if (!apiKey) {
      return {
        text: '联网搜索未配置：请在「设置」中填写 Tavily API key（或设置 TAVILY_API_KEY / ~/.csm-agent/config/search.user.yaml），配置后即可使用。在此之前请明确告知用户本次分析未包含互联网公开动态。',
        isError: true,
      };
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { text: 'web_search 需要 query 参数。', isError: true };
    const topic = args.topic === 'general' ? 'general' : 'news';
    const days = topic === 'news' ? Math.min(365, Math.max(1, Math.round(Number(args.days ?? 90)) || 90)) : undefined;
    const maxResults = Math.min(10, Math.max(1, Math.round(Number(args.max_results ?? deps.getMaxResults())) || deps.getMaxResults()));
    const body: Record<string, unknown> = { query, topic, max_results: maxResults, search_depth: 'basic' };
    if (days !== undefined) body.days = days;
    try {
      const fetcher = deps.fetcher ?? tavilyFetch;
      const results = await fetcher(body, apiKey, SEARCH_TIMEOUT_MS);
      if (!results.length) {
        return { text: `未检索到与「${query}」相关的公开结果。注意：未搜到不构成任何正面或负面信号，该角度信息为 unknown。` };
      }
      const lines = results.map((r, i) =>
        `${i + 1}. ${r.title ?? '(无标题)'}\n   日期: ${r.published_date ?? 'unknown'}\n   来源: ${r.url ?? 'unknown'}\n   摘要: ${(r.content ?? '').slice(0, 400)}`);
      return { text: `联网搜索「${query}」（topic=${topic}${days !== undefined ? `，最近 ${days} 天` : ''}，${results.length} 条结果）：\n${lines.join('\n\n')}` };
    } catch (err) {
      return { text: `联网搜索失败: ${(err as Error).message}。请如实向用户说明该角度未能获取，不要编造结果。`, isError: true };
    }
  };
}

export interface RecordWebIntelligenceDeps {
  getCustomer(): { id: string; name: string } | null;
  addEvidence(input: { customerId: string; kind: string; label: string; detail: string; occurredAt: string; confidence: number; sourceSystem: string; sourceUrl?: string | null }): unknown;
}

export function makeRecordWebIntelligenceHandler(
  deps: RecordWebIntelligenceDeps,
): (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> {
  return async (args) => {
    const customer = deps.getCustomer();
    if (!customer) {
      return { text: 'record_web_intelligence: 当前会话未绑定客户，无法落库。请先完成客户身份解析。', isError: true };
    }
    const findings = Array.isArray(args.findings) ? args.findings : [];
    if (!findings.length) return { text: 'record_web_intelligence: findings 为空，未落库任何记录。', isError: true };
    const saved: string[] = [];
    for (const item of findings) {
      const f = item as Record<string, unknown>;
      const label = typeof f.label === 'string' ? f.label.trim() : '';
      const url = typeof f.source_url === 'string' ? f.source_url.trim() : '';
      const occurredAt = typeof f.occurred_at === 'string' ? f.occurred_at.trim() : '';
      if (!label || !url || !occurredAt) continue; // 只落有来源、有日期的动态
      const category = typeof f.category === 'string' && f.category.trim() ? f.category.trim() : 'other';
      const detail = typeof f.detail === 'string' ? f.detail.trim() : '';
      deps.addEvidence({
        customerId: customer.id,
        kind: 'web_signal',
        label,
        detail: detail ? `[${category}] ${detail}` : `[${category}]`,
        occurredAt,
        confidence: 0.6,
        sourceSystem: 'web',
        sourceUrl: url,
      });
      saved.push(label);
    }
    if (!saved.length) {
      return { text: 'record_web_intelligence: 所有条目均缺少 label/source_url/occurred_at，未落库。每条动态必须带来源 URL 与日期。', isError: true };
    }
    return { text: `已把 ${saved.length} 条公开动态落库为 web_signal 证据（客户「${customer.name}」）：\n${saved.map((s, i) => `${i + 1}. ${s}`).join('\n')}` };
  };
}
