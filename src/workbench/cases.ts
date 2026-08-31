import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { argumentsHash } from '../approval.js';
import { extractText } from '../agent.js';
import type { McpHub } from '../mcp/index.js';
import { onesAsrAliasRule } from './drafts.js';
import { completeModelWithProgress, modelProgressText } from './model-progress.js';
import { mentionsCustomer } from './webintel.js';
import { caseSpeakerRole, isDeliveredOnesEvent, type CaseSpeakerRole } from './sync.js';
import { performRawWebSearch, type HttpPost } from '../tools/websearch.js';
import { WorkbenchDatabase } from './database.js';
import type { CaseDraft, Customer, EvidenceInput, OpportunityHypothesis, RiskAssessment, SourceEvent } from './types.js';

export const CASE_GENERATION_VERSION = 'case-v4-rich-narrative';
export const CASE_WEB_FRESH_DAYS = 7;

/** 案例五段叙事的字段契约（templates/case.json 同源描述，供前端/CLI 展示）。 */
export interface CaseNarrativeFields {
  background: string;
  challenges: string[];
  requirements: string[];
  solution: string;
  value: string[];
}

export type CaseSectionKey = keyof CaseNarrativeFields;
export type CaseSignalModality = 'pain' | 'requirement' | 'solution' | 'value';
export type CaseTimeScope = 'current' | 'future' | 'completed' | 'unknown';

export interface CaseClaimEvidence {
  section: CaseSectionKey;
  claim: string;
  source_refs: string[];
  excerpt?: string;
  speaker_role?: CaseSpeakerRole;
  status_category?: string;
  confidence?: number;
}

export interface CaseEvidenceSnapshotItem {
  id: string;
  source_system: string;
  source_type: string;
  external_id: string;
  occurred_at: string;
  synced_at: string;
  title: string;
  excerpt: string;
  url: string;
  payload_hash: string;
  speaker_role?: CaseSpeakerRole;
  status_category?: string;
  speaker_lines?: Array<{ speaker: string; speaker_role: CaseSpeakerRole; text: string }>;
}

export interface CaseContextSnapshot {
  generated_at: string;
  internal_digest: string;
  digest: string;
  sources: CaseEvidenceSnapshotItem[];
}

export const CASE_SECTIONS: Array<{ key: keyof CaseNarrativeFields; label: string; description: string }> = [
  { key: 'background', label: '客户背景', description: '客户行业、业务概况与合作起点的一段连贯叙述' },
  { key: 'challenges', label: '痛点、现状与挑战', description: '合作前/合作中面临的核心业务痛点、现状困难与挑战' },
  { key: 'requirements', label: '需求与要求', description: '客户明确提出的功能诉求、交付要求与服务标准' },
  { key: 'solution', label: '解决方案', description: '以「我们为客户提供了什么方案」为主线的方案级举措叙述' },
  { key: 'value', label: '价值与成效', description: '已确认的客户价值：量化结果优先，无量化写有据定性价值' },
];

/** 章节序号（与 CASE_SECTIONS 顺序对应）。 */
const CASE_SECTION_NUMBERS = ['一', '二', '三', '四', '五'];

/** 转写注入预算：超预算按片段均摊截取（保留每片段开头——背景与诉求信号多出现在对话开头）。 */
const TRANSCRIPT_BUDGET = 36_000;
/** 案例上下文注入的最大 Hemory 片段数（超出的按最早 1/3 + 最近 2/3 保留：背景靠早期证据，价值靠近期证据）。 */
const MAX_CASE_FRAGMENTS = 150;
/** 已交付记录注入上限（解决方案段的举措证据底料）。 */
const MAX_DELIVERED_RECORDS = 40;
/** 每类片段信号提取上限。 */
const MAX_CASE_SIGNALS = 40;
/** 单片段对每类信号的最大贡献条数：避免一个长片段刷满预算。 */
const MAX_SIGNALS_PER_FRAGMENT = 3;
/** 信号摘录长度上限。 */
const SIGNAL_EXCERPT_LIMIT = 160;
/** records（非片段事件清单）注入上限：超限保最早 1/6 + 最近 5/6，与片段选择同哲学（背景靠早期证据、价值靠近期证据）。 */
const MAX_CASE_RECORDS = 300;
/** evidence_signals 注入上限（每条 detail 已截 200 字，全量注入无预算会稀释注意力）。 */
const MAX_CASE_EVIDENCE = 60;
/** crm_followups 注入上限。 */
const MAX_CASE_FOLLOWUPS = 30;

/** 列表章节的写回护栏上限：生成契约是 3~6 条，超出视为编辑异常（非阻断告警）。 */
const CASE_LIST_ITEM_LIMIT = 12;
/** 单条正文/单段的写回护栏长度上限（字符）。 */
const CASE_ITEM_MAX_CHARS = 500;
/** 案例生成输出预算：五章+claim_evidence 的 JSON 输出与 reasoning 共享 completion 上限，服务端默认 8k 会截断（stopReason=length）。 */
const CASE_MODEL_MAX_TOKENS = 16_384;

/** 案例联网检索角度（生成时现搜，低频手动动作不做新鲜度门）：背景与制度要求类信息不限时间窗。 */
export const CASE_WEB_ANGLES: ReadonlyArray<{ key: string; label: string; query: string }> = [
  { key: 'project_mgmt', label: '项目管理', query: '项目管理' },
  { key: 'requirements_mgmt', label: '需求管理', query: '需求管理' },
  { key: 'knowledge_mgmt', label: '知识管理', query: '知识管理' },
  { key: 'bidding', label: '招投标', query: '招投标' },
  { key: 'procurement', label: '中标采购', query: '中标 采购' },
];

/** 每角度检索取用的最大结果数。 */
const CASE_WEB_PER_ANGLE_LIMIT = 5;

/** 案例联网检索依赖（与 web_search 工具/WebIntelService 同源配置，测试可注入 fetcher）。 */
export interface CaseWebSearchDeps {
  getApiKey(): string | undefined;
  getMaxResults(): number;
  getKeylessEnabled(): boolean;
  fetcher?: HttpPost;
}

/** 案例联网检索结果（随草稿存 fields.web_search 内部字段，不渲染进正文）。 */
export interface CaseWebSearchContext {
  searched: number;
  searchedAt: string;
  results: Array<{ id: string; angle: string; title: string; snippet: string; domain: string; sourceTier: CaseWebSourceTier; url: string; date: string }>;
  errors: string[];
}

export type CaseWebSourceTier = 'customer_official' | 'government_procurement' | 'media' | 'official';

function officialUrlsIn(value: unknown, depth = 0, hinted = false): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') return hinted ? value.match(/https?:\/\/[^\s"'<>]+/g) ?? [] : [];
  if (Array.isArray(value)) return value.flatMap((item) => officialUrlsIn(item, depth + 1, hinted));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const labelHint = Object.entries(record).some(([key, item]) => /^(?:label|name|title|field_name)$/i.test(key)
      && typeof item === 'string' && /官网|网址|website|official.?site/i.test(item));
    return Object.entries(record).flatMap(([key, item]) => officialUrlsIn(item, depth + 1, hinted || labelHint || /官网|网址|website|official.?site/i.test(key)));
  }
  return [];
}

function customerOfficialDomains(customer: Customer): Set<string> {
  const crmHost = (() => { try { return customer.crmUrl ? new URL(customer.crmUrl).hostname.toLowerCase() : ''; } catch { return ''; } })();
  return new Set(officialUrlsIn(customer.source).flatMap((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host && host !== crmHost ? [host.replace(/^www\./, '')] : [];
    } catch { return []; }
  }));
}

function sourceTier(url: string, officialDomains: Set<string>): Exclude<CaseWebSourceTier, 'official'> {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if ([...officialDomains].some((domain) => host === domain || host.endsWith(`.${domain}`))) return 'customer_official';
    return /(?:^|\.)(?:gov\.cn|chinabidding\.cn|cebpubservice\.com)$/.test(host) ? 'government_procurement' : 'media';
  } catch {
    return 'media';
  }
}

/**
 * 客户公开信息检索：逐角度现搜「客户名 + 角度词」，标题/摘要须含客户全称或简称（削减同名噪音）。
 * 单角度失败只记入 errors 不阻断（生成不依赖检索成功）；全空由调用方按「未搜到=unknown」口径提示模型。
 */
