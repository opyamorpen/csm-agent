import { randomUUID } from 'node:crypto';
import type { WorkbenchDatabase } from './database.js';
import { parseOccurredAt } from './database.js';
import { summarizeWebSignals } from './risk.js';
import type { AlertTriggerKey, CustomerAlert, EvidenceInput, SourceEvent, WorkhourRecord } from './types.js';

export const ALERT_RULE_VERSION = 'csm-alert-v1';

/** 触发①回看窗口：近 N 天 CRM 跟进与 ONES 工作项/工时活动同时停滞才预警（用户拍板 AND 口径）。 */
export const ALERT_INACTIVITY_DAYS = 30;

/** 互动停滞事实：CRM 侧（跟进事件 + 档案「最后联系」兜底）与 ONES 侧（field009/field010 naive 上海时间）各取最晚标记。 */
export interface EngagementFacts {
  lastFollowupAt: string | null;
  lastWorkItemActivityAt: string | null;
  lastWorkhourAt: string | null;
  lastOnesActivityAt: string | null;
  /** 两侧最晚标记：重报抑制的比对基准（任一渠道出现过新活动即前移）。 */
  lastEngagementAt: string | null;
  dataAsOf: string | null;
}

/** 触发②事实：回看窗口内负向公开动态证据。 */
export interface NegativeSignalFacts {
  negativeEvidenceIds: string[];
  negativeCount: number;
}

export interface AlertEvaluation {
  customerId: string;
  created: AlertTriggerKey[];
  refreshed: AlertTriggerKey[];
  autoResolved: AlertTriggerKey[];
  /** 条件仍成立但被已消除记录抑制（情况无新变化，不重报）。 */
  suppressed: AlertTriggerKey[];
}

/** 预警判定入口：由 recompute 在每次风险重算后调用；对两个触发键独立执行状态机。 */
export function evaluateCustomerAlerts(db: WorkbenchDatabase, customerId: string, now = new Date()): AlertEvaluation {
  const result: AlertEvaluation = { customerId, created: [], refreshed: [], autoResolved: [], suppressed: [] };

  const inactivity = evaluateEngagementInactivity(db, customerId, now);
  applyTrigger(db, customerId, 'engagement_inactivity', inactivity.conditionMet, {
    build: () => inactivity,
    // 已确认基准 = 历次已消除行中 lastEngagementAt 的最大值（任一渠道前移过即视为新周期）。
    refire: (resolved) => {
      const before = resolved.reduce((latest, item) => {
        const value = String(item.details.lastEngagementAt ?? '');
        return value > latest ? value : latest;
      }, '');
      return inactivity.details.lastEngagementAt! > before;
    },
    autoResolveNote: () => '预警条件自动解除：检测到新的 CRM 跟进或 ONES 活动',
  }, result);

  const negative = evaluateNegativeSignals(db, customerId, now);
  applyTrigger(db, customerId, 'negative_public_signal', negative.conditionMet, {
    build: () => negative,
    // 已确认基准 = 历次已消除行 negativeEvidenceIds 的并集：仅当出现从未确认过的新证据 ID 才重报。
    refire: (resolved) => {
      const seen = new Set<string>();
      for (const item of resolved) {
        if (Array.isArray(item.details.negativeEvidenceIds)) {
          for (const id of item.details.negativeEvidenceIds as unknown[]) seen.add(String(id));
        }
      }
      return negative.details.negativeEvidenceIds.some((id) => !seen.has(id));
    },
    autoResolveNote: () => '预警条件自动解除：回看窗口内已无负面公开动态',
  }, result);

  return result;
}

interface TriggerPlan {
  build: () => { reasons: string[]; details: Record<string, unknown> };
  refire: (resolved: CustomerAlert[]) => boolean;
  autoResolveNote: () => string;
}

