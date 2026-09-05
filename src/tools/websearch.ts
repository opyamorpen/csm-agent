import { Type } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { webSignalDetailPrefix, type WebSignalSentiment } from '../workbench/risk.js';

export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const RECORD_WEB_INTELLIGENCE_TOOL_NAME = 'record_web_intelligence';

const WEB_SIGNAL_SENTIMENT_VALUES = ['negative', 'neutral', 'positive'] as const;

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 15_000;

/** Local tool: search the public web (Tavily key, or keyless anonymous tier). */
export const webSearchTool: Tool = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    '联网搜索客户在互联网上的公开动态（新闻、公告、融资、招聘、产品发布、舆情等）。' +
    '参数：query 检索词（建议组合客户全称/简称 + 角度关键词）；topic 可选 news（新闻，默认）或 general（综合）；' +
    'days 时间窗天数（news 默认 90 天，即最近三个月；仅已配置 API key 的 Tavily 模式支持严格时间过滤）。' +
    '返回标题、URL、日期、摘要。请在 csm-web-intelligence 工作流指导下从多个角度分别检索。' +
    '未配置搜索 API key 时自动走免费匿名搜索层（多供应商轮换，无严格时间过滤，请结合结果日期自行判断时效）。',
  parameters: Type.Object({
    query: Type.String({ description: '检索词，建议：客户名称 + 角度关键词（如 融资、中标、裁员、新品发布）' }),
    topic: Type.Optional(Type.String({ description: 'news=新闻检索（默认，支持 days 时间窗），general=综合检索' })),
    days: Type.Optional(Type.Number({ minimum: 1, maximum: 365, description: 'news 主题下的时间窗天数，默认 90（最近三个月）；仅 key 模式生效' })),
    max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: '返回条数上限，默认取配置值(5)' })),
  }),
};

/** Local tool: persist summarized web intelligence as web_signal evidence. */
export const recordWebIntelligenceTool: Tool = {
  name: RECORD_WEB_INTELLIGENCE_TOOL_NAME,
  description:
    '把联网搜索汇总后的客户公开动态落库为 web_signal 证据，供后续分析直接读取（get_customer_profile 会带回最近记录）。' +
    'customer_name 指定归属客户（全称/简称/别名，与工作台客户唯一匹配——落库归属必须确定性，匹配不上宁可不落）。' +
    '每条动态须带日期与来源 URL；只记录有来源依据的内容。sentiment 是风险/预警的正负向权威口径，请站在客户公司立场逐条判定（拿不准取 neutral）。' +
    '这是本地工作台写入，不涉及外部系统，无需 confirm_write。',
  parameters: Type.Object({
    customer_name: Type.String({ description: '客户全称/简称/别名（与工作台客户唯一匹配，落库归属）' }),
    findings: Type.Array(
      Type.Object({
        label: Type.String({ description: '一句话概括该动态，如「完成 B 轮融资」' }),
        detail: Type.String({ description: '动态详情（含关键事实与数字）' }),
        occurred_at: Type.String({ description: '动态发生日期，ISO 格式 YYYY-MM-DD' }),
        source_url: Type.String({ description: '来源 URL' }),
        category: Type.String({ description: '角度分类：financing|contract|product|executive|org|sentiment|hiring|policy|other' }),
        sentiment: Type.Optional(Type.String({ description: '情感判定（站在客户公司立场）：negative=对公司利空、neutral=无明显影响、positive=利好；只看实质关系不看字面词，拿不准取 neutral' })),
      }),
      { description: '本次搜索汇总出的公开动态列表' },
    ),
  }),
};

export interface WebResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  content?: string;
}

/** Minimal HTTP POST abstraction so tests can stub every outbound call. */
export type HttpPost = (url: string, headers: Record<string, string>, body: Record<string, unknown>, timeoutMs: number) => Promise<string>;

