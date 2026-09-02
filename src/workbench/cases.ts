import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { argumentsHash } from '../approval.js';
import { extractText } from '../agent.js';
import type { McpHub } from '../mcp/index.js';
import { onesAsrAliasRule } from './drafts.js';
import { completeModelWithProgress, modelProgressText } from './model-progress.js';
import { mentionsCustomer } from './webintel.js';
import { renderCaseDocx, caseDocxFilename } from './case-docx.js';
import { caseSpeakerRole, isDeliveredOnesEvent, type CaseSpeakerRole } from './sync.js';
import { performRawWebSearch, type HttpPost } from '../tools/websearch.js';
import { WorkbenchDatabase } from './database.js';
import type { CaseDraft, Customer, EvidenceInput, OpportunityHypothesis, RiskAssessment, SourceEvent } from './types.js';
import { ONES_CAPABILITY_MAP } from './case-ones-knowledge.js';

/** v10：解决方案两图制（需求场景-能力映射图标配 + 多系统集成时加画集成架构图）、一指禅方案区服务端嵌入映射图。
 * 提示词实质变化必须升版本破指纹短路，否则存量自然指纹会命中旧稿跳过重新生成。 */
export const CASE_GENERATION_VERSION = 'case-v10-standard';
export const CASE_WEB_FRESH_DAYS = 7;

/**
 * 旧版五段叙事契约（v7 及更早草稿的存量兼容）：只用于读取/渲染/编辑/精修旧稿，
 * v8 起生成走 CaseV8Narrative（四章深结构，对齐手写案例标准）。
 */
export interface CaseNarrativeFields {
  background: string;
  challenges: string[];
  requirements: string[];
  solution: string;
  value: string[];
}

/** v8 生成/渲染章节（六章 = 生成调用单位；渲染时 status/demands/solution 归入「二、场景及解决方案」）。 */
export type CaseChapterKey = 'intro' | 'status' | 'demands' | 'solution' | 'value' | 'summary';

/** v8 公开正文的解决方案小节（每个方案级举措一节）。 */
export interface CaseSolutionSection {
  title: string;
  text: string;
}

/** v8 公开正文字段（snake_case 与落库 fields、模型输出 JSON 同形）。 */
export interface CaseV8PublicFields {
  company_info: string;
  business_scope: string;
  competitive_strategy: string;
  project_background: string;
  business_status: string[];
  demands: string[];
  solution_sections: CaseSolutionSection[];
  value_items: string[];
  lessons: string[];
  summary: string;
}

/** v8 叙事读取形态（与落库 fields、模型输出 JSON 同形的 snake_case 键）。 */
export type CaseV8Narrative = CaseV8PublicFields;

/** 系统使用情况表行（服务端派生，CSM 可编辑；LLM 不写这张表）。 */
export interface CaseSystemUsageRow {
  item: string;
  content: string;
}

/** 服务里程碑（服务端从已交付事件确定性挑选，CSM 可编辑；LLM 不写）。 */
export interface CaseMilestone {
  date: string;
  label: string;
}

export type CaseSectionKey = CaseChapterKey | keyof CaseNarrativeFields;
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

/** 配图类型：现状/目标流程、需求场景-产品能力映射、方案架构、服务里程碑时间轴，以及痛点-方案-价值全景图。 */
export type CaseFigureKind = 'flow_current' | 'flow_target' | 'capability_map' | 'architecture' | 'milestone' | 'value_map';

/** 落库配图（图级证据：整图挂 source_refs，不逐节点定位；svg 为服务端消毒后的产物）。 */
export interface CaseFigure {
  id: string;
  section: CaseFigureSectionKey;
  kind: CaseFigureKind;
  svg: string;
  caption: string;
  source_refs: string[];
  note?: string;
}

/** 配图允许挂载的章节：v8 四类 + 存量旧稿的三章键（读取兼容）。 */
export type CaseFigureSectionKey = 'status' | 'demands' | 'solution' | 'value' | 'challenges' | 'requirements';
const CASE_FIGURE_SECTION_KEYS: ReadonlySet<string> = new Set(['status', 'demands', 'solution', 'value', 'challenges', 'requirements']);

/** 规划阶段的配图骨架（idea 描述画什么，svg 由后续逐图生成调用产出）。 */
interface PlanFigure {
  section: CaseFigureSectionKey;
  kind: CaseFigureKind;
  idea: string;
  source_refs: string[];
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

/** v8 章节契约（生成调用单位与 claim_evidence.section 枚举；渲染层级在 renderCaseMarkdown 内组织）。 */
export const CASE_SECTIONS: Array<{ key: CaseChapterKey; label: string; description: string }> = [
  { key: 'intro', label: '客户及背景介绍', description: '客户简介（公司信息/核心业务范围/竞争优势与发展战略）与项目背景——客户是谁、为什么与 ONES 合作' },
  { key: 'status', label: '业务现状', description: '合作前/合作中客户面临的业务现状与核心痛点（连贯段落）' },
  { key: 'demands', label: '业务诉求', description: '客户明确提出的功能诉求、交付要求与服务标准' },
  { key: 'solution', label: '业务解决方案', description: '以「我们为客户提供了什么方案」为主线的方案级举措，每个举措一个小节' },
  { key: 'value', label: '方案价值概述', description: '已确认的客户价值（价值成效）与合作过程中的复盘沉淀（经验复盘）' },
  { key: 'summary', label: '项目总结', description: '全案收束：串联合作起点、核心举措与已交付价值的整体总结' },
];

/** v8 章节序号（渲染时 status/demands/solution 同属「二、场景及解决方案」的子节，见 renderCaseMarkdown）。 */

/** 存量旧稿（v7 及以前）的五段章节契约：只用于旧稿渲染/编辑/质检兼容。 */
export const CASE_LEGACY_SECTIONS: Array<{ key: keyof CaseNarrativeFields; label: string }> = [
  { key: 'background', label: '客户背景' },
  { key: 'challenges', label: '痛点、现状与挑战' },
  { key: 'requirements', label: '需求与要求' },
  { key: 'solution', label: '解决方案' },
  { key: 'value', label: '价值与成效' },
];

const CASE_LEGACY_SECTION_NUMBERS = ['一', '二', '三', '四', '五'];

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

/** 列表章节（业务诉求/价值成效/经验复盘/业务现状段落）的写回护栏上限：生成契约是 3~6 条，超出视为编辑异常（非阻断告警）。 */
const CASE_LIST_ITEM_LIMIT = 12;
/** 单条条目/单段正文的写回护栏长度上限（字符）。 */
const CASE_ITEM_MAX_CHARS = 600;
/** 解决方案小节正文/长段单字段的写回护栏长度上限（字符）。 */
const CASE_SECTION_MAX_CHARS = 1_200;

/** 规划阶段 completion 上限：plan 正文 ~3k token，但推理模型的思考 token 与输出共享上限
 * （真实验收教训：deepseek 对大素材客户在思考中做全文分析，8k/16k 均被思考吃掉后 plan JSON
 * 截断成 stopReason=length——3 连败实测思考可达 12k+，须给足思考余量）。 */
export const PLAN_MAX_TOKENS = 32_768;
/** 案例生成各阶段模型调用重试退避（默认 5s/15s/45s；测试可调 baseMs 加速，与 drafts 同款）。 */
export const caseModelRetryDelays = { baseMs: 5_000 };
/** 请求超时按输入规模自适应：中继大上下文的首字节延迟随 token 数线性增长（实测 ~40k token ≈ 70s，
 * 高峰期规划级 90k token 可超 180s），固定 180s 会在首字节前击穿（真实验收连败根因）；
 * 流一旦开始（thinking/text delta 到达）不受此限制——图调用 10 分钟长流在 180s 下历史成功。
 * 基线 180s + 每 token 5ms 首字节预算（实测 ~1.7ms/token 的 3 倍余量）。 */
export function caseModelTimeoutMs(prompt: string): number {
  return 180_000 + estimateTokens(prompt) * 5;
}
/** 单个章节生成时 completion 上限：v8 章节正文最长数千字（方案章 2~6 小节 × 600 字）+ 推理思考余量
 * （真实验收教训：deepseek 思考 token 与输出共享上限，v5 的 8k 曾被思考吃掉截断）。 */
const CHAPTER_MAX_TOKENS = 16_384;
/** 单张配图生成时 completion 上限：SVG 标记 + 中文标签 + 推理模型思考余量
 * （真实验收教训：8k 与 16k 均被思考吃光 stopReason=length——小素材客户 16k 够、
 * 大素材客户（掌趣级，图 prompt 注入多片段完整转写）须与规划同级的 32k）。 */
const FIGURE_MAX_TOKENS = 32_768;
/** 配图 SVG 尺寸上限（字符）：模型偶发整段正文塞进图注/图形文本时的硬闸。 */
const FIGURE_SVG_MAX_CHARS = 65_536;
/** 输入上下文 token 预算：按「中文 1 字符 ≈ 0.6 token、ASCII 4 字符 ≈ 1 token」估算。 */
const INPUT_BUDGET_TOKENS = 96_000;
/** 摘要降级单次调用输出上限。 */
const SUMMARY_MAX_TOKENS = 4_096;

/** 输入源就绪时估算 prompt 中各项素材块的 token 成本（中文按 1 字符≈0.6、英文按 4 字符≈1）。 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += /[一-龥]/.test(char) ? 0.6 : 0.25;
  return Math.ceil(tokens);
}

/** 章节产出的形态（v8）：intro 四小节、solution 小节数组、value 双数组、其余单文本/条目列表。 */
/** 规划阶段的单个章节条目骨架：idea 是写作要点（非最终正文），其余字段与 claim_evidence 同形。
 * slot 标记条目落位：intro 固定四槽（company_info/business_scope/competitive_strategy/project_background）、
 * value 章 slot=value|lesson（默认 value），其余章节无需 slot。 */
interface PlanItem {
  slot?: string;
  idea: string;
  excerpt?: string;
  source_refs: string[];
  speaker_role?: string;
  status_category?: string;
  confidence?: number;
}
/** 规划阶段的完整产物：六个章节各自的要点与证据骨架，以及可选的配图骨架。 */
interface CasePlan {
  title?: string;
  plan: Array<{ section: CaseChapterKey; items: PlanItem[] }>;
  figures?: PlanFigure[];
  unknowns?: string[];
}

/** 案例联网检索角度（生成时现搜，低频手动动作不做新鲜度门）：背景与制度要求类信息不限时间窗。
 * v8 新增「公司概况」（客户简介三小节素材）与「行业动态」（项目背景的信创/监管/数字化语境）。 */
export const CASE_WEB_ANGLES: ReadonlyArray<{ key: string; label: string; query: string }> = [
  { key: 'company_profile', label: '公司概况', query: '公司简介' },
  { key: 'project_mgmt', label: '项目管理', query: '项目管理' },
  { key: 'requirements_mgmt', label: '需求管理', query: '需求管理' },
  { key: 'knowledge_mgmt', label: '知识管理', query: '知识管理' },
  { key: 'industry_digital', label: '行业动态', query: '数字化转型' },
  { key: 'bidding', label: '招投标', query: '招投标' },
  { key: 'procurement', label: '中标采购', query: '中标 采购' },
];

/** 每角度检索取用的最大结果数。 */
const CASE_WEB_PER_ANGLE_LIMIT = 5;
/** 检索并发上限（角度间独立，失败互不影响；限流友好）。 */
const CASE_WEB_CONCURRENCY = 3;

/** 有限并发映射：保持结果与输入同序（章节波次/检索角度并行的共用工具）。 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

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
 * 客户公开信息检索：并发现搜「客户名 + 角度词」（限 CASE_WEB_CONCURRENCY），标题/摘要须含客户全称或简称（削减同名噪音）。
 * 单角度失败只记入 errors 不阻断（生成不依赖检索成功）；全空由调用方按「未搜到=unknown」口径提示模型。
 */
export async function searchCaseWebContext(customer: Customer, deps: CaseWebSearchDeps, onProgress?: (text: string) => void): Promise<CaseWebSearchContext> {
  const searchName = customer.shortName?.trim() || customer.name;
  const names = [customer.name, customer.shortName].filter((name): name is string => !!name?.trim());
  const context: CaseWebSearchContext = { searched: 0, searchedAt: new Date().toISOString(), results: [], errors: [] };
  const seenUrls = new Set<string>();
  const officialDomains = customerOfficialDomains(customer);
  onProgress?.(`联网检索公开动态（${CASE_WEB_ANGLES.length} 个角度并行）…`);
  const outcomes = await mapWithConcurrency(CASE_WEB_ANGLES, CASE_WEB_CONCURRENCY, async (angle) => {
    try {
      const outcome = await performRawWebSearch({
        query: `${searchName} ${angle.query}`,
        maxResults: Math.max(3, Math.min(deps.getMaxResults(), CASE_WEB_PER_ANGLE_LIMIT)),
        apiKey: deps.getApiKey(),
        keylessEnabled: deps.getKeylessEnabled(),
        topic: 'general',
        fetcher: deps.fetcher,
      });
      return { angle, outcome } as const;
    } catch (error) {
      return { angle, error: `${angle.label}: ${(error as Error).message}` } as const;
    }
  });
  for (const outcome of outcomes) {
    if ('error' in outcome) {
      context.errors.push(outcome.error ?? `${outcome.angle.label}: 未知错误`);
      onProgress?.(`联网检索公开动态 ${outcome.angle.label}（该角度检索失败，已跳过）`);
      continue;
    }
    context.searched += 1;
    const angle = outcome.angle;
    for (const result of outcome.outcome.results) {
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
 * 读取存量旧稿（v7 及以前）的五段正文：新键 challenges/value 缺失时回退旧键
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

/** v8 草稿判定：fields 带 company_info 键即为 v8 结构（v7 及更早的草稿没有该键）。 */
export function isV8CaseDraft(fields: Record<string, unknown> | undefined): boolean {
  return typeof fields?.company_info === 'string';
}

/** 规范化 v8 解决方案小节（编辑/模型输出容错：字符串行视为无标题小节，非法项剔除）。 */
function normalizeSolutionSections(value: unknown): CaseSolutionSection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [{ title: '', text: item.trim() }] : [];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (!text) return [];
    return [{ title: typeof row.title === 'string' ? row.title.trim().slice(0, 40) : '', text }];
  });
}

/** 读取 v8 公开正文字段（非法形态容错归零；business_scope/competitive_strategy/lessons 允许为空）。 */
export function caseV8NarrativeOf(fields: Record<string, unknown>): CaseV8Narrative {
  const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
  const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
  return {
    company_info: str(fields.company_info),
    business_scope: str(fields.business_scope),
    competitive_strategy: str(fields.competitive_strategy),
    project_background: str(fields.project_background),
    business_status: list(fields.business_status),
    demands: list(fields.demands),
    solution_sections: normalizeSolutionSections(fields.solution_sections),
    value_items: list(fields.value_items),
    lessons: list(fields.lessons),
    summary: str(fields.summary),
  };
}

/** 读取系统使用情况表 / 服务里程碑（派生字段；存量缺失返回空数组）。 */
export function caseSystemUsageOf(fields: Record<string, unknown>): CaseSystemUsageRow[] {
  if (!Array.isArray(fields.system_usage)) return [];
  return fields.system_usage.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const itemLabel = typeof row.item === 'string' ? row.item.trim() : '';
    const content = typeof row.content === 'string' ? row.content.trim() : '';
    return itemLabel && content ? [{ item: itemLabel, content }] : [];
  });
}

export function caseMilestonesOf(fields: Record<string, unknown>): CaseMilestone[] {
  if (!Array.isArray(fields.milestones)) return [];
  return fields.milestones.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const date = typeof row.date === 'string' ? row.date.trim().slice(0, 10) : '';
    const label = typeof row.label === 'string' ? row.label.trim().slice(0, 80) : '';
    return date && label ? [{ date, label }] : [];
  });
}

/**
 * 客户版 Markdown 的唯一权威渲染（Web 复制、Wiki 发布正文、CLI 默认输出均复用本函数产物，
 * 不允许任何一端自行拼装第二份格式）。v8：四章深结构（一、客户及背景介绍（一~三子节，含系统使用情况表）
 * → 二、场景及解决方案（业务现状/业务诉求/业务解决方案小节化）→ 三、方案价值概述（服务里程碑/价值成效/
 * 经验复盘）→ 四、项目总结）；存量旧稿走 legacy 五段分支。内部元数据不渲染。
 */