/** 单个触发键的状态机：条件成立→建/刷 active；条件消失→自动解除；消除后仅在新变化时重报。 */
function applyTrigger(
  db: WorkbenchDatabase,
  customerId: string,
  triggerKey: AlertTriggerKey,
  conditionMet: boolean,
  plan: TriggerPlan,
  result: AlertEvaluation,
): void {
  const active = db.activeAlert(customerId, triggerKey);
  if (conditionMet) {
    const facts = plan.build();
    if (active) {
      if (JSON.stringify(active.reasons) !== JSON.stringify(facts.reasons)
        || JSON.stringify(active.details) !== JSON.stringify(facts.details)) {
        db.updateAlert(active.id, facts.reasons, facts.details);
        result.refreshed.push(triggerKey);
      }
      return;
    }
    const resolved = db.listResolvedAlerts(customerId, triggerKey);
    if (resolved.length && !plan.refire(resolved)) {
      result.suppressed.push(triggerKey);
      return;
    }
    const created = db.saveAlert({ id: randomUUID(), customerId, triggerKey, reasons: facts.reasons, details: facts.details });
    db.audit('system', 'alert.create', 'customer_alert', created.id, { triggerKey });
    result.created.push(triggerKey);
    return;
  }
  if (active) {
    const note = plan.autoResolveNote();
    db.resolveAlert(active.id, 'system', note);
    db.audit('system', 'alert.auto_resolve', 'customer_alert', active.id, { triggerKey, note });
    result.autoResolved.push(triggerKey);
  }
}

/**
 * 触发①（互动停滞）：近 30 天无 CRM 跟进记录 且 无 ONES 工作项新增/更新与新增工时——
 * 两侧都沉默才预警，任一渠道有活动即不触发（用户拍板 AND 口径）。
 * CRM 侧标记 = max(跟进事件 occurred_at, 档案「最后联系」last_contact_at)：跟进同步只拉全局
 * 最近 200 条、无法按客户过滤，档案「最后联系」是逐客户权威值，取最大防高频期误报。
 * 两侧都零历史（从未跟进也未用过 ONES）不预警；单侧零历史不算豁免——「双方都沉默」本就成立。
 */
export function evaluateEngagementInactivity(db: WorkbenchDatabase, customerId: string, now: Date): {
  conditionMet: boolean;
  reasons: string[];
  details: Record<string, unknown> & EngagementFacts;
} {
  const facts = collectEngagementFacts(db, customerId);
  if (!facts.lastEngagementAt) {
    return { conditionMet: false, reasons: [], details: { ...facts } };
  }
  const cutoff = now.getTime() - ALERT_INACTIVITY_DAYS * 86_400_000;
  const lastFollowup = facts.lastFollowupAt ? parseOccurredAt(facts.lastFollowupAt) ?? 0 : 0;
  const lastOnes = facts.lastOnesActivityAt ? parseOccurredAt(facts.lastOnesActivityAt) ?? 0 : 0;
  const conditionMet = lastFollowup < cutoff && lastOnes < cutoff;
  if (!conditionMet) {
    return { conditionMet: false, reasons: [], details: { ...facts } };
  }
  const followup = facts.lastFollowupAt ? shanghaiDate(facts.lastFollowupAt) : '无记录';
  const item = facts.lastWorkItemActivityAt ? shanghaiDate(facts.lastWorkItemActivityAt) : '无记录';
  const hour = facts.lastWorkhourAt ? shanghaiDate(facts.lastWorkhourAt) : '无记录';
  const reasons = [
    `近 ${ALERT_INACTIVITY_DAYS} 天无 CRM 跟进记录，且无 ONES 工作项新增/更新与新增工时（最后跟进 ${followup}，最后工作项活动 ${item}，最后工时登记 ${hour}）`,
  ];
  if (facts.dataAsOf) reasons.push(`数据截至 ${shanghaiDateTime(facts.dataAsOf)}`);
  return { conditionMet: true, reasons, details: { ...facts } };
}

