import { randomUUID } from 'node:crypto';
import type { Customer, EvidenceInput, RiskAssessment, RiskStats } from './types.js';

// v3：评分维度 = 需求完成 / 工单解决 / 互动 / 客户声音 / 公开动态。
// v2 的「续约临近度」「合同状态」退出计分（续约日期、合同额仍展示）；明确不续约/流失保留为硬覆盖高风险。
// 完成率按 ONES field005.category==='done' 判定（绝不拿状态名猜）；公开动态按近 90 天 web_signal 证据判定。
// v4：公开动态正负向以落库 sentiment（web-intel-v2 起 LLM 判定入库）为权威；缺失时才走关键词 + sentiment 角度兜底
//（org/executive 退出兜底——人事任命/组织新闻多为中性，曾把「连获荣誉」「获聘」整类误判为负向）。
export const RISK_RULE_VERSION = 'csm-risk-v4';

/** 公开动态证据回看窗口（天）。 */
export const WEB_SIGNAL_WINDOW_DAYS = 90;

/** 公开动态负向关键词（命中 label/detail 任一即计负向；category 兜底另算）。收入/罚款类由预警需求补充。 */
export const WEB_NEGATIVE_PATTERN = /裁员|处罚|罚款|诉讼|投诉|违规|亏损|收入下降|营收下降|收入下滑|营收下滑|业绩下滑|退市|减持|高管离职|组织调整|破产|被执行|失信|欠薪|降薪|仲裁|立案|谴责/;
/** 公开动态正向关键词（用于增购机会侧，与负向互斥：先判负向）。 */
export const WEB_POSITIVE_PATTERN = /融资|中标|签约|扩张|发布|招聘|增长|上市|战略合作|收购|增资|订单|扩产|新品/;

/** 公开动态情感判定（web-intel-v2 起落库进 detail 前缀，站在该公司视角：利空/中性/利好）。 */
export type WebSignalSentiment = 'negative' | 'neutral' | 'positive';

const WEB_SIGNAL_SENTIMENTS = new Set<string>(['negative', 'neutral', 'positive']);

/** record_web_intelligence / 同步落库同款 detail 前缀：`[category] 详情` 或 `[category|sentiment] 详情`。 */
export function webSignalDetailPrefix(category: string, sentiment: WebSignalSentiment | null, detail: string): string {
  const tag = sentiment ? `[${category}|${sentiment}]` : `[${category}]`;
  const text = detail.trim();
  return text ? `${tag} ${text}` : tag;
}

/** 解析 detail 前缀的 category 与 sentiment；旧格式 `[category]`（及无前缀行）的 sentiment 为 null。 */
export function webSignalDetailTags(detail: string): { category: string | null; sentiment: WebSignalSentiment | null } {
  const match = /^\[([a-z_]+)(?:\|([a-z_]+))?\]/.exec(detail);
  if (!match) return { category: null, sentiment: null };
  const sentiment = match[2] && WEB_SIGNAL_SENTIMENTS.has(match[2]) ? match[2] as WebSignalSentiment : null;
  return { category: match[1] ?? null, sentiment };
}

export interface WebSignalSummary {
  /** 窗口内 web_signal 证据总数。 */
  total: number;
  negative: EvidenceInput[];
  positive: EvidenceInput[];
}

/** 近 N 天 web_signal 证据归类：负向/正向。sentiment（web-intel-v2 起入库）为权威口径；缺失时关键词优先、sentiment 角度兜底。 */
export function summarizeWebSignals(evidence: EvidenceInput[], now: Date, days = WEB_SIGNAL_WINDOW_DAYS): WebSignalSummary {
  const cutoff = now.getTime() - days * 86_400_000;
  const inWindow: EvidenceInput[] = [];
  for (const item of evidence) {
    if (item.kind !== 'web_signal') continue;
    const at = new Date(item.occurredAt).getTime();
    if (Number.isNaN(at) || at < cutoff) continue;
    inWindow.push(item);
  }
  const negative: EvidenceInput[] = [];
  const positive: EvidenceInput[] = [];
  for (const item of inWindow) {
    const text = `${item.label} ${item.detail}`;
    const { category, sentiment } = webSignalDetailTags(item.detail);
    // 情感判定入库（csm-risk-v4）：LLM 落库 sentiment 是权威——negative 直接计负；
    // positive/neutral 一律不计负（覆盖「买方破产…纳入承保范围」这类关键词/角度误伤）。
    if (sentiment) {
      if (sentiment === 'negative') negative.push(item);
      else if (sentiment === 'positive') positive.push(item);
      continue;
    }
    // 存量行/未判定 sentiment 的兜底：关键词优先，category 仅「负面舆情」角度计负（org/executive 不再兜底），
    // 融资/合同/招聘角度视为扩张信号。
    if (WEB_NEGATIVE_PATTERN.test(text) || category === 'sentiment') negative.push(item);
    else if (WEB_POSITIVE_PATTERN.test(text) || (category && ['financing', 'contract', 'hiring'].includes(category))) positive.push(item);
  }
  return { total: inWindow.length, negative, positive };
}