export async function httpPost(url: string, headers: Record<string, string>, body: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ── Keyed Tavily ────────────────────────────────────────────────────────────

export async function tavilyFetch(body: Record<string, unknown>, apiKey: string, timeoutMs: number, post: HttpPost = httpPost): Promise<WebResult[]> {
  const text = await post(TAVILY_ENDPOINT, { Authorization: `Bearer ${apiKey}` }, body, timeoutMs);
  const data = JSON.parse(text) as { results?: WebResult[] };
  return Array.isArray(data.results) ? data.results : [];
}

// ── Keyless anonymous tier (mirrors Hermes agent's plugins/web/keyless_mcp) ─

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp';
const TAVILY_KEYLESS_URL = 'https://api.tavily.com/search';
const FIRECRAWL_KEYLESS_URL = 'https://api.firecrawl.dev/v2/search';
const KEENABLE_KEYLESS_URL = 'https://api.keenable.ai/v1/search/public';

const CLIENT_NAME = 'csm-agent';
/** Free-tier rate-limit correlation id — random per process, never persisted. */
const KEYLESS_SESSION_ID = randomUUID().replace(/-/g, '');

const RATE_LIMIT_MARKERS = ['rate limit', 'rate-limit', 'ratelimit', 'too many requests', '429', 'quota exceeded', 'slow down'];

function isRateLimitish(message: string): boolean {
  const lowered = (message || '').toLowerCase();
  return RATE_LIMIT_MARKERS.some((marker) => lowered.includes(marker));
}

/** POST a JSON-RPC tools/call; answer may be plain JSON or SSE data: lines. */
async function mcpCall(url: string, tool: string, args: Record<string, unknown>, post: HttpPost): Promise<string> {
  const body = await post(url, { Accept: 'application/json, text/event-stream', 'User-Agent': CLIENT_NAME }, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  }, SEARCH_TIMEOUT_MS);
  return parseMcpBody(body);
}

export function parseMcpBody(body: string): string {
  const fromPayload = (raw: string): string | null => {
    const data = JSON.parse(raw) as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    if (data.error) throw new Error(String(data.error.message ?? data.error));
    const result = data.result ?? {};
    const texts = (result.content ?? []).map((c) => c?.text ?? '');
    if (result.isError) throw new Error(texts.filter(Boolean).join(' ') || 'MCP tool call failed');
    return texts.find((t) => t) ?? null;
  };
  const stripped = body.trim();
  if (stripped.startsWith('{')) {
    try {
      const text = fromPayload(stripped);
      if (text !== null) return text;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const text = fromPayload(line.slice('data: '.length));
      if (text !== null) return text;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  throw new Error('无法解析的 MCP 响应格式');
}

/** Parse Exa's formatted text blocks (Title:/URL:/Published:/Highlights:). */
export function parseExaSearchText(text: string, limit: number): WebResult[] {
  const results: WebResult[] = [];
  for (const block of text.split('\n---\n')) {
    let title = '';
    let url = '';
    let published = '';
    const highlights: string[] = [];
    let inHighlights = false;
    for (const line of block.split('\n')) {
      const stripped = line.trim();
      if (stripped.startsWith('Title:')) { title = stripped.slice('Title:'.length).trim(); inHighlights = false; }
      else if (stripped.startsWith('URL:')) { url = stripped.slice('URL:'.length).trim(); inHighlights = false; }
      else if (stripped.startsWith('Published:')) { published = stripped.slice('Published:'.length).trim(); inHighlights = false; }
      else if (stripped.startsWith('Highlights:')) { inHighlights = true; }
      else if (stripped.startsWith('Author:')) { inHighlights = false; }
      else if (inHighlights && stripped) highlights.push(stripped);
    }
    if (url) results.push({ title, url, publishedDate: published || undefined, content: highlights.join(' ') });
    if (limit && results.length >= limit) break;
  }
  return results;
}

type KeylessSearcher = (query: string, limit: number, post: HttpPost) => Promise<WebResult[]>;

const exaSearch: KeylessSearcher = async (query, limit, post) => {
  const text = await mcpCall(EXA_MCP_URL, 'web_search_exa', { query, numResults: Math.max(1, limit) }, post);
  return parseExaSearchText(text, limit);
};

const parallelSearch: KeylessSearcher = async (query, limit, post) => {
  const text = await mcpCall(PARALLEL_MCP_URL, 'web_search', {
    objective: query,
    search_queries: [query],
    session_id: KEYLESS_SESSION_ID,
  }, post);
  const data = JSON.parse(text) as { results?: Array<{ url?: string; title?: string; excerpts?: string[] }> };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: (r.excerpts ?? []).join(' '),
  }));
};

const tavilyKeylessSearch: KeylessSearcher = async (query, limit, post) => {
  const text = await post(TAVILY_KEYLESS_URL, { 'X-Client-Name': CLIENT_NAME, 'X-Tavily-Access-Mode': 'keyless' },
    { query, max_results: Math.max(1, limit) }, SEARCH_TIMEOUT_MS);
  const data = JSON.parse(text) as { results?: WebResult[] };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: (r as { title?: string }).title ?? '',
    url: (r as { url?: string }).url ?? '',
    publishedDate: (r as { published_date?: string }).published_date,
    content: (r as { content?: string }).content ?? '',
  }));
};