export async function searchCaseWebContext(customer: Customer, deps: CaseWebSearchDeps, onProgress?: (text: string) => void): Promise<CaseWebSearchContext> {
  const searchName = customer.shortName?.trim() || customer.name;
  const names = [customer.name, customer.shortName].filter((name): name is string => !!name?.trim());
  const context: CaseWebSearchContext = { searched: 0, searchedAt: new Date().toISOString(), results: [], errors: [] };
  const seenUrls = new Set<string>();
  const officialDomains = customerOfficialDomains(customer);
  for (const [index, angle] of CASE_WEB_ANGLES.entries()) {
    onProgress?.(`联网检索公开动态（${index + 1}/${CASE_WEB_ANGLES.length}）${angle.label}…`);
    try {
      const outcome = await performRawWebSearch({
        query: `${searchName} ${angle.query}`,
        maxResults: Math.max(3, Math.min(deps.getMaxResults(), CASE_WEB_PER_ANGLE_LIMIT)),
        apiKey: deps.getApiKey(),
        keylessEnabled: deps.getKeylessEnabled(),
        topic: 'general',
        fetcher: deps.fetcher,
      });
      context.searched += 1;
      for (const result of outcome.results) {
        if (!mentionsCustomer(result, names)) continue;
        const url = String(result.url ?? '').trim();
        const snippet = String(result.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
        // 标题命中只能用于召回，不能单独成为公开事实；没有正文摘要的结果不送入模型。
        if (!url || snippet.length < 8 || !mentionsCustomer({ title: '', content: snippet }, names)) continue;
        let canonicalUrl = url;
        try {
          const parsed = new URL(url);
          parsed.hash = '';
          for (const key of [...parsed.searchParams.keys()]) if (/^(?:utm_|spm|from)/i.test(key)) parsed.searchParams.delete(key);
          canonicalUrl = parsed.toString();
        } catch { /* keep raw URL */ }
        if (seenUrls.has(canonicalUrl)) continue;
        seenUrls.add(canonicalUrl);
        let domain = '';
        try { domain = new URL(canonicalUrl).hostname; } catch { /* invalid URL already retained for audit */ }
        context.results.push({
          id: `web:${hash(canonicalUrl).slice(0, 16)}`,
          angle: angle.label,
          title: String(result.title ?? '').trim().slice(0, 160),
          snippet,
          domain,
          sourceTier: sourceTier(canonicalUrl, officialDomains),
          url: canonicalUrl,
          date: String(result.publishedDate ?? '').trim().slice(0, 20),
        });
      }
    } catch (error) {
      context.errors.push(`${angle.label}: ${(error as Error).message}`);
      onProgress?.(`联网检索公开动态（${index + 1}/${CASE_WEB_ANGLES.length}）${angle.label}（该角度检索失败，已跳过）`);
    }
  }
  return context;
}

/** 痛点主题（客户原话线索 → 痛点段素材）：命中即提取为待分析信号，甄别与归纳由模型完成。 */
const CASE_PAIN_THEMES: ReadonlyArray<{ key: string; label: string; pattern: RegExp }> = [
  { key: 'silo', label: '系统未打通/数据孤岛', pattern: /(?:没|不|未|无法|没法|难以|难|不能).{0,8}(?:打通|互通|互联|对接|集成|连通)|(?:数据|信息|系统|平台)孤岛|(?:数据|信息)不通|孤岛/ },
  { key: 'inefficiency', label: '效率低/耗时', pattern: /低效|效率(?:很|太|比较|相当|非常|特别)?(?:低|差|不行|不高)|太慢|很慢|费时|费时间|耗时|耗时间|浪费时间|(?:处理|推进|协同|统计|汇总).{0,8}(?:困难|困难重重|很难|难以)/ },
  { key: 'manual', label: '表格/人工管理', pattern: /(?:人工|手工)(?:管理|统计|汇总|整理|记录|录入|维护|操作|跟进)|(?:人工|手工).{0,8}(?:表格|[eE][xX][cC][eE][lL])|还在用.{0,12}(?:表格|[eE][xX][cC][eE][lL])|(?:用|靠|依赖).{0,10}(?:表格|[eE][xX][cC][eE][lL]).{0,10}(?:管理|统计|汇总|记录|维护|整理|跟进)/ },
  { key: 'opaque', label: '信息不透明', pattern: /不透明|(?:进度|信息|数据|状态|情况|整体)(?:不|没)(?:透明|可见|同步|掌握)|看不到.{0,12}(?:进度|情况|整体|全局|状态|数据)|查不到.{0,12}(?:进度|记录|数据)/ },
  { key: 'collab', label: '协作不畅', pattern: /(?:协作|配合|协同|沟通)(?:不|难|成本)|(?:协作|配合|协同|沟通)不畅|扯皮|来回.{0,10}(?:传|发|对|确认|问)|对不上/ },
  { key: 'scattered', label: '信息或工具分散', pattern: /(?:信息|数据|文档|需求|任务|项目|工具|系统).{0,8}(?:分散|散落|各自维护)|分散在.{0,16}(?:系统|平台|表格|文档)/ },
  { key: 'duplicate', label: '重复工作', pattern: /重复(?:录入|登记|统计|汇总|整理|沟通|确认|操作|维护|工作)|多头(?:录入|维护|管理)/ },
  { key: 'governance_gap', label: '缺少规范或追溯', pattern: /(?:缺少|缺乏|没有|无法).{0,10}(?:规范|标准|统一流程|追溯|留痕|审计)|(?:不|难以|无法)(?:追溯|留痕)/ },
];

/** 价值主题（客户正面反馈线索 → 价值段素材）。 */
const CASE_VALUE_THEMES: ReadonlyArray<{ key: string; label: string; pattern: RegExp }> = [
  { key: 'positive', label: '有对象的正面评价', pattern: /(?:系统|平台|方案|功能|流程|服务|交付).{0,12}(?:挺好|不错|很好|好用|满意|认可|方便|省心|放心|靠谱)|(?:满意|认可).{0,12}(?:系统|平台|方案|功能|流程|服务|交付)/ },
  { key: 'efficiency_gain', label: '效率提升', pattern: /效率(?:提升|提高|高了|好了|好多了|上来了)|省(?:时|事|力|人)|快多了|节省(?:不少|很多|大量)?(?:时间|人力|成本|工作量)/ },
  { key: 'process', label: '流程改善', pattern: /顺畅|顺多了|清晰(?:多了|很多)|透明(?:多了|很多)|规范(?:多了|很多)|有条理|理顺|可追溯|统一管理|统一到/ },
  { key: 'adoption', label: '上线使用', pattern: /用起来|用上了|都在用|全面(?:上线|使用)|正式(?:上线|使用)|推广开|铺开|落地/ },
  { key: 'reduction', label: '周期或成本改善', pattern: /(?:时间|周期|耗时|成本|人力|工作量).{0,8}(?:缩短|减少|降低|下降)|(?:缩短|减少|降低).{0,8}(?:时间|周期|耗时|成本|人力|工作量)/ },
  { key: 'coverage', label: '覆盖与采用', pattern: /(?:已经|目前|现已).{0,8}(?:覆盖|采用)|覆盖率.{0,8}(?:提升|提高)|采用率.{0,8}(?:提升|提高)/ },
];

const CASE_REQUIREMENT_THEMES: ReadonlyArray<{ key: string; label: string; pattern: RegExp }> = [
  { key: 'explicit_need', label: '明确需求', pattern: /希望|需要|必须|期望|要求|诉求|最好能够|能不能|是否支持/ },
  { key: 'integration', label: '集成与迁移要求', pattern: /集成|对接|打通|迁移|导入|接口/ },
  { key: 'governance', label: '治理与验收要求', pattern: /权限|安全|合规|验收|SLA|服务标准|时间节点|截止|如期/ },
];

const CASE_SOLUTION_THEMES: ReadonlyArray<{ key: string; label: string; pattern: RegExp }> = [
  { key: 'delivered', label: '已交付举措', pattern: /已(?:建立|配置|部署|迁移|打通|集成|培训|交付|完成|上线|落地)|完成了?(?:配置|部署|迁移|对接|培训|交付|上线)|正式上线/ },
];

const FUTURE_PATTERN = /待|希望|计划|预计|拟|将要|后续|下一步|需要|期望|要求/;
const NEGATED_COMPLETION_PATTERN = /尚未|还未|未能|没有|并未|未完成|未上线|未交付/;
const COMPLETED_PATTERN = /已经|已(?:完成|解决|建立|配置|部署|迁移|打通|集成|培训|交付|上线|落地)|正式上线|用上了|都在用|不再/;

/** 片段信号：客户原话摘录 + 主题归类（供模型按主题归并分析）。 */
export interface CaseFragmentSignal {
  date: string;
  theme: string;
  fragment_id: string;
  topic: string;
  excerpt: string;
  speakerRole: CaseSpeakerRole;
  modality: CaseSignalModality;
  statusCategory: string;
  timeScope: CaseTimeScope;
}

interface FragmentSpeechLine { speaker: string; text: string }

/** 取片段逐句文本并保留说话人；没有明确角色的行只能作为内部待确认线索。 */
function fragmentSpeechLines(event: SourceEvent): FragmentSpeechLine[] {
  const evidence = event.payload?.evidence;
  if (Array.isArray(evidence) && evidence.length) {
    return evidence
      .flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        const text = typeof row.text === 'string' ? row.text.trim() : '';
        return text ? [{ speaker: typeof row.speaker === 'string' ? row.speaker.trim() : '', text }] : [];
      });
  }
  return String(event.payload?.transcript ?? '')
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^([^:：]{1,24})[:：]\s*(.*)$/);
      const text = (match?.[2] ?? line).trim();
      return text ? [{ speaker: match?.[1]?.trim() ?? '', text }] : [];
    });
}

/**
 * 片段说话人角色摘要（catalog 注入用）：按角色聚合「共 N 句」而非逐句全文——
 * 完整逐句文本走 communications 与摘录校验第二查找源，catalog 不再重复注入全量转写。
 */
function speakerRoleSummaryLines(event: SourceEvent, csmName?: string | null): Array<{ speaker: string; speaker_role: CaseSpeakerRole; text: string }> {
  const counts = new Map<CaseSpeakerRole, number>();
  const speakers = new Map<CaseSpeakerRole, Set<string>>();
  for (const line of fragmentSpeechLines(event)) {
    if (line.text.length < 4) continue;
    const role = caseSpeakerRole(line.speaker, csmName);
    counts.set(role, (counts.get(role) ?? 0) + 1);
    const names = speakers.get(role) ?? new Set<string>();
    if (line.speaker) names.add(line.speaker);
    speakers.set(role, names);
  }
  const labels: Record<CaseSpeakerRole, string> = { customer: '客户', csm: 'CSM/我方', unknown: '未明确' };
  return [...counts.entries()].map(([role, count]) => ({
    speaker: [...(speakers.get(role) ?? [])].slice(0, 3).join('、') || labels[role],
    speaker_role: role,
    text: `${labels[role]}发言共 ${count} 句（完整逐句见 communications 中该片段）`,
  }));
}

function signalTimeScope(text: string, modality: CaseSignalModality): CaseTimeScope {  if (NEGATED_COMPLETION_PATTERN.test(text)) return modality === 'pain' ? 'current' : 'future';
  if (COMPLETED_PATTERN.test(text) || modality === 'solution') return 'completed';
  if (modality === 'pain') return 'current';
  if (FUTURE_PATTERN.test(text)) return 'future';
  if (modality === 'value') return 'current';
  return 'unknown';
}

function statusCategoryOf(event: SourceEvent): string {
  const status = event.payload?.field005;
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    const category = (status as Record<string, unknown>).category;
    if (typeof category === 'string') return category;
  }
  return 'unknown';
}

/**
 * 全量片段痛点/价值信号预扫描：逐句匹配主题关键词，把客户原话线索结构化后随上下文注入。
 * 扫描的是全部已确认片段的全文转写，独立于 prompt 注入的片段选择与头部截断——
 * 中后段的长片段痛点/正面反馈不会因预算截断而丢失。信号只是线索，不直接等于事实。
 */
export function caseFragmentSignals(hemory: SourceEvent[], csmName?: string | null): {
  painPoints: CaseFragmentSignal[];
  requirements: CaseFragmentSignal[];
  solutions: CaseFragmentSignal[];
  values: CaseFragmentSignal[];
  review: CaseFragmentSignal[];
} {
  const sorted = [...hemory].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const result = { painPoints: [] as CaseFragmentSignal[], requirements: [] as CaseFragmentSignal[], solutions: [] as CaseFragmentSignal[],
    values: [] as CaseFragmentSignal[], review: [] as CaseFragmentSignal[] };
  for (const event of sorted) {
    const counts: Record<CaseSignalModality, number> = { pain: 0, requirement: 0, solution: 0, value: 0 };
    for (const line of fragmentSpeechLines(event)) {
      if (line.text.length < 4) continue;
      const excerpt = line.text.length > SIGNAL_EXCERPT_LIMIT ? `${line.text.slice(0, SIGNAL_EXCERPT_LIMIT)}…` : line.text;
      const speakerRole = caseSpeakerRole(line.speaker, csmName);
      const definitions: Array<{ modality: CaseSignalModality; target: CaseFragmentSignal[]; themes: ReadonlyArray<{ label: string; pattern: RegExp }> }> = [
        { modality: 'pain', target: result.painPoints, themes: CASE_PAIN_THEMES },
        { modality: 'requirement', target: result.requirements, themes: CASE_REQUIREMENT_THEMES },
        { modality: 'solution', target: result.solutions, themes: CASE_SOLUTION_THEMES },
        { modality: 'value', target: result.values, themes: CASE_VALUE_THEMES },
      ];
      for (const definition of definitions) {
        if (counts[definition.modality] >= MAX_SIGNALS_PER_FRAGMENT || definition.target.length >= MAX_CASE_SIGNALS) continue;
        const theme = definition.themes.find((item) => item.pattern.test(line.text));
        if (!theme) continue;
        const signal: CaseFragmentSignal = { date: event.occurredAt.slice(0, 10), theme: theme.label,
          fragment_id: event.id, topic: event.title.slice(0, 80), excerpt, speakerRole,
          modality: definition.modality, statusCategory: statusCategoryOf(event), timeScope: signalTimeScope(line.text, definition.modality) };
        const conflictsWithTime = (definition.modality === 'pain' && signal.timeScope === 'completed')
          || (definition.modality === 'requirement' && signal.timeScope === 'completed')
          || (definition.modality === 'solution' && signal.timeScope !== 'completed')
          || (definition.modality === 'value' && signal.timeScope === 'future');
        // 客户声音章节只接收明确客户角色，且完成/未来状态必须与章节一致。其余命中留作内部复核。
        if (speakerRole === 'customer' && !conflictsWithTime) definition.target.push(signal);
        else if (result.review.length < MAX_CASE_SIGNALS) result.review.push(signal);
        counts[definition.modality] += 1;
      }
    }
  }
  return result;
}

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
 * 条目章节统一阿拉伯数字有序编号；evidenceRefs/claim_evidence/context_snapshot/unknowns 等内部元数据不渲染。
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
    ...CASE_SECTIONS.map((section, index) => `## ${CASE_SECTION_NUMBERS[index]}、${section.label}\n\n${bodies[section.key]}\n`),
  ].join('\n');
}