export function renderCaseMarkdown(draft: CaseDraft): string {
  const figures = caseFiguresOf(draft.fields);
  const figureNote = (section: string, kind?: CaseFigureKind) => figures
    .filter((figure) => figure.section === section && (!kind || figure.kind === kind))
    .map((figure) => `> 图：${figure.caption.replace(/\s+/g, ' ').trim()}（图示详见工作台）`);
  if (!isV8CaseDraft(draft.fields)) return renderLegacyCaseMarkdown(draft, figures);
  const v8 = caseV8NarrativeOf(draft.fields);
  const usage = caseSystemUsageOf(draft.fields);
  const milestones = caseMilestonesOf(draft.fields);
  const usageTable = usage.length
    ? ['| 项目 | 内容 |', '| --- | --- |', ...usage.map((row) => `| ${row.item} | ${row.content.replace(/\|/g, '\\|')} |`)].join('\n')
    : '';
  const solutionBlocks = v8.solution_sections.map((section, index) =>
    `#### ${index + 1}、${section.title || '方案举措'}\n\n${section.text}`);
  const introBlocks = [
    v8.company_info ? `#### 公司信息\n\n${v8.company_info}` : '',
    v8.business_scope ? `#### 核心业务范围\n\n${v8.business_scope}` : '',
    v8.competitive_strategy ? `#### 竞争优势与发展战略\n\n${v8.competitive_strategy}` : '',
  ].filter(Boolean);
  const parts: string[] = [
    `# ${draft.title}\n`,
    `## 一、客户及背景介绍\n`,
    `### （一）客户简介\n\n${introBlocks.join('\n\n')}\n`,
    `### （二）项目背景\n\n${v8.project_background}\n`,
  ];
  if (usageTable) parts.push(`### （三）系统使用情况\n\n${usageTable}\n`);
  parts.push(`## 二、场景及解决方案\n`);
  parts.push(`### （一）业务现状\n\n${v8.business_status.join('\n\n')}${figureNote('status').length ? `\n${figureNote('status').join('\n')}` : ''}\n`);
  parts.push(`### （二）业务诉求\n\n${v8.demands.map((item, index) => `${index + 1}. ${item}`).join('\n')}${figureNote('demands').length ? `\n${figureNote('demands').join('\n')}` : ''}\n`);
  parts.push(`### （三）业务解决方案\n\n${solutionBlocks.join('\n\n')}${figureNote('solution').length ? `\n${figureNote('solution').join('\n')}` : ''}\n`);
  parts.push(`## 三、方案价值概述\n`);
  if (milestones.length) {
    parts.push(`### 服务里程碑\n\n${milestones.map((milestone) => `- ${milestone.date} ${milestone.label}`).join('\n')}${figureNote('value', 'milestone').length ? `\n${figureNote('value', 'milestone').join('\n')}` : ''}\n`);
  }
  parts.push(`### 价值成效\n\n${v8.value_items.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n`);
  if (v8.lessons.length) parts.push(`### 经验复盘与沉淀\n\n${v8.lessons.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n`);
  // value_map（痛点-方案-价值全景图）是全案收束图，占位固定在价值章末尾（项目总结之前）。
  if (figureNote('value', 'value_map').length) parts.push(`${figureNote('value', 'value_map').join('\n')}\n`);
  parts.push(`## 四、项目总结\n\n${v8.summary}\n`);
  return parts.join('\n');
}

/** 存量旧稿（v7 及以前五段结构）的 Markdown 渲染分支：与 v7 行为完全一致。 */
function renderLegacyCaseMarkdown(draft: CaseDraft, figures: CaseFigure[]): string {
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
    // 配图以引用块占位（Markdown 消费方大多不渲染内联 SVG），图形本体在工作台详情展示。
    ...CASE_LEGACY_SECTIONS.map((section, index) => {
      const figureNotes = figures.filter((figure) => figure.section === section.key)
        .map((figure) => `> 图：${figure.caption.replace(/\s+/g, ' ').trim()}（图示详见工作台）`);
      return `## ${CASE_LEGACY_SECTION_NUMBERS[index]}、${section.label}\n\n${bodies[section.key]}${figureNotes.length ? `\n${figureNotes.join('\n')}` : ''}\n`;
    }),
  ].join('\n');
}

export type ParsedCaseContent = { title?: string } & CaseV8PublicFields & {
  claim_evidence: CaseClaimEvidence[];
  evidence_map?: Record<string, string>;
  unknowns: string[];
};

/** v8 必填公开字段（缺任一即契约失败）：business_scope/competitive_strategy/lessons 允许为空。 */
const CASE_V8_REQUIRED_LABELS: Partial<Record<keyof CaseV8PublicFields, string>> = {
  company_info: '客户及背景介绍·公司信息',
  project_background: '客户及背景介绍·项目背景',
  business_status: '业务现状',
  demands: '业务诉求',
  solution_sections: '业务解决方案',
  value_items: '方案价值概述·价值成效',
  summary: '项目总结',
};