function collectEngagementFacts(db: WorkbenchDatabase, customerId: string): EngagementFacts {
  let lastFollowup: number | null = null;
  let dataAsOf: string | null = null;
  const touchFollowup = (value: unknown): void => {
    if (value == null) return;
    const at = parseOccurredAt(String(value));
    if (at != null && (lastFollowup == null || at > lastFollowup)) lastFollowup = at;
  };
  for (const event of db.listCrmFollowupEvents(customerId)) {
    if (dataAsOf == null || event.syncedAt > dataAsOf) dataAsOf = event.syncedAt;
    touchFollowup(event.occurredAt);
  }
  // 档案「最后联系」（field_ekp9X__c）兜底本地跟进窗口覆盖不到的近期联系。
  const customer = db.getCustomer(customerId);
  touchFollowup(customer?.lastContactAt ?? null);
  if (customer?.syncedAt && (dataAsOf == null || customer.syncedAt > dataAsOf)) dataAsOf = customer.syncedAt;

  const ones = collectOnesActivity(db.listOnesSourceEvents(customerId));
  if (ones.dataAsOf && (dataAsOf == null || ones.dataAsOf > dataAsOf)) dataAsOf = ones.dataAsOf;
  const lastOnesMs = ones.lastOnesActivityAt ? parseOccurredAt(ones.lastOnesActivityAt) ?? 0 : 0;
  const lastEngagementAt = Math.max(lastFollowup ?? 0, lastOnesMs) || null;
  return {
    lastFollowupAt: lastFollowup == null ? null : new Date(lastFollowup).toISOString(),
    lastWorkItemActivityAt: ones.lastWorkItemActivityAt,
    lastWorkhourAt: ones.lastWorkhourAt,
    lastOnesActivityAt: ones.lastOnesActivityAt,
    lastEngagementAt: lastEngagementAt == null ? null : new Date(lastEngagementAt).toISOString(),
    dataAsOf,
  };
}

function collectOnesActivity(rows: SourceEvent[]): Pick<EngagementFacts, 'lastWorkItemActivityAt' | 'lastWorkhourAt' | 'lastOnesActivityAt' | 'dataAsOf'> {
  let lastItem: number | null = null;
  let lastHour: number | null = null;
  let dataAsOf: string | null = null;
  const touch = (value: unknown): void => {
    if (value == null) return;
    const at = parseOccurredAt(String(value));
    if (at != null && (lastItem == null || at > lastItem)) lastItem = at;
  };
  for (const event of rows) {
    if (dataAsOf == null || event.syncedAt > dataAsOf) dataAsOf = event.syncedAt;
    touch(event.payload?.field009);
    touch(event.payload?.field010);
    const records = Array.isArray(event.payload?.workhourRecords) ? (event.payload!.workhourRecords as WorkhourRecord[]) : [];
    for (const record of records) {
      const at = parseOccurredAt(String(record.startTime ?? ''));
      if (at != null && (lastHour == null || at > lastHour)) lastHour = at;
    }
  }
  const lastOnesActivityAt = Math.max(lastItem ?? 0, lastHour ?? 0) || null;
  return {
    lastWorkItemActivityAt: lastItem == null ? null : new Date(lastItem).toISOString(),
    lastWorkhourAt: lastHour == null ? null : new Date(lastHour).toISOString(),
    lastOnesActivityAt: lastOnesActivityAt == null ? null : new Date(lastOnesActivityAt).toISOString(),
    dataAsOf,
  };
}

/** 触发②：回看窗口内存在负向公开动态（关键词/category 双口径，与风险 web 维度同源）。 */
export function evaluateNegativeSignals(db: WorkbenchDatabase, customerId: string, now: Date): {
  conditionMet: boolean;
  reasons: string[];
  details: Record<string, unknown> & NegativeSignalFacts;
} {
  const web = summarizeWebSignals(db.listEvidence(customerId), now);
  const negative = web.negative.filter((item) => item.id);
  const ids = negative.map((item) => item.id!);
  if (negative.length === 0) {
    return { conditionMet: false, reasons: [], details: { negativeEvidenceIds: [], negativeCount: 0 } };
  }
  const shown = negative.slice(0, 5).map((item) => negativeReason(item));
  if (negative.length > shown.length) shown.push(`……等共 ${negative.length} 条负面信息`);
  return { conditionMet: true, reasons: shown, details: { negativeEvidenceIds: ids, negativeCount: negative.length } };
}

function negativeReason(item: EvidenceInput): string {
  const date = item.occurredAt?.slice(0, 10) ?? '';
  const url = item.sourceUrl ? `，${item.sourceUrl}` : '';
  return `公开负面：${item.label}（${date}${url}）`;
}

function shanghaiDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function shanghaiDateTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