function daysSince(date: string, now: Date): number | null {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  return Math.floor((now.getTime() - value.getTime()) / 86_400_000);
}

/** 需求完成 / 工单解决共用分档：达到健康线 0 分、健康线与警戒线之间半分（约权重一半）、警戒线以下满分。 */
function rateDimension(
  stat: RiskStats['suggestionRate'],
  weight: number,
  healthyPct: number,
  warningPct: number,
  label: string,
  unknownName: string,
  unknowns: string[],
): RiskAssessment['dimensions'][string] {
  if (!stat || stat.total === 0) {
    unknowns.push(unknownName);
    return { score: 0, weight, known: false, reason: '暂无相关记录' };
  }
  if (stat.stale) {
    unknowns.push(unknownName);
    return { score: 0, weight, known: false, reason: '状态类型缺失，「刷新三套系统」后出数' };
  }
  const score = stat.pct >= healthyPct ? 0 : stat.pct >= warningPct ? Math.round(weight / 2) : weight;
  return { score, weight, known: true, reason: `${label} ${stat.pct}%（已完成 ${stat.done}/${stat.total}）` };
}

export function assessRisk(customer: Customer, evidence: EvidenceInput[] = [], now = new Date(), stats: RiskStats = {}): RiskAssessment {
  const dimensions: RiskAssessment['dimensions'] = {};
  const unknowns: string[] = [];
  const web = summarizeWebSignals(evidence, now);
  const evidenceRefs = evidence
    .filter((item) => item.kind === 'risk' || item.kind === 'voice')
    .map((item) => item.id!)
    .filter(Boolean)
    .concat(web.negative.map((item) => item.id!).filter(Boolean));

  // 需求完成率（建议与反馈）：≥30% 健康，15%~29% 半分，<15% 满分。
  dimensions.suggestion = rateDimension(stats.suggestionRate, 25, 30, 15, '需求完成率', '需求完成率', unknowns);
  // 工单解决率（工单，不含运维工单）：≥90% 健康，75%~89% 半分，<75% 满分。
  dimensions.ticket = rateDimension(stats.ticketRate, 25, 90, 75, '工单解决率', '工单解决率', unknowns);

  const inactiveDays = customer.lastContactAt ? daysSince(customer.lastContactAt, now) : null;
  if (inactiveDays === null) {
    dimensions.engagement = { score: 0, weight: 20, known: false, reason: '缺少最后互动时间' };
    unknowns.push('最后互动时间');
  } else {
    const score = inactiveDays > 60 ? 20 : inactiveDays > 30 ? 12 : inactiveDays > 14 ? 6 : 0;
    dimensions.engagement = { score, weight: 20, known: true, reason: `${inactiveDays} 天未记录客户互动` };
  }

  const voiceEvidence = evidence.filter((item) => item.kind === 'voice' || item.kind === 'risk');
  if (customer.voiceRisk == null && voiceEvidence.length === 0) {
    dimensions.voice = { score: 0, weight: 10, known: false, reason: '缺少客户声音证据' };
    unknowns.push('客户声音');
  } else {
    const hasRisk = customer.voiceRisk === true || voiceEvidence.some((item) => /不满|不续约|替换|投诉|预算取消|阻塞/.test(`${item.label} ${item.detail}`));
    dimensions.voice = { score: hasRisk ? 10 : 0, weight: 10, known: true, reason: hasRisk ? '沟通中出现风险信号' : '未发现明确负向客户声音' };
  }

  if (web.total === 0) {
    dimensions.web = { score: 0, weight: 20, known: false, reason: '暂无公开动态记录（联网检索后出数）' };
    unknowns.push('公开动态');
  } else {
    const score = web.negative.length >= 2 ? 20 : web.negative.length === 1 ? 10 : 0;
    dimensions.web = { score, weight: 20, known: true, reason: `近${WEB_SIGNAL_WINDOW_DAYS}天公开动态 ${web.total} 条，负向 ${web.negative.length} 条` };
  }

  const knownWeight = Object.values(dimensions).filter((item) => item.known).reduce((sum, item) => sum + item.weight, 0);
  const rawScore = Object.values(dimensions).reduce((sum, item) => sum + item.score, 0);
  const coverage = knownWeight;
  const explicitOverride = customer.explicitNonrenewal === true || /不续约|流失|终止/.test(customer.contractStatus ?? '');
  const normalized = knownWeight ? Math.round((rawScore / knownWeight) * 100) : null;
  const level = explicitOverride ? 'high' : coverage < 60 ? 'unknown' : normalized! >= 70 ? 'high' : normalized! >= 40 ? 'medium' : 'low';

  return {
    id: randomUUID(),
    customerId: customer.id,
    score: normalized,
    level,
    coverage,
    dimensions,
    evidenceRefs,
    unknowns,
    ruleVersion: RISK_RULE_VERSION,
    generatedAt: now.toISOString(),
  };
}

export function renewalWithin(customer: Customer, days: number, now = new Date()): boolean {
  if (!customer.renewalDate) return false;
  const value = new Date(customer.renewalDate).getTime();
  return !Number.isNaN(value) && value - now.getTime() >= 0 && value - now.getTime() <= days * 86_400_000;
}