/** 模型输出契约校验；公开生成路径额外要求 v8 各章完整、无占位词且每条主张可追溯。 */
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
  const parsed: ParsedCaseContent = {
    ...caseV8NarrativeOf(raw),
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined,
    claim_evidence: [],
    unknowns: Array.isArray(raw.unknowns) ? raw.unknowns.map(String).map((item) => item.trim()).filter(Boolean) : [],
  };
  if (raw.evidence_map && typeof raw.evidence_map === 'object' && !Array.isArray(raw.evidence_map)) {
    const entries = Object.entries(raw.evidence_map as Record<string, unknown>)
      .map(([key, item]) => [key, String(item).trim()] as const)
      .filter(([, item]) => item);
    if (entries.length) parsed.evidence_map = Object.fromEntries(entries);
  }
  parsed.claim_evidence = Array.isArray(raw.claim_evidence) ? raw.claim_evidence.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const section = String(record.section ?? '') as CaseSectionKey;
    const claim = typeof record.claim === 'string' ? record.claim.trim() : '';
    const refs = Array.isArray(record.source_refs) ? record.source_refs.map(String).map((ref) => ref.trim()).filter(Boolean) : [];
    if (!CASE_SECTIONS.some((entry) => entry.key === section) || !claim || !refs.length) return [];
    return [{ section, claim, source_refs: refs,
      excerpt: typeof record.excerpt === 'string' ? record.excerpt.trim() : undefined,
      speaker_role: ['customer', 'csm', 'unknown'].includes(String(record.speaker_role)) ? String(record.speaker_role) as CaseSpeakerRole : undefined,
      status_category: typeof record.status_category === 'string' ? record.status_category : undefined,
      confidence: Number.isFinite(Number(record.confidence)) ? Math.max(0, Math.min(1, Number(record.confidence))) : undefined }];
  }) : [];
  if (!options.requirePublic) return parsed;
  const missing = Object.entries(CASE_V8_REQUIRED_LABELS)
    .filter(([key]) => {
      const content = parsed[key as keyof CaseV8PublicFields];
      return Array.isArray(content) ? content.length === 0 : !content;
    })
    .map(([, label]) => label!);
  if (missing.length) throw new Error(`模型未返回完整公开版章节: ${missing.join('、')}`);
  const sectionLabel = (key: CaseSectionKey) => CASE_SECTIONS.find((section) => section.key === key)?.label ?? String(key);
  const visibleClaims: Array<{ section: CaseChapterKey; claim: string }> = [
    { section: 'intro', claim: parsed.company_info },
    ...(parsed.business_scope ? [{ section: 'intro' as const, claim: parsed.business_scope }] : []),
    ...(parsed.competitive_strategy ? [{ section: 'intro' as const, claim: parsed.competitive_strategy }] : []),
    { section: 'intro', claim: parsed.project_background },
    ...parsed.business_status.map((claim) => ({ section: 'status' as const, claim })),
    ...parsed.demands.map((claim) => ({ section: 'demands' as const, claim })),
    ...parsed.solution_sections.map((section) => ({ section: 'solution' as const, claim: section.text })),
    ...parsed.value_items.map((claim) => ({ section: 'value' as const, claim })),
    ...parsed.lessons.map((claim) => ({ section: 'value' as const, claim })),
    { section: 'summary', claim: parsed.summary },
  ];
  if (visibleClaims.some((item) => /待确认|待补充|\bunknown\b/i.test(item.claim))) throw new Error('公开版正文包含待确认/待补充占位词');
  const sourceMap = new Map((options.sources ?? []).map((source) => [source.id, source]));
  for (const item of visibleClaims) {
    const mapped = parsed.claim_evidence.find((entry) => entry.section === item.section && entry.claim === item.claim);
    if (!mapped) throw new Error(`${sectionLabel(item.section)}存在未映射证据的主张`);
    if (options.allowedRefs && mapped.source_refs.some((ref) => !options.allowedRefs!.has(ref))) throw new Error(`主张引用了未知证据: ${mapped.source_refs.join('、')}`);
    if (!mapped.excerpt) throw new Error(`${sectionLabel(item.section)}主张缺少原文摘录`);
    if (sourceMap.size) {
      const supporting = mapped.source_refs.map((ref) => sourceMap.get(ref)).filter((source): source is CaseEvidenceSnapshotItem => !!source)
        .filter((source) => sourceSupportsExcerpt(source, mapped.excerpt!, options.communications));
      if (!supporting.length) throw new Error(`${sectionLabel(item.section)}主张的摘录未在引用证据中找到`);
      const roles = supporting.flatMap((source) => sourceExcerptRoles(source, mapped.excerpt!, options.communications));
      mapped.speaker_role = roles.includes('customer') ? 'customer' : roles.includes('csm') ? 'csm' : 'unknown';
      const statuses = [...new Set(supporting.map((source) => source.status_category).filter((status): status is string => !!status && status !== 'unknown'))];
      mapped.status_category = statuses.length === 1 ? statuses[0] : 'unknown';
      if (['status', 'demands', 'value'].includes(item.section)
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

/** 摘录校验第二查找源：与注入 prompt 的 communications 同口径（同选择、同预算、同截取）。 */
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

/** 系统使用情况表的建议补充行（手写案例标准有、本地数据源没有的信息，进 unknowns 提示 CSM 补充）。 */
const CASE_SYSTEM_USAGE_SUGGESTED_ROWS = ['购买账号数', '有效期', '使用部门'];

/**
 * 服务端派生「系统使用情况」表（v8）：客户名称/购买版本/购买产品/合作时间来自 CRM 档案与交付统计，
 * 只渲染有值行；LLM 不写这张表（防虚构），CSM 可在编辑弹窗修正补充。missing 返回建议向 CSM 确认的缺失行。
 */
export function caseSystemUsageRows(customer: Customer, stats: CaseDeliveryStats): { rows: CaseSystemUsageRow[]; missing: string[] } {
  const rows: CaseSystemUsageRow[] = [{ item: '客户名称', content: customer.name }];
  if (customer.shortName?.trim() && customer.shortName !== customer.name) rows.push({ item: '客户简称', content: customer.shortName.trim() });
  if (customer.usageVersion?.trim()) rows.push({ item: '购买版本', content: customer.usageVersion.trim() });
  if (customer.products?.length) rows.push({ item: '购买产品', content: customer.products.join('、') });
  if (stats.firstConfirmedAt) rows.push({ item: '合作时间', content: stats.firstConfirmedAt.slice(0, 7) });
  return { rows, missing: [...CASE_SYSTEM_USAGE_SUGGESTED_ROWS] };
}

/** 里程碑上限：合作起点 + 各类交付首单 + 私有云部署，通常 5 条以内；超过按时间截尾。 */
const CASE_MILESTONE_LIMIT = 8;

/**
 * 服务端派生「服务里程碑」时间线（v8，确定性）：合作起点（最早 confirmed 事件）+ 各交付类别的首个闭环事件
 * + 首个私有云实例，日期取年月、标签取事件标题（可被 CSM 编辑）。LLM 不写里程碑（防虚构）。
 * 少于 2 条视为素材不足返回空数组（渲染时整节约略）。
 */
export function caseMilestoneEvents(input: { timeline: SourceEvent[]; hemory: SourceEvent[] }): CaseMilestone[] {
  const confirmed = [...input.timeline, ...input.hemory].filter((event) => event.attributionStatus === 'confirmed');
  if (!confirmed.length) return [];
  const byDate = [...confirmed].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const picks: CaseMilestone[] = [{ date: byDate[0].occurredAt.slice(0, 7), label: '合作启动（据最早服务记录）' }];
  const delivered = confirmed.filter((event) => event.sourceSystem === 'ones' && isDeliveredOnesEvent(event))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const sourceType of ['suggestion_feedback', 'support_ticket', 'operations_ticket', 'private_cloud_instance']) {
    const first = sourceType === 'private_cloud_instance'
      ? [...confirmed].filter((event) => event.sourceSystem === 'ones' && event.sourceType === sourceType)
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0]
      : delivered.find((event) => event.sourceType === sourceType);
    if (!first) continue;
    const label = sourceType === 'private_cloud_instance' ? '私有云实例部署' : `${CASE_STATS_CATEGORY_LABELS[sourceType] ?? sourceType}首个闭环`;
    picks.push({ date: first.occurredAt.slice(0, 7), label: `${label}：${first.title.replace(/\s+/g, ' ').trim().slice(0, 30)}` });
  }
  const seen = new Set<string>();
  const unique = picks.filter((item) => {
    const key = `${item.date}|${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length >= 2 ? unique.sort((a, b) => a.date.localeCompare(b.date)).slice(0, CASE_MILESTONE_LIMIT) : [];
}

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
    // v6 口径（用户拍板）：ONES 记录明细（建议/工单/运维/私有云实例/工时行）不作为案例输入——
    // 不进来源目录即不可被 claim_evidence 引用；ONES 数据只经 delivery_stats 聚合事实参与生成。
    if (event.sourceSystem === 'ones') continue;
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




/** 输入预算分级：正常路径（level 0）注入完整原文；溢出时先逐级收缩注入规模，仍溢出才走摘要压缩。 */
interface InputBudget {
  level: number;
  maxRecords: number;
  maxDelivered: number;
  maxFollowups: number;
  maxSignal: number;
  transcriptBudget: number;
  maxEvidence: number;
  description: string;
}

const INPUT_DEGRADATION_BUDGETS: InputBudget[] = [
  { level: 0, maxRecords: MAX_CASE_RECORDS, maxDelivered: MAX_DELIVERED_RECORDS, maxFollowups: MAX_CASE_FOLLOWUPS, maxSignal: MAX_CASE_SIGNALS, transcriptBudget: TRANSCRIPT_BUDGET, maxEvidence: MAX_CASE_EVIDENCE, description: '原始预算' },
  { level: 1, maxRecords: 150, maxDelivered: 20, maxFollowups: 16, maxSignal: 24, transcriptBudget: 24_000, maxEvidence: 36, description: '一级降级（records 150、转写 24000 字符）' },
  { level: 2, maxRecords: 80, maxDelivered: 10, maxFollowups: 8, maxSignal: 16, transcriptBudget: 12_000, maxEvidence: 24, description: '二级降级（records 80、转写 12000 字符）' },
];

/** 目录行（source_catalog）收缩：正常路径全量；降级路径优先保留 customer/stats/web/片段（摘录校验主命中源），
 * 工单/建议等记录行按预算等比收缩（数千条目录行本身就是超限大户）。 */
function catalogRows(input: CasePromptInput, snapshot: CaseContextSnapshot, budget: InputBudget): Array<Record<string, unknown>> {
  const base = snapshot.sources.map((item) => ({ source_ref: item.id, title: item.title, excerpt: item.excerpt,
    speaker_lines: item.speaker_lines, status_category: item.status_category, source_type: item.source_type }));
  if (budget.level === 0) return base;
  // 优先保留：客户档案、交付统计、公开检索（数量可控）；Hemory 片段目录行按预算收缩——
  // ONES 明细剔除后片段目录行成为目录体量主源，不收缩则降级失效。
  const prioritized = base.filter((row) => String(row.source_ref).startsWith('customer:')
    || String(row.source_ref) === CASE_STATS_SOURCE_ID
    || String(row.source_type).startsWith('web:'));
  const fragments = base.filter((row) => String(row.source_type) === 'ai_topic_segment');
  const rest = base.filter((row) => !prioritized.includes(row) && !fragments.includes(row));
  const restLimit = Math.max(budget.maxRecords, budget.maxEvidence + budget.maxFollowups + budget.maxSignal);
  const fragmentLimit = Math.max(budget.maxRecords, Math.floor(MAX_CASE_FRAGMENTS * (budget.transcriptBudget / TRANSCRIPT_BUDGET)));
  return [...prioritized, ...fragments.slice(0, fragmentLimit), ...rest.slice(0, restLimit)];
}

/** 素材块注入的统一载体：renderInputText 产出 JSON 文本与各块 token 估算，供预算循环复用。 */
interface RenderedInput {
  text: string;
  tokens: number;
  budget: InputBudget;
}

/** 章节撰写注入保留的素材块：写作素材本体；source_catalog/信号表/allowed_refs 等规划脚手架不注入
 * （摘录校验由服务端对位组装执行，章节写作不需要目录索引——省下的输入 token 是逐章重复注入的大头）。 */
const CHAPTER_CONTEXT_KEYS = new Set(['customer', 'delivery_stats', 'evidence_signals', 'communications', 'crm_followups', 'web_context']);

/** 章节注入形态：从全量 blocks 中只保留写作素材块；摘要路径的压缩文本已最小化，整体复用。 */
function chapterContextOf(blocks: Record<string, unknown>, fallbackText: string): string {
  if (!Object.keys(blocks).length) return fallbackText;
  return JSON.stringify(Object.fromEntries(Object.entries(blocks).filter(([key]) => CHAPTER_CONTEXT_KEYS.has(key))));
}

/** 渲染注入上下文的素材块对象（按预算等级截断素材规模）。v6：ONES 记录明细不注入（只经 delivery_stats 聚合参与）。 */
function renderInputBlocks(input: CasePromptInput, snapshot: CaseContextSnapshot, budget: InputBudget): Record<string, unknown> {
  const { customer, timeline, hemory, evidence, risk, opportunities, webContext } = input;
  const confirmed = timeline.filter((event) => event.attributionStatus === 'confirmed');
  // records 只保留 CRM 侧非跟进记录（ONES 明细已剔除，实践上该块通常为空——保留 schema 键避免下游断言漂移）。
  const recordEvents = confirmed
    .filter((event) => event.sourceSystem !== 'hemory' && event.sourceSystem !== 'ones' && event.sourceType !== 'crm_followup');
  const keptRecords = recordEvents.length <= budget.maxRecords
    ? recordEvents
    : [...recordEvents.slice(0, Math.max(1, Math.floor(budget.maxRecords / 6))), ...recordEvents.slice(-(budget.maxRecords - Math.max(1, Math.floor(budget.maxRecords / 6))))];
  const records = keptRecords
    .map((event) => ({ source_ref: event.id, date: event.occurredAt.slice(0, 10), system: event.sourceSystem, type: event.sourceType,
      display: event.displayId ?? '', title: event.title.slice(0, 120), status: nestedName(event.payload?.field005) || '', status_category: statusCategory(event) }));
  const followups = confirmed
    .filter((event) => event.sourceType === 'crm_followup')
    .slice(-budget.maxFollowups)
    .map((event) => ({ source_ref: event.id, date: event.occurredAt.slice(0, 10), title: event.title.slice(0, 120),
      content: String(event.payload?.active_record_content ?? event.title).slice(0, 400) }));
  const fragments = selectFragments(hemory);
  const perFragment = Math.max(400, Math.floor(budget.transcriptBudget / Math.max(1, fragments.length)));
  const communications = fragments.map((event) => ({
    id: event.id, occurred_at: event.occurredAt, topic: event.title, recording_id: String(event.payload?.recordingId ?? ''),
    speakers: Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : [],
    summary: typeof event.payload?.summary === 'string' ? event.payload.summary : '',
    transcript: textOf(event).slice(0, perFragment),
  }));
  const signals = caseFragmentSignals(hemory, customer.csmName);
  const clip = (list: CaseFragmentSignal[]) => list.slice(0, budget.maxSignal);
  const statsSource = snapshot.sources.find((item) => item.id === CASE_STATS_SOURCE_ID);
  return {
    customer: { source_ref: `customer:${customer.id}`, ...customerPublicProfile(customer) },
    delivery_stats: statsSource ? { source_ref: CASE_STATS_SOURCE_ID, facts: statsSource.excerpt } : undefined,
    evidence_signals: evidence.slice(0, budget.maxEvidence).map((item) => ({ source_ref: item.id, kind: item.kind, label: item.label,
      detail: item.detail.slice(0, 200), occurred_at: item.occurredAt })),
    communications,
    records,
    crm_followups: followups,
    pain_point_signals: clip(signals.painPoints),
    requirement_signals: clip(signals.requirements),
    solution_signals: clip(signals.solutions),
    value_signals: clip(signals.values),
    internal_review_signals: clip(signals.review),
    internal_business_review: {
      note: '仅供识别内部缺口并写入 unknowns，不得写入公开正文，也不得作为 claim_evidence',
      risk: risk ? { level: risk.level, dimensions: Object.keys(risk.dimensions ?? {}), unknowns: risk.unknowns } : null,
      opportunities: opportunities.map((item) => ({ title: item.title, detail: item.detail.slice(0, 200), status: item.status })),
    },
    source_catalog: catalogRows(input, snapshot, budget),
    allowed_source_refs: snapshot.sources.map((item) => item.id),
    web_context: webContext
      ? { searched: webContext.searched, results: webContext.results, errors: webContext.errors.length ? webContext.errors : undefined }
      : '本次生成未联网检索，背景只依据内部档案与沟通记录',
  };
}

/** 全量注入文本（规划/补写/摘要判定共用；预算分级判定也以它为准）。 */
function renderInputText(input: CasePromptInput, snapshot: CaseContextSnapshot, budget: InputBudget): string {
  return JSON.stringify(renderInputBlocks(input, snapshot, budget));
}

/**
 * 输入预算决策（用户拍板原则：只有输入超出模型上下文限制才摘要，正常路径完整原文注入）：
 * 1. level 0 完整注入；超预算 → 逐级收缩注入规模（level 1/2），每级用收缩后的素材重新渲染重新估算；
 * 2. 二级收缩后仍超 → 追加一次「素材摘要」模型调用，把大块素材压缩成分块摘要再渲染；
 * 3. 摘要后仍超或摘要失败 → 抛「上下文预算超限」（含降级轨迹），任务失败并明示原因。
 * 降级/摘要轨迹记入 fields.input_summary 供 CLI/UI 展示。
 */
async function prepareCaseInput(runtime: Runtime, input: CasePromptInput, snapshot: CaseContextSnapshot,
  onProgress?: (text: string) => void): Promise<{ contextText: string; chapterContextText: string; inputSummary: Record<string, unknown> | null }> {
  const trials: Array<{ level: number; tokens: number; action: string }> = [];
  let budget = INPUT_DEGRADATION_BUDGETS[0];
  let blocks = renderInputBlocks(input, snapshot, budget);
  let text = JSON.stringify(blocks);
  let tokens = estimateTokens(text);
  trials.push({ level: 0, tokens, action: '完整注入' });
  let summary: string | null = null;
  if (tokens > INPUT_BUDGET_TOKENS) {
    for (const candidate of INPUT_DEGRADATION_BUDGETS.slice(1)) {
      onProgress?.(`输入素材约 ${tokens} tokens 超出预算 ${INPUT_BUDGET_TOKENS}，${candidate.description}…`);
      budget = candidate;
      blocks = renderInputBlocks(input, snapshot, budget);
      text = JSON.stringify(blocks);
      tokens = estimateTokens(text);
      trials.push({ level: candidate.level, tokens, action: candidate.description });
      if (tokens <= INPUT_BUDGET_TOKENS) break;
    }
  }
  if (tokens > INPUT_BUDGET_TOKENS) {
    // 二级收缩后仍超预算：先摘要压缩（唯一兜底），保留 source_ref 对位以便摘录校验。
    onProgress?.(`降级后仍约 ${tokens} tokens，调用模型压缩素材摘要…`);
    const compressed = await summarizeCaseInput(runtime, input, text, onProgress);
    if (compressed) {
      summary = compressed;
      text = renderSummaryContext(summary, snapshot);
      blocks = {};
      tokens = estimateTokens(text);
      trials.push({ level: budget.level, tokens, action: '素材摘要压缩' });
      if (tokens > INPUT_BUDGET_TOKENS) throw new Error(`上下文预算超限：摘要后仍约 ${tokens} tokens（上限 ${INPUT_BUDGET_TOKENS}），降级轨迹：${trials.map((t) => `${t.level}:${t.action}=${t.tokens}`).join(' → ')}`);
    } else {
      throw new Error(`上下文预算超限：素材摘要失败，降级轨迹：${trials.map((t) => `${t.level}:${t.action}=${t.tokens}`).join(' → ')}`);
    }
  }
  // 章节注入形态：同一预算等级下的写作素材子集（目录/信号表等规划脚手架剥离）；摘要路径整体复用压缩文本。
  const chapterContextText = chapterContextOf(blocks, text);
  if (!trials.some((t) => t.level > 0) && !summary) return { contextText: text, chapterContextText, inputSummary: null };
  return {
    contextText: text,
    chapterContextText,
    inputSummary: {
      budget_tokens: INPUT_BUDGET_TOKENS,
      trials: trials.map((t) => ({ ...t, tokens: t.tokens })),
      degraded: trials.filter((t) => t.level > 0).map((t) => t.action),
      summarized: !!summary,
      summary: summary ?? undefined,
    },
  };
}

/** 摘要模型调用：把超出预算的素材文本压缩为分块摘要（保留 source_ref 对位）。失败返回 null 由调用方兜底报错。 */
async function summarizeCaseInput(runtime: Runtime, input: CasePromptInput, materialText: string, onProgress?: (text: string) => void): Promise<string | null> {
  const prompt = `以下是客户「${input.customer.name}」案例生成的全部素材上下文（JSON）。素材总量超出模型输入预算，需要你压缩为一份保真的分块摘要，供后续案例写作使用。\n`
    + `要求：\n`
    + `- 输出纯文本摘要（非 JSON）：按素材块分组（communications 转写、records CRM 记录、crm_followups 跟进、各 signal 信号、web_context 公开信息），每块先写「# 块名」，块内逐 source_ref 归并要点。\n`
    + `- 必须保留每个素材条目的 source_ref ID（形如 xxxxxxxx-xxxx 的 ID 或 customer:/stats:/web: 前缀 ID）与日期、状态、说话人角色——这些是后续引用与摘录校验的锚点，丢失即无法对位。\n`
    + `- 客户原话（痛点/诉求/正面反馈）尽量保留原句或压缩句；数字、日期、状态、规模逐字保留。\n`
    + `- 不新增任何素材中没有的事实，不推测。\n`
    + `素材：${materialText}`;
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await completeModelWithProgress(runtime, {
      systemPrompt: '你是素材压缩助手。只做忠实压缩：保留 source_ref、日期、状态、数字与客户原话要点，不添加任何新事实。',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    }, onProgress ? (tick) => onProgress(modelProgressText(tick)) : undefined, { maxTokens: SUMMARY_MAX_TOKENS, timeoutMs: caseModelTimeoutMs(prompt) });
    if (response.stopReason === 'error') {
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    const text = extractText(response.content).trim();
    if (text) return text;
  }
  return null;
}

/** 摘要形态的目录行预算：摘要路径下 source_catalog 也要收缩（3000 条目录行本身≈20 万 tokens），
 * 保留 customer/stats/web 与 hemory 片段（摘录校验主要命中源），其余按标题行精简。 */
const SUMMARY_CATALOG_FRAGMENT_LIMIT = 120;
const SUMMARY_CATALOG_ROW_LIMIT = 400;

/** 摘要后的上下文形态：摘要正文 + 收缩后的来源目录（customer/stats/片段保留原文 excerpt 供摘录校验）。 */
function renderSummaryContext(summary: string, snapshot: CaseContextSnapshot): string {
  const priority = (source: CaseEvidenceSnapshotItem): number =>
    source.id.startsWith('customer:') || source.id === CASE_STATS_SOURCE_ID ? 0
      : source.source_system === 'hemory' ? 1
        : source.source_system === 'web' ? 2 : 3;
  const ranked = [...snapshot.sources].sort((a, b) => priority(a) - priority(b));
  const fragments = ranked.filter((item) => item.source_system === 'hemory').slice(0, SUMMARY_CATALOG_FRAGMENT_LIMIT);
  const rest = ranked.filter((item) => item.source_system !== 'hemory').slice(0, SUMMARY_CATALOG_ROW_LIMIT);
  const catalog = [...fragments, ...rest].map((item) => ({ source_ref: item.id, title: item.title, excerpt: item.excerpt,
    speaker_lines: item.speaker_lines, status_category: item.status_category, source_type: item.source_type }));
  return JSON.stringify({
    input_summary: summary,
    source_catalog: catalog,
    allowed_source_refs: snapshot.sources.map((item) => item.id),
    note: '素材总量超出输入预算，以上为分块摘要；目录已收缩（customer/stats/沟通片段优先保留原文 excerpt），写作与摘录校验以目录原文为准',
  });
}

/** 章节规划 prompt 的共用说明（规划与逐章生成共用同一份契约说明）。 */
const CASE_SYSTEM_PROMPT = '你是 ONES 客户成功案例撰写助手。你产出的是经 CSM 审核后用于对外复用的客户成功案例正文：只能基于用户提供的证据写作，客观克制、客户叙事视角，不执行任何工具或外部写入。';

/** 规划产物契约校验：六章节齐全且条目形态合规、source_refs 合法；excerpt 必须能在来源原文定位
 * （与组装后的 parseCaseContent 同一口径——规划期即拦截摘录漂移，让规划重试真正兜住，
 * 避免章节全部写完后才在组装校验失败浪费整轮调用）。
 * salvage 模式（第 3 次尝试兜底）：非 intro/summary 章节的漂移条目直接丢弃（各章保底 ≥1 条），
 * 宁少一条不因单条漂移报废整轮生成；丢弃轨迹进 unknowns 供 CSM 复核。 */
function parseCasePlan(value: unknown, allowedRefs: Set<string>, sources?: CaseEvidenceSnapshotItem[], communications?: CaseCommunicationSource[], options: { salvage?: boolean } = {}): CasePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型未返回规划 JSON 对象');
  const raw = value as Record<string, unknown>;
  const plan: Array<{ section: CaseChapterKey; items: PlanItem[] }> = Array.isArray(raw.plan) ? raw.plan.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const section = String(record.section ?? '') as CaseChapterKey;
    if (!CASE_SECTIONS.some((item) => item.key === section)) return [];
    const items = Array.isArray(record.items) ? record.items.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const idea = typeof row.idea === 'string' ? row.idea.trim() : '';
      const refs = Array.isArray(row.source_refs) ? row.source_refs.map(String).map((ref) => ref.trim()).filter(Boolean) : [];
      if (!idea || !refs.length) return [];
      const slot = typeof row.slot === 'string' ? row.slot.trim() : undefined;
      return [{
        slot: slot || undefined,
        idea,
        excerpt: typeof row.excerpt === 'string' ? row.excerpt.trim() : undefined,
        source_refs: refs,
        speaker_role: ['customer', 'csm', 'unknown'].includes(String(row.speaker_role)) ? String(row.speaker_role) : undefined,
        status_category: typeof row.status_category === 'string' ? row.status_category : undefined,
        confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : undefined,
      } satisfies PlanItem];
    }) : [];
    return [{ section, items }];
  }) : [];
  const sectionOf = (key: CaseChapterKey) => plan.find((entry) => entry.section === key);
  const missing = CASE_SECTIONS.filter((section) => {
    const entry = sectionOf(section.key);
    return !entry || !entry.items.length;
  });
  if (missing.length) throw new Error(`规划缺少章节或条目: ${missing.map((item) => item.label).join('、')}`);
  const unknownRefs = plan.flatMap((entry) => entry.items.flatMap((item) => item.source_refs)).filter((ref) => !allowedRefs.has(ref));
  if (unknownRefs.length) throw new Error(`规划引用了未知证据: ${[...new Set(unknownRefs)].slice(0, 5).join('、')}`);
  // 摘录定位校验（规划期拦截，与组装校验同口径）：excerpt 必须能在引用来源的原文中找到。
  // intro/summary 章节例外（真实验收教训：公司简介类事实常来自模型常识而非可逐字抄写的原文，
  // 逐字锚点 3 连败会卡死整轮生成）——摘录漂移的条目回退到客户档案/交付统计的确定性摘录锚点，
  // 缺失小节用档案条目回填；其余章节保持整份拒绝，让 3 次规划重试真正兜住摘录漂移（v7 口径）。
  if (sources?.length) {
    const sourceMap = new Map(sources.map((item) => [item.id, item]));
    const profileSource = sources.find((item) => item.id.startsWith('customer:'));
    const statsSource = sources.find((item) => item.id === CASE_STATS_SOURCE_ID);
    const excerptLocatable = (item: PlanItem) => !!item.excerpt
      && item.source_refs.some((ref) => {
        const source = sourceMap.get(ref);
        return !!source && sourceSupportsExcerpt(source, item.excerpt!, communications);
      });
    for (const entry of plan) {
      if (entry.section !== 'intro' && entry.section !== 'summary' && !options.salvage) {
        for (const item of entry.items) {
          const label = CASE_SECTIONS.find((section) => section.key === entry.section)!.label;
          if (!item.excerpt) throw new Error(`${label}条目缺少原文摘录`);
          if (!excerptLocatable(item)) throw new Error(`${label}条目的摘录未在引用证据中找到`);
        }
      }
    }
    // intro 槽位归一：显式 slot 优先、缺省按序补位；漂移/缺失槽用档案确定性条目回填（恒为 4 条）。
    const intro = sectionOf('intro')!;
    const canonicalSlots: Array<{ slot: string; idea: string }> = [
      { slot: 'company_info', idea: '公司信息：以客户档案为准的机构简介' },
      { slot: 'business_scope', idea: '核心业务范围：基于客户档案行业与产品线的业务描述' },
      { slot: 'competitive_strategy', idea: '竞争优势与发展战略：仅有可核验公开信息时展开，否则收缩篇幅' },
      { slot: 'project_background', idea: '项目背景：与 ONES 合作的动因与目标' },
    ];
    const profileFallback = (slot: string, idea: string): PlanItem | null => {
      if (!profileSource) return null;
      return { slot, idea, excerpt: profileSource.excerpt.slice(0, 60), source_refs: [profileSource.id],
        speaker_role: 'unknown', status_category: 'unknown', confidence: 0.3 };
    };
    const bySlot = new Map<string, PlanItem>();
    for (const item of intro.items) {
      const slot = item.slot && canonicalSlots.some((candidate) => candidate.slot === item.slot)
        ? item.slot
        : canonicalSlots.find((candidate) => !bySlot.has(candidate.slot))?.slot;
      if (!slot || bySlot.has(slot)) continue;
      bySlot.set(slot, excerptLocatable(item) ? { ...item, slot } : profileFallback(slot, canonicalSlots.find((candidate) => candidate.slot === slot)!.idea) ?? { ...item, slot });
    }
    for (const candidate of canonicalSlots) {
      if (bySlot.has(candidate.slot)) continue;
      const fallback = profileFallback(candidate.slot, candidate.idea);
      if (!fallback) throw new Error('规划 intro 章节摘录漂移且快照缺客户档案，无法回填小节锚点');
      bySlot.set(candidate.slot, fallback);
    }
    intro.items = canonicalSlots.map((candidate) => bySlot.get(candidate.slot)!) as PlanItem[];
    // summary 单条同理：漂移回退到交付统计事实行（或档案行）作为锚点。
    const summary = sectionOf('summary')!;
    const summaryFallback = (() => {
      const anchor = statsSource ?? profileSource;
      if (!anchor) return null;
      return { slot: undefined, idea: '项目总结：全案收束（串联合作起点、核心举措与已交付价值）',
        excerpt: anchor.excerpt.slice(0, 60), source_refs: [anchor.id],
        speaker_role: 'unknown' as const, status_category: 'unknown', confidence: 0.3 } satisfies PlanItem;
    })();
    summary.items = summary.items
      .filter((item) => excerptLocatable(item))
      .slice(0, 1);
    if (!summary.items.length) {
      if (!summaryFallback) throw new Error('规划 summary 章节摘录漂移且无可回退锚点');
      summary.items = [summaryFallback];
    }
  } else {
    // 无来源快照（诊断路径）：槽位仍按显式 slot/顺序归一到 4 条。
    const intro = sectionOf('intro')!;
    intro.items.forEach((item, index) => {
      item.slot = ['company_info', 'business_scope', 'competitive_strategy', 'project_background'][index] ?? item.slot;
    });
  }
  const summaryCount = sectionOf('summary')!.items.length;
  if (summaryCount !== 1) throw new Error(`规划 summary 章节必须恰好 1 条，实际 ${summaryCount} 条`);
  const valueItems = sectionOf('value')!.items;
  valueItems.forEach((item) => {
    if (item.slot !== 'lesson') item.slot = 'value';
  });
  if (!valueItems.some((item) => item.slot === 'value')) throw new Error('规划 value 章节必须至少 1 条价值条目（slot=value）');
  if (valueItems.filter((item) => item.slot === 'lesson').length > 3) throw new Error('规划 value 章节复盘条目（slot=lesson）至多 3 条');
  const unknowns = Array.isArray(raw.unknowns) ? raw.unknowns.map(String).map((item) => item.trim()).filter(Boolean) : [];
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined;
  // 摘录定位校验：非 intro/summary 章节默认整份拒绝（重试兜底，v7 口径）；
  // salvage 模式（第 3 次尝试）改为丢弃漂移条目——各章保底 ≥1 条，宁少一条不报废整轮。
  if (sources?.length && options.salvage) {
    const sourceMap = new Map(sources.map((item) => [item.id, item]));
    const excerptLocatable = (item: PlanItem) => !!item.excerpt
      && item.source_refs.some((ref) => {
        const source = sourceMap.get(ref);
        return !!source && sourceSupportsExcerpt(source, item.excerpt!, communications);
      });
    let droppedCount = 0;
    for (const entry of plan) {
      if (entry.section === 'intro' || entry.section === 'summary') continue; // 这两章有档案锚点回退
      const before = entry.items.length;
      entry.items = entry.items.filter((item) => excerptLocatable(item));
      droppedCount += before - entry.items.length;
    }
    if (droppedCount) unknowns.push(`规划期 ${droppedCount} 条要点因摘录漂移被丢弃（末次尝试打捞模式），如需补全请重新生成`);
    const empty = plan.filter((entry) => !entry.items.length);
    if (empty.length) throw new Error(`打捞后章节条目为空: ${empty.map((entry) => CASE_SECTIONS.find((section) => section.key === entry.section)!.label).join('、')}`);
  }
  // 配图骨架：非法条目直接丢弃（配图是可选增强，不值得为它触发整份规划重试）；每 kind 至多 1 张、总量至多 6 张（六类图可共存）。
  const figures: PlanFigure[] = [];
  if (Array.isArray(raw.figures)) {
    for (const entry of raw.figures) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || figures.length >= 6) continue;
      const row = entry as Record<string, unknown>;
      const section = String(row.section ?? '') as CaseFigureSectionKey;
      const kind = String(row.kind ?? '') as CaseFigureKind;
      const idea = typeof row.idea === 'string' ? row.idea.trim() : '';
      const refs = Array.isArray(row.source_refs) ? row.source_refs.map(String).map((ref) => ref.trim()).filter(Boolean) : [];
      // capability_map/architecture 只挂解决方案章；milestone 与 value_map 只挂价值章；其余 kind 不挂这两章（v8 章节键）；旧键不再接受新规划。
      const sectionAllowed = kind === 'milestone' || kind === 'value_map' ? section === 'value'
        : kind === 'capability_map' || kind === 'architecture' ? section === 'solution'
          : ['status', 'demands', 'solution'].includes(section);
      if (!sectionAllowed || !['flow_current', 'flow_target', 'capability_map', 'architecture', 'milestone', 'value_map'].includes(kind) || !idea || !refs.length) continue;
      if (refs.some((ref) => !allowedRefs.has(ref))) continue;
      if (figures.some((figure) => figure.kind === kind)) continue;
      figures.push({ section, kind, idea, source_refs: refs });
    }
  }
  return { title, plan, figures: figures.length ? figures : undefined, unknowns };
}