export type ParsedCaseContent = { title?: string } & CaseNarrativeFields & {
  claim_evidence: CaseClaimEvidence[];
  evidence_map?: Record<string, string>;
  unknowns: string[];
};

/** 模型输出契约校验；公开生成路径额外要求五章完整、无占位词且每条主张可追溯。 */
/** 摘录校验的第二查找源：注入片段的 summary+transcript（catalog 的 hemory 条目只带角色摘要）。 */
interface CaseCommunicationSource { id: string; transcript: string; summary: string; csmName?: string | null; evidence?: Array<{ speaker: string; text: string }> }

function sourceSupportsExcerpt(source: CaseEvidenceSnapshotItem, excerpt: string, communications?: CaseCommunicationSource[]): boolean {
  if (`${source.title}\n${source.excerpt}`.includes(excerpt)
    || !!source.speaker_lines?.some((line) => line.text.includes(excerpt))) return true;
  // catalog 的 hemory 条目只带角色摘要行——摘录的逐字定位回退到注入片段全文（communications）。
  if (communications?.length && source.source_system === 'hemory') {
    const fragment = communications.find((item) => item.id === source.id);
    if (fragment && (`${fragment.summary}\n${fragment.transcript}`.includes(excerpt))) return true;
  }
  return false;
}

function sourceExcerptRoles(source: CaseEvidenceSnapshotItem, excerpt: string, communications?: CaseCommunicationSource[]): CaseSpeakerRole[] {
  const direct = source.speaker_lines?.filter((line) => line.text.includes(excerpt)).map((line) => line.speaker_role) ?? [];
  if (direct.length) return direct;
  // 摘录来自片段正文时，说话人角色从片段逐句结构化证据推导（catalog 摘要行不含逐句角色；
  // evidence 数组优先——transcript 行解析对无前缀行拿不到说话人）。
  if (communications?.length && source.source_system === 'hemory') {
    const fragment = communications.find((item) => item.id === source.id);
    if (fragment) {
      if (fragment.evidence?.length) {
        const roles = fragment.evidence.filter((line) => line.text.includes(excerpt)).map((line) => caseSpeakerRole(line.speaker, fragment.csmName));
        if (roles.length) return roles;
      }
      const line = fragmentSpeechTextLines(fragment.transcript).find((item) => item.text.includes(excerpt));
      if (line) return [caseSpeakerRole(line.speaker, fragment.csmName)];
    }
  }
  return [];
}

/** 注入片段的逐句拆分（校验第二查找源用）：按「说话人:」行拆，无前缀行 speaker 为空。 */
function fragmentSpeechTextLines(transcript: string): Array<{ speaker: string; text: string }> {
  return transcript.split('\n').flatMap((line) => {
    const match = line.match(/^([^:：]{1,24})[:：]\s*(.*)$/);
    const text = (match?.[2] ?? line).trim();
    return text ? [{ speaker: match?.[1]?.trim() ?? '', text }] : [];
  });
}

export function parseCaseContent(value: unknown, options: { requirePublic?: boolean; allowedRefs?: Set<string>; sources?: CaseEvidenceSnapshotItem[]; communications?: CaseCommunicationSource[] } = {}): ParsedCaseContent {
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
  const claimEvidence = Array.isArray(raw.claim_evidence) ? raw.claim_evidence.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const section = String(record.section ?? '') as CaseSectionKey;
    const claim = typeof record.claim === 'string' ? record.claim.trim() : '';
    const refs = list(record.source_refs);
    if (!CASE_SECTIONS.some((entry) => entry.key === section) || !claim || !refs.length) return [];
    return [{ section, claim, source_refs: refs,
      excerpt: typeof record.excerpt === 'string' ? record.excerpt.trim() : undefined,
      speaker_role: ['customer', 'csm', 'unknown'].includes(String(record.speaker_role)) ? String(record.speaker_role) as CaseSpeakerRole : undefined,
      status_category: typeof record.status_category === 'string' ? record.status_category : undefined,
      confidence: Number.isFinite(Number(record.confidence)) ? Math.max(0, Math.min(1, Number(record.confidence))) : undefined }];
  }) : [];
  const parsed: ParsedCaseContent = {
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined,
    background, challenges: list(raw.challenges), requirements: list(raw.requirements), solution, value: list(raw.value),
    claim_evidence: claimEvidence, evidence_map: evidenceMap, unknowns: list(raw.unknowns),
  };
  if (!options.requirePublic) return parsed;
  const missing = CASE_SECTIONS.filter((section) => {
    const content = parsed[section.key];
    return typeof content === 'string' ? !content : content.length === 0;
  });
  if (missing.length) throw new Error(`模型未返回完整公开版章节: ${missing.map((item) => item.label).join('、')}`);
  const visibleClaims: Array<{ section: CaseSectionKey; claim: string }> = [
    { section: 'background', claim: parsed.background },
    ...parsed.challenges.map((claim) => ({ section: 'challenges' as const, claim })),
    ...parsed.requirements.map((claim) => ({ section: 'requirements' as const, claim })),
    { section: 'solution', claim: parsed.solution },
    ...parsed.value.map((claim) => ({ section: 'value' as const, claim })),
  ];
  if (visibleClaims.some((item) => /待确认|待补充|\bunknown\b/i.test(item.claim))) throw new Error('公开版正文包含待确认/待补充占位词');
  const sourceMap = new Map((options.sources ?? []).map((source) => [source.id, source]));
  for (const item of visibleClaims) {
    const mapped = claimEvidence.find((entry) => entry.section === item.section && entry.claim === item.claim);
    if (!mapped) throw new Error(`${CASE_SECTIONS.find((section) => section.key === item.section)!.label}存在未映射证据的主张`);
    if (options.allowedRefs && mapped.source_refs.some((ref) => !options.allowedRefs!.has(ref))) throw new Error(`主张引用了未知证据: ${mapped.source_refs.join('、')}`);
    if (!mapped.excerpt) throw new Error(`${CASE_SECTIONS.find((section) => section.key === item.section)!.label}主张缺少原文摘录`);
    if (sourceMap.size) {
      const supporting = mapped.source_refs.map((ref) => sourceMap.get(ref)).filter((source): source is CaseEvidenceSnapshotItem => !!source)
        .filter((source) => sourceSupportsExcerpt(source, mapped.excerpt!, options.communications));
      if (!supporting.length) throw new Error(`${CASE_SECTIONS.find((section) => section.key === item.section)!.label}主张的摘录未在引用证据中找到`);
      const roles = supporting.flatMap((source) => sourceExcerptRoles(source, mapped.excerpt!, options.communications));
      mapped.speaker_role = roles.includes('customer') ? 'customer' : roles.includes('csm') ? 'csm' : 'unknown';
      const statuses = [...new Set(supporting.map((source) => source.status_category).filter((status): status is string => !!status && status !== 'unknown'))];
      mapped.status_category = statuses.length === 1 ? statuses[0] : 'unknown';
      if (['challenges', 'requirements', 'value'].includes(item.section)
        && supporting.some((source) => source.source_system === 'hemory') && !roles.includes('customer')) {
        // 真实会议的说话人形态多样（客户员工真名/无名分轨/拼接摘录），逐句角色判定无法稳定可靠——
        // 摘录可定位（防编造）保持阻断，说话人角色降级为非阻断告警（caseQualityReview 同款），由 CSM 复核。
        continue;
      }
    }
  }
  return parsed;
}

interface CasePromptInput {
  customer: Customer;
  timeline: SourceEvent[];
  hemory: SourceEvent[];
  evidence: EvidenceInput[];
  /** 仅供内部缺口复核并参与过期指纹，不能作为公开主张证据。 */
  risk: RiskAssessment | null;
  /** 仅供内部缺口复核并参与过期指纹，不能作为公开主张证据。 */
  opportunities: OpportunityHypothesis[];
  /** 生成时联网检索的客户公开信息；null = 本次未检索（如未注入依赖）。 */
  webContext: CaseWebSearchContext | null;
}

/** 片段选择：超上限时保留最早 1/3 + 最近 2/3（背景/痛点靠早期证据，价值靠近期证据），再按预算均摊截头。 */
function selectFragments(hemory: SourceEvent[]): SourceEvent[] {
  const sorted = [...hemory].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  if (sorted.length <= MAX_CASE_FRAGMENTS) return sorted;
  const early = Math.max(1, Math.floor(MAX_CASE_FRAGMENTS / 3));
  return [...sorted.slice(0, early), ...sorted.slice(-(MAX_CASE_FRAGMENTS - early))];
}

/** 摘录校验第二查找源：与 renderContext 注入的 communications 同口径（同选择、同预算、同截取）。 */
function caseCommunicationSources(input: CasePromptInput): CaseCommunicationSource[] {
  const fragments = selectFragments(input.hemory);
  const perFragment = Math.max(400, Math.floor(TRANSCRIPT_BUDGET / Math.max(1, fragments.length)));
  return fragments.map((event) => ({
    id: event.id,
    summary: typeof event.payload?.summary === 'string' ? event.payload.summary : '',
    // 校验用全文（含被预算截断的中后段）：模型可能引用 communications 之外、source_catalog 仅有摘要的句子——
    // 逐字定位与角色推导必须覆盖完整转写，否则中长片段的引用会误判「摘录未找到」。
    transcript: textOf(event),
    evidence: fragmentSpeechLines(event),
    csmName: input.customer.csmName,
  }));
}

function statusCategory(event: SourceEvent): string {
  const value = event.payload?.field005;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const category = (value as Record<string, unknown>).category;
    if (typeof category === 'string' && category) return category;
  }
  return 'unknown';
}

function eventExcerpt(event: SourceEvent): string {
  if (event.sourceSystem === 'hemory') return String(event.payload?.summary ?? event.payload?.transcript ?? event.title).slice(0, 600);
  if (event.sourceType === 'crm_followup') return String(event.payload?.active_record_content ?? event.payload?.content ?? event.title).slice(0, 600);
  return `${event.title}${nestedName(event.payload?.field005) ? `（状态：${nestedName(event.payload?.field005)}）` : ''}`.slice(0, 600);
}

function customerPublicProfile(customer: Customer): Record<string, unknown> {
  return { id: customer.id, name: customer.name, short_name: customer.shortName ?? null, industry: customer.industry ?? null,
    usage_version: customer.usageVersion ?? null, products: customer.products ?? [] };
}

/** 交付事实统计（服务端预计算，仅交付事实口径，不含完成率百分比）。 */
export interface CaseDeliveryStats {
  /** 合作起点：confirmed 事件最早日期（YYYY-MM-DD）；无事件时为 null。 */
  firstConfirmedAt: string | null;
  /** 合作月数（按 30 天一月向下取整）。 */
  months: number | null;
  /** 交付完成量：suggestion_feedback / support_ticket / operations_ticket 三类 ONES 工作项的 {total, done}。 */
  categories: Array<{ source_type: string; label: string; total: number; done: number }>;
  /** 私有云实例条数（任意状态）。 */
  privateCloudInstances: number;
  /** 工单解决时效（天）：support/operations 已完成项 field009→field010 的中位数与最小值；样本不足为 null。 */
  ticketResolutionDays: { median: number; min: number } | null;
  /** 工时登记总小时数（field019 累加）。 */
  registeredHours: number | null;
}

const CASE_STATS_CATEGORY_LABELS: Record<string, string> = {
  suggestion_feedback: '建议与反馈', support_ticket: '工单', operations_ticket: '运维工单',
};

