import { randomUUID } from 'node:crypto';
import type { Customer, EvidenceInput, RiskAssessment } from './types.js';

// v2：互动维度的最后互动时间由 CRM 原始字段改为客户全量业务事件的最晚时间（database.lastInteractionAt）。
export const RISK_RULE_VERSION = 'csm-risk-v2';

function daysUntil(date: string, now: Date): number | null {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  return Math.ceil((value.getTime() - now.getTime()) / 86_400_000);
}

function daysSince(date: string, now: Date): number | null {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  return Math.floor((now.getTime() - value.getTime()) / 86_400_000);
}

export function assessRisk(customer: Customer, evidence: EvidenceInput[] = [], now = new Date()): RiskAssessment {
  const dimensions: RiskAssessment['dimensions'] = {};
  const unknowns: string[] = [];
  const evidenceRefs = evidence.filter((item) => item.kind === 'risk' || item.kind === 'voice').map((item) => item.id!).filter(Boolean);

  const renewalDays = customer.renewalDate ? daysUntil(customer.renewalDate, now) : null;
  if (renewalDays === null) {
    dimensions.renewal = { score: 0, weight: 25, known: false, reason: '缺少有效续约日期' };
    unknowns.push('续约日期');
  } else {
    const score = renewalDays <= 30 ? 25 : renewalDays <= 60 ? 20 : renewalDays <= 120 ? 12 : 0;
    dimensions.renewal = { score, weight: 25, known: true, reason: renewalDays < 0 ? `已到期 ${Math.abs(renewalDays)} 天` : `距续约 ${renewalDays} 天` };
  }

  if (customer.contractStatus == null && customer.explicitNonrenewal == null) {
    dimensions.contract = { score: 0, weight: 20, known: false, reason: '缺少合同状态' };
    unknowns.push('合同状态');
  } else {
    const status = `${customer.contractStatus ?? ''}`;
    const explicit = customer.explicitNonrenewal === true || /不续约|流失|终止|取消/.test(status);
    const score = explicit ? 20 : /待确认|到期|暂停/.test(status) ? 12 : 0;
    dimensions.contract = { score, weight: 20, known: true, reason: explicit ? '存在明确不续约或流失信号' : status || '无异常合同信号' };
  }

  const inactiveDays = customer.lastContactAt ? daysSince(customer.lastContactAt, now) : null;
  if (inactiveDays === null) {
    dimensions.engagement = { score: 0, weight: 20, known: false, reason: '缺少最后互动时间' };
    unknowns.push('最后互动时间');
  } else {
    const score = inactiveDays > 60 ? 20 : inactiveDays > 30 ? 12 : inactiveDays > 14 ? 6 : 0;
    dimensions.engagement = { score, weight: 20, known: true, reason: `${inactiveDays} 天未记录客户互动` };
  }

  if (customer.supportOpenCount == null && customer.supportBlockedCount == null) {
    dimensions.delivery = { score: 0, weight: 25, known: false, reason: '缺少工单与交付统计' };
    unknowns.push('工单与交付统计');
  } else {
    const blocked = customer.supportBlockedCount ?? 0;
    const open = customer.supportOpenCount ?? 0;
    const score = blocked > 0 ? 25 : open >= 5 ? 15 : open >= 2 ? 8 : 0;
    dimensions.delivery = { score, weight: 25, known: true, reason: `未完成 ${open}，阻塞 ${blocked}` };
  }

  const voiceEvidence = evidence.filter((item) => item.kind === 'voice' || item.kind === 'risk');
  if (customer.voiceRisk == null && voiceEvidence.length === 0) {
    dimensions.voice = { score: 0, weight: 10, known: false, reason: '缺少客户声音证据' };
    unknowns.push('客户声音');
  } else {
    const hasRisk = customer.voiceRisk === true || voiceEvidence.some((item) => /不满|不续约|替换|投诉|预算取消|阻塞/.test(`${item.label} ${item.detail}`));
    dimensions.voice = { score: hasRisk ? 10 : 0, weight: 10, known: true, reason: hasRisk ? '沟通中出现风险信号' : '未发现明确负向客户声音' };
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
  const value = daysUntil(customer.renewalDate, now);
  return value !== null && value >= 0 && value <= days;
}