/** SVG 标签白名单：只保留静态绘制元素——script/foreignObject/动画/引用外部资源的元素一律不在名单内。 */
const FIGURE_SVG_TAG_ALLOWLIST = new Set(['svg', 'g', 'defs', 'marker', 'linearGradient', 'radialGradient', 'stop',
  'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan']);
/** SVG 属性白名单：布局/绘制/文本属性。style（可藏 url()/expression）、href/xlink:href、on* 事件等一律剥离。
 * dy/dx 必须在名单内（真实验收教训：tspan 的 dy 被剥离后多行文字全部叠在同一基线，v7 的「tspan 叠字」根因）。 */
const FIGURE_SVG_ATTR_ALLOWLIST = new Set(['xmlns', 'id', 'class', 'viewBox', 'preserveAspectRatio',
  'x', 'y', 'dx', 'dy', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'transform', 'd', 'points', 'opacity', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'font-size', 'font-weight', 'font-family', 'font-style', 'text-anchor', 'dominant-baseline',
  'markerWidth', 'markerHeight', 'markerEnd', 'markerStart', 'refX', 'refY', 'orient', 'markerUnits',
  'gradientUnits', 'offset', 'stop-color', 'stop-opacity']);

/**
 * 配图 SVG 消毒与校验（服务端权威；落库前执行，编辑/精修路径无法覆写 figures）。
 * 返回消毒后的 SVG 字符串；任何结构问题返回 null（调用方丢弃该图，不阻断五段正文）。
 * 无 XML parser 可用，采用「白名单标签 + 白名单属性 + 危险结构拒绝」的正则消毒：
 * 名单外标签/DOCTYPE/ENTITY/非 svg 根直接拒绝，名单外属性逐个剥离。
 */
export function sanitizeCaseSvg(raw: string): string | null {
  const svg = raw.trim();
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) return null;
  if (svg.length > FIGURE_SVG_MAX_CHARS) return null;
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<\?xml-stylesheet/i.test(svg)) return null;
  // 根元素须声明 viewBox（前端按 viewBox 自适应缩放，缺失视为结构不合格）。
  const opening = svg.slice(0, svg.indexOf('>') + 1);
  if (!/\sviewBox\s*=\s*["'][^"']*["']/.test(opening)) return null;
  // 标签白名单：开/闭标签一并检查（闭标签无属性）。
  const tags = [...svg.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)].map((match) => match[1].toLowerCase());
  if (!tags.length || tags.some((tag) => !FIGURE_SVG_TAG_ALLOWLIST.has(tag))) return null;
  // 叠字防御（真实验收教训：<text> 内直接裸换行的多行文字，栅格化后各行叠在同一基线不可读）：
  // ① 文本节点含「非空白\n非空白」直接拒绝；② <text> 里 tspan 从第二个起缺 dy（与上一行同位叠加）拒绝；
  // ③ <text> 自带裸文字又含 tspan（裸文字与首个 tspan 同位叠加）拒绝。拒绝触发逐图重试，仍失败即丢图不阻断正文。
  const rawTextNodes = [...svg.matchAll(/>([^<>]+)</g)].map((match) => match[1]);
  if (rawTextNodes.some((node) => /\S\s*\n\s*\S/.test(decodeXmlEntities(node)))) return null;
  for (const textMatch of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const inner = textMatch[2];
    // 裸文字 = 剥掉整个 tspan 元素（含其文字）后仍残留的文字——与首个 tspan 同位叠加才是叠字。
    const plainPrefix = inner.replace(/<tspan\b[\s\S]*?<\/tspan>/g, '').replace(/<[^>]+>/g, '').trim();
    const tspans = [...inner.matchAll(/<tspan\b([^>]*)>/g)].map((match) => match[1]);
    if (plainPrefix && tspans.length) return null;
    if (tspans.slice(1).some((attrs) => !/\b(?:dy|y)\s*=/.test(attrs))) return null;
  }
  // 文本内容过正文禁区词（联系人/金额/内部系统名等不得出现在图内）。
  const textContent = [...svg.matchAll(/>([^<>]+)</g)].map((match) => match[1]).join(' ');
  if (CASE_INTERNAL_EVIDENCE_PATTERNS.some(({ pattern }) => pattern.test(decodeXmlEntities(textContent)))) return null;
  // 属性白名单：名单外属性逐个剥离（含 on* 事件、style、href/xlink:href、data: URI）。
  // SVG 实际属性用 kebab-case（marker-end/stroke-width），白名单按 camelCase 维护，比较前先归一化。
  const camelAttr = (name: string) => name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
  return svg.replace(/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (whole, tag: string, attrs: string) => {
    if (!FIGURE_SVG_TAG_ALLOWLIST.has(tag.toLowerCase())) return whole; // 白名单已在上一步整图拒绝，这里保持原样
    const kept = attrs.replace(/([a-zA-Z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, (attrWhole, name: string) =>
      FIGURE_SVG_ATTR_ALLOWLIST.has(name) || FIGURE_SVG_ATTR_ALLOWLIST.has(camelAttr(name))
        ? attrWhole : '');
    return `<${tag}${kept.replace(/\s+/g, ' ').replace(/\s+>/g, '>')}>`;
  });
}

/** SVG 文本实体解码（禁区词检查用，防实体编码绕过）。 */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const code = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

/** 配图（图级证据）读取：存量草稿无 figures 字段按空数组兼容；元素结构非法的逐项剔除。
 * 章节键同时接受 v8（status/demands/solution/value）与存量旧稿（challenges/requirements）。 */
export function caseFiguresOf(fields: Record<string, unknown> | undefined): CaseFigure[] {
  if (!Array.isArray(fields?.figures)) return [];
  return fields!.figures.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const section = String(row.section ?? '') as CaseFigureSectionKey;
    const kind = String(row.kind ?? '') as CaseFigureKind;
    const svg = typeof row.svg === 'string' ? row.svg : '';
    const refs = Array.isArray(row.source_refs) ? row.source_refs.map(String).filter(Boolean) : [];
    if (!CASE_FIGURE_SECTION_KEYS.has(section) || !['flow_current', 'flow_target', 'capability_map', 'architecture', 'milestone', 'value_map'].includes(kind)
      || !svg || !refs.length) return [];
    return [{ id: String(row.id ?? ''), section, kind, svg, caption: String(row.caption ?? '').trim(), source_refs: refs,
      note: typeof row.note === 'string' ? row.note : undefined }];
  });
}


/** 章节产出的规范化载荷：texts 与规划条目一一对位（intro 四槽/段落/条目/小节正文/价值条目/总结段），
 * lessons 与 value 章的 lesson 槽位对位，sectionTitles 与 solution 章 texts 对位。 */
interface ChapterOutput {
  texts: string[];
  lessons?: string[];
  sectionTitles?: string[];
}

/** 章节输出 JSON 的形态说明（逐章 prompt 注入）。 */
const CHAPTER_OUTPUT_SCHEMAS: Record<CaseChapterKey, string> = {
  intro: '{"company_info":"...","business_scope":"...","competitive_strategy":"...","project_background":"..."}（四个小节各一段；素材确实不足的小节允许空字符串，但 company_info/project_background 不得为空）',
  status: '{"texts":["...","..."]}（texts 为本章段落数组，顺序与写作要点一一对应）',
  demands: '{"texts":["...","..."]}（texts 为本章条目数组，顺序与写作要点一一对应）',
  solution: '{"sections":[{"title":"...","text":"..."}]}（sections 为方案小节数组，顺序与写作要点一一对应，title 为 20 字以内小节标题）',
  value: '{"texts":["..."],"lessons":["..."]}（texts 为价值成效条目、lessons 为经验复盘条目，各自与同槽位写作要点一一对应；无复盘素材时 lessons 为空数组）',
  summary: '{"text":"..."}（text 为本章正文，一段收束总结）',
};

function parseChapterOutput(section: CaseChapterKey, value: unknown): ChapterOutput {
  const label = CASE_SECTIONS.find((item) => item.key === section)!.label;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`模型未返回「${label}」章节 JSON`);
  const raw = value as Record<string, unknown>;
  const str = (input: unknown) => (typeof input === 'string' ? input.trim() : '');
  const list = (input: unknown) => (Array.isArray(input) ? input.map(String).map((item) => item.trim()).filter(Boolean) : []);
  const assertNoPlaceholder = (texts: string[]) => {
    if (texts.some((item) => /待确认|待补充|\bunknown\b/i.test(item))) throw new Error(`「${label}」包含待确认/待补充占位词`);
  };
  if (section === 'intro') {
    const texts = [str(raw.company_info), str(raw.business_scope), str(raw.competitive_strategy), str(raw.project_background)];
    if (!texts[0]) throw new Error('「客户及背景介绍」缺少公司信息');
    if (!texts[3]) throw new Error('「客户及背景介绍」缺少项目背景');
    assertNoPlaceholder(texts.filter(Boolean));
    return { texts };
  }
  if (section === 'solution') {
    const sections = normalizeSolutionSections(raw.sections);
    if (!sections.length) throw new Error(`模型未返回「${label}」小节`);
    assertNoPlaceholder(sections.map((item) => item.text).concat(sections.map((item) => item.title).filter(Boolean)));
    return { texts: sections.map((item) => item.text), sectionTitles: sections.map((item) => item.title) };
  }
  if (section === 'value') {
    const texts = list(raw.texts);
    const lessons = list(raw.lessons);
    if (!texts.length) throw new Error(`模型未返回「${label}」价值成效条目`);
    assertNoPlaceholder([...texts, ...lessons]);
    return { texts, lessons };
  }
  if (section === 'summary') {
    const text = str(raw.text);
    if (!text) throw new Error(`模型未返回「${label}」正文`);
    assertNoPlaceholder([text]);
    return { texts: [text] };
  }
  const texts = list(raw.texts);
  if (!texts.length) throw new Error(`模型未返回「${label}」条目`);
  assertNoPlaceholder(texts);
  return { texts };
}

/**
 * 规划阶段模型调用：产出六章节的要点与证据骨架（plan）。
 * plan.items 的 excerpt/source_refs 将原样进入 claim_evidence，逐字校验在组装阶段统一执行。
 */