const firecrawlSearch: KeylessSearcher = async (query, limit, post) => {
  const text = await post(FIRECRAWL_KEYLESS_URL, {}, { query, limit: Math.max(1, limit) }, SEARCH_TIMEOUT_MS);
  const data = JSON.parse(text) as { data?: { web?: unknown[] } | unknown[]; web?: unknown[]; results?: unknown[] };
  const rows = Array.isArray(data.data) ? data.data : data.data?.web ?? data.web ?? data.results ?? [];
  return (rows as Array<Record<string, unknown>>).slice(0, limit).map((r) => ({
    title: typeof r.title === 'string' ? r.title : '',
    url: typeof r.url === 'string' ? r.url : '',
    content: typeof r.description === 'string' ? r.description : typeof r.content === 'string' ? r.content : '',
  }));
};

const keenableSearch: KeylessSearcher = async (query, limit, post) => {
  const text = await post(KEENABLE_KEYLESS_URL, { 'X-Keenable-Title': CLIENT_NAME },
    { query, max_results: Math.max(1, limit) }, SEARCH_TIMEOUT_MS);
  const data = JSON.parse(text) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: r.snippet ?? '',
  }));
};

/** Vendor ring, mirroring Hermes: random start, rotates once per request. */
const KEYLESS_RING: Array<{ name: string; search: KeylessSearcher }> = [
  { name: 'exa', search: exaSearch },
  { name: 'parallel', search: parallelSearch },
  { name: 'tavily', search: tavilyKeylessSearch },
  { name: 'firecrawl', search: firecrawlSearch },
  { name: 'keenable', search: keenableSearch },
];
let ringCursor = Math.floor(Math.random() * KEYLESS_RING.length);

export function nextKeylessOrder(): string[] {
  const start = ringCursor;
  ringCursor = (ringCursor + 1) % KEYLESS_RING.length;
  return Array.from({ length: KEYLESS_RING.length }, (_, i) => KEYLESS_RING[(start + i) % KEYLESS_RING.length].name);
}

/**
 * Keyless search across the vendor ring with next-in-line failover:
 * rate-limit-shaped errors advance to the next vendor; other errors stop
 * the walk (a malformed query fails everywhere).
 */
export async function keylessSearchWithFailover(
  query: string,
  limit: number,
  post: HttpPost = httpPost,
): Promise<{ results: WebResult[]; servedBy: string }> {
  const order = nextKeylessOrder();
  let lastError = '';
  for (let i = 0; i < order.length; i++) {
    const vendor = KEYLESS_RING.find((v) => v.name === order[i])!;
    try {
      const results = await vendor.search(query, limit, post);
      if (results.length) return { results, servedBy: vendor.name };
      lastError = `${vendor.name}: 空结果`;
    } catch (err) {
      lastError = `${vendor.name}: ${(err as Error).message}`;
      if (!isRateLimitish((err as Error).message)) {
        throw new Error(`联网搜索失败（${lastError}）。`);
      }
      // throttled → try the next vendor in the ring
    }
  }
  throw new Error(
    `全部免费搜索通道均不可用（${order.join('、')}）；最近错误: ${lastError}。` +
    '可在「设置」中配置 Tavily API key 获得稳定服务。',
  );
}

// ── Handlers ────────────────────────────────────────────────────────────────

export interface WebSearchToolDeps {
  getApiKey(): string | undefined;
  getMaxResults(): number;
  getKeylessEnabled?(): boolean;
  fetcher?: HttpPost;
}

/** 共享底层搜索结果：agent web_search 工具与同步路径公开动态检索共用同一实现。 */
export interface RawWebSearchOutcome {
  /** Tavily key 模式（topic=news 支持 days 严格时间窗）或 keyless 免费轮换。 */
  mode: 'keyed' | 'keyless';
  /** keyless 模式实际服务的供应商名；keyed 恒为 'tavily'。 */
  servedBy: string;
  results: WebResult[];
}

/**
 * 底层搜索：keyed Tavily 走严格 topic/days 窗，无 key 走免费通道轮换（无严格时间过滤）。
 * key 与 keyless 都未启用时抛错（调用方决定降级行为）；空结果不抛错，由调用方按 unknown 口径处理。
 */
