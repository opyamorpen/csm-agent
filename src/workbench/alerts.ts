import { randomUUID } from 'node:crypto';
import type { WorkbenchDatabase } from './database.js';
import { parseOccurredAt } from './database.js';
import { summarizeWebSignals } from './risk.js';
import type { AlertTriggerKey, CustomerAlert, EvidenceInput, SourceEvent, WorkhourRecord } from './types.js';

export const ALERT_RULE_VERSION = 'csm-alert-v1';

/** 触发①回看窗口：近 N 天无 ONES 工作项新增/更新且无新增工时。 */
export const ONES_INACTIVITY_DAYS = 30;

/** ONES 活动事实：field009/field010 为 naive 上海时间，须经 parseOccurredAt 解析。 */
export interface OnesActivityFacts {
  lastWorkItemActivityAt: string | null;
  lastWorkhourAt: string | null;
  lastOnesActivityAt: string | null;
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

  const inactivity = evaluateOnesInactivity(db, customerId, now);
  applyTrigger(db, customerId, 'ones_inactivity', inactivity.conditionMet, {
    build: () => inactivity,
    refire: (resolved) => {
      const before = String(resolved.details.lastOnesActivityAt ?? '');
      return inactivity.details.lastOnesActivityAt! > before;
    },
    autoResolveNote: () => '预警条件自动解除：检测到新的 ONES 工作项活动或工时登记',
  }, result);

  const negative = evaluateNegativeSignals(db, customerId, now);
  applyTrigger(db, customerId, 'negative_public_signal', negative.conditionMet, {
    build: () => negative,
    refire: (resolved) => {
      const seen = Array.isArray(resolved.details.negativeEvidenceIds)
        ? (resolved.details.negativeEvidenceIds as unknown[]).map(String)
        : [];
      return negative.details.negativeEvidenceIds.some((id) => !seen.includes(id));
    },
    autoResolveNote: () => '预警条件自动解除：回看窗口内已无负面公开动态',
  }, result);

  return result;
}

interface TriggerPlan {
  build: () => { reasons: string[]; details: Record<string, unknown> };
  refire: (resolved: CustomerAlert) => boolean;
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
    const resolved = db.latestResolvedAlert(customerId, triggerKey);
    if (resolved && !plan.refire(resolved)) {
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

/** 触发①：近 30 天无 ONES 工作项新增/更新且无新增工时。零历史记录客户不出预警（无法区分「没用 ONES」）。 */
export function evaluateOnesInactivity(db: WorkbenchDatabase, customerId: string, now: Date): {
  conditionMet: boolean;
  reasons: string[];
  details: Record<string, unknown> & OnesActivityFacts;
} {
  const rows = db.listOnesSourceEvents(customerId);
  const facts = collectOnesActivity(rows);
  if (!facts.lastOnesActivityAt) {
    return { conditionMet: false, reasons: [], details: { ...facts } };
  }
  const cutoff = now.getTime() - ONES_INACTIVITY_DAYS * 86_400_000;
  const lastAt = parseOccurredAt(facts.lastOnesActivityAt) ?? 0;
  const conditionMet = lastAt < cutoff;
  if (!conditionMet) {
    return { conditionMet: false, reasons: [], details: { ...facts } };
  }
  const item = facts.lastWorkItemActivityAt ? shanghaiDate(facts.lastWorkItemActivityAt) : '无记录';
  const hour = facts.lastWorkhourAt ? shanghaiDate(facts.lastWorkhourAt) : '无记录';
  const reasons = [
    `近 ${ONES_INACTIVITY_DAYS} 天无 ONES 工作项新增/更新，且无新增工时（最后工作项活动 ${item}，最后工时登记 ${hour}）`,
  ];
  if (facts.dataAsOf) reasons.push(`ONES 数据截至 ${shanghaiDateTime(facts.dataAsOf)}`);
  return { conditionMet: true, reasons, details: { ...facts } };
}

function collectOnesActivity(rows: SourceEvent[]): OnesActivityFacts {
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