async function planCaseWithModel(runtime: Runtime, input: CasePromptInput, snapshot: CaseContextSnapshot, contextText: string,
  communications: CaseCommunicationSource[], onProgress?: (text: string) => void): Promise<CasePlan> {
  const prompt = `为客户「${input.customer.name}」规划客户成功案例草稿的章节结构。这份案例经 CSM 审核后用于对外展示（深度长文：客户及背景介绍 → 场景及解决方案 → 方案价值概述 → 项目总结）。你只做规划不写正文，只输出 JSON：\n`
    + `{"title":"...","plan":[{"section":"intro|status|demands|solution|value|summary","items":[{"slot":"intro/value 章需要","idea":"本条写作要点的简明描述（非最终正文）","excerpt":"支持该要点的原文摘录","source_refs":["上下文中的 source_ref"],"speaker_role":"customer|csm|unknown","status_category":"done|in_progress|to_do|unknown","confidence":0.0}]}],"figures":[{"section":"status|demands|solution|value","kind":"flow_current|flow_target|architecture|milestone","idea":"这张图画什么","source_refs":["..."]}],"unknowns":["..."]}\n`
    + `规划规则：\n`
    + `- 先在思考中通读素材再输出：思考从简（只做章节路由与证据挑选判断），plan JSON 是唯一交付物。\n`
    + `- 六个章节都必须有条目：intro 恰好 4 条且按 slot 顺序 company_info（公司信息）/business_scope（核心业务范围）/competitive_strategy（竞争优势与发展战略）/project_background（项目背景）；status 2~4 条（每条一段现状/痛点）；demands 3~6 条；solution 2~6 条（每条一个方案级举措小节）；value 2~6 条（slot=value）另可加 0~3 条复盘条目（slot=lesson，合作过程中的研讨与优化结论）；summary 恰好 1 条。素材不足时允许在下限以内收缩、宁少勿注水，没有把握写入的素材收进 unknowns。\n`
    + `- 每个条目的 idea 是「这一条要写什么」的要点描述（40 字以内，如「客户因跨部门数据孤岛导致人工汇总耗时」），不是最终正文；后续章节生成会依据 idea 撰写完整正文。\n`
    + `- 每个条目必须绑定真实 source_refs 与一段 excerpt 原文摘录（60 字以内，从对应来源的 title/excerpt/事实原文中连续逐字截取，不得改写拼接）；摘录是后续正文逐字校验的锚点。\n`
    + `- 客户简介三小节（intro 前三槽）的摘录必须真的可抄：优先逐字取 customer 档案行（如「客户名称：…；行业：…」）或 web_context snippet 中的完整原句；档案与检索都查不到的信息（成立年份、规模、排名等具体事实）不得凭常识补写来源——对应小节写基于档案的收缩要点，缺失信息收进 unknowns（服务端会把无法定位摘录的简介/总结条目回退到档案锚点，但凭常识编造的事实仍会被公开检查标记）。\n`
    + `- 配图（figures）：capability_map=需求场景-产品能力映射图（业务解决方案章标配——只要方案章有举措就规划：客户需求场景按业务先后顺序编号、逐场景对应所采用的 ONES 产品能力，idea 写明场景顺序与对应能力主线）；architecture=系统集成架构图（业务解决方案章，仅当素材中有外部系统与 ONES 对接/集成的表述时才在 capability_map 之外加画——此时解决方案章共两张图，idea 写明参与集成的系统与各自的数据流向）；此外素材中还有客户用一段话描述的流程（现状流程/期望流程）或值得呈现的合作里程碑时再加画——flow_current=现状流程（业务现状/业务诉求章）、flow_target=目标流程（业务现状/业务诉求章）、milestone=服务里程碑时间轴（方案价值概述章，节点事实由服务端交付统计提供）、value_map=痛点-方案-价值全景图（方案价值概述章末尾：痛点与价值收束对位，方案区由服务端嵌入需求场景-产品能力映射图、模型不画方案区）；至多 6 张、每 kind 至多 1 张，每张绑定支撑该图的 source_refs；无合适素材就省略对应图，宁缺毋滥。\n`
    + `- 章节路由：客户简介三小节（company_info/business_scope/competitive_strategy）只取客户档案与 web_context 可信公开信息（customer_official、government_procurement 优先，media 只能辅助）；项目背景取合作动因（档案、早期沟通记录、招采与政策类公开信息）；业务现状必须是合作前或当前问题；诉求是客户明确诉求；方案条目须有沟通记录或 CRM 跟进中的交付事实支撑、或 delivery_stats 佐证——讨论、计划和待办不得写成已交付；价值与复盘条目必须来自客户说话人或可复核指标，价值发生在方案落地之后、复盘发生在合作期间。\n`
    + `- 信号表兜底：pain_point_signals/value_signals 是关键词预扫描的线索而非全集——若在 communications 片段原文中发现未被收录、但确属客户痛点或方案落地后价值反馈的表述，可直接引用该片段（source_ref 取片段 id）建条目，不受信号表限制，摘录从片段原文逐字截取。\n`
    + `- 公开检索信息只能依据 snippet 中可直接核验的事实；customer_official、government_procurement（以及旧版 official）可用于客户简介/项目背景/正式要求，media 只能辅助背景。标题命中客户名不能单独成文，同名或业务不符结果必须丢弃。\n`
    + `- 交付统计（delivery_stats）可被 intro/status/solution/value 条目引用（source_ref "${CASE_STATS_SOURCE_ID}"、摘录取其 facts 原文）；只可作事实陈述，不得自行计算百分比。\n`
    + `- unknowns 每条写明「缺失项 + 建议向谁/从哪里确认」（如系统使用情况表缺账号数/有效期/使用部门，建议向客户成功经理或合同记录确认）。\n`
    + `${onesAsrAliasRule()}该订正适用于全部正文与摘录。\n`
    + `${ONES_CAPABILITY_MAP}\n（idea 与摘录中提到 ONES 产品模块/集成机制时，命名须与图谱一致。）\n`
    + `上下文：${contextText}`;
  // 4 次尝试 + 退避封顶 120s：中继坏窗口为分钟级，3 次/45s 封顶会被同一窗口连续击穿（真实验收两连败教训）。
  const MAX_ATTEMPTS = 4;
  const retryDelayMs = (attempt: number) => Math.min(120_000, caseModelRetryDelays.baseMs * 3 ** (attempt - 1));
  let lastError = '模型未返回可解析的案例规划 JSON';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await completeModelWithProgress(runtime, {
      systemPrompt: CASE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    }, onProgress ? (tick) => onProgress(modelProgressText(tick)) : undefined, { maxTokens: PLAN_MAX_TOKENS, timeoutMs: caseModelTimeoutMs(prompt) });
    if (response.stopReason === 'error') {
      lastError = `规划模型调用失败（第 ${attempt}/${MAX_ATTEMPTS} 次）: ${response.errorMessage || '未知错误'}`;
      if (attempt < MAX_ATTEMPTS) {
        onProgress?.(`${lastError}，${Math.round(retryDelayMs(attempt) / 1000)} 秒后自动重试`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      }
      continue;
    }
    const value = cleanJson(extractText(response.content));
    if (value) {
      try {
        // 末次尝试启用打捞模式：漂移条目丢弃而非整份拒绝（真实验收教训：单条漂移连败报废整轮生成）。
        return parseCasePlan(value, new Set(snapshot.sources.map((item) => item.id)), snapshot.sources, communications,
          { salvage: attempt >= MAX_ATTEMPTS }); }
      catch (error) {
        lastError = `模型规划契约不合格（第 ${attempt}/${MAX_ATTEMPTS} 次）: ${(error as Error).message}`;
        onProgress?.(lastError);
      }
    } else {
      lastError = `模型未返回可解析的案例规划 JSON（第 ${attempt}/${MAX_ATTEMPTS} 次，stopReason=${response.stopReason}）`;
    }
    if (attempt < MAX_ATTEMPTS) {
      onProgress?.(`规划输出未通过校验（第 ${attempt}/${MAX_ATTEMPTS} 次），正在重写`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  throw new Error(lastError);
}

/** 逐章篇幅与写法要求（逐章 prompt 注入；篇幅是质量要求非硬字符数）。 */
const CHAPTER_WRITING_BRIEFS: Record<CaseChapterKey, string> = {
  intro: '- 本章四个小节：公司信息 100~250 字（公司全称、成立/上市等可核验背景）、核心业务范围 100~250 字（业务板块）、竞争优势与发展战略 100~250 字、项目背景 200~500 字（与 ONES 合作的动因与目标，可自然融入 delivery_stats 合作时长与服务投入）。三小节只写客户档案与 web_context 可核验的公开信息，禁止虚构排名、规模、上市与经营数据；无公开依据的小节基于档案行业/产品写收缩篇幅的行业性描述，确实无素材允许空字符串。',
  status: '- 每段 100~250 字、共 2~4 段（texts 数组每元素一段连贯段落）：客户合作前或当前的业务现状与痛点，每段包含「痛点现象 + 具体场景或影响」两层；必须是合作前或当前问题，已解决事项不写成现状；写连贯叙述段落，不写一句话条目清单。',
  demands: '- 每条 60~180 字：客户明确提出的需求与要求，有明确时间节点的保留节点；可信的招投标/制度类公开信息可作佐证。',
  solution: '- 每个小节一个方案级举措（sections 数组，title 为 20 字以内小节标题、text 为 250~600 字正文）：说明举措内容、落地过程与所解决的问题，可引用 delivery_stats 佐证规模；以「我们为客户提供了什么方案」为主线，不得写成功能点罗列或事件流水。',
  value: '- 价值成效（texts）每条 50~180 字：客户获得的已确认价值，量化结果优先，无量化写有证据支持的定性价值；不得出现人名，禁止虚构数字。经验复盘（lessons）每条 60~180 字、0~3 条：只写沟通记录中有出处的复盘结论（如研讨后的度量口径调整、实施策略优化），措辞正面建设性，不得负面定性客户；无素材返回空数组。',
  summary: '- 一段 150~400 字的收束总结：串联合作起点、核心举措与已交付价值；不引入前文未出现的新事实、新数字。',
};

/**
 * 章节生成模型调用：按 plan 的单章节撰写正文。单次输出只有一章，规避 maxTokens 截断。
 * 每章 3 次指数退避重试；单章失败抛错由调用方判任务失败（已完成的章节不重复消耗）。
 */
async function generateChapterWithModel(runtime: Runtime, input: CasePromptInput, snapshot: CaseContextSnapshot, plan: CasePlan,
  section: CaseChapterKey, contextText: string, priorChapters: Array<{ label: string; text: string }>,
  onProgress?: (text: string) => void): Promise<ChapterOutput> {
  const definition = CASE_SECTIONS.find((item) => item.key === section)!;
  const sectionPlan = plan.plan.find((entry) => entry.section === section)!;
  const slotLabels: Record<string, string> = { company_info: '公司信息', business_scope: '核心业务范围', competitive_strategy: '竞争优势与发展战略', project_background: '项目背景', value: '价值成效', lesson: '经验复盘' };
  const chapterBriefs = sectionPlan.items.map((item, index) => `${slotLabels[item.slot ?? ''] ? `[${slotLabels[item.slot!]}] ` : ''}第 ${index + 1} 条：${item.idea}（证据摘录：${item.excerpt ?? '无'}）`).join('\n');
  const prompt = `为客户「${input.customer.name}」的客户成功案例撰写「${definition.label}」章节正文（案例叙事路径「客户及背景介绍 → 场景及解决方案 → 方案价值概述 → 项目总结」中的${definition.description}）。只写这一个章节，只输出 JSON：\n`
    + `${CHAPTER_OUTPUT_SCHEMAS[section]}\n`
    + `写作要点（来自已确认的章节规划，每条已有绑定证据，按顺序逐条撰写正文）：\n${chapterBriefs}\n`
    + (priorChapters.length
      ? `此前章节已定稿正文（新章节不得重复其已表述的具体内容——背景信息只在客户及背景介绍章展开、同一问题不在业务现状与业务诉求两节写两遍；专有名词、产品模块名、客户称谓必须与前章用词保持一致）：\n${priorChapters.map((chapter) => `【${chapter.label}】${chapter.text}`).join('\n\n')}\n`
      : '')
    + `写作要求：\n`
    + `- 客户叙事视角：客户是主角；多个系统中同一件事合并为一条叙述，禁止流水账。\n`
    + `- 只写有证据的事实：正文内容须与写作要点及其证据一致，不得虚构数字/引语/ROI；没有量化证据时只写有证据支持的定性表述。\n`
    + `${ONES_CAPABILITY_MAP}\n（正文提到 ONES 产品模块或集成机制时命名须与图谱一致；某能力是否已为客户交付/配置/打通仍须以写作要点的证据为准。）\n`
    + `- 正文禁止出现 unknown 等占位词、内部系统名（Hemory、CRM）、风险评级、工时统计、联系人姓名/联系方式/合同金额，不得泄露其他客户或其他项目信息。\n`
    + `${CHAPTER_WRITING_BRIEFS[section]}\n`
    + `- 篇幅契约是质量要求而非硬性字符数：素材不足以支撑下限时允许略低，禁止空泛注水。\n`
    + `${onesAsrAliasRule()}该订正适用于全部正文。\n`
    + `上下文：${contextText}`;
  // 4 次尝试 + 退避封顶 120s：中继坏窗口为分钟级，3 次/45s 封顶会被同一窗口连续击穿（真实验收两连败教训）。
  const MAX_ATTEMPTS = 4;
  const retryDelayMs = (attempt: number) => Math.min(120_000, caseModelRetryDelays.baseMs * 3 ** (attempt - 1));
  let lastError = `模型未返回「${definition.label}」章节 JSON`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await completeModelWithProgress(runtime, {
      systemPrompt: CASE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    }, onProgress ? (tick) => onProgress(`撰写「${definition.label}」中… ${modelProgressText(tick)}`) : undefined, { maxTokens: CHAPTER_MAX_TOKENS, timeoutMs: caseModelTimeoutMs(prompt) });
    if (response.stopReason === 'error') {
      lastError = `「${definition.label}」模型调用失败（第 ${attempt}/${MAX_ATTEMPTS} 次）: ${response.errorMessage || '未知错误'}`;
      if (attempt < MAX_ATTEMPTS) {
        onProgress?.(`${lastError}，${Math.round(retryDelayMs(attempt) / 1000)} 秒后自动重试`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      }
      continue;
    }
    const value = cleanJson(extractText(response.content));
    if (value) {
      try {
        const output = parseChapterOutput(section, value);
        // 各章产出条数须与规划一致（服务端按序号对位组装 claim_evidence）；value 章 texts 对 value 槽、lessons 对 lesson 槽。
        const valueSlotItems = section === 'value' ? sectionPlan.items.filter((item) => item.slot !== 'lesson') : sectionPlan.items;
        if (output.texts.length !== valueSlotItems.length) throw new Error(`条目数 ${output.texts.length} 与规划 ${valueSlotItems.length} 不一致`);
        if (section === 'value') {
          const lessonItems = sectionPlan.items.filter((item) => item.slot === 'lesson');
          if ((output.lessons ?? []).length !== lessonItems.length) throw new Error(`复盘条目数 ${(output.lessons ?? []).length} 与规划 ${lessonItems.length} 不一致`);
        }
        return output;
      } catch (error) {
        lastError = `「${definition.label}」契约不合格（第 ${attempt}/${MAX_ATTEMPTS} 次）: ${(error as Error).message}`;
        onProgress?.(lastError);
      }
    } else {
      lastError = `「${definition.label}」未返回可解析 JSON（第 ${attempt}/${MAX_ATTEMPTS} 次，stopReason=${response.stopReason}）`;
    }
    if (attempt < MAX_ATTEMPTS) {
      onProgress?.(`「${definition.label}」输出未通过校验（第 ${attempt}/${MAX_ATTEMPTS} 次），正在重写`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  throw new Error(lastError);
}

/**
 * 配图类型说明（逐图生成 prompt 注入）：图内容的事实边界由素材原文约束，画法只约束形态不约束事实。
 */
const CASE_FIGURE_KIND_BRIEFS: Record<CaseFigureKind, string> = {
  flow_current: '流程现状图：客户当前（合作前/现状）的实际业务流程——按步骤或角色分栏画框，箭头连接，突出断点、人工环节与重复环节',
  flow_target: '目标流程图：客户期望达成的目标流程——方案落地后的目标流转，步骤框 + 箭头，体现统一平台/自动化环节替代人工与断点',
  capability_map: '需求场景-产品能力映射图：客户的每个需求场景按业务先后顺序编号排列，逐场景对应所采用的 ONES 产品能力（能力名以能力图谱为准）——左场景右能力的映射连线图',
  architecture: '系统集成架构图：多系统集成场景专用——素材表明方案涉及外部系统与 ONES 的对接（信息接入 ONES、或从 ONES 取数）时绘制：ONES 平台为核心、外部系统环绕对接、连线带数据标注。模块名与连接关系须有素材依据，不虚构未交付组件',
  milestone: '服务里程碑时间轴：按时间先后横向排列的合作里程碑——水平主轴 + 依次节点，每个节点为「年月 + 短标签」的圆点/框，节点事实必须与提供的里程碑清单完全一致，不虚构、不增删节点',
  value_map: '痛点-方案-价值全景图：把前文客户痛点与已确认价值收束为一张总览大图——顶部痛点带 + 右栏价值栏两区由模型绘制（痛点与价值按序一一对位），左下方案区由服务端嵌入需求场景-产品能力映射图',
};

/** 配图绘图规范·通用条目（所有 kind 适用；规模/画布/布局差异在 CASE_FIGURE_KIND_RULES 专属条目里）。 */
const CASE_FIGURE_COMMON_RULES = [
  '- 思考从简：先在思考里直接定下节点/分区清单与连接关系（规模上限见本图专属规范）就立即开始输出，不要反复推敲布局与配色；{"svg","caption"} JSON 是唯一交付物。',
  '- svg 是一个自包含的 <svg>…</svg> 字符串（不引用外部资源、不含脚本与交互属性），根元素必须声明 viewBox；画布尺寸与比例按本图专属规范取值。',
  '- 文字一律 <text> 中文标签（font-size 不小于 12；每行不超过 10 个汉字，长标签用 <tspan> 拆行且每个 tspan 必须带递增 dy（如 dy="18"，首个可不带），否则多行文字会叠在一起）；<text> 元素内严禁直接换行写多行文字——多行必须且只能用 tspan 逐行拆分。',
  '- 块/节点用 <rect> 圆角框；连线用 <line> 或 <path> 并以 marker 箭头标示方向；节点不重叠、连线不穿越文字。',
  '- 所有图形与文字元素必须完整落在 viewBox 画布范围内（坐标不小于 0、不超出画布宽高），顶部内容从 y≥40 开始，不得出现被画布边缘裁切的元素；每个块都必须带文字标签，禁止无文字的空白占位块。',
  '- 配色克制：浅色填充 + 深色描边 + 深色文字；只使用纯 SVG 绘制元素，不使用 <image>、外链或 CSS 样式表。',
  '- 图内文字与正文禁区相同：不得出现人名、联系方式、合同金额、内部系统名（Hemory、CRM）、其他客户信息；caption 是 30 字以内的图注（如「客户现状：三套系统并行、人工汇总对齐」）。',
].join('\n');

/** 流程/时间轴类的专属规范（v7 原口径不变：节点 ≤10、2~4k 字符、横向布局）。 */
const CASE_FIGURE_SIMPLE_KIND_RULES = '- 规模：节点总数不超过 10 个、每个标签不超过 10 个字，SVG 通常 2~4k 字符即可。\n'
  + '- 画布 viewBox="0 0 800 480"（可按内容在 600~900 × 400~540 间调整）；整体横向布局。';

/**
 * 配图绘图规范·kind 专属条目（v9：架构图集成画法细化——ONES 能力模块化、连线方向+数据标注+端点落模块；
 * 新增 value_map 痛点-方案-价值全景图）。画法对齐手绘示例图：核心平台内部画能力模块清单、连线端点精确到模块、
 * 线色=数据发出方、线上标注框写数据内容；全景图三区不连线、靠编号对位表达映射。
 */
const CASE_FIGURE_KIND_RULES: Record<CaseFigureKind, string> = {
  flow_current: CASE_FIGURE_SIMPLE_KIND_RULES,
  flow_target: CASE_FIGURE_SIMPLE_KIND_RULES,
  milestone: CASE_FIGURE_SIMPLE_KIND_RULES,
  capability_map: [
    '- 规模：需求场景 3~6 个、ONES 能力块 4~8 个，SVG 约 4~8k 字符即可。',
    '- 画布 viewBox="0 0 800 460"（此图后续会被服务端原比例嵌入一指禅图，不要改画布比例）。',
    '- 布局：左列为客户需求场景卡——白底卡 + 实色编号标题条（白字 6~12 字场景名）+ 卡内一行副注（不超过 20 个字），按业务诉求/方案正文中的先后顺序自上而下编号 1、2、3… 排列；右侧为 ONES 产品能力块（白底块，能力名从下方能力图谱中选取，可按产品域加实色域名条分组）；每个能力块尽量垂直对齐其主要采用的场景行，使映射以水平短线为主；左列与右列之间留足连线走廊。',
    '- 映射连线：每个场景向其采用的能力引 1~2 条单向箭头（场景→能力），深灰细线 + 小箭头，以水平线或浅折线为主；禁止长距离纵向干线、禁止连线互相交叉——某条映射难以无交叉布线时，宁可把目标能力块挪到对应场景的行高再连；一个能力被多个场景共用是正常的（多入汇聚，箭头从不同行汇入同块）；箭头尖端必须触达能力块的边框，不得停在块附近的空白处。',
    '- 同一产品域拆出多个能力块时，块标题须带副题区分（如「ONES Project·工作项管理」「ONES Project·流程自动化」）。',
    '- 场景与对应能力须有素材依据，不虚构未提及的需求或未采用的能力；除映射主线外不画其他装饰元素。',
  ].join('\n'),
  architecture: [
    '- 规模：块总数不超过 22、连线不超过 8 条，SVG 约 4~10k 字符即可。',
    '- 画布 viewBox="0 0 900 540"（可按内容在 700~960 × 460~600 间调整）。',
    '- 素材中有外部系统向 ONES 接入信息、或从 ONES 抓取数据的对接时，按「系统集成图」画：',
    '  · 布局：ONES 平台为核心容器置于中部——容器顶部边框上骑一块实心深色「ONES 平台」标题牌（不要把平台名画成与能力模块并排的普通块），标题牌下方按 2~3 行网格（每行 2~3 块）排列本方案涉及的能力模块块（白底块，模块名从下方能力图谱与素材中选取，数量与方案正文涉及的能力相当、通常 3~6 个且不少于 3 个——除非素材确实只支撑更少）；容器高度与宽度贴合内容收拢，内容区应占满画布高度与宽度的 80% 以上、四周留白大致均衡、不得留大片空白；外部系统环绕在核心容器四周，各系统块之间留出空白走廊供连线走线。',
    '  · 外部系统：素材提到该系统的具体功能/模块时，画「浅色容器 + 实心系统名块 + 若干白底模块块」的组块；素材没提内部模块的系统只画系统级单块；每个系统分配一个专属主题色（容器浅色、系统名块实色）。',
    '  · 连线：横平竖直的正交折线（只在 90° 转角改向），单向实心箭头，箭头方向=数据流向——外部系统向 ONES 接入信息、以及 ONES 向外部系统供数（外部从 ONES 抓取）都要按素材如实画出方向；每条连线必须带 marker 箭头，两端都无箭头的无方向线段禁止出现；素材未写明方向时按语境选择最可能的流向画单向箭头、并在标注中写明数据发出方；连线与箭头用数据发出方系统的主题色；连线不交叉、不穿过任何容器。',
    '  · 连线标注：每条连线必须配一个白底、与线同色细边框的圆角小标签框，紧贴所标注的连线放置（不得悬浮在远离连线的空白处，也不得压住任何块或容器的边框），框内写这条对接传输的数据内容（须有素材依据，每行不超过 10 个字）；标注动词方向必须与箭头一致——指向 ONES 用「推送/同步至 ONES」语义（如「推送工单状态」），从 ONES 指出用「输出/供数至外部」语义（如「输出项目进度」）。',
    '  · 端点精度：连线两端必须落到具体的模块块边缘——ONES 侧箭头指向消费或提供该数据的能力模块块（不得只指平台容器外框），外部系统侧指向相关模块块或系统块边缘。',
    '- 纯平台落地方案（素材中无外部系统对接）按分层架构画：接入层/平台能力模块层/数据层的分层框线，模块名须与素材及能力图谱一致。',
  ].join('\n'),
  value_map: [
    '- 规模：痛点卡与价值卡各 3~4 条且数量必须相等，SVG 约 4~10k 字符即可。',
    '- 画布 2:1 横版，viewBox="0 0 1440 720"。',
    '- 你只画两个区：①顶部痛点带——红色虚线圆角框（x=44 至 x=1396、y=24 至 y=184）+ 框顶中央压红色实心「痛点」标题牌，框内痛点卡横向均排：红色实心标题条带编号（白字，如「1. 收集靠邮件」6~10 字）+ 白底卡身一行描述（不超过 30 个字），从业务现状/业务诉求正文中提炼；②右侧价值栏——蓝色虚线圆角框（x=1030 至 x=1396、y=208 至 y=696）+ 框顶蓝色实心「价值」标题牌，价值卡纵向排列：蓝色实心标题条带编号（如「1. 进度可控」）+ 白底卡身描述（不超过 30 个字）。',
    '- 痛点与价值按序一一对位：第 i 个痛点对应第 i 个价值，措辞互相呼应。',
    '- 左下方案区（x=44 至 x=1004、y=208 至 y=696）由服务端拼装解决方案章节的配图，你必须把该区域完全留空——不得在其中画任何框、线或文字，痛点带与价值栏也不得越界侵入该区域。',
    '- 两区之间不画任何连线；色彩语义：痛点红、价值蓝，整图白底。',
  ].join('\n'),
};

/**
 * 配图生成 prompt 的唯一组装出口（生成调用 / 探针脚本 / 单测共用一份实现，防止三处漂移）。
 * capability_map / architecture / value_map 额外注入 ONES 能力图谱（模块命名依据），其余 kind 不注入。
 */
export function buildCaseFigurePrompt(input: {
  customerName: string;
  sectionLabel: string;
  kind: CaseFigureKind;
  idea: string;
  /** 图所依托的定稿正文锚点（普通图=本章锚点；value_map=痛点/价值合并锚点，自带段落标记）。 */
  chapterAnchor: string;
  materials: string[];
}): string {
  const knowledge = input.kind === 'capability_map' || input.kind === 'architecture' || input.kind === 'value_map'
    ? `${ONES_CAPABILITY_MAP}\n（图中 ONES 能力模块的命名须与图谱一致；图谱不构成该客户已交付的证据——是否交付以正文与素材为准。）\n`
    : '';
  return `为客户「${input.customerName}」的客户成功案例绘制「${input.sectionLabel}」章节配图（${CASE_FIGURE_KIND_BRIEFS[input.kind]}）。这份案例经 CSM 审核后对外展示，图内容只能基于提供的素材原文，不得虚构环节、模块或数字。只输出 JSON：{"svg":"...","caption":"..."}\n`
    + `绘图规范：\n`
    + `${CASE_FIGURE_COMMON_RULES}\n`
    + `本图专属规范：\n${CASE_FIGURE_KIND_RULES[input.kind]}\n`
    + knowledge
    + `- 本图要表达的内容（来自章节规划）：${input.idea}\n`
    + `- 图所依托的定稿正文（图内容须与正文口径一致）：${input.chapterAnchor}\n`
    + `- 支撑素材原文（图内容的事实依据，图中的环节/模块/角色/数字必须能在这里找到）：\n${input.materials.join('\n\n')}`;
}

/** value_map 方案区拼装几何（1440×720 画布；与 CASE_FIGURE_KIND_RULES.value_map 要求模型留空的区域严格对位）。 */
const VALUE_MAP_SOLUTION_ZONE = { frame: { x: 44, y: 208, w: 960, h: 488 }, inner: { x: 64, y: 240, w: 920, h: 440 } };

/**
 * 一指禅图方案区的服务端拼装（v10）：模型按规范把左下区域完全留空，这里补画「方案」蓝色虚线分区框 + 实色标题牌，
 * 并把解决方案章的 capability_map 图（已消毒）以嵌套 <svg> 等比嵌入——映射图按 800×460 设计，嵌入后约 0.96 倍、
 * 文字近原生可读；映射图缺失（未规划/生成失败）时画居中占位文案。返回拼装并重新消毒后的 SVG；
 * 结构异常返回 null（调用方退回未拼装版，不阻断）。
 */
export function composeValueMapSvg(svg: string, solutionFigure: { svg: string } | null): string | null {
  let nested: string | null;
  if (!solutionFigure) {
    nested = `<text x="524" y="458" text-anchor="middle" font-size="20" fill="#9CA3AF">方案详见「业务解决方案」章节配图</text>`;
  } else {
    const source = solutionFigure.svg;
    // 模型可能用单引号或双引号书写属性（消毒不统一引号风格），两种都要能取到根 viewBox。
    const viewBox = source.match(/viewBox=["']([^"']+)["']/)?.[1];
    const rootEnd = source.indexOf('>');
    const closing = source.lastIndexOf('</svg>');
    if (!viewBox || rootEnd < 0 || closing <= rootEnd) return null;
    const { x, y, w, h } = VALUE_MAP_SOLUTION_ZONE.inner;
    nested = `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${source.slice(rootEnd + 1, closing)}</svg>`;
  }
  const f = VALUE_MAP_SOLUTION_ZONE.frame;
  const plateX = Math.round(f.x + f.w / 2);
  const zone = `<g>`
    + `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="12" fill="none" stroke="#1D4ED8" stroke-width="2" stroke-dasharray="8 6"/>`
    + `<rect x="${plateX - 48}" y="${f.y - 17}" width="96" height="34" rx="6" fill="#1D4ED8"/>`
    + `<text x="${plateX}" y="${f.y}" text-anchor="middle" dominant-baseline="middle" font-size="18" font-weight="bold" fill="#FFFFFF">方案</text>`
    + nested
    + `</g>`;
  const closing = svg.lastIndexOf('</svg>');
  if (closing < 0) return null;
  return sanitizeCaseSvg(`${svg.slice(0, closing)}${zone}</svg>`);
}

/**
 * 配图生成模型调用（各章完成后逐图执行）：输入 = 关联来源完整原文 + 该章定稿正文 + 画法规范，
 * 输出 {"svg","caption"}。消毒失败重试，全部失败返回 null——配图是可选增强，绝不阻断正文。
 * milestone 时间轴的节点事实来自服务端派生里程碑清单（deterministic），额外注入为画图素材。
 */
async function generateFigureWithModel(runtime: Runtime, input: CasePromptInput, snapshot: CaseContextSnapshot,
  figure: PlanFigure, communications: CaseCommunicationSource[], chapterText: string, milestones: CaseMilestone[],
  onProgress?: (text: string) => void): Promise<CaseFigure | null> {
  const sectionLabel = CASE_SECTIONS.find((item) => item.key === figure.section)?.label ?? figure.section;
  // 关联来源的完整原文：hemory 片段取全量转写（流程描述常在片段中后段），其余来源取目录 title+excerpt。
  const sourceMap = new Map(snapshot.sources.map((item) => [item.id, item]));
  const materials = figure.source_refs.flatMap((ref) => {
    const fragment = communications.find((item) => item.id === ref);
    if (fragment) return [`[${ref}] ${fragment.summary}\n${fragment.transcript}`.trim()];
    const source = sourceMap.get(ref);
    return source ? [`[${ref}] ${source.title}\n${source.excerpt}`] : [];
  });
  if (figure.kind === 'milestone') {
    if (!milestones.length) return null; // 无派生里程碑事实可画，直接放弃该图
    materials.unshift(`[milestones] 服务端派生的合作里程碑清单（时间轴节点的唯一事实来源，日期与标签逐项对应）：\n${milestones.map((item) => `- ${item.date} ${item.label}`).join('\n')}`);
  }
  if (!materials.length) return null; // 规划引用的来源已不可解析（如降级摘要后），直接放弃该图
  const prompt = buildCaseFigurePrompt({
    customerName: input.customer.name,
    sectionLabel,
    kind: figure.kind,
    idea: figure.idea,
    chapterAnchor: chapterText,
    materials,
  });
  // 4 次尝试 + 退避封顶 120s：中继坏窗口为分钟级，3 次/45s 封顶会被同一窗口连续击穿（真实验收两连败教训）。
  const MAX_ATTEMPTS = 4;
  const retryDelayMs = (attempt: number) => Math.min(120_000, caseModelRetryDelays.baseMs * 3 ** (attempt - 1));
  let lastError = '配图生成未返回可解析 JSON';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await completeModelWithProgress(runtime, {
      systemPrompt: CASE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    }, onProgress ? (tick) => onProgress(modelProgressText(tick)) : undefined, { maxTokens: FIGURE_MAX_TOKENS, timeoutMs: caseModelTimeoutMs(prompt) });
    if (response.stopReason === 'error') {
      lastError = `配图模型调用失败（第 ${attempt}/${MAX_ATTEMPTS} 次）: ${response.errorMessage || '未知错误'}`;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      continue;
    }
    const value = cleanJson(extractText(response.content));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const rawSvg = typeof record.svg === 'string' ? record.svg.trim() : '';
      const caption = typeof record.caption === 'string' ? record.caption.trim().slice(0, 60) : '';
      const svg = sanitizeCaseSvg(rawSvg);
      if (svg && caption && !CASE_INTERNAL_EVIDENCE_PATTERNS.some(({ pattern }) => pattern.test(caption))) {
        return { id: `figure:${hash(`${figure.kind}:${figure.source_refs.join(',')}`).slice(0, 24)}`, section: figure.section,
          kind: figure.kind, svg, caption, source_refs: figure.source_refs, note: figure.idea };
      }
      lastError = `配图 SVG 消毒或图注校验未通过（第 ${attempt}/${MAX_ATTEMPTS} 次）`;
    } else {
      lastError = `配图未返回可解析 JSON（第 ${attempt}/${MAX_ATTEMPTS} 次，stopReason=${response.stopReason}）`;
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
  }
  onProgress?.(`${lastError}，丢弃该配图（不影响正文）`);
  return null;
}

/**
 * 组装：plan 骨架 + 各章产出 → 完整 ParsedCaseContent，再走 parseCaseContent(requirePublic) 全套公开契约校验。
 * claim_evidence 的 claim 直接取章节正文（小节/条目/段落逐字），excerpt/source_refs 来自规划骨架——
 * 服务端对位组装使「claim 与正文逐字一致」天然成立，模型不再被要求复写正文（输出 token 减半的根因）。
 */
function assembleCase(plan: CasePlan, chapters: Map<CaseChapterKey, ChapterOutput>): ParsedCaseContent {
  const claimEvidence: CaseClaimEvidence[] = [];
  const itemsOf = (section: CaseChapterKey) => plan.plan.find((entry) => entry.section === section)!.items;
  /** 按索引配对再过滤空文本（过滤会错位索引，必须先配对）。 */
  const pushClaims = (section: CaseChapterKey, pairs: Array<{ item: PlanItem; text: string }>) => {
    for (const { item, text } of pairs) {
      if (!text) continue;
      claimEvidence.push({
        section,
        claim: text,
        source_refs: item.source_refs,
        excerpt: item.excerpt,
        speaker_role: item.speaker_role as CaseSpeakerRole | undefined,
        status_category: item.status_category,
        confidence: item.confidence,
      });
    }
  };
  const pair = (items: PlanItem[], texts: string[]) => texts.map((text, index) => ({ item: items[index], text }));
  const intro = chapters.get('intro')!;
  pushClaims('intro', pair(itemsOf('intro'), intro.texts));
  pushClaims('status', pair(itemsOf('status'), chapters.get('status')!.texts));
  pushClaims('demands', pair(itemsOf('demands'), chapters.get('demands')!.texts));
  const solutionOutput = chapters.get('solution')!;
  pushClaims('solution', pair(itemsOf('solution'), solutionOutput.texts));
  const valueItems = itemsOf('value');
  const valueOutput = chapters.get('value')!;
  pushClaims('value', pair(valueItems.filter((item) => item.slot !== 'lesson'), valueOutput.texts));
  pushClaims('value', pair(valueItems.filter((item) => item.slot === 'lesson'), valueOutput.lessons ?? []));
  pushClaims('summary', pair(itemsOf('summary'), chapters.get('summary')!.texts));
  return {
    title: plan.title,
    company_info: intro.texts[0] ?? '',
    business_scope: intro.texts[1] ?? '',
    competitive_strategy: intro.texts[2] ?? '',
    project_background: intro.texts[3] ?? '',
    business_status: chapters.get('status')!.texts,
    demands: chapters.get('demands')!.texts,
    solution_sections: solutionOutput.texts.map((text, index) => ({ title: solutionOutput.sectionTitles?.[index] ?? '', text })),
    value_items: valueOutput.texts,
    lessons: valueOutput.lessons ?? [],
    summary: chapters.get('summary')!.texts[0] ?? '',
    claim_evidence: claimEvidence,
    unknowns: plan.unknowns ?? [],
  };
}

/** 章节定稿文本的锚点形态（前序章节注入用）：带小节/条目结构，保持与最终渲染同口径。 */
function chapterAnchorText(section: CaseChapterKey, output: ChapterOutput): string {
  if (section === 'intro') {
    const labels = ['公司信息', '核心业务范围', '竞争优势与发展战略', '项目背景'];
    return output.texts.map((text, index) => text ? `【${labels[index]}】${text}` : '').filter(Boolean).join('\n');
  }
  if (section === 'solution') {
    return output.texts.map((text, index) => `【${output.sectionTitles?.[index] || '方案举措'}】${text}`).join('\n');
  }
  if (section === 'value') {
    return [...output.texts.map((text) => `【价值成效】${text}`), ...(output.lessons ?? []).map((text) => `【经验复盘】${text}`)].join('\n');
  }
  return output.texts.join('\n');
}

/** value_map（痛点-方案-价值全景图）的合并锚点：触发于价值章登记时，前序波次均已定稿——
 * 痛点取业务现状/业务诉求两章，价值取本章；方案区由服务端嵌入映射图、模型不画，不再注入方案正文（省 token）。 */
function valueMapAnchorText(chapters: Map<CaseChapterKey, ChapterOutput>): string {
  const demands = (chapters.get('demands')?.texts ?? []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    `【痛点素材·业务现状】\n${(chapters.get('status')?.texts ?? []).join('\n')}`,
    `【痛点素材·业务诉求】\n${demands}`,
    `【价值正文·方案价值概述】\n${chapterAnchorText('value', chapters.get('value')!)}`,
  ].join('\n');
}

/** 章节波次（提速并行，锚点语义不变）：简介先行 → 现状+诉求并行（互不依赖，素材在规划期已分流）→
 * 方案（锚点=前两波）→ 价值 → 总结。波内并行、波间串行，前序章节锚点与串行版完全一致。 */
const CHAPTER_WAVES: ReadonlyArray<readonly CaseChapterKey[]> = [['intro'], ['status', 'demands'], ['solution'], ['value'], ['summary']];
/** 模型调用全局并发上限（章节+配图共享）：中继对同 key 的长流并发存在 ~2 的隐性上限——
 * 第 3 路并发重流会零字节停顿直至 180s 超时（真实验收三连败均为「第 3 路流」）。章节优先于配图取槽。 */
const MODEL_CALL_CONCURRENCY = 2;

/** 全局模型调用槽位（章节优先的两级等待队列）：acquire 时有空槽直接占用，否则按优先级排队；
 * 释放时槽位直接转移给队首等待者（不经过空闲态，避免插队超发）。 */
function createModelSlotLimiter() {
  let active = 0;
  const chapterWaiters: Array<() => void> = [];
  const figureWaiters: Array<() => void> = [];
  const release = () => {
    const next = chapterWaiters.shift() ?? figureWaiters.shift();
    if (next) next(); // 槽位转移给等待者
    else active -= 1;
  };
  const acquire = (kind: 'chapter' | 'figure'): Promise<() => void> => {
    if (active < MODEL_CALL_CONCURRENCY) {
      active += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      (kind === 'chapter' ? chapterWaiters : figureWaiters).push(() => resolve(release));
    });
  };
  return { acquire };
}

/** 生成阶段耗时标注（进度列/CLI 可见，阶段瓶颈一眼可辨）。 */
function elapsedStamp(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return `[${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s]`;
}

/**
 * 案例生成主编排（v8 分章节流水线，v8.1 并行化提速）：
 * 1. 输入预算决策（超预算才降级/摘要，正常路径完整原文——分级与摘要兜底逻辑不变）；
 * 2. 规划章节骨架（plan，一次小 JSON 调用，注入全量上下文）；
 * 3. 章节按波次并行撰写（波间串行保前序锚点；章节注入瘦身形态——只带写作素材不带规划脚手架）；
 * 4. 配图流水线：某章定稿立即开画（限并发），与后续波次重叠，波次全部结束后统一收图；
 * 5. 服务端派生系统使用情况表与服务里程碑（LLM 不写，防虚构）；
 * 6. 服务端组装 + 全套公开契约校验（含摘录逐字校验）。
 * 返回 inputSummary 供 process 落 fields.input_summary（降级/摘要轨迹）。
 */
async function proposeCaseWithModel(runtime: Runtime, input: CasePromptInput, snapshot: CaseContextSnapshot,
  onProgress?: (text: string) => void): Promise<{ content: ParsedCaseContent; figures: CaseFigure[]; inputSummary: Record<string, unknown> | null; systemUsage: { rows: CaseSystemUsageRow[]; missing: string[] }; milestones: CaseMilestone[] }> {
  const startedAt = Date.now();
  const stamped = onProgress ? (text: string) => onProgress(`${elapsedStamp(startedAt)} ${text}`) : undefined;
  const communications = caseCommunicationSources(input);
  const { contextText, chapterContextText, inputSummary } = await prepareCaseInput(runtime, input, snapshot, stamped);
  // 服务端派生数据（确定性，LLM 不写）：系统使用情况表 + 服务里程碑。
  const stats = caseDeliveryStats(input);
  const systemUsage = caseSystemUsageRows(input.customer, stats);
  const milestones = caseMilestoneEvents(input);
  stamped?.('规划章节结构…');
  const plan = await planCaseWithModel(runtime, input, snapshot, contextText, communications, stamped);
  const chapters = new Map<CaseChapterKey, ChapterOutput>();
  const priorChapters: Array<{ label: string; text: string }> = [];
  // 配图流水线：图与图独立（v7 设计），章节定稿即开画、限并发 2，与后续章节波次重叠；
  // 失败只丢弃该图（generateFigureWithModel 永不抛错），不阻断正文。
  const figureTasks: Array<Promise<CaseFigure | null>> = [];
  // 全局槽位限流（章节优先）：图任务章定稿即入队，但只有拿到槽位才真正发起调用——
  // 任何时刻在飞的重流（章+图合计）不超过 MODEL_CALL_CONCURRENCY。
  const slots = createModelSlotLimiter();
  /** 按 `section:kind` 登记配图任务，供 value_map 拼装时等待并取用解决方案映射图的最终 SVG。 */
  const figureTasksByKey = new Map<string, Promise<CaseFigure | null>>();
  const startFigure = (figure: PlanFigure, chapterOutput: ChapterOutput) => {
    stamped?.(`配图（${CASE_FIGURE_KIND_BRIEFS[figure.kind].split('：')[0]}）绘制中…`);
    const task = (async (): Promise<CaseFigure | null> => {
      const release = await slots.acquire('figure');
      let generated: CaseFigure | null;
      try {
        // value_map 锚点=痛点+价值合并（方案区由服务端嵌入映射图、模型不画）；其余图只锚定本章定稿正文。
        const anchor = figure.kind === 'value_map'
          ? valueMapAnchorText(chapters)
          : chapterAnchorText(figure.section as CaseChapterKey, chapterOutput);
        generated = await generateFigureWithModel(runtime, input, snapshot, figure, communications, anchor, milestones, stamped);
      } finally {
        release();
      }
      // 一指禅方案区拼装：先释放并发槽、再等解决方案映射图完成（并发=2，占着槽等会互相卡死），
      // 把已生成的 capability_map 以嵌套 <svg> 嵌入模型留空的左下区域；拼装失败退回未拼装版不阻断。
      if (generated && figure.kind === 'value_map') {
        const solutionFigure = await (figureTasksByKey.get('solution:capability_map') ?? Promise.resolve(null));
        const composed = composeValueMapSvg(generated.svg, solutionFigure);
        if (composed) return { ...generated, svg: composed };
        stamped?.('一指禅方案区拼装未通过消毒，保留未拼装版本');
      }
      return generated;
    })();
    figureTasksByKey.set(`${figure.section}:${figure.kind}`, task);
    figureTasks.push(task);
  };
  for (const [waveIndex, wave] of CHAPTER_WAVES.entries()) {
    const waveLabels = wave.map((key) => CASE_SECTIONS.find((item) => item.key === key)!.label).join('、');
    if (wave.length > 1) stamped?.(`第 ${waveIndex + 1}/${CHAPTER_WAVES.length} 波（${waveLabels}）并行撰写中…`);
    // 波内并行、allSettled 后首个失败即抛（与串行版失败语义一致）；成功结果按波内顺序登记锚点。
    const settled = await Promise.allSettled(wave.map(async (key) => {
      const definition = CASE_SECTIONS.find((item) => item.key === key)!;
      stamped?.(`撰写「${definition.label}」中…`);
      const release = await slots.acquire('chapter');
      try {
        const output = await generateChapterWithModel(runtime, input, snapshot, plan, key, chapterContextText, priorChapters, stamped);
        return { key, label: definition.label, output };
      } finally {
        release();
      }
    }));
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    for (const result of settled) {
      const { key, label, output } = (result as PromiseFulfilledResult<{ key: CaseChapterKey; label: string; output: ChapterOutput }>).value;
      chapters.set(key, output);
      // 各章定稿文本作为后续章节的一致性锚点（不重复、口径一致）。
      priorChapters.push({ label, text: chapterAnchorText(key, output) });
      for (const figure of plan.figures ?? []) {
        if (figure.section === key) startFigure(figure, output);
      }
    }
  }
  const figures = (await Promise.all(figureTasks)).filter((figure): figure is CaseFigure => !!figure);
  const content = assembleCase(plan, chapters);
  parseCaseContent(content as unknown as Record<string, unknown>, {
    requirePublic: true,
    allowedRefs: new Set(snapshot.sources.map((item) => item.id)),
    sources: snapshot.sources,
    communications,
  });
  return { content, figures, inputSummary, systemUsage, milestones };
}

/** 素材覆盖度：关键素材被 claim_evidence 实际引用的比例（诊断生成是否浪费素材，非正确性判定）。
 * v6：ONES 明细已剔除输入，交付记录池取消——覆盖度衡量价值/痛点信号与权威公开资料。 */
export interface CaseCoverage {
  valueSignals: { total: number; cited: number };
  painSignals: { total: number; cited: number };
  authoritativeWeb: { total: number; cited: number };
  /** 规划兜底召回规模（审核参考，不参与补写触发）：被正文引用、但不在预扫描价值/痛点信号集内的片段数。 */
  fallbackCited: number;
}

/** 补写触发阈值（从严）：单一素材池引用率过低且样本足够多才补写；单边聚焦是正常写作不算浪费。 */
const COVERAGE_VALUE_MIN = 4;
const COVERAGE_VALUE_RATIO = 1 / 4;

export function caseCoverage(content: { claim_evidence: Array<{ source_refs: string[] }> }, input: CasePromptInput): CaseCoverage {
  const cited = new Set(content.claim_evidence.flatMap((item) => item.source_refs));
  const signals = caseFragmentSignals(input.hemory, input.customer.csmName);
  const authoritativeWeb = (input.webContext?.results ?? []).filter((item) => item.sourceTier === 'customer_official' || item.sourceTier === 'government_procurement' || item.sourceTier === 'official').map((item) => item.id);
  const count = (ids: string[]) => ({ total: ids.length, cited: ids.filter((id) => cited.has(id)).length });
  // 兜底召回计数：分母/触发逻辑不动（并入分母只会抬高引用率、反而抑制补写），只给 CSM 一眼可见的审核数字。
  const fragmentIds = new Set(input.hemory.map((event) => event.id));
  const signalIds = new Set([...signals.values, ...signals.painPoints].map((item) => item.fragment_id));
  const fallbackCited = [...cited].filter((id) => fragmentIds.has(id) && !signalIds.has(id)).length;
  return { valueSignals: count(signals.values.map((item) => item.fragment_id)),
    painSignals: count(signals.painPoints.map((item) => item.fragment_id)), authoritativeWeb: count(authoritativeWeb), fallbackCited };
}

/** 覆盖率是否低到值得追加一次「补充完善」调用（从严阈值：只在主要素材池大量闲置时触发）。 */
export function coverageNeedsEnrichment(coverage: CaseCoverage): boolean {
  return coverage.valueSignals.total > COVERAGE_VALUE_MIN
    && coverage.valueSignals.cited < coverage.valueSignals.total * COVERAGE_VALUE_RATIO;
}

/** 覆盖率的一行人类可读描述（进度列/CLI 共用）。 */
export function coverageSummary(coverage: CaseCoverage): string {
  return `素材覆盖率：价值信号 ${coverage.valueSignals.cited}/${coverage.valueSignals.total}`
    + `，痛点信号 ${coverage.painSignals.cited}/${coverage.painSignals.total}`
    + `，权威公开资料 ${coverage.authoritativeWeb.cited}/${coverage.authoritativeWeb.total}`
    + (coverage.fallbackCited ? `，兜底引用片段 ${coverage.fallbackCited}` : '');
}

/** 未被引用的关键素材清单（补写 prompt 注入；只列主要池，避免清单本身过长）。 */
function uncoveredMaterialList(content: { claim_evidence: Array<{ source_refs: string[] }> }, input: CasePromptInput, snapshot: CaseContextSnapshot): string[] {
  const cited = new Set(content.claim_evidence.flatMap((item) => item.source_refs));
  const sourceMap = new Map(snapshot.sources.map((item) => [item.id, item]));
  const signals = caseFragmentSignals(input.hemory, input.customer.csmName);
  const items: string[] = [];
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
 * 追加一次「补充完善」生成（章节级）：把未引用素材清单反馈给模型重写对应章节。
 * 同样过全套公开契约校验；失败保留第一稿（返回 null 由调用方降级），不因补写失败判任务失败。
 */
async function enrichCaseWithModel(runtime: Runtime, input: CasePromptInput, snapshot: CaseContextSnapshot, first: ParsedCaseContent,
  uncovered: string[], contextText: string, onProgress?: (text: string) => void): Promise<ParsedCaseContent | null> {
  const communications = caseCommunicationSources(input);
  const basePrompt = `为客户「${input.customer.name}」补充完善客户成功案例草稿。第一稿已通过契约校验，但以下关键素材未被引用，说明案例内容还不够充实。\n`
    + `未引用素材清单（全部真实存在，source_ref 可直接引用）：\n${uncovered.slice(0, 40).join('\n')}\n`
    + `要求：\n`
    + `- 在第一稿基础上充实内容：优先把上述素材中有价值的内容并入对应章节（会议中的交付讨论进 solution 小节、客户正面反馈进 value_items），并为其新增 claim_evidence（claim 与正文逐字一致、摘录取素材原文）。\n`
    + `- 已合格且与素材无关的章节内容保持第一稿原文，不为了引用而引用、不堆砌清单；确实无价值的素材允许继续不引用。\n`
    + `- 输出完整的 v8 六章 JSON（与第一稿相同的 schema：company_info/business_scope/competitive_strategy/project_background/business_status/demands/solution_sections/value_items/lessons/summary + claim_evidence/unknowns），不是增量补丁。\n`
    + `- 第一稿正文：\n${JSON.stringify({ title: first.title, company_info: first.company_info, business_scope: first.business_scope, competitive_strategy: first.competitive_strategy, project_background: first.project_background, business_status: first.business_status, demands: first.demands, solution_sections: first.solution_sections, value_items: first.value_items, lessons: first.lessons, summary: first.summary })}\n`
    + `上下文：${contextText}`;
  const MAX_ATTEMPTS = 2;
  const retryDelayMs = (attempt: number) => caseModelRetryDelays.baseMs * 3 ** (attempt - 1);
  let lastError = '补充完善未返回可解析的案例 JSON';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await completeModelWithProgress(runtime, {
      systemPrompt: CASE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: basePrompt, timestamp: Date.now() }],
      tools: [],
    }, onProgress ? (tick) => onProgress(modelProgressText(tick)) : undefined, { maxTokens: PLAN_MAX_TOKENS, timeoutMs: caseModelTimeoutMs(basePrompt) });
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

/** 残留检测核心（标题 + 全部可见正文文本，v8 含派生表/里程碑标签），caseContentWarnings 与写回护栏共用。 */
function caseTextsContentWarnings(title: string, fields: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  if (!isV8CaseDraft(fields)) {
    // 存量旧稿：v7 五段口径。
    const texts = caseSectionTexts(fields);
    const legacyByKey: Record<keyof CaseNarrativeFields, string[]> = {
      background: [texts.background],
      challenges: texts.challenges,
      requirements: texts.requirements,
      solution: [texts.solution],
      value: texts.value,
    };
    for (const { pattern, label } of CASE_INTERNAL_EVIDENCE_PATTERNS) {
      const hits = [
        ...(pattern.test(title) ? ['案例标题'] : []),
        ...CASE_LEGACY_SECTIONS
          .filter((section) => (legacyByKey[section.key] ?? []).some((text) => pattern.test(text)))
          .map((section) => section.label),
      ];
      if (hits.length) warnings.push(`客户版正文检出内部信息「${label}」（${hits.join('、')}），请确认已转换为面向客户的表达后再发布`);
    }
    return warnings;
  }
  const v8 = caseV8NarrativeOf(fields);
  const blocks: Array<{ label: string; texts: string[] }> = [
    { label: '客户及背景介绍', texts: [v8.company_info, v8.business_scope, v8.competitive_strategy, v8.project_background].filter(Boolean) },
    { label: '业务现状', texts: v8.business_status },
    { label: '业务诉求', texts: v8.demands },
    { label: '业务解决方案', texts: v8.solution_sections.flatMap((section) => section.title ? [section.title, section.text] : [section.text]) },
    { label: '方案价值概述', texts: [...v8.value_items, ...v8.lessons] },
    { label: '项目总结', texts: v8.summary ? [v8.summary] : [] },
    { label: '系统使用情况表', texts: caseSystemUsageOf(fields).map((row) => `${row.item} ${row.content}`) },
    { label: '服务里程碑', texts: caseMilestonesOf(fields).map((milestone) => `${milestone.date} ${milestone.label}`) },
  ];
  for (const { pattern, label } of CASE_INTERNAL_EVIDENCE_PATTERNS) {
    const hits = [
      ...(pattern.test(title) ? ['案例标题'] : []),
      ...blocks.filter((block) => block.texts.some((text) => pattern.test(text))).map((block) => block.label),
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
  const warnings: string[] = [];
  if (!isV8CaseDraft(fields)) {
    const texts = caseSectionTexts(fields);
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
      if (text.length > CASE_SECTION_MAX_CHARS) warnings.push(`「${label}」超过 ${CASE_SECTION_MAX_CHARS} 字，请确认适合对外展示`);
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
  const v8 = caseV8NarrativeOf(fields);
  const itemGuards: Array<{ label: string; items: string[] }> = [
    { label: '业务现状', items: v8.business_status },
    { label: '业务诉求', items: v8.demands },
    { label: '价值成效', items: v8.value_items },
    { label: '经验复盘', items: v8.lessons },
  ];
  for (const guard of itemGuards) {
    if (guard.items.length > CASE_LIST_ITEM_LIMIT) warnings.push(`「${guard.label}」条目数 ${guard.items.length} 超过 ${CASE_LIST_ITEM_LIMIT} 条，请确认不是编辑异常`);
    const overlong = guard.items.filter((item) => item.length > CASE_ITEM_MAX_CHARS).length;
    if (overlong) warnings.push(`「${guard.label}」有 ${overlong} 条超过 ${CASE_ITEM_MAX_CHARS} 字，请确认适合对外展示`);
  }
  const longTextGuards: Array<{ label: string; text: string; limit: number }> = [
    { label: '公司信息', text: v8.company_info, limit: CASE_ITEM_MAX_CHARS },
    { label: '核心业务范围', text: v8.business_scope, limit: CASE_ITEM_MAX_CHARS },
    { label: '竞争优势与发展战略', text: v8.competitive_strategy, limit: CASE_ITEM_MAX_CHARS },
    { label: '项目背景', text: v8.project_background, limit: CASE_ITEM_MAX_CHARS },
    { label: '项目总结', text: v8.summary, limit: CASE_ITEM_MAX_CHARS },
  ];
  for (const guard of longTextGuards) {
    if (guard.text.length > guard.limit) warnings.push(`「${guard.label}」超过 ${guard.limit} 字，请确认适合对外展示`);
  }
  const overlongSections = v8.solution_sections.filter((section) => section.text.length > CASE_SECTION_MAX_CHARS).length;
  if (overlongSections) warnings.push(`「业务解决方案」有 ${overlongSections} 个小节超过 ${CASE_SECTION_MAX_CHARS} 字，请确认适合对外展示`);
  const pseudoGuards: Array<{ label: string; items: string[] }> = [
    { label: '公司信息', items: [v8.company_info, v8.business_scope, v8.competitive_strategy, v8.project_background] },
    { label: '业务现状', items: v8.business_status },
    { label: '业务诉求', items: v8.demands },
    { label: '业务解决方案', items: v8.solution_sections.flatMap((section) => section.title ? [section.title, section.text] : [section.text]) },
    { label: '方案价值概述', items: [...v8.value_items, ...v8.lessons] },
    { label: '项目总结', items: v8.summary ? [v8.summary] : [] },
  ];
  for (const guard of pseudoGuards) {
    if (guard.items.some((item) => item && /待确认|待补充|\bunknown\b/i.test(item))) warnings.push(`「${guard.label}」包含待确认/待补充占位词，请改为有证据的表述或移入待确认清单`);
  }
  warnings.push(...caseTextsContentWarnings('', fields));
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
  const snapshot = contextSnapshotOf(draft);
  const claims = claimEvidenceOf(draft);
  const now = options.now ?? new Date();
  const internalContextStale = !!snapshot && !!options.currentInternalDigest && snapshot.internal_digest !== options.currentInternalDigest;
  const web = draft.fields?.web_search as CaseWebSearchContext | undefined;
  const webSearchedAt = web?.searchedAt ? Date.parse(web.searchedAt) : Number.NaN;
  const webStale = !!web && (!Number.isFinite(webSearchedAt) || now.getTime() - webSearchedAt > CASE_WEB_FRESH_DAYS * 86_400_000);
  const contextStale = internalContextStale || webStale;
  const isV8 = isV8CaseDraft(draft.fields);
  // 各章可见主张（v8 六章键 / 存量旧稿五段键）——逐条与 claim_evidence 对位复核。
  const visibleClaims: Array<{ section: CaseSectionKey; text: string }> = isV8
    ? (() => {
      const v8 = caseV8NarrativeOf(draft.fields);
      return [
        { section: 'intro', text: v8.company_info },
        ...(v8.business_scope ? [{ section: 'intro' as const, text: v8.business_scope }] : []),
        ...(v8.competitive_strategy ? [{ section: 'intro' as const, text: v8.competitive_strategy }] : []),
        { section: 'intro', text: v8.project_background },
        ...v8.business_status.map((text) => ({ section: 'status' as const, text })),
        ...v8.demands.map((text) => ({ section: 'demands' as const, text })),
        ...v8.solution_sections.map((item) => ({ section: 'solution' as const, text: item.text })),
        ...v8.value_items.map((text) => ({ section: 'value' as const, text })),
        ...v8.lessons.map((text) => ({ section: 'value' as const, text })),
        { section: 'summary', text: v8.summary },
      ];
    })()
    : (() => {
      const texts = caseSectionTexts(draft.fields);
      return [
        { section: 'background' as const, text: texts.background },
        ...texts.challenges.map((text) => ({ section: 'challenges' as const, text })),
        ...texts.requirements.map((text) => ({ section: 'requirements' as const, text })),
        { section: 'solution' as const, text: texts.solution },
        ...texts.value.map((text) => ({ section: 'value' as const, text })),
      ];
    })();
  const sectionLabel = (key: CaseSectionKey) => CASE_SECTIONS.find((section) => section.key === key)?.label
    ?? CASE_LEGACY_SECTIONS.find((section) => section.key === key)?.label ?? String(key);
  if (isV8) {
    const v8 = caseV8NarrativeOf(draft.fields);
    const required: Array<{ label: string; empty: boolean }> = [
      { label: '客户及背景介绍·公司信息', empty: !v8.company_info },
      { label: '客户及背景介绍·项目背景', empty: !v8.project_background },
      { label: '业务现状', empty: !v8.business_status.length },
      { label: '业务诉求', empty: !v8.demands.length },
      { label: '业务解决方案', empty: !v8.solution_sections.length },
      { label: '方案价值概述·价值成效', empty: !v8.value_items.length },
      { label: '项目总结', empty: !v8.summary },
    ];
    for (const item of required) if (item.empty) warnings.push(`客户版正文「${item.label}」为空，请补充后再发布`);
  } else {
    const texts = caseSectionTexts(draft.fields);
    for (const section of CASE_LEGACY_SECTIONS) {
      const value = texts[section.key];
      if (typeof value === 'string' ? !value : value.length === 0) warnings.push(`客户版正文「${section.label}」为空，请补充后再发布`);
    }
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
  const filtered = visibleClaims.filter((item) => !!item.text);
  const solutionTimes = claims.filter((claim) => claim.section === 'solution')
    .flatMap((claim) => claim.source_refs.map((ref) => sourceMap.get(ref)?.occurred_at).filter((value): value is string => !!value))
    .map(Date.parse).filter(Number.isFinite);
  // 客户声音章节（v8：业务现状/业务诉求/价值；旧稿：痛点/需求/价值）说话人与来源规则。
  const customerVoiceSections = isV8 ? ['status', 'demands', 'value'] : ['challenges', 'requirements', 'value'];
  for (const item of filtered) {
    const mapping = claims.find((claim) => claim.section === item.section && claim.claim === item.text);
    if (!mapping) { warnings.push(`「${item.text.slice(0, 36)}」缺少逐条证据映射`); continue; }
    const sources = mapping.source_refs.map((ref) => sourceMap.get(ref)).filter((source): source is CaseEvidenceSnapshotItem => !!source);
    if (sources.length !== mapping.source_refs.length) warnings.push(`「${item.text.slice(0, 36)}」引用了不存在的证据`);
    const supportingSources = mapping.excerpt ? sources.filter((source) => sourceSupportsExcerpt(source, mapping.excerpt!)) : [];
    if (!mapping.excerpt) warnings.push(`「${item.text.slice(0, 36)}」缺少证据原文摘录`);
    else if (!supportingSources.length) warnings.push(`「${item.text.slice(0, 36)}」的证据摘录无法在来源快照中定位`);
    const excerptRoles = supportingSources.flatMap((source) => sourceExcerptRoles(source, mapping.excerpt!));
    if (customerVoiceSections.includes(item.section)
      && supportingSources.some((source) => source.source_system === 'hemory') && !excerptRoles.includes('customer')) {
      warnings.push(`「${item.text.slice(0, 36)}」引用的会议表述不是明确客户说话人`);
    }
    if (customerVoiceSections.includes(item.section)
      && supportingSources.some((source) => source.source_type === 'crm_followup') && mapping.speaker_role !== 'customer') {
      warnings.push(`「${item.text.slice(0, 36)}」仅引用了 CSM 记录的 CRM 跟进，缺少明确客户说话人或正式来源`);
    }
    // （v6 起 ONES 明细不进快照，「引用未完成 ONES 记录」分支随之移除；stats 披露口径警告保留。）
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
  // 其他客户名扫描范围含派生表与里程碑标签（v8）。
  const derivedTexts = isV8
    ? [...caseSystemUsageOf(draft.fields).map((row) => row.content), ...caseMilestonesOf(draft.fields).map((milestone) => milestone.label)]
    : [];
  for (const name of options.otherCustomerNames ?? []) {
    if (name && name.length >= 3 && (draft.title.includes(name) || filtered.some((item) => item.text.includes(name)) || derivedTexts.some((text) => text.includes(name)))) warnings.push(`正文疑似包含其他客户名称「${name}」`);
  }
  // 正文引用了服务端交付统计（stats:delivery）时提示 CSM 确认对外披露口径（数字本身是事实，披露与否需人拍板）。
  if (claims.some((claim) => claim.source_refs.includes(CASE_STATS_SOURCE_ID))) {
    warnings.push('正文引用了服务端预计算的交付统计数字，请确认客户允许对外披露该口径');
  }
  // 配图复核（非阻断）：图注、来源存在性、图文一致性（图来源被正文引用过）、图内数字有据。
  const figures = caseFiguresOf(draft.fields);
  if (figures.length) {
    const citedRefs = new Set(claims.flatMap((claim) => claim.source_refs));
    for (const figure of figures) {
      if (!figure.caption) warnings.push(`配图（${figure.kind}）缺少图注，请补充后再发布`);
      const missingFigureRefs = figure.source_refs.filter((ref) => !sourceMap.has(ref));
      if (missingFigureRefs.length) warnings.push(`配图「${figure.caption.slice(0, 20) || figure.kind}」引用了不存在的证据: ${missingFigureRefs.join('、')}`);
      else if (!figure.source_refs.some((ref) => citedRefs.has(ref))) {
        warnings.push(`配图「${figure.caption.slice(0, 20)}」的来源未被任何正文主张引用，请确认图文一致`);
      }
      const evidenceTexts = figure.source_refs.map((ref) => sourceMap.get(ref)).filter((source): source is CaseEvidenceSnapshotItem => !!source)
        .map((source) => `${source.title} ${source.excerpt}`).join(' ');
      const figureText = [...figure.svg.matchAll(/>([^<>]+)</g)].map((match) => decodeXmlEntities(match[1])).join(' ');
      for (const number of figureText.match(/\d+(?:\.\d+)?%?/g) ?? []) {
        if (!evidenceTexts.includes(number)) warnings.push(`配图「${figure.caption.slice(0, 20)}」中的数字「${number}」未在引用证据原文中找到`);
      }
    }
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

  /** 任务是否在本进程处理中：running 状态跨进程不可信（服务重启遗留的孤儿永不终结），stalled 装饰与 heretry 同源。 */
  isJobProcessing(jobId: string): boolean {
    return this.processing.has(jobId);
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
      report_(`上下文与信号就绪（${timeline.length} 条事件 / ${hemory.length} 个片段${webContext ? ` / ${webContext.results.length} 条公开信息` : ''}），规划章节…`);
      const snapshot = buildContextSnapshot(promptInput);
      let content: ParsedCaseContent;
      let figures: CaseFigure[] = [];
      let inputSummary: Record<string, unknown> | null = null;
      let systemUsage: { rows: CaseSystemUsageRow[]; missing: string[] } = { rows: [], missing: [] };
      let milestones: CaseMilestone[] = [];
      try {
        const proposed = await proposeCaseWithModel(this.runtime, promptInput, snapshot, report_);
        content = proposed.content;
        figures = proposed.figures;
        inputSummary = proposed.inputSummary;
        systemUsage = proposed.systemUsage;
        milestones = proposed.milestones;
      } catch (error) { throw new Error(`模型未生成案例: ${(error as Error).message}`); }
      // 素材覆盖度诊断 + 从严阈值自动补写：主要素材池（已交付记录/客户正面反馈）大量闲置时
      // 追加一次「补充完善」调用；补写失败保留第一稿，不因补写失败判任务失败。
      // v5：补写沿用生成阶段的同一份 contextText（含降级/摘要后的素材）。
      const coverage = caseCoverage(content, promptInput);
      let enriched = false;
      if (coverageNeedsEnrichment(coverage)) {
        const uncovered = uncoveredMaterialList(content, promptInput, snapshot);
        if (uncovered.length) {
          report_(`${coverageSummary(coverage)}——关键素材闲置较多，自动补充完善中…`);
          const contextText = inputSummary?.contextText as string | undefined ?? renderInputText(promptInput, snapshot, INPUT_DEGRADATION_BUDGETS[0]);
          const refined = await enrichCaseWithModel(this.runtime, promptInput, snapshot, content, uncovered, contextText, report_);
          if (refined) { content = refined; enriched = true; }
        }
      }
      const finalCoverage = enriched ? caseCoverage(content, promptInput) : coverage;
      const generator = `${this.runtime.llm.provider}/${this.runtime.llm.model}`;
      const evidenceRefs = [...new Set(content.claim_evidence.flatMap((item) => item.source_refs))];
      const fields: Record<string, unknown> = {
        customer_id: customer.id, customer_name: customer.name,
        company_info: content.company_info, business_scope: content.business_scope,
        competitive_strategy: content.competitive_strategy, project_background: content.project_background,
        business_status: content.business_status, demands: content.demands,
        solution_sections: content.solution_sections, value_items: content.value_items,
        lessons: content.lessons, summary: content.summary,
        claim_evidence: content.claim_evidence,
        context_snapshot: snapshot,
        coverage: { ...finalCoverage, enriched },
      };
      if (inputSummary) fields.input_summary = inputSummary;
      // 派生数据（v8）：系统使用情况表只含有值行；建议补充行（账号数/有效期/使用部门）进 unknowns。
      fields.system_usage = systemUsage.rows;
      const unknowns = [...(content.unknowns ?? []), ...systemUsage.missing.map((item) => `系统使用情况表缺「${item}」，建议向客户成功经理或合同记录确认后在工作台补充`)];
      if (unknowns.length) fields.unknowns = [...new Set(unknowns)];
      if (milestones.length) fields.milestones = milestones;
      // 配图：消毒产物落库；补写（enrichment）只重写各章正文，figures 保持第一稿。
      if (figures.length) fields.figures = figures;
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

  /** 各章正文编辑只合并公开字段（v8 含派生表/里程碑；存量旧稿仍走五段键）；生成时的证据、客户绑定和联网快照不可被 PATCH 覆写。 */
  update(draftId: string, version: number, title: string | undefined, input: Record<string, unknown>): CaseDraft | null {
    const draft = this.db.getCaseDraft(draftId);
    if (!draft || draft.status !== 'draft') return null;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
    let fields: Record<string, unknown>;
    if (isV8CaseDraft(draft.fields)) {
      const current = caseV8NarrativeOf(draft.fields);
      const incoming = caseV8NarrativeOf(input);
      const usage = has('system_usage') ? caseSystemUsageOf(input) : caseSystemUsageOf(draft.fields);
      const milestones = has('milestones') ? caseMilestonesOf(input) : caseMilestonesOf(draft.fields);
      fields = { ...draft.fields,
        company_info: has('company_info') ? incoming.company_info : current.company_info,
        business_scope: has('business_scope') ? incoming.business_scope : current.business_scope,
        competitive_strategy: has('competitive_strategy') ? incoming.competitive_strategy : current.competitive_strategy,
        project_background: has('project_background') ? incoming.project_background : current.project_background,
        business_status: has('business_status') ? incoming.business_status : current.business_status,
        demands: has('demands') ? incoming.demands : current.demands,
        solution_sections: has('solution_sections') ? incoming.solution_sections : current.solution_sections,
        value_items: has('value_items') ? incoming.value_items : current.value_items,
        lessons: has('lessons') ? incoming.lessons : current.lessons,
        summary: has('summary') ? incoming.summary : current.summary,
        system_usage: usage, milestones };
    } else {
      const current = caseSectionTexts(draft.fields);
      const incoming = caseSectionTexts(input);
      fields = { ...draft.fields,
        background: has('background') ? incoming.background : current.background,
        challenges: has('challenges') ? incoming.challenges : current.challenges,
        requirements: has('requirements') ? incoming.requirements : current.requirements,
        solution: has('solution') ? incoming.solution : current.solution,
        value: has('value') ? incoming.value : current.value };
    }
    return this.db.updateCaseDraft(draftId, version, title === undefined ? draft.title : title, fields);
  }

  /** 导出 Word 文档（读操作，v8/legacy 双口径）：二进制附件由 server/CLI 消费，动作记审计。 */
  async exportDocx(draftId: string): Promise<{ buffer: Buffer; filename: string; draft: CaseDraft } | undefined> {
    const draft = this.db.getCaseDraft(draftId);
    if (!draft) return undefined;
    const customer = this.db.getCustomer(draft.customerId);
    const buffer = await renderCaseDocx(draft);
    this.db.audit('agent', 'export_case_docx', 'case_draft', draft.id, { version: draft.version, status: draft.status });
    return { buffer, filename: caseDocxFilename(draft, customer?.name), draft };
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