export async function performRawWebSearch(
  options: { query: string; maxResults: number; apiKey?: string; keylessEnabled?: boolean; topic?: 'news' | 'general'; days?: number; fetcher?: HttpPost },
): Promise<RawWebSearchOutcome> {
  const query = options.query.trim();
  if (!query) throw new Error('search query 不能为空');
  const post = options.fetcher ?? httpPost;
  const maxResults = Math.min(10, Math.max(1, Math.round(options.maxResults) || 5));
  if (options.apiKey) {
    const topic = options.topic === 'general' ? 'general' : 'news';
    const days = topic === 'news' ? Math.min(365, Math.max(1, Math.round(options.days ?? 90) || 90)) : undefined;
    const body: Record<string, unknown> = { query, topic, max_results: maxResults, search_depth: 'basic' };
    if (days !== undefined) body.days = days;
    const results = await tavilyFetch(body, options.apiKey, SEARCH_TIMEOUT_MS, post);
    return { mode: 'keyed', servedBy: 'tavily', results };
  }
  if (options.keylessEnabled ?? true) {
    const { results, servedBy } = await keylessSearchWithFailover(query, maxResults, post);
    return { mode: 'keyless', servedBy, results };
  }
  throw new Error('联网搜索未配置且免费通道已停用：请配置 Tavily API key（或启用免费通道）。');
}

function formatResults(results: WebResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title || '(无标题)'}\n   日期: ${r.publishedDate || 'unknown'}\n   来源: ${r.url || 'unknown'}\n   摘要: ${(r.content ?? '').slice(0, 400)}`)
    .join('\n\n');
}

export function makeWebSearchHandler(deps: WebSearchToolDeps): (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> {
  return async (args) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { text: 'web_search 需要 query 参数。', isError: true };
    const maxResults = Math.min(10, Math.max(1, Math.round(Number(args.max_results ?? deps.getMaxResults())) || deps.getMaxResults()));
    const topic = args.topic === 'general' ? 'general' : 'news';
    const days = Math.min(365, Math.max(1, Math.round(Number(args.days ?? 90)) || 90));

    try {
      const outcome = await performRawWebSearch({
        query,
        maxResults,
        apiKey: deps.getApiKey(),
        keylessEnabled: deps.getKeylessEnabled?.() ?? true,
        topic,
        days,
        fetcher: deps.fetcher,
      });
      if (!outcome.results.length) {
        return { text: `未检索到与「${query}」相关的公开结果。注意：未搜到不构成任何正面或负面信号，该角度信息为 unknown。` };
      }
      const windowNote = outcome.mode === 'keyed'
        ? `Tavily，topic=${topic}${topic === 'news' ? `，最近 ${days} 天` : ''}`
        : `免费通道 ${outcome.servedBy}；无严格时间过滤，请依据各条日期判断是否在最近三个月内`;
      return { text: `联网搜索「${query}」（${windowNote}，${outcome.results.length} 条结果）：\n\n${formatResults(outcome.results)}` };
    } catch (err) {
      return { text: `联网搜索失败: ${(err as Error).message}。请如实向用户说明该角度未能获取，不要编造结果。`, isError: true };
    }
  };
}

export interface RecordWebIntelligenceDeps {
  /** 按客户全称/简称/别名唯一匹配（写路径归属必须确定性）；未唯一命中返回 null。 */
  resolveCustomer(name: string): { id: string; name: string } | null;
  addEvidence(input: { customerId: string; kind: string; label: string; detail: string; occurredAt: string; confidence: number; sourceSystem: string; sourceUrl?: string | null }): unknown;
}

export function makeRecordWebIntelligenceHandler(
  deps: RecordWebIntelligenceDeps,
): (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> {
  return async (args) => {
    const customerName = typeof args.customer_name === 'string' ? args.customer_name.trim() : '';
    const customer = customerName ? deps.resolveCustomer(customerName) : null;
    if (!customer) {
      return { text: `record_web_intelligence: 缺少 customer_name，或「${customerName || '(未提供)'}」未在工作台唯一匹配到客户。落库归属必须确定，请提供客户全称/简称/别名后重试。`, isError: true };
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
      const sentiment = typeof f.sentiment === 'string' && (WEB_SIGNAL_SENTIMENT_VALUES as readonly string[]).includes(f.sentiment.trim())
        ? f.sentiment.trim() as WebSignalSentiment
        : null;
      const detail = typeof f.detail === 'string' ? f.detail.trim() : '';
      deps.addEvidence({
        customerId: customer.id,
        kind: 'web_signal',
        label,
        detail: webSignalDetailPrefix(category, sentiment, detail),
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