function payloadDate(value: unknown): number | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}+08:00` : text;
  const at = Date.parse(normalized);
  return Number.isFinite(at) ? at : null;
}

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 服务端预计算的交付事实统计：合作起点/时长、各类已完成交付量、工单解决时效、工时投入。
 * 这些数字由本地已同步数据计算（非模型推导），作为可引用素材注入案例上下文——
 * 口径只有「已完成的交付事实」，不含完成率百分比（低完成率写进对外案例有口径风险）。
 */
export function caseDeliveryStats(input: { customer: Customer; timeline: SourceEvent[]; hemory: SourceEvent[] }): CaseDeliveryStats {
  const confirmed = [...input.timeline, ...input.hemory].filter((event) => event.attributionStatus === 'confirmed');
  const times = confirmed.map((event) => Date.parse(event.occurredAt)).filter(Number.isFinite);
  const firstAt = times.length ? Math.min(...times) : null;
  const categories = ['suggestion_feedback', 'support_ticket', 'operations_ticket'].map((sourceType) => {
    const items = confirmed.filter((event) => event.sourceSystem === 'ones' && event.sourceType === sourceType);
    return { source_type: sourceType, label: CASE_STATS_CATEGORY_LABELS[sourceType] ?? sourceType,
      total: items.length, done: items.filter((item) => isDeliveredOnesEvent(item)).length };
  });
  const privateCloudInstances = confirmed.filter((event) => event.sourceSystem === 'ones' && event.sourceType === 'private_cloud_instance').length;
  const resolutions = confirmed
    .filter((event) => event.sourceSystem === 'ones' && (event.sourceType === 'support_ticket' || event.sourceType === 'operations_ticket')
      && isDeliveredOnesEvent(event))
    .map((event) => {
      const created = payloadDate(event.payload?.field009);
      const updated = payloadDate(event.payload?.field010);
      return created != null && updated != null && updated >= created ? (updated - created) / 86_400_000 : null;
    })
    .filter((days): days is number => days != null)
    .sort((a, b) => a - b);
  const registeredHours = (() => {
    let total = 0;
    let seen = false;
    for (const event of confirmed) {
      if (event.sourceSystem !== 'ones' || event.sourceType !== 'customer_manhour') continue;
      const raw = Number(event.payload?.field019);
      if (Number.isFinite(raw) && raw > 0) { total += raw / 100_000; seen = true; }
    }
    return seen ? roundHours(total) : null;
  })();
  return {
    firstConfirmedAt: firstAt != null ? new Date(firstAt).toISOString().slice(0, 10) : null,
    months: firstAt != null ? Math.max(0, Math.floor((Date.now() - firstAt) / (30 * 86_400_000))) : null,
    categories,
    privateCloudInstances,
    ticketResolutionDays: resolutions.length ? { median: roundHours(resolutions[Math.floor((resolutions.length - 1) / 2)]), min: roundHours(resolutions[0]) } : null,
    registeredHours,
  };
}

/** 统计条目的自然语言正文（作为 stats 证据的 excerpt，逐字校验在此定位）。 */
function deliveryStatsText(stats: CaseDeliveryStats, customer: Customer): string {
  const parts: string[] = [];
  if (stats.firstConfirmedAt) {
    parts.push(`最早记录 ${stats.firstConfirmedAt} 起${stats.months != null && stats.months > 0 ? `，合作约 ${stats.months} 个月` : ''}`);
  }
  for (const category of stats.categories) {
    if (!category.total) continue;
    parts.push(`${category.label}共 ${category.total} 项，已完成 ${category.done} 项`);
  }
  if (stats.privateCloudInstances) parts.push(`私有云实例 ${stats.privateCloudInstances} 个`);
  if (stats.ticketResolutionDays) {
    const { median, min } = stats.ticketResolutionDays;
    parts.push(`已完成工单解决时长中位约 ${median} 天，最快 ${min} 天`);
  }
  if (stats.registeredHours != null) parts.push(`累计登记服务投入 ${stats.registeredHours} 小时（客户：${customer.name}）`);
  return parts.join('；');
}

export function caseFingerprint(customer: Customer | string, timeline: SourceEvent[], hemory: SourceEvent[] = [], evidence: EvidenceInput[] = [],
  risk: RiskAssessment | null = null, opportunities: OpportunityHypothesis[] = []): string {
  const profile = typeof customer === 'string' ? { id: customer } : customerPublicProfile(customer);
  const seen = new Set<string>();
  const events: string[] = [];
  for (const event of [...timeline, ...hemory].sort((a, b) => a.id.localeCompare(b.id))) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(`${event.id}:${event.payloadHash}:${event.attributionStatus}`);
  }
  const evidenceParts = [...evidence].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((item) => `${item.id ?? ''}:${item.kind}:${item.detail}:${item.confidence}:${item.occurredAt}`);
  const riskState = risk ? { level: risk.level, coverage: risk.coverage, dimensions: risk.dimensions, unknowns: risk.unknowns, ruleVersion: risk.ruleVersion } : null;
  const opportunityState = [...opportunities].sort((a, b) => a.id.localeCompare(b.id)).map((item) => ({
    id: item.id, title: item.title, detail: item.detail, confidence: item.confidence, status: item.status, evidenceRefs: item.evidenceRefs,
  }));
  return hash(JSON.stringify({ version: CASE_GENERATION_VERSION, profile, events, evidence: evidenceParts, risk: riskState, opportunities: opportunityState }));
}

/** stats 证据条目 ID（claim_evidence 引用它的 source_ref）。 */
export const CASE_STATS_SOURCE_ID = 'stats:delivery';

function buildContextSnapshot(input: CasePromptInput): CaseContextSnapshot {
  const generatedAt = new Date().toISOString();
  const internalDigest = caseFingerprint(input.customer, input.timeline, input.hemory, input.evidence, input.risk, input.opportunities);
  const stats = caseDeliveryStats(input);
  const statsText = deliveryStatsText(stats, input.customer);
  // 档案摘录用自然语言而非 JSON.stringify：摘录校验要求「excerpt 逐字是来源原文的子串」，
  // JSON 化的键值串（带引号逗号）模型几乎不可能逐字抄对，背景主张会稳定校验失败（真实验收教训）。
  const profileText = [
    `客户名称：${input.customer.name}`,
    input.customer.shortName && input.customer.shortName !== input.customer.name ? `简称：${input.customer.shortName}` : '',
    input.customer.industry ? `行业：${input.customer.industry}` : '',
    input.customer.usageVersion ? `使用版本：${input.customer.usageVersion}` : '',
    input.customer.products?.length ? `产品：${input.customer.products.join('、')}` : '',
  ].filter(Boolean).join('；');
  const sources: CaseEvidenceSnapshotItem[] = [{
    id: `customer:${input.customer.id}`, source_system: 'crm', source_type: 'customer_profile', external_id: input.customer.id,
    occurred_at: input.customer.updatedAt, synced_at: input.customer.syncedAt ?? input.customer.updatedAt,
    title: input.customer.name, excerpt: profileText, url: '', payload_hash: hash(profileText),
  }];
  if (statsText) {
    // 交付事实统计以独立证据条目进入来源目录：数字由服务端预计算，claim_evidence 可直接引用其原文。
    sources.push({ id: CASE_STATS_SOURCE_ID, source_system: 'internal', source_type: 'stats:delivery', external_id: CASE_STATS_SOURCE_ID,
      occurred_at: generatedAt, synced_at: generatedAt, title: '交付事实统计（服务端预计算）', excerpt: statsText, url: '',
      payload_hash: hash(statsText) });
  }
  const seen = new Set(sources.map((item) => item.id));
  for (const event of [...input.timeline, ...input.hemory]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    // speaker_lines 只保留「角色:行数」摘要行——完整逐句文本已在 communications（注入的片段）与
    // 摘录校验的第二查找源中，catalog 再放一份全量转写会让大客户上下文重复注入数万字符。
    const speakerLines = event.sourceSystem === 'hemory'
      ? speakerRoleSummaryLines(event, input.customer.csmName)
      : undefined;
    sources.push({ id: event.id, source_system: event.sourceSystem, source_type: event.sourceType, external_id: event.externalId,
      occurred_at: event.occurredAt, synced_at: event.syncedAt, title: event.title.slice(0, 160), excerpt: eventExcerpt(event),
      url: event.url ?? '', payload_hash: event.payloadHash, status_category: statusCategory(event), speaker_lines: speakerLines });
  }
  for (const item of input.evidence) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    sources.push({ id: item.id, source_system: item.sourceSystem, source_type: `evidence:${item.kind}`, external_id: item.id,
      occurred_at: item.occurredAt, synced_at: generatedAt, title: item.label.slice(0, 160), excerpt: item.detail.slice(0, 600),
      url: item.sourceUrl ?? '', payload_hash: hash(`${item.kind}:${item.detail}:${item.confidence}`) });
  }
  for (const item of input.webContext?.results ?? []) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    sources.push({ id: item.id, source_system: 'web', source_type: `web:${item.sourceTier}`, external_id: item.url,
      occurred_at: item.date || generatedAt, synced_at: input.webContext!.searchedAt, title: item.title, excerpt: item.snippet,
      url: item.url, payload_hash: hash(JSON.stringify(item)) });
  }
  const digest = hash(JSON.stringify({ internalDigest, web: input.webContext?.results ?? [], searchedAt: input.webContext?.searchedAt ?? null }));
  return { generated_at: generatedAt, internal_digest: internalDigest, digest, sources };
}

function renderContext(input: CasePromptInput, snapshot: CaseContextSnapshot): string {
  const { customer, timeline, hemory, evidence, risk, opportunities, webContext } = input;
  const confirmed = timeline.filter((event) => event.attributionStatus === 'confirmed');
  // records 预算：全量事件清单无上限时大客户（数百条）会稀释注意力——保最早 1/6 + 最近 5/6。
  const recordEvents = confirmed
    .filter((event) => event.sourceSystem !== 'hemory' && event.sourceType !== 'crm_followup');
  const keptRecords = recordEvents.length <= MAX_CASE_RECORDS
    ? recordEvents
    : [...recordEvents.slice(0, Math.max(1, Math.floor(MAX_CASE_RECORDS / 6))), ...recordEvents.slice(-(MAX_CASE_RECORDS - Math.max(1, Math.floor(MAX_CASE_RECORDS / 6))))];
  const records = keptRecords
    .map((event) => ({ source_ref: event.id, date: event.occurredAt.slice(0, 10), system: event.sourceSystem, type: event.sourceType,
      display: event.displayId ?? '', title: event.title.slice(0, 120), status: nestedName(event.payload?.field005) || '', status_category: statusCategory(event) }));
  const delivered = confirmed
    .filter((event) => event.sourceSystem === 'ones' && isDeliveredOnesEvent(event))
    .map((event) => ({ source_ref: event.id, date: event.occurredAt.slice(0, 10), type: event.sourceType,
      display: event.displayId ?? '', title: event.title.slice(0, 120), status_category: statusCategory(event) }))
    .slice(0, MAX_DELIVERED_RECORDS);
  const followups = confirmed
    .filter((event) => event.sourceType === 'crm_followup')
    .slice(-MAX_CASE_FOLLOWUPS)
    .map((event) => ({ source_ref: event.id, date: event.occurredAt.slice(0, 10), title: event.title.slice(0, 120),
      content: String(event.payload?.active_record_content ?? event.title).slice(0, 400) }));
  const fragments = selectFragments(hemory);
  const perFragment = Math.max(400, Math.floor(TRANSCRIPT_BUDGET / Math.max(1, fragments.length)));
  const communications = fragments.map((event) => ({
    id: event.id, occurred_at: event.occurredAt, topic: event.title, recording_id: String(event.payload?.recordingId ?? ''),
    speakers: Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : [],
    summary: typeof event.payload?.summary === 'string' ? event.payload.summary : '',
    transcript: textOf(event).slice(0, perFragment),
  }));
  const signals = caseFragmentSignals(hemory, customer.csmName);
  const statsSource = snapshot.sources.find((item) => item.id === CASE_STATS_SOURCE_ID);
  return JSON.stringify({
    customer: { source_ref: `customer:${customer.id}`, ...customerPublicProfile(customer) },
    delivery_stats: statsSource ? { source_ref: CASE_STATS_SOURCE_ID, facts: statsSource.excerpt } : undefined,
    evidence_signals: evidence.slice(0, MAX_CASE_EVIDENCE).map((item) => ({ source_ref: item.id, kind: item.kind, label: item.label,
      detail: item.detail.slice(0, 200), occurred_at: item.occurredAt })),
    communications,
    records,
    crm_followups: followups,
    delivered_records: delivered,
    pain_point_signals: signals.painPoints,
    requirement_signals: signals.requirements,
    solution_signals: signals.solutions,
    value_signals: signals.values,
    internal_review_signals: signals.review,
    internal_business_review: {
      note: '仅供识别内部缺口并写入 unknowns，不得写入公开正文，也不得作为 claim_evidence',
      risk: risk ? { level: risk.level, dimensions: Object.keys(risk.dimensions ?? {}), unknowns: risk.unknowns } : null,
      opportunities: opportunities.map((item) => ({ title: item.title, detail: item.detail.slice(0, 200), status: item.status })),
    },
    source_catalog: snapshot.sources.map((item) => ({ source_ref: item.id, title: item.title, excerpt: item.excerpt,
      speaker_lines: item.speaker_lines, status_category: item.status_category, source_type: item.source_type })),
    allowed_source_refs: snapshot.sources.map((item) => item.id),
    web_context: webContext
      ? { searched: webContext.searched, results: webContext.results, errors: webContext.errors.length ? webContext.errors : undefined }
      : '本次生成未联网检索，背景只依据内部档案与沟通记录',
  });
}

async function proposeCaseWithModel(runtime: Runtime, input: CasePromptInput, snapshot: CaseContextSnapshot, onProgress?: (text: string) => void): Promise<ParsedCaseContent> {
  // 摘录校验的第二查找源：catalog 的 hemory 条目只带角色摘要，逐句定位回退到注入片段正文。
  const communications = caseCommunicationSources(input);
  const prompt = `为客户「${input.customer.name}」生成一篇客户成功案例草稿。这份案例经 CSM 审核后会用于对外展示与复用，是正式的客户叙事型案例。你只能基于下面提供的上下文证据写作，不执行任何工具或外部写入。\n`
    + `按固定叙事路径输出五个章节，只输出 JSON：\n`
    + `{"title":"...","background":"...","challenges":["..."],"requirements":["..."],"solution":"...","value":["..."],"claim_evidence":[{"section":"background|challenges|requirements|solution|value","claim":"与正文逐字一致的完整主张","source_refs":["上下文中的 source_ref"],"excerpt":"支持该主张的原文摘录","speaker_role":"customer|csm|unknown","status_category":"done|in_progress|to_do|unknown","confidence":0.0}],"unknowns":["..."]}\n`
    + `写作总则（全部章节适用）：\n`
    + `- 客户叙事视角：客户是主角，按「背景 → 痛点/现状/挑战 → 需求/要求 → 解决方案 → 价值」的故事路径组织；不按 CRM、ONES、会议记录等数据来源罗列过程。\n`
    + `- 多个系统中同一件事必须合并为一条叙述，禁止会议流水账与工单流水账。\n`
    + `- 动笔前先通读 pain_point_signals、value_signals、delivered_records、delivery_stats 与 web_context，按素材充分度决定各章节条数：素材充足时取条数区间上限，素材不足时宁少勿注水；没有把握写入正文的素材收进 unknowns，不得硬凑条目。\n`
    + `- 只写有证据的事实。每个背景/方案段以及每条列表正文都必须在 claim_evidence 中逐字复写并绑定真实 source_ref；claim 字段是对正文整段/整条的逐字符复制（不是摘要、不得增删或改写任何一个字），background 与 solution 整段作为一条 claim 完整复制。禁止引用 allowed_source_refs 之外的 ID。摘录（excerpt）必须从某一个来源（source_refs 中列出的任一来源）的 title/excerpt/事实原文中连续逐字截取，不得自行改写、不得拼接多个来源的片段、不得跨来源拼凑——正文若综合了多个来源的信息，excerpt 只需截取其中最能支撑该主张的那一个来源的连续原文（如 delivery_stats 的 facts 原文、customer 档案的「行业：…」句、某一条 web snippet）。\n`
    + `- 公开检索信息只能依据 snippet 中可直接核验的事实；customer_official、government_procurement（以及旧版 official）可用于背景/正式要求，media 只能辅助背景。标题命中客户名不能单独成文，同名或业务不符结果必须丢弃。\n`
    + `- 交付统计（delivery_stats）的数字由服务端从交付记录预计算，可直接引用（引用 source_ref "${CASE_STATS_SOURCE_ID}"、摘录取其原文），但只可作事实陈述（如累计完成 N 项、合作 N 个月、解决时长中位 N 天）；不得自行计算任何提升百分比或完成率。若某类「已完成数」不足「总数」的一半，只写已完成的部分，不在对外正文中暴露未完成口径。\n`
    + `- 价值纪律：优先使用已确认的量化结果（含 delivery_stats 中的交付事实）；没有量化证据时只写有证据支持的定性价值，禁止虚构 ROI、百分比或任何数字。\n`
    + `- 未确认内容只能写入 unknowns，绝不在正文写「待确认」「待补充」「unknown」或其他占位词。unknowns 每条写明「缺失项 + 建议向谁/从哪里确认」（如「量化收益数据待补：建议向客户项目负责人索取上线前后对比数据」）。\n`
    + `- 正文禁止出现 unknown 等占位词、内部系统名（Hemory、CRM）、风险评级/评分、工时统计、行动事项等内部信息，禁止出现联系人姓名、联系方式、合同金额，不得泄露其他客户或其他项目的信息。delivery_stats 中的工时投入不得写成客户价值，只能作为背景里的服务投入事实。\n`
    + `- internal_business_review 只用于发现需线下复核的内部缺口并写入 unknowns，绝不能进入正文或 claim_evidence。\n`
    + `- 禁止生成直接或间接的虚构客户引语；只有 speakerRole=customer 的逐句证据才能概括为客户反馈，且正文不加引号。CSM/unknown 说话人的判断只能进 unknowns。\n`
    + `- 所有数字、比例、效率、成本、时长和规模必须能在 claim_evidence 引用的原文（含 delivery_stats 的 facts 原文）中找到，不得自行计算提升百分比。\n`
    + `章节路由判定（关键词只是线索，必须同时看 speakerRole、timeScope、statusCategory、来源和上下文）：\n`
    + `- 背景：行业、业务、组织、产品线、项目范围、合作起点、建设目标；只取客户档案、早期沟通记录，以及 web_context 中可信的公开信息（招投标、制度要求、公开报道等）。\n`
    + `- 痛点：无法、困难、低效、耗时、人工/表格、孤岛、分散、不透明、重复、协作不畅、缺少规范/追溯；必须是合作前或当前问题，已解决事项不再写成现状。\n`
    + `- 需求：希望、需要、必须、期望、要求、支持、集成、迁移、权限、安全、合规、验收、SLA、时间节点；必须是客户明确诉求或正式招采要求。\n`
    + `- 方案：已建立/配置/部署/迁移/打通/培训/交付/完成上线；ONES 记录必须 status_category=done，讨论、计划和待办不得写成已交付。\n`
    + `- 价值：提升、缩短、减少、节省、统一、透明、规范、可追溯、覆盖、采用、满意、认可；必须来自客户说话人或可复核指标，并发生在方案落地之后，泛泛「很好」不能单独成项。\n`
    + `冲突示例：「希望 9 月上线」属于需求；「尚未上线」不属于方案；「已完成上线」属于方案；「全面使用」只有真实采用证据时才属于价值；CSM 说「效率提升」只进入 unknowns。\n`
    + `章节要求：\n`
    + `1. background（客户背景）：一段 150~400 字的连贯叙述——客户所处行业与业务概况、与 ONES 合作的起点与目标，可自然融入合作时长与服务投入（delivery_stats）。依据客户档案（customer 来源，其 excerpt 为「行业：…；使用版本：…」等自然语言句，摘录从中逐字截取）、早期沟通记录，以及 web_context 中可信的公开信息（招投标、制度要求、公开报道等）。\n`
    + `2. challenges（痛点、现状与挑战）：3~6 条，客户在合作前或合作中面临的核心业务痛点与现状困难，每条 30~120 字且包含「痛点现象 + 具体场景或影响」两层，禁止一句话条目。重点从 pain_point_signals 中客户原话表达的痛点线索（系统未打通、效率低、表格/人工管理、信息不透明、协作不畅等）分析整理并归纳为主题；信号只是线索，须结合上下文甄别（如转述他人情形、已解决的历史问题不写入）；工单/建议/运维记录作为补充佐证。\n`
    + `3. requirements（需求与要求）：2~6 条，客户明确提出的需求与要求（功能诉求、交付要求、服务标准），每条 30~120 字；有明确时间节点的要求保留节点；web_context 中可信的招投标/制度类公开信息可作为佐证。\n`
    + `4. solution（解决方案）：以「我们为客户提供了什么方案」为主线的连贯叙述，全文 250~800 字、2~5 个自然段——从 delivered_records（已完成交付）与会议讨论中提炼方案级举措（如建立需求池/需求管理机制、提供资源管理、二次开发打通既有系统、开发定制插件、搭建知识库等），每项举措一段（80~250 字）说明其内容与所解决的问题，可引用 delivery_stats 的交付完成量佐证规模；不得写成功能点罗列、按日期排列的事件流水或需求清单；每一项举措都必须有交付记录或会议证据支撑，不得虚构。\n`
    + `5. value（价值与成效）：2~6 条，客户获得的已确认价值，每条 30~150 字。重点从 value_signals 中客户的正面反馈表述（如对效率提升、流程改善的认可）与 signals 中的成果反馈分析总结；量化结果优先（上线时间、效率改善、问题下降等，含 delivery_stats 的交付事实），无量化写有证据支持的定性价值，可适度转述客户反馈但不得出现人名；禁止虚构数字。\n`
    + `篇幅契约是质量要求而非硬性字符数：上下文素材不足以支撑下限时允许略低，但禁止明显低于下限的空泛正文；超出上限的冗长堆砌同样不合格。\n`
    + `内部字段（不进入正文）：claim_evidence 为逐条事实依据；unknowns 为 CSM 需补充确认的关键信息清单。\n`
    + `title：案例标题，概括客户从痛点到价值的实践，也可朴素地写「${input.customer.name}客户成功案例」。\n`
    + `${onesAsrAliasRule()}该订正适用于全部正文。\n`
    + `上下文：${renderContext(input, snapshot)}`;
  // 中继端点偶发连接超时（undici 10s 连接超时，实测坏窗口可持续数分钟）：complete 不抛异常而是
  // 返回 stopReason='error' + errorMessage，必须显式透出真实原因并自动重试；固定短间隔重试会整个
  // 落在同一坏窗口内，指数退避（5s→15s→45s）才能跨出去。
  const MAX_MODEL_ATTEMPTS = 3;
  const retryDelayMs = (attempt: number) => 5_000 * 3 ** (attempt - 1);
  let lastError = '模型未返回可解析的案例 JSON';
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
    // 输出预算：五章正文 + claim_evidence 的 JSON 常达 8k+ 中文字符，reasoning token 与正文共享
    // completion 上限——服务端默认 8k 会截断成 stopReason=length（真实验收教训），显式给大预算。
    const response = await completeModelWithProgress(runtime, {
      systemPrompt: '你是 ONES 客户成功案例撰写助手。你产出的是经 CSM 审核后用于对外复用的客户成功案例正文：只能基于用户提供的证据写作，客观克制、客户叙事视角，不执行任何工具或外部写入。',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    }, onProgress ? (tick) => onProgress(modelProgressText(tick)) : undefined, { maxTokens: CASE_MODEL_MAX_TOKENS, timeoutMs: 180_000 });
    if (response.stopReason === 'error') {
      lastError = `模型调用失败（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次）: ${response.errorMessage || '未知错误'}`;
      if (attempt < MAX_MODEL_ATTEMPTS) {
        onProgress?.(`${lastError}，${Math.round(retryDelayMs(attempt) / 1000)} 秒后自动重试`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      }
      continue;
    }
    const value = cleanJson(extractText(response.content));
    if (value) {
      try { return parseCaseContent(value, { requirePublic: true, allowedRefs: new Set(snapshot.sources.map((item) => item.id)), sources: snapshot.sources, communications }); }
      catch (error) {
        lastError = `模型案例契约不合格（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次）: ${(error as Error).message}`;
        onProgress?.(lastError);
      }
    } else {
      lastError = `模型未返回可解析的案例 JSON（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次，stopReason=${response.stopReason}）`;
    }
    if (attempt < MAX_MODEL_ATTEMPTS) {
      onProgress?.(`模型输出未通过校验（第 ${attempt}/${MAX_MODEL_ATTEMPTS} 次），正在重写`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  throw new Error(lastError);
}

/** 素材覆盖度：关键素材被 claim_evidence 实际引用的比例（诊断生成是否浪费素材，非正确性判定）。 */
export interface CaseCoverage {
  delivered: { total: number; cited: number };
  valueSignals: { total: number; cited: number };
  painSignals: { total: number; cited: number };
  authoritativeWeb: { total: number; cited: number };
}

/** 补写触发阈值（从严）：单一素材池引用率过低且样本足够多才补写；单边聚焦是正常写作不算浪费。 */
const COVERAGE_DELIVERED_MIN = 5;
const COVERAGE_DELIVERED_RATIO = 1 / 3;
const COVERAGE_VALUE_MIN = 4;
const COVERAGE_VALUE_RATIO = 1 / 4;

export function caseCoverage(content: { claim_evidence: Array<{ source_refs: string[] }> }, input: CasePromptInput): CaseCoverage {
  const cited = new Set(content.claim_evidence.flatMap((item) => item.source_refs));
  const confirmed = input.timeline.filter((event) => event.attributionStatus === 'confirmed');
  const deliveredTotal = confirmed.filter((event) => event.sourceSystem === 'ones' && isDeliveredOnesEvent(event)).map((event) => event.id);
  const signals = caseFragmentSignals(input.hemory, input.customer.csmName);
  const authoritativeWeb = (input.webContext?.results ?? []).filter((item) => item.sourceTier === 'customer_official' || item.sourceTier === 'government_procurement' || item.sourceTier === 'official').map((item) => item.id);
  const count = (ids: string[]) => ({ total: ids.length, cited: ids.filter((id) => cited.has(id)).length });
  return { delivered: count(deliveredTotal), valueSignals: count(signals.values.map((item) => item.fragment_id)),
    painSignals: count(signals.painPoints.map((item) => item.fragment_id)), authoritativeWeb: count(authoritativeWeb) };
}

/** 覆盖率是否低到值得追加一次「补充完善」调用（从严阈值：只在主要素材池大量闲置时触发）。 */
export function coverageNeedsEnrichment(coverage: CaseCoverage): boolean {
  const deliveredLow = coverage.delivered.total > COVERAGE_DELIVERED_MIN
    && coverage.delivered.cited < coverage.delivered.total * COVERAGE_DELIVERED_RATIO;
  const valueLow = coverage.valueSignals.total > COVERAGE_VALUE_MIN
    && coverage.valueSignals.cited < coverage.valueSignals.total * COVERAGE_VALUE_RATIO;
  return deliveredLow || valueLow;
}

/** 覆盖率的一行人类可读描述（进度列/CLI 共用）。 */
export function coverageSummary(coverage: CaseCoverage): string {
  return `素材覆盖率：交付记录 ${coverage.delivered.cited}/${coverage.delivered.total}`
    + `，价值信号 ${coverage.valueSignals.cited}/${coverage.valueSignals.total}`
    + `，痛点信号 ${coverage.painSignals.cited}/${coverage.painSignals.total}`
    + `，权威公开资料 ${coverage.authoritativeWeb.cited}/${coverage.authoritativeWeb.total}`;
}

/** 未被引用的关键素材清单（补写 prompt 注入；只列主要池，避免清单本身过长）。 */
function uncoveredMaterialList(content: { claim_evidence: Array<{ source_refs: string[] }> }, input: CasePromptInput, snapshot: CaseContextSnapshot): string[] {
  const cited = new Set(content.claim_evidence.flatMap((item) => item.source_refs));
  const sourceMap = new Map(snapshot.sources.map((item) => [item.id, item]));
  const confirmed = input.timeline.filter((event) => event.attributionStatus === 'confirmed');
  const items: string[] = [];
  for (const event of confirmed.filter((item) => item.sourceSystem === 'ones' && isDeliveredOnesEvent(item))) {
    if (cited.has(event.id)) continue;
    items.push(`- [已交付记录] ${event.occurredAt.slice(0, 10)} ${event.title.slice(0, 80)}（source_ref: ${event.id}）`);
  }
  const signals = caseFragmentSignals(input.hemory, input.customer.csmName);
  for (const signal of signals.values) {
    if (cited.has(signal.fragment_id)) continue;
    items.push(`- [客户正面反馈] ${signal.date} ${signal.theme}：${signal.excerpt.slice(0, 80)}（source_ref: ${signal.fragment_id}）`);
  }
  for (const item of items) {
    const ref = item.match(/source_ref: (\S+?)）/)?.[1];
    if (!ref || !sourceMap.has(ref)) return items; // 兜底：来源不在 catalog 时不注入清单
  }
  return items;
}

/**
 * 追加一次「补充完善」生成：把未引用素材清单反馈给模型重写一稿。
 * 同样过全套公开契约校验；失败保留第一稿（返回 null 由调用方降级），不因补写失败判任务失败。
 */
async function enrichCaseWithModel(runtime: Runtime, input: CasePromptInput, snapshot: CaseContextSnapshot, first: ParsedCaseContent,
  uncovered: string[], onProgress?: (text: string) => void): Promise<ParsedCaseContent | null> {
  const communications = caseCommunicationSources(input);
  const basePrompt = `为客户「${input.customer.name}」补充完善客户成功案例草稿。这是第二遍生成：第一稿已通过契约校验，但以下关键素材未被引用，说明案例内容还不够充实。\n`
    + `未引用素材清单（全部真实存在，source_ref 可直接引用）：\n${uncovered.slice(0, 40).join('\n')}\n`
    + `要求：\n`
    + `- 在第一稿基础上充实内容：优先把上述素材中有价值的内容并入对应章节（已交付记录进 solution、客户正面反馈进 value），并为其新增 claim_evidence（claim 与正文逐字一致、摘录取素材原文）。\n`
    + `- 已合格且与素材无关的章节内容保持第一稿原文，不为了引用而引用、不堆砌清单；确实无价值的素材允许继续不引用。\n`
    + `- 输出完整的五章 JSON（与第一稿相同的 schema），不是增量补丁。\n`
    + `- 第一稿正文：\n${JSON.stringify({ title: first.title, background: first.background, challenges: first.challenges, requirements: first.requirements, solution: first.solution, value: first.value })}\n`
    + `上下文：${renderContext(input, snapshot)}`;
  const MAX_ATTEMPTS = 2;
  const retryDelayMs = (attempt: number) => 5_000 * 3 ** (attempt - 1);
  let lastError = '补充完善未返回可解析的案例 JSON';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await completeModelWithProgress(runtime, {
      systemPrompt: '你是 ONES 客户成功案例撰写助手。你产出的是经 CSM 审核后用于对外复用的客户成功案例正文：只能基于用户提供的证据写作，客观克制、客户叙事视角，不执行任何工具或外部写入。',
      messages: [{ role: 'user', content: basePrompt, timestamp: Date.now() }],
      tools: [],
    }, onProgress ? (tick) => onProgress(modelProgressText(tick)) : undefined, { maxTokens: CASE_MODEL_MAX_TOKENS, timeoutMs: 180_000 });
    if (response.stopReason === 'error') {
      lastError = `补充完善模型调用失败（第 ${attempt}/${MAX_ATTEMPTS} 次）: ${response.errorMessage || '未知错误'}`;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      continue;
    }
    const value = cleanJson(extractText(response.content));
    if (value) {
      try {
        const refined = parseCaseContent(value, { requirePublic: true, allowedRefs: new Set(snapshot.sources.map((item) => item.id)), sources: snapshot.sources, communications });
        // 补写稿必须真的更充实（引用素材数不少于第一稿），否则视为无效补写、保留第一稿。
        const citeCount = (content: ParsedCaseContent) => new Set(content.claim_evidence.flatMap((item) => item.source_refs)).size;
        if (citeCount(refined) >= citeCount(first)) return refined;
        lastError = '补充完善稿引用的证据不多于第一稿，弃用';
      } catch (error) {
        lastError = `补充完善契约不合格（第 ${attempt}/${MAX_ATTEMPTS} 次）: ${(error as Error).message}`;
        onProgress?.(lastError);
      }
    } else {
      lastError = `补充完善未返回可解析的案例 JSON（第 ${attempt}/${MAX_ATTEMPTS} 次，stopReason=${response.stopReason}）`;
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
  }
  onProgress?.(`${lastError}，保留第一稿`);
  return null;
}

/**
 * 内部信息残留检测（非阻断）：新版提示词生成的正文不应命中；发布前向 CSM 提示人工复核。
 * 只查客户版标题与五段文本，不查 claim_evidence/context_snapshot/unknowns。
 */
const CASE_INTERNAL_EVIDENCE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /hemory/i, label: 'Hemory' },
  { pattern: /\bCRM\b/i, label: 'CRM' },
  { pattern: /风险评级|风险评分|健康度/, label: '内部风险评级/健康度' },
  { pattern: /工时\s*[\d.]+\s*(?:小时|h)/i, label: '内部工时统计' },
  { pattern: /\bunknown\b/i, label: 'unknown 占位词' },
  { pattern: /待确认|待补充/, label: '内部占位词' },
  { pattern: /客户(?:不满|抱怨|担忧|焦虑)/, label: '客户情绪内部记录' },
  { pattern: /有坑/, label: '内部记录式表达「有坑」' },
  { pattern: /https?:\/\/\S+/i, label: '原始链接' },
  { pattern: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/, label: '邮箱地址' },
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/, label: '手机号码' },
  { pattern: /合同金额|续约金额|客单价|ARR|MRR/i, label: '合同或收入信息' },
];

export function caseContentWarnings(draft: CaseDraft): string[] {
  return caseTextsContentWarnings(draft.title, draft.fields);
}

/** 残留检测核心（标题 + 五段文本），caseContentWarnings 与写回护栏 caseNarrativeWarnings 共用。 */
function caseTextsContentWarnings(title: string, fields: Record<string, unknown>): string[] {
  const texts = caseSectionTexts(fields);
  const textsByKey: Record<keyof CaseNarrativeFields, string[]> = {
    background: [texts.background],
    challenges: texts.challenges,
    requirements: texts.requirements,
    solution: [texts.solution],
    value: texts.value,
  };
  const warnings: string[] = [];
  for (const { pattern, label } of CASE_INTERNAL_EVIDENCE_PATTERNS) {
    const hits = [
      ...(pattern.test(title) ? ['案例标题'] : []),
      ...CASE_SECTIONS
        .filter((section) => (textsByKey[section.key] ?? []).some((text) => pattern.test(text)))
        .map((section) => section.label),
    ];
    if (hits.length) warnings.push(`客户版正文检出内部信息「${label}」（${hits.join('、')}），请确认已转换为面向客户的表达后再发布`);
  }
  return warnings;
}

/**
 * 写回护栏（非阻断）：对话精修与结构化编辑只做字段合并，没有生成路径的逐字校验——
 * 这里检查明显异常的编辑结果（条目数失控/单条超长/内部信息残留/占位词），命中不阻止保存，
 * 只通过 API 响应返回 warnings 交给 CSM 复核。
 */
export function caseNarrativeWarnings(fields: Record<string, unknown>): string[] {
  const texts = caseSectionTexts(fields);
  const warnings: string[] = [];
  const listSections: Array<{ key: 'challenges' | 'requirements' | 'value'; label: string }> = [
    { key: 'challenges', label: '痛点、现状与挑战' },
    { key: 'requirements', label: '需求与要求' },
    { key: 'value', label: '价值与成效' },
  ];
  for (const section of listSections) {
    const items = texts[section.key];
    if (items.length > CASE_LIST_ITEM_LIMIT) warnings.push(`「${section.label}」条目数 ${items.length} 超过 ${CASE_LIST_ITEM_LIMIT} 条，请确认不是编辑异常`);
    const overlong = items.filter((item) => item.length > CASE_ITEM_MAX_CHARS).length;
    if (overlong) warnings.push(`「${section.label}」有 ${overlong} 条超过 ${CASE_ITEM_MAX_CHARS} 字，请确认适合对外展示`);
  }
  for (const [label, text] of [['客户背景', texts.background], ['解决方案', texts.solution]] as const) {
    if (text.length > CASE_ITEM_MAX_CHARS * 4) warnings.push(`「${label}」超过 ${CASE_ITEM_MAX_CHARS * 4} 字，请确认适合对外展示`);
  }
  if (texts.background || texts.solution || texts.challenges.length || texts.requirements.length || texts.value.length) {
    const pseudo: Array<{ key: keyof CaseNarrativeFields; label: string }> = [
      { key: 'background', label: '客户背景' }, { key: 'challenges', label: '痛点、现状与挑战' },
      { key: 'requirements', label: '需求与要求' }, { key: 'solution', label: '解决方案' }, { key: 'value', label: '价值与成效' },
    ];
    for (const section of pseudo) {
      const items = typeof texts[section.key] === 'string' ? [texts[section.key] as unknown as string] : texts[section.key] as string[];
      if (items.some((item) => /待确认|待补充|\bunknown\b/i.test(item))) warnings.push(`「${section.label}」包含待确认/待补充占位词，请改为有证据的表述或移入待确认清单`);
    }
    warnings.push(...caseTextsContentWarnings('', fields));
  }
  return [...new Set(warnings)];
}

function contextSnapshotOf(draft: CaseDraft): CaseContextSnapshot | null {
  const value = draft.fields?.context_snapshot;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as CaseContextSnapshot;
  return typeof snapshot.internal_digest === 'string' && Array.isArray(snapshot.sources) ? snapshot : null;
}

function claimEvidenceOf(draft: CaseDraft): CaseClaimEvidence[] {
  return Array.isArray(draft.fields?.claim_evidence) ? draft.fields.claim_evidence as CaseClaimEvidence[] : [];
}

export interface CaseQualityReview {
  warnings: string[];
  digest: string;
  contextStale: boolean;
}

export function caseQualityReview(draft: CaseDraft, options: { currentInternalDigest?: string; otherCustomerNames?: string[]; now?: Date } = {}): CaseQualityReview {
  const warnings = caseContentWarnings(draft);
  const texts = caseSectionTexts(draft.fields);
  const snapshot = contextSnapshotOf(draft);
  const claims = claimEvidenceOf(draft);
  const now = options.now ?? new Date();
  const internalContextStale = !!snapshot && !!options.currentInternalDigest && snapshot.internal_digest !== options.currentInternalDigest;
  const web = draft.fields?.web_search as CaseWebSearchContext | undefined;
  const webSearchedAt = web?.searchedAt ? Date.parse(web.searchedAt) : Number.NaN;
  const webStale = !!web && (!Number.isFinite(webSearchedAt) || now.getTime() - webSearchedAt > CASE_WEB_FRESH_DAYS * 86_400_000);
  const contextStale = internalContextStale || webStale;
  for (const section of CASE_SECTIONS) {
    const value = texts[section.key];
    if (typeof value === 'string' ? !value : value.length === 0) warnings.push(`客户版正文「${section.label}」为空，请补充后再发布`);
  }
  if (!draft.title.trim()) warnings.push('客户版案例标题为空，请补充后再发布');
  const unknowns = Array.isArray(draft.fields?.unknowns) ? draft.fields.unknowns.map(String).filter(Boolean) : [];
  if (unknowns.length) warnings.push(`仍有 ${unknowns.length} 项内部待确认信息，请由 CSM 线下核实`);
  if (!snapshot) warnings.push('该草稿没有不可变上下文快照，无法完整核验公开事实');
  if (!claims.length) warnings.push('该草稿没有逐条 claim_evidence，无法证明正文主张来源');
  if (internalContextStale) warnings.push('生成后客户内部数据已更新，建议重新生成或逐条复核证据');
  if (!web || !web.results?.length) warnings.push('本次生成没有可核验的公开资料，客户背景只能依据内部档案');
  if (webStale) {
    warnings.push(`公开资料快照已超过 ${CASE_WEB_FRESH_DAYS} 天，建议重新生成后再发布`);
  }
  if (web?.results?.length && !web.results.some((item) => item.sourceTier !== 'media')) warnings.push('公开资料仅来自普通媒体，未找到客户官网、政府或招采等权威来源');
  const sourceMap = new Map((snapshot?.sources ?? []).map((item) => [item.id, item]));
  const allVisibleClaims: Array<{ section: CaseSectionKey; text: string }> = [
    { section: 'background', text: texts.background },
    ...texts.challenges.map((text): { section: CaseSectionKey; text: string } => ({ section: 'challenges', text })),
    ...texts.requirements.map((text): { section: CaseSectionKey; text: string } => ({ section: 'requirements', text })),
    { section: 'solution', text: texts.solution },
    ...texts.value.map((text): { section: CaseSectionKey; text: string } => ({ section: 'value', text })),
  ];
  const visibleClaims = allVisibleClaims.filter((item) => !!item.text);
  const solutionTimes = claims.filter((claim) => claim.section === 'solution')
    .flatMap((claim) => claim.source_refs.map((ref) => sourceMap.get(ref)?.occurred_at).filter((value): value is string => !!value))
    .map(Date.parse).filter(Number.isFinite);
  for (const item of visibleClaims) {
    const mapping = claims.find((claim) => claim.section === item.section && claim.claim === item.text);
    if (!mapping) { warnings.push(`「${item.text.slice(0, 36)}」缺少逐条证据映射`); continue; }
    const sources = mapping.source_refs.map((ref) => sourceMap.get(ref)).filter((source): source is CaseEvidenceSnapshotItem => !!source);
    if (sources.length !== mapping.source_refs.length) warnings.push(`「${item.text.slice(0, 36)}」引用了不存在的证据`);
    const supportingSources = mapping.excerpt ? sources.filter((source) => sourceSupportsExcerpt(source, mapping.excerpt!)) : [];
    if (!mapping.excerpt) warnings.push(`「${item.text.slice(0, 36)}」缺少证据原文摘录`);
    else if (!supportingSources.length) warnings.push(`「${item.text.slice(0, 36)}」的证据摘录无法在来源快照中定位`);
    const excerptRoles = supportingSources.flatMap((source) => sourceExcerptRoles(source, mapping.excerpt!));
    if (['challenges', 'requirements', 'value'].includes(item.section)
      && supportingSources.some((source) => source.source_system === 'hemory') && !excerptRoles.includes('customer')) {
      warnings.push(`「${item.text.slice(0, 36)}」引用的会议表述不是明确客户说话人`);
    }
    if (['challenges', 'requirements', 'value'].includes(item.section)
      && supportingSources.some((source) => source.source_type === 'crm_followup') && mapping.speaker_role !== 'customer') {
      warnings.push(`「${item.text.slice(0, 36)}」仅引用了 CSM 记录的 CRM 跟进，缺少明确客户说话人或正式来源`);
    }
    if (item.section === 'solution' && sources.some((source) => source.source_system === 'ones' && source.status_category !== 'done')) {
      warnings.push(`「${item.text.slice(0, 36)}」引用了未完成的 ONES 记录作为已交付方案`);
    }
    if (item.section === 'value') {
      const valueTimes = sources.map((source) => Date.parse(source.occurred_at)).filter(Number.isFinite);
      if (!solutionTimes.length || !valueTimes.some((valueTime) => solutionTimes.some((solutionTime) => solutionTime <= valueTime))) {
        warnings.push(`「${item.text.slice(0, 36)}」缺少先方案落地、后价值反馈的时间证据`);
      }
    }
    const numbers = item.text.match(/\d+(?:\.\d+)?%?/g) ?? [];
    for (const number of numbers) {
      if (!sources.some((source) => `${source.title} ${source.excerpt}`.includes(number))) warnings.push(`数字「${number}」未在引用证据原文中找到`);
    }
  }
  for (const name of options.otherCustomerNames ?? []) {
    if (name && name.length >= 3 && (draft.title.includes(name) || visibleClaims.some((item) => item.text.includes(name)))) warnings.push(`正文疑似包含其他客户名称「${name}」`);
  }
  // 正文引用了服务端交付统计（stats:delivery）时提示 CSM 确认对外披露口径（数字本身是事实，披露与否需人拍板）。
  if (claims.some((claim) => claim.source_refs.includes(CASE_STATS_SOURCE_ID))) {
    warnings.push('正文引用了服务端预计算的交付统计数字，请确认客户允许对外披露该口径');
  }
  warnings.push('公开发布前请由 CSM 线下确认客户名称、事实数据和客户反馈引用已获授权');
  const unique = [...new Set(warnings)];
  return { warnings: unique, digest: hash(JSON.stringify({ warnings: unique, context: snapshot?.digest ?? null })), contextStale };
}

export interface CaseDetail {
  draft: CaseDraft;
  markdown: string;
  warnings: string[];
  /** 生成后客户数据已变化（实时重算指纹 ≠ 草稿指纹）：非阻断提示「数据已更新，可重新生成」。 */
  contextStale: boolean;
  qualityReview: CaseQualityReview;
  /** 生成上下文概览：各源条数与最近同步时间（当前实时值，供审核参考）。 */
  contextSummary: Array<{ system: string; count: number; lastSyncedAt: string | null }>;
}

export class CaseService {
  private processing = new Set<string>();
  private publishing = new Set<string>();

  constructor(
    private readonly db: WorkbenchDatabase,
    private readonly mcp: McpHub,
    private readonly runtime?: Runtime,
    /** 联网检索依赖：注入后生成时现搜客户公开信息；未注入（如测试）跳过检索。 */
    private readonly webSearchDeps?: CaseWebSearchDeps,
  ) {}

  /** 案例全量上下文：不使用 UI 分页窗口；风险/机会只供内部缺口复核，不作为公开事实。 */
  private collectContext(customerId: string): { timeline: SourceEvent[]; hemory: SourceEvent[]; evidence: EvidenceInput[]; risk: RiskAssessment | null; opportunities: OpportunityHypothesis[] } {
    return {
      timeline: this.db.listCaseContextEvents(customerId),
      hemory: this.db.listConfirmedHemorySegments(customerId),
      evidence: this.db.listEvidence(customerId),
      risk: this.db.latestRisk(customerId),
      opportunities: this.db.listOpportunities(customerId),
    };
  }

  private internalDigest(customer: Customer, context = this.collectContext(customer.id)): string {
    return caseFingerprint(customer, context.timeline, context.hemory, context.evidence, context.risk, context.opportunities);
  }

  private webSnapshotFresh(draft: CaseDraft, now = new Date()): boolean {
    const web = draft.fields?.web_search as CaseWebSearchContext | undefined;
    if (!this.webSearchDeps) return true;
    if (!web?.searchedAt) return false;
    const at = Date.parse(web.searchedAt);
    return Number.isFinite(at) && now.getTime() - at <= CASE_WEB_FRESH_DAYS * 86_400_000;
  }

  /**
   * 生成（或幂等复用）某客户的案例草稿任务。指纹 = 版本:客户:事件集哈希；
   * 最新草稿为草稿态且指纹一致时直接复用；force 加盐换指纹强制重建。失败任务不落草稿，重试不会被幂等短路。
   */
  generate(customerId: string, force = false): { jobId: string | null; draftId?: string; fingerprint: string; reused?: boolean } {
    const customer = this.db.getCustomer(customerId);
    if (!customer) throw new Error('customer not found');
    const { timeline, hemory, evidence, risk, opportunities } = this.collectContext(customerId);
    if (!timeline.length && !hemory.length && !evidence.length) throw new Error('该客户没有已同步数据（请先同步）');
    const fingerprint = caseFingerprint(customer, timeline, hemory, evidence, risk, opportunities);
    const latest = this.db.listCaseDrafts(customerId)[0] ?? null;
    const latestSnapshot = latest ? contextSnapshotOf(latest) : null;
    if (latest && !force && latest.status === 'draft' && latestSnapshot?.internal_digest === fingerprint && this.webSnapshotFresh(latest)) {
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
    const report_ = (text: string) => this.db.updateDraftJobProgress(jobId, text);
    try {
      const customer = this.db.getCustomer(job.customerId);
      if (!customer) throw new Error('customer not found');
      report_('正在收集客户上下文…');
      // 执行时重新收集全量数据：任务排队期间新同步的数据也会并入。
      const { timeline, hemory, evidence, risk, opportunities } = this.collectContext(customer.id);
      if (!timeline.length && !hemory.length && !evidence.length) throw new Error('该客户没有已同步数据');
      if (!this.runtime) throw new Error('模型未配置，无法生成案例（请检查 LLM 配置后重新生成）');
      // 联网检索客户公开信息：任一角度失败只记入 errors 不阻断生成（未搜到=unknown，不作为事实依据）。
      const webContext = this.webSearchDeps ? await searchCaseWebContext(customer, this.webSearchDeps, report_) : null;
      const promptInput = { customer, timeline, hemory, evidence, risk, opportunities, webContext };
      report_(`上下文与信号就绪（${timeline.length} 条事件 / ${hemory.length} 个片段${webContext ? ` / ${webContext.results.length} 条公开信息` : ''}），模型撰写中…`);
      const snapshot = buildContextSnapshot(promptInput);
      let content: ParsedCaseContent;
      try { content = await proposeCaseWithModel(this.runtime, promptInput, snapshot, report_); }
      catch (error) { throw new Error(`模型未生成案例: ${(error as Error).message}`); }
      // 素材覆盖度诊断 + 从严阈值自动补写：主要素材池（已交付记录/客户正面反馈）大量闲置时
      // 追加一次「补充完善」调用；补写失败保留第一稿，不因补写失败判任务失败。
      const coverage = caseCoverage(content, promptInput);
      let enriched = false;
      if (coverageNeedsEnrichment(coverage)) {
        const uncovered = uncoveredMaterialList(content, promptInput, snapshot);
        if (uncovered.length) {
          report_(`${coverageSummary(coverage)}——关键素材闲置较多，自动补充完善中…`);
          const refined = await enrichCaseWithModel(this.runtime, promptInput, snapshot, content, uncovered, report_);
          if (refined) { content = refined; enriched = true; }
        }
      }
      const finalCoverage = enriched ? caseCoverage(content, promptInput) : coverage;
      const generator = `${this.runtime.llm.provider}/${this.runtime.llm.model}`;
      const evidenceRefs = [...new Set(content.claim_evidence.flatMap((item) => item.source_refs))];
      const fields: Record<string, unknown> = {
        customer_id: customer.id, customer_name: customer.name,
        background: content.background, challenges: content.challenges, requirements: content.requirements,
        solution: content.solution, value: content.value, claim_evidence: content.claim_evidence,
        context_snapshot: snapshot,
        coverage: { ...finalCoverage, enriched },
      };
      if (content.unknowns?.length) fields.unknowns = content.unknowns;
      // 检索审计快照：不渲染进正文，case show --json 可见生成时用了哪些公开信息。
      if (webContext) fields.web_search = webContext;
      const draft = this.db.createCaseDraft(customer.id, content.title ?? `${customer.name}客户成功案例`, fields, evidenceRefs,
        { fingerprint: snapshot.digest, generator });
      this.db.updateDraftJob(jobId, 'succeeded');
      this.db.audit('agent', 'generate_case_draft', 'case_draft', draft.id, { customerId: customer.id, generator, fingerprint: job.fingerprint, coverage: finalCoverage, enriched });
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
    const customer = this.db.getCustomer(draft.customerId);
    if (!customer) return undefined;
    const context = this.collectContext(draft.customerId);
    const { timeline, hemory } = context;
    const systems = new Map<string, { count: number; lastSyncedAt: string | null }>();
    for (const event of [...timeline, ...hemory]) {
      const current = systems.get(event.sourceSystem) ?? { count: 0, lastSyncedAt: null };
      current.count += 1;
      if (!current.lastSyncedAt || event.syncedAt > current.lastSyncedAt) current.lastSyncedAt = event.syncedAt;
      systems.set(event.sourceSystem, current);
    }
    const summary = [...systems.entries()].map(([system, info]) => ({ system, ...info })).sort((a, b) => a.system.localeCompare(b.system));
    // 生成时联网检索的条数（审计快照，web_search 字段无检索结果时 count 亦如实为 0）。
    const webSearch = draft.fields?.web_search as CaseWebSearchContext | undefined;
    if (webSearch) summary.push({ system: 'web', count: webSearch.results.length, lastSyncedAt: null });
    // 服务端预计算的交付事实统计条目（v4 起注入，claim_evidence 可引用）。
    if (contextSnapshotOf(draft)?.sources.some((item) => item.id === CASE_STATS_SOURCE_ID)) summary.push({ system: 'stats', count: 1, lastSyncedAt: null });
    const qualityReview = caseQualityReview(draft, {
      currentInternalDigest: this.internalDigest(customer, context),
      otherCustomerNames: this.db.listCustomers().filter((item) => item.id !== draft.customerId).flatMap((item) => [item.name, item.shortName ?? '']),
    });
    return {
      draft,
      markdown: renderCaseMarkdown(draft),
      warnings: qualityReview.warnings,
      contextStale: qualityReview.contextStale,
      qualityReview,
      contextSummary: summary,
    };
  }

  /** 五段正文编辑只合并公开字段；生成时的证据、客户绑定和联网快照不可被 PATCH 覆盖。 */
  update(draftId: string, version: number, title: string | undefined, input: Record<string, unknown>): CaseDraft | null {
    const draft = this.db.getCaseDraft(draftId);
    if (!draft || draft.status !== 'draft') return null;
    const current = caseSectionTexts(draft.fields);
    const incoming = caseSectionTexts(input);
    const has = (key: CaseSectionKey) => Object.prototype.hasOwnProperty.call(input, key);
    const fields = { ...draft.fields,
      background: has('background') ? incoming.background : current.background,
      challenges: has('challenges') ? incoming.challenges : current.challenges,
      requirements: has('requirements') ? incoming.requirements : current.requirements,
      solution: has('solution') ? incoming.solution : current.solution,
      value: has('value') ? incoming.value : current.value };
    return this.db.updateCaseDraft(draftId, version, title === undefined ? draft.title : title, fields);
  }

  publishPreview(draftId: string, parentPageID: string): { draft: CaseDraft; tool: string; args: Record<string, unknown>; approvalHash: string; warnings: string[]; reviewDigest: string } {
    const draft = this.db.getCaseDraft(draftId);
    if (!draft || draft.status !== 'draft') throw new Error('草稿不可发布（不存在或已发布）');
    if (!parentPageID.trim()) throw new Error('缺少 ONES 案例库父页面 ID');
    const tool = 'mcp__ones__create_page';
    const args = { parentPageID, title: draft.title, content: renderCaseMarkdown(draft) };
    const detail = this.detail(draftId)!;
    const reviewDigest = detail.qualityReview.digest;
    return { draft, tool, args, reviewDigest,
      approvalHash: argumentsHash({ draftId, version: draft.version, tool, args, reviewDigest }), warnings: detail.qualityReview.warnings };
  }

  async publish(draftId: string, version: number, parentPageID: string, approvalHash: string): Promise<CaseDraft> {
    const preview = this.publishPreview(draftId, parentPageID);
    const expected = argumentsHash({ draftId, version, tool: preview.tool, args: preview.args, reviewDigest: preview.reviewDigest });
    if (preview.draft.version !== version || expected !== approvalHash) throw new Error('草稿版本或批准内容已变化，请重新确认');
    const requestHash = argumentsHash({ draftId, version, parentPageID, approvalHash });
    const started = this.db.beginCasePublishAttempt(draftId, version, parentPageID, requestHash);
    if (!started.acquired) {
      if (started.attempt.status === 'succeeded') {
        const published = this.db.getCaseDraft(draftId);
        if (published?.status === 'published') return published;
      }
      if (started.attempt.status === 'unknown') throw new Error('上次发布结果未知，请先在 ONES Wiki 核对，避免重复创建页面');
      if (started.attempt.status === 'pending') {
        if (this.publishing.has(requestHash)) throw new Error('相同案例正在发布，请勿重复提交');
        this.db.updateCasePublishAttempt(started.attempt.id, 'unknown', { error: '服务重启或发布中断，无法确认外部结果' });
        throw new Error('上次发布在结果确认前中断，请先在 ONES Wiki 核对');
      }
      throw new Error(started.attempt.error || '案例发布未成功，请重新预览后重试');
    }
    this.publishing.add(requestHash);
    try {
      let result;
      try { result = await this.mcp.call(preview.tool, preview.args); }
      catch (error) {
        this.db.updateCasePublishAttempt(started.attempt.id, 'unknown', { error: (error as Error).message });
        throw new Error(`ONES Wiki 发布结果未知，请先核对目标页面: ${(error as Error).message}`);
      }
      if (result.isError) {
        this.db.updateCasePublishAttempt(started.attempt.id, 'failed', { error: result.text });
        throw new Error(result.text);
      }
      let pageId = '';
      try {
        const parsed = JSON.parse(result.text);
        pageId = String(parsed.pageID ?? parsed.id ?? parsed.data?.pageID ?? '');
      } catch {
        pageId = result.text.match(/[0-9a-f-]{8,}/i)?.[0] ?? '';
      }
      if (!pageId) {
        this.db.updateCasePublishAttempt(started.attempt.id, 'unknown', { error: 'ONES 返回成功但未提供 page ID' });
        throw new Error('ONES 返回成功但未提供页面 ID，发布结果未知，请先核对案例库');
      }
      const published = this.db.completeCasePublishAttempt(started.attempt.id, draftId, version, pageId);
      if (!published) {
        this.db.updateCasePublishAttempt(started.attempt.id, 'unknown', { pageId, error: '外部页面已创建，但本地草稿状态发生变化' });
        throw new Error(`ONES 页面 ${pageId} 已创建，但本地草稿状态变化，请人工核对`);
      }
      this.db.audit('csm', 'publish_case', 'case_draft', draftId, { version, pageId, approvalHash, requestHash });
      return published;
    } finally {
      this.publishing.delete(requestHash);
    }
  }
}
