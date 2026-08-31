import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { McpGateway } from '../agent.js';
import { WorkbenchDatabase } from './database.js';
import type { HemorySegmentationResult } from './hemory.js';
import { assessRisk, summarizeWebSignals } from './risk.js';
import { normalizeAfterSalesStage, type Customer, type SourceEvent, type SourceEventInput, type SyncRun, type WorkhourRecord } from './types.js';

const CRM_FIELDS = {
  id: '_id',
  // 客户名称是 object_reference（→ AccountObj「客户」），显示值带 __r 后缀，始终是客户全称。
  name: 'field_n1qN0__c__r',
  nameReferenceId: 'field_n1qN0__c',
  // 售后客户名称是手填文本字段，常为简称（如「华大九天」），只作次级名称。
  shortName: 'field_83f4l__c',
  industry: 'field_OL1jQ__c',
  // 使用版本（单选）：公有云版 / 私有部署按年订阅版 / 私有部署一次性授权版；ONES 实例部署类型按它判定。
  // CRM 返回的是选项 value（option1/Hox1iRI04/E4H2tH6o4），入库前规范化成 label。
  usageVersion: 'field_Q2L6p__c',
  // CSM 负责人 = 售后客户的「负责人」字段（owner，employee，显示值 owner__r/name）；
  // field_M1uu5__c 是「客户经理」，field_c2pNm__c 是「所属销售」，都不是负责人。
  csm: 'owner',
  renewalDate: 'field_lh3L2__c',
  contractValue: 'field_d0EqS__c',
  contractValueFallback: 'field_yxgZ1__c',
  products: 'field_f6iQS__c',
  lastContactAt: 'field_ekp9X__c',
  lastFollowup: 'field_Ni7Ud__c',
  lifeStatus: 'life_status',
  stage: 'field_c0avd__c__r',
  stageValue: 'field_c0avd__c',
  specialRenewalTerms: 'field_xRnas__c',
  customerNeeds: 'field_Rk0oz__c',
  updatedAt: 'last_modified_time',
  pageCursor: 'create_time',
} as const;

const CRM_SELECT_FIELDS = [
  CRM_FIELDS.id, CRM_FIELDS.name, CRM_FIELDS.nameReferenceId, CRM_FIELDS.shortName, CRM_FIELDS.industry, CRM_FIELDS.usageVersion, CRM_FIELDS.csm,
  CRM_FIELDS.renewalDate, CRM_FIELDS.contractValue, CRM_FIELDS.contractValueFallback, CRM_FIELDS.products,
  CRM_FIELDS.lastContactAt, CRM_FIELDS.lastFollowup, CRM_FIELDS.lifeStatus, CRM_FIELDS.stageValue,
  CRM_FIELDS.specialRenewalTerms, CRM_FIELDS.customerNeeds, CRM_FIELDS.updatedAt, CRM_FIELDS.pageCursor,
];
const CRM_OBJECT = 'object_Umwnn__c';
const CRM_LOST_STAGE_VALUE = '052JwwdZ4';

/** 使用版本选项 value → label（describe 实测）；未知 value 原样保留，缺失返回 null。 */
const CRM_USAGE_VERSION_LABELS: Record<string, string> = {
  option1: '公有云版',
  Hox1iRI04: '私有部署按年订阅版',
  E4H2tH6o4: '私有部署一次性授权版',
};

export function normalizeUsageVersion(value: string | null): string | null {
  const text = value?.trim();
  return text ? CRM_USAGE_VERSION_LABELS[text] ?? text : null;
}

const ONES_CUSTOMER_FIELD_ID = process.env.ONES_CUSTOMER_FIELD_ID ?? 'JrvswW8P';
const ONES_WEB_BASE_URL = (process.env.ONES_WEB_BASE_URL ?? 'https://our.ones.pro').replace(/\/$/, '');
const ONES_TEAM_ID = process.env.ONES_TEAM_ID ?? 'RDjYMhKq';

/** 自动/手动增量同步扫描的滚动窗口（上海自然日，含今天）。已入库录音靠分段指纹与 upsert 去重。 */
export const HEMORY_SYNC_WINDOW_DAYS = 7;

export const ONES_CSM_SOURCES = [
  { projectId: 'GL3ysesFPdnAQNIU', projectName: 'ONES Desk', issueTypeId: 'A99xMfkg', issueTypeName: '建议和反馈', sourceType: 'suggestion_feedback' },
  { projectId: 'GL3ysesFPdnAQNIU', projectName: 'ONES Desk', issueTypeId: '7sxvwZMY', issueTypeName: '工单', sourceType: 'support_ticket' },
  { projectId: 'GL3ysesFPdnAQNIU', projectName: 'ONES Desk', issueTypeId: '943qpMX7', issueTypeName: '运维工单', sourceType: 'operations_ticket' },
  { projectId: 'W8rxM3UE8jPHuDrh', projectName: '客户工时管理', issueTypeId: '5DMbQXvd', issueTypeName: '售后客户', sourceType: 'customer_manhour' },
  { projectId: 'GL3ysesF59l5lRH9', projectName: '私有云实例管理', issueTypeId: 'GvyPHeW5', issueTypeName: '私有云实例', sourceType: 'private_cloud_instance' },
] as const;

const ONES_SOURCE_BY_ISSUE_TYPE: Map<string, (typeof ONES_CSM_SOURCES)[number]> =
  new Map(ONES_CSM_SOURCES.map((source) => [source.issueTypeName, source]));

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // Be tolerant of diagnostic text surrounding a structured JSON line.
    for (const line of text.split('\n').reverse()) {
      try { return JSON.parse(line); } catch { /* continue */ }
    }
    return null;
  }
}

interface OnesIssuePage {
  records: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor?: string;
}

export interface OnesManhourPage {
  records: WorkhourRecord[];
  hasNextPage: boolean;
  endCursor?: string;
}

export function parseOnesIssuePage(text: string): OnesIssuePage {
  const value = parseJson(text);
  const raw = Array.isArray(value?.data) ? value.data : [];
  const records = raw
    .map((entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
      ? ((entry as Record<string, unknown>).item ?? entry)
      : null)
    .filter((entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry));
  const pageInfo = value?.page_info ?? value?.pageInfo ?? {};
  return {
    records,
    hasNextPage: pageInfo.has_next_page === true || pageInfo.hasNextPage === true,
    endCursor: asText(pageInfo.end_cursor ?? pageInfo.endCursor) ?? undefined,
  };
}

function workhourDate(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const date = new Date(number < 10_000_000_000 ? number * 1000 : number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseOnesManhourPage(text: string): OnesManhourPage {
  const value = parseJson(text);
  const data = value?.data ?? value?.result?.data ?? {};
  const raw: unknown[] = Array.isArray(data?.list) ? data.list : recordsIn(data);
  const records = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const owner = item.owner && typeof item.owner === 'object' && !Array.isArray(item.owner)
        ? item.owner as Record<string, unknown>
        : null;
      return {
        id: asText(item.id) ?? '',
        owner: owner ? { id: asText(owner.id) ?? undefined, name: asText(owner.name) ?? undefined } : null,
        startTime: workhourDate(item.startTime) ?? '',
        hours: Number(item.hours ?? 0),
        description: asText(item.description) ?? '',
      } satisfies WorkhourRecord;
    })
    .filter((item) => item.id && item.startTime);
  const pageInfo = data?.pageInfo ?? data?.page_info ?? {};
  return {
    records,
    hasNextPage: pageInfo.hasNextPage === true || pageInfo.has_next_page === true,
    endCursor: asText(pageInfo.endCursor ?? pageInfo.end_cursor) ?? undefined,
  };
}

// get_manhour_mode 的真实返回是 ONES 状态信封（{"result":"SUCCESS","data":{"mode":"summary"}} 一类），
// 顶层 result 是状态码而非模式值；历史版本只读顶层 result 导致模式永远识别失败。宽容兼容多种形状，
// 无法识别返回 null（FAIL 信封也返回 null，由调用方决定按业务失败还是降级处理）。
export function parseOnesManhourMode(text: string): 'simple' | 'summary' | null {
  const value = parseJson(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const candidate = (raw: unknown): 'simple' | 'summary' | null =>
    raw === 'simple' || raw === 'summary' ? raw : null;
  const direct = candidate(envelope.result) ?? candidate(envelope.mode);
  if (direct) return direct;
  const data = envelope.data;
  if (typeof data === 'string') return candidate(data);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    const inner = candidate(nested.result) ?? candidate(nested.mode) ?? candidate(nested.manhourMode) ?? candidate(nested.manhour_mode);
    if (inner) return inner;
    // 浅层扫描：模式值可能藏在任意键下（如 {data:{workhourMode:{value:'summary'}}}）。
    for (const raw of Object.values(nested)) {
      const found = candidate(unwrap(raw));
      if (found) return found;
    }
  }
  return null;
}

function recordsIn(value: any): Record<string, unknown>[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    if (value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) return value;
    return value.flatMap(recordsIn);
  }
  if (typeof value !== 'object') return [];
  for (const key of ['records', 'recordList', 'dataList', 'list', 'items']) {
    if (Array.isArray(value[key])) return value[key] as Record<string, unknown>[];
  }
  for (const key of ['data', 'recordResult', 'result']) {
    const nested = recordsIn(value[key]);
    if (nested.length) return nested;
  }
  if (value._id || value.id) return [value as Record<string, unknown>];
  return [];
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of ['value', 'label', 'name', 'text']) {
      if (object[key] != null) return unwrap(object[key]);
    }
  }
  return value;
}

function asText(value: unknown): string | null {
  const raw = unwrap(value);
  if (Array.isArray(raw)) {
    const items = raw.map(asText).filter((item): item is string => !!item);
    return items.length ? items.join('、') : null;
  }
  if (raw == null || raw === '') return null;
  return String(raw);
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter((item): item is string => !!item);
  const text = asText(value);
  return text ? text.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) : [];
}

function asNumber(value: unknown): number | null {
  const raw = unwrap(value);
  if (raw == null || raw === '') return null;
  const number = Number(raw);
  // 纷享浮点字段有时以 1e5 为精度单位返回。
  if (!Number.isFinite(number)) return null;
  return Math.abs(number) > 10_000_000 ? number / 100_000 : number;
}

function asBoolean(value: unknown): boolean | null {
  const raw = unwrap(value);
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (/^(是|true|yes|1|已流失)$/i.test(String(raw))) return true;
  if (/^(否|false|no|0|未流失)$/i.test(String(raw))) return false;
  return null;
}

function asDate(value: unknown): string | null {
  const raw = unwrap(value);
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    const ms = raw < 10_000_000_000 ? raw * 1000 : raw;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asOnesDate(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}+08:00`
    : text;
  return asDate(normalized);
}

function relatedName(record: Record<string, unknown>, field: string): string | null {
  const related = record[`${field}__r`];
  if (related && typeof related === 'object' && !Array.isArray(related)) {
    const name = asText((related as Record<string, unknown>).name);
    if (name) return name;
  }
  const list = record[`${field}__l`];
  if (Array.isArray(list)) {
    const names = list.map((item) => item && typeof item === 'object' ? asText((item as Record<string, unknown>).name) : null)
      .filter((item): item is string => !!item);
    if (names.length) return names.join('、');
  }
  return asText(record[field]);
}

export function crmFollowupEvent(record: Record<string, unknown>): SourceEventInput | null {
  const related = Array.isArray(record.related_object_data) ? record.related_object_data as Array<Record<string, unknown>> : [];
  const bound = related.find((entry) => entry?.describe_api_name === CRM_OBJECT && typeof entry.id === 'string');
  if (!bound?.id) return null;
  const content = asText(record.active_record_content) ?? '';
  const createdAt = asDate(record.create_time);
  const occurredAt = asDate(record.field_oUaZx__c) ?? createdAt ?? new Date().toISOString();
  return { customerId: String(bound.id), sourceSystem: 'crm', sourceType: 'crm_followup',
    externalId: String(record._id ?? ''), title: content.split('\n')[0]?.slice(0, 120) || 'CRM 跟进记录',
    occurredAt, payload: { recordId: record._id, content, type: record.active_record_type__r ?? null,
      channel: record.field_MIe19__c__r ?? null, relatedCustomers: related, createTime: createdAt },
    confidence: 1, attributionStatus: 'confirmed' };
}

export function crmCustomer(record: Record<string, unknown>): Parameters<WorkbenchDatabase['upsertCustomer']>[0] | null {
  const id = asText(record[CRM_FIELDS.id]) ?? asText(record.id);
  // 客户名称（引用显示值）是主名称；个别记录引用缺失时才回退到售后客户名称文本。
  const name = asText(record[CRM_FIELDS.name]) ?? asText(record[CRM_FIELDS.shortName]);
  if (!id || !name) return null;
  const lifeStatus = asText(record[`${CRM_FIELDS.lifeStatus}__r`]) ?? asText(record[CRM_FIELDS.lifeStatus]);
  const special = asText(record[CRM_FIELDS.specialRenewalTerms]);
  const stage = asText(record[CRM_FIELDS.stage]) ?? asText(record[CRM_FIELDS.stageValue]);
  return {
    id,
    name,
    sourceObject: CRM_OBJECT,
    shortName: asText(record[CRM_FIELDS.shortName]),
    industry: asText(record[CRM_FIELDS.industry]),
    usageVersion: normalizeUsageVersion(asText(record[CRM_FIELDS.usageVersion])),
    csmName: relatedName(record, CRM_FIELDS.csm),
    renewalDate: asDate(record[CRM_FIELDS.renewalDate]),
    contractValue: asNumber(record[CRM_FIELDS.contractValue] ?? record[CRM_FIELDS.contractValueFallback]),
    afterSalesStage: normalizeAfterSalesStage(stage),
    contractStatus: lifeStatus,
    products: asList(record[CRM_FIELDS.products]),
    lastContactAt: asDate(record[CRM_FIELDS.lastContactAt]),
    explicitNonrenewal: stage === '流失' || /不续约|终止|取消/.test(special ?? ''),
    nextAction: asText(record[CRM_FIELDS.lastFollowup]),
    syncedAt: new Date().toISOString(),
    source: record,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function onesqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildOnesCustomerQuery(optionIds: string[], cursor = ''): string {
  const deskTypes = ONES_CSM_SOURCES.filter((source) => source.projectName === 'ONES Desk')
    .map((source) => `'${source.issueTypeId}'`).join(', ');
  const hours = ONES_CSM_SOURCES.find((source) => source.sourceType === 'customer_manhour')!;
  const privateCloud = ONES_CSM_SOURCES.find((source) => source.sourceType === 'private_cloud_instance')!;
  // 客户可能同时有全称与简称两个客户信息选项，工作项挂在任一名下都要拉取（IN 单元素等价于 =）。
  const options = optionIds.map((id) => `'${onesqlLiteral(id)}'`).join(', ');
  // field005.category 是 grammar 未记载但实测可用的扩展：返回状态类型编码（to_do/in_progress/done），
  // 只能用于 SELECT、不能 WHERE——完成率/解决率一律按 category === 'done' 判定，不靠状态名猜。
  return `SELECT uuid, display_id, field001, field005.name, field005.category, field006.name, field007.name, ${ONES_CUSTOMER_FIELD_ID}.name, `
    + `TODATE(field009, 'YYYY-MM-DD HH:mm:ss'), TODATE(field010, 'YYYY-MM-DD HH:mm:ss'), field019, field020 `
    + `FROM issue WHERE v$cursor > '${onesqlLiteral(cursor)}' AND ${ONES_CUSTOMER_FIELD_ID} IN (${options}) AND (`
    + `(field006 = 'GL3ysesFPdnAQNIU' AND field007 IN (${deskTypes})) OR `
    + `(field006 = '${hours.projectId}' AND field007 = '${hours.issueTypeId}') OR `
    + `(field006 = '${privateCloud.projectId}' AND field007 = '${privateCloud.issueTypeId}')) `
    + 'ORDER BY field009 DESC LIMIT 1000, 50';
}

export function onesSourceType(issue: Record<string, unknown>): string | null {
  const issueType = asText(issue.field007);
  return issueType ? ONES_SOURCE_BY_ISSUE_TYPE.get(issueType)?.sourceType ?? null : null;
}

/**
 * 工作项状态类型编码（to_do/in_progress/done），来自 SELECT field005.category。
 * 旧同步数据的 field005 是纯状态名字符串、没有 category——返回 null，让调用方显式走兜底口径，
 * 绝不用状态名去猜类别。
 */
export function onesStatusCategory(item: Record<string, unknown>): string | null {
  const status = item?.field005;
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    const category = (status as Record<string, unknown>).category;
    if (typeof category === 'string' && category) return category;
  }
  return null;
}

export function onesIssueUrl(issueUuid: string, displayId?: string | null): string {
  return `${ONES_WEB_BASE_URL}/project/#/team/${ONES_TEAM_ID}/issue/${encodeURIComponent(displayId || issueUuid)}`;
}

interface TranscriptLine {
  recordingId: string;
  spokenAt: string;
  speaker: string;
  text: string;
}

function parseTranscriptPage(text: string): { lines: TranscriptLine[]; more: boolean; cursor?: string } {
  const header = text.match(/^# .*?more=(true|false)(?:\s*\|\s*cursor=([^\s]+))?/m);
  let recordingId = 'unknown';
  const lines: TranscriptLine[] = [];
  for (const line of text.split('\n')) {
    const group = line.match(/^##\s+(\S+)/);
    if (group) {
      recordingId = group[1];
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 3 || !/^\d{4}-\d{2}-\d{2}T/.test(parts[0])) continue;
    lines.push({ recordingId, spokenAt: parts[0].split(' (')[0], speaker: parts[1], text: parts.slice(2).join('\t').trim() });
  }
  return { lines, more: header?.[1] === 'true', cursor: header?.[2] };
}

export class PortfolioSyncService {
  private onesqlGrammarReady?: Promise<void>;
  private hemoryRun?: SyncRun;
  private webIntelRun = new Set<string>();

  constructor(private readonly db: WorkbenchDatabase, private readonly mcp: McpGateway,
    private readonly segmentRecording: (recording: SourceEvent) => Promise<HemorySegmentationResult>,
    /** 同步路径的公开动态检索（server 注入 WebIntelService.refresh）；缺省跳过（如测试环境）。 */
    private readonly refreshWebIntel: (customer: Customer, options: { force?: boolean }) => Promise<{ status: string; saved: number }> = async () => ({ status: 'skipped', saved: 0 }),
  ) {}

  /** 单客户公开动态检索（幂等去重：同一客户并发触发只跑一次）。失败只记状态，不抛给调用方。 */
  async runWebIntelForCustomer(customerId: string, options: { force?: boolean } = {}): Promise<{ status: string; saved: number }> {
    const customer = this.db.getCustomer(customerId);
    if (!customer) return { status: 'skipped', saved: 0 };
    if (this.webIntelRun.has(customerId)) return { status: 'skipped', saved: 0 };
    this.webIntelRun.add(customerId);
    try {
      return await this.refreshWebIntel(customer, options);
    } catch (error) {
      console.warn(`[web-intel] 客户 ${customer.name} 公开动态检索失败（不阻断同步）: ${(error as Error).message}`);
      return { status: 'failed', saved: 0 };
    } finally {
      this.webIntelRun.delete(customerId);
    }
  }

  refreshAll(): SyncRun {
    const run = this.db.createSyncRun('all');
    void this.executeAll(run);
    return run;
  }

  refreshCustomer(customerId: string): SyncRun {
    const run = this.db.createSyncRun('customer', customerId);
    void this.executeCustomer(run, customerId);
    return run;
  }

  /** 定向刷新单客户的 ONES 工作项（含客户工时管理/售后客户）：不建 SyncRun、不动 CRM/Hemory。
   * 供草稿生成路径在本地缺「售后客户」匹配时即时补数据，失败由调用方降级处理。 */
  async syncOnesForCustomer(customerId: string): Promise<number> {
    const customer = this.db.getCustomer(customerId);
    if (!customer) throw new Error('customer not found');
    const count = await this.syncOnesCustomer(customer);
    return count;
  }

  /** Read the current customer's ONES work-hour registrations for the UI/CLI. */
  async listCustomerWorkhours(customerId: string): Promise<{
    issueId: string | null;
    totalHours: number | null;
    remainingHours: number | null;
    records: WorkhourRecord[];
  }> {
    const issue = this.db.findCustomerManhourIssue(customerId);
    if (!issue) return { issueId: null, totalHours: null, remainingHours: null, records: [] };
    const payload = issue.payload ?? {};
    const totalHours = Number(payload.field019) / 100000;
    const remainingHours = Number(payload.field020) / 100000;
    const stored = Array.isArray(payload.workhourRecords) ? this.normalizeStoredWorkhours(payload.workhourRecords) : null;
    if (stored) {
      stored.sort((left, right) => Date.parse(right.startTime) - Date.parse(left.startTime) || right.id.localeCompare(left.id));
      return {
        issueId: issue.externalId,
        totalHours: Number.isFinite(totalHours) ? totalHours : null,
        remainingHours: Number.isFinite(remainingHours) ? remainingHours : null,
        records: stored,
      };
    }
    const records = await this.fetchWorkhourRecords(issue.externalId);
    records.sort((left, right) => Date.parse(right.startTime) - Date.parse(left.startTime) || right.id.localeCompare(left.id));
    return {
      issueId: issue.externalId,
      totalHours: Number.isFinite(totalHours) ? totalHours : null,
      remainingHours: Number.isFinite(remainingHours) ? remainingHours : null,
      records,
    };
  }

  private normalizeStoredWorkhours(value: unknown[]): WorkhourRecord[] {
    return value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => {
        const owner = item.owner && typeof item.owner === 'object' && !Array.isArray(item.owner)
          ? item.owner as Record<string, unknown>
          : null;
        return {
          id: asText(item.id) ?? '',
          owner: owner ? { id: asText(owner.id) ?? undefined, name: asText(owner.name) ?? undefined } : null,
          startTime: workhourDate(item.startTime) ?? '',
          hours: Number(item.hours ?? 0),
          description: asText(item.description) ?? '',
        };
      })
      .filter((item) => item.id && item.startTime);
  }

  private async fetchWorkhourRecords(issueId: string): Promise<WorkhourRecord[]> {
    const modeResult = await this.mcp.call('mcp__ones__get_manhour_mode', {});
    if (modeResult.isError) return [];
    const mode = parseOnesManhourMode(modeResult.text) ?? 'summary';
    const tool = mode === 'simple'
      ? 'mcp__ones__get_manhour_list_in_simple_mode'
      : 'mcp__ones__get_manhour_list_in_summary_mode';
    const records: WorkhourRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const args: Record<string, unknown> = { issueID: issueId };
      if (cursor) args.cursor = cursor;
      const result = await this.mcp.call(tool, args);
      if (result.isError) return records;
      const parsed = parseOnesManhourPage(result.text);
      records.push(...parsed.records);
      if (!parsed.hasNextPage || !parsed.endCursor) break;
      cursor = parsed.endCursor;
    }
    return records;
  }

  refreshPortfolioSources(): SyncRun {
    const run = this.db.createSyncRun('portfolio');
    void this.executePortfolio(run);
    return run;
  }

  refreshHemoryDate(date = shanghaiDateKey(), scheduledHour?: number): SyncRun {
    if (this.hemoryRun && this.db.getSyncRun(this.hemoryRun.id)?.status === 'running') return this.hemoryRun;
    const run = this.db.createSyncRun(`hemory:${date}${scheduledHour ? `:${scheduledHour}` : ''}`);
    this.hemoryRun = run;
    const { startedAt, endedAt } = shanghaiDayBounds(date);
    void this.executeHemory(run, startedAt, endedAt);
    return run;
  }

  /** 滚动增量同步：覆盖最近 HEMORY_SYNC_WINDOW_DAYS 个上海自然日，已入库片段靠 upsert 去重，不重复产生。 */
  refreshRecentHemory(scheduledHour?: number): SyncRun {
    if (this.hemoryRun && this.db.getSyncRun(this.hemoryRun.id)?.status === 'running') return this.hemoryRun;
    const date = shanghaiDateKey();
    const run = this.db.createSyncRun(scheduledHour ? `hemory:${date}:${scheduledHour}` : 'hemory:recent');
    this.hemoryRun = run;
    const { startedAt } = shanghaiDayBounds(date);
    const windowStart = new Date(new Date(startedAt).getTime() - (HEMORY_SYNC_WINDOW_DAYS - 1) * 86_400_000).toISOString();
    void this.executeHemory(run, windowStart, new Date().toISOString());
    return run;
  }

  /** 全量重切：遍历库内全部录音（不受滚动窗口限制），与 Hemory 互斥，逐录音成功即切换代际。 */
  resegmentAllHemory(): SyncRun {
    if (this.hemoryRun && this.db.getSyncRun(this.hemoryRun.id)?.status === 'running') return this.hemoryRun;
    const run = this.db.createSyncRun('hemory:resegment:all');
    this.hemoryRun = run;
    void this.executeHemoryResegment(run);
    return run;
  }

  private async executeHemoryResegment(run: SyncRun): Promise<void> {
    interface RecordingOutcome { recordingId: string; status: 'succeeded' | 'failed'; fragments?: number; error?: string }
    const outcomes: RecordingOutcome[] = [];
    const backupPath = join(dirname(this.db.path), `workbench-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    try {
      this.db.backupTo(backupPath);
      const recordings = this.db.listHemoryRawTranscriptRecordings();
      let proposed = 0;
      let included = 0;
      for (const recording of recordings) {
        const recordingId = String(recording.payload?.recordingId ?? recording.externalId);
        try {
          const result = await this.segmentRecording(recording);
          proposed += result.proposedCount;
          included += result.includedCount;
          outcomes.push({ recordingId, status: 'succeeded', fragments: result.includedCount });
        } catch (error) {
          outcomes.push({ recordingId, status: 'failed', error: (error as Error).message });
        }
      }
      for (const customer of this.db.listCustomers()) this.recompute(customer.id);
      const failed = outcomes.filter((outcome) => outcome.status === 'failed');
      const summary = { status: failed.length ? 'partial' : 'succeeded', count: included,
        error: failed.length ? `${failed.length}/${outcomes.length} 录音重切失败` : undefined,
        recordings: outcomes.length, failedRecordings: failed.length,
        discardedSegments: Math.max(0, proposed - included), backupPath } as Record<string, unknown>;
      this.db.finishSyncRun(run.id, failed.length ? 'partial' : 'succeeded', { hemory: summary as SyncRun['sourceStatus'][string] },
        failed.length ? failed.map((outcome) => `${outcome.recordingId}: ${outcome.error}`).join('; ') : undefined);
      this.db.audit('csm', 'resegment_hemory_all', 'sync_run', run.id,
        { recordings: outcomes.length, failed: failed.length, includedSegments: included, discardedSegments: Math.max(0, proposed - included), backupPath, failures: failed });
    } catch (error) {
      this.db.finishSyncRun(run.id, 'failed', { hemory: { status: 'failed', error: (error as Error).message } }, (error as Error).message);
    } finally {
      this.hemoryRun = undefined;
    }
  }

  private async executeAll(run: SyncRun): Promise<void> {
    const statuses: SyncRun['sourceStatus'] = {};
    try {
      const crmCount = await this.syncCrmCustomers();
      statuses.crm = { status: 'succeeded', count: crmCount };
    } catch (error) {
      statuses.crm = { status: 'failed', error: (error as Error).message };
    }
    try {
      const hemoryCount = await this.syncRecentHemory();
      statuses.hemory = { status: 'succeeded', count: hemoryCount };
    } catch (error) {
      statuses.hemory = { status: 'failed', error: (error as Error).message };
    }
    try {
      await this.ensureOnesqlGrammar();
      let onesCount = 0;
      const customers = this.db.listCustomers();
      for (let offset = 0; offset < customers.length; offset += 4) {
        const counts = await Promise.all(customers.slice(offset, offset + 4).map((customer) => this.syncOnesCustomer(customer)));
        onesCount += counts.reduce((sum, count) => sum + count, 0);
      }
      statuses.ones = { status: 'succeeded', count: onesCount };
    } catch (error) {
      statuses.ones = { status: 'failed', error: (error as Error).message };
    }
    // 公开动态：每客户 7 天新鲜度门（force=false），失败只计 partial 不阻断其他源。
    try {
      let savedCount = 0;
      for (const customer of this.db.listCustomers()) {
        const result = await this.runWebIntelForCustomer(customer.id, { force: false });
        if (result.status === 'failed') throw new Error(`${customer.name}: 公开动态检索失败`);
        savedCount += result.saved;
      }
      statuses.web_intelligence = { status: 'succeeded', count: savedCount };
    } catch (error) {
      statuses.web_intelligence = { status: 'failed', error: (error as Error).message };
    }
    const failures = Object.values(statuses).filter((value) => value.status === 'failed');
    this.db.finishSyncRun(run.id, failures.length === 0 ? 'succeeded' : failures.length === Object.keys(statuses).length ? 'failed' : 'partial', statuses,
      failures.map((value) => value.error).filter(Boolean).join('; ') || undefined);
  }

  private async executePortfolio(run: SyncRun): Promise<void> {
    const statuses: SyncRun['sourceStatus'] = {};
    try { statuses.crm = { status: 'succeeded', count: await this.syncCrmCustomers() }; }
    catch (error) { statuses.crm = { status: 'failed', error: (error as Error).message }; }
    try {
      await this.ensureOnesqlGrammar();
      let count = 0;
      const customers = this.db.listCustomers();
      for (let offset = 0; offset < customers.length; offset += 4) {
        const counts = await Promise.all(customers.slice(offset, offset + 4).map((customer) => this.syncOnesCustomer(customer)));
        count += counts.reduce((sum, value) => sum + value, 0);
      }
      statuses.ones = { status: 'succeeded', count };
    } catch (error) { statuses.ones = { status: 'failed', error: (error as Error).message }; }
    const failures = Object.values(statuses).filter((value) => value.status === 'failed');
    this.db.finishSyncRun(run.id, failures.length === 0 ? 'succeeded' : failures.length === 2 ? 'failed' : 'partial', statuses,
      failures.map((value) => value.error).filter(Boolean).join('; ') || undefined);
  }

  private async executeHemory(run: SyncRun, startedAt: string, endedAt: string): Promise<void> {
    const delays = [0, 60_000, 5 * 60_000, 15 * 60_000];
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      try {
        const count = await this.scanHemory([], startedAt, endedAt);
        this.db.finishSyncRun(run.id, 'succeeded', { hemory: { status: 'succeeded', count } });
        this.hemoryRun = undefined;
        return;
      } catch (error) { lastError = error as Error; }
    }
    this.db.finishSyncRun(run.id, 'failed', { hemory: { status: 'failed', error: lastError?.message } }, lastError?.message);
    this.hemoryRun = undefined;
  }

  private async executeCustomer(run: SyncRun, customerId: string): Promise<void> {
    const customer = this.db.getCustomer(customerId);
    if (!customer) {
      this.db.finishSyncRun(run.id, 'failed', {}, 'customer not found');
      return;
    }
    const statuses: SyncRun['sourceStatus'] = {};
    // CRM 步骤可能更新客户名/主体名，ONES 解析必须读最新记录而不是刷新前的快照。
    const fresh = () => this.db.getCustomer(customerId) ?? customer;
    for (const [source, task] of [
      ['crm', () => this.syncSingleCrmCustomer(customer)],
      ['ones', () => this.syncOnesCustomer(fresh())],
      ['hemory', () => this.syncHemoryCustomer(fresh())],
    ] as const) {
      try {
        statuses[source] = { status: 'succeeded', count: await task() };
      } catch (error) {
        statuses[source] = { status: 'failed', error: (error as Error).message };
      }
    }
    // 单客户手动刷新：公开动态强制检索（忽略 7 天门），失败计 partial 不阻断其余源。
    try {
      const webIntel = await this.runWebIntelForCustomer(customerId, { force: true });
      statuses.web_intelligence = { status: webIntel.status === 'failed' ? 'failed' : 'succeeded', count: webIntel.saved };
    } catch (error) {
      statuses.web_intelligence = { status: 'failed', error: (error as Error).message };
    }
    this.recompute(customerId);
    const failures = Object.values(statuses).filter((value) => value.status === 'failed');
    this.db.finishSyncRun(run.id, failures.length === 0 ? 'succeeded' : failures.length === Object.keys(statuses).length ? 'failed' : 'partial', statuses,
      failures.map((value) => value.error).filter(Boolean).join('; ') || undefined);
  }

  private async syncCrmCustomers(): Promise<number> {
    const baseArgs = {
      apiName: 'QueryRecordsByFields',
      object_api_name: CRM_OBJECT,
      select_fields: CRM_SELECT_FIELDS,
      need_count: true,
    };
    const records = await this.fetchAllCrmRecords(baseArgs, [{ field_name: CRM_FIELDS.stageValue, field_values: [CRM_LOST_STAGE_VALUE], operator: 'ne', connector: 'AND', value_type: 0 }]);
    let count = 0;
    for (const record of records) {
      const input = crmCustomer(record);
      if (!input) continue;
      const customer = this.db.upsertCustomer(input);
      this.db.upsertIdentity(customer.id, 'crm', customer.id, customer.name);
      this.db.upsertSourceEvent({ customerId: customer.id, sourceSystem: 'crm', sourceType: 'customer_snapshot', externalId: customer.id,
        title: 'CRM 客户资料同步', occurredAt: input.source?.[CRM_FIELDS.updatedAt] ? asDate(input.source[CRM_FIELDS.updatedAt]) ?? new Date().toISOString() : new Date().toISOString(),
        payload: record, confidence: 1 });
      this.addCrmEvidence(customer, record);
      this.recompute(customer.id);
      count++;
    }
    await this.syncCrmFollowupRecords();
    return count;
  }

  // 跟进记录（销售记录 ActiveRecordObj）通过 related_object_data 关联售后客户；what_list_data 不支持服务端过滤，
  // 按创建时间倒序取最近一批后本地归属。销售记录量大且历史久远，全量分页拉取代价高且只用于回显近期跟进。
  private async syncCrmFollowupRecords(limit = 200): Promise<number> {
    const result = await this.mcp.call('mcp__crm__data_record_query-by-fields', {
      apiName: 'QueryRecordsByFields', object_api_name: 'ActiveRecordObj', need_count: false,
      select_fields: ['_id', 'active_record_content', 'active_record_type__r', 'field_MIe19__c__r', 'related_object_data', 'create_time', 'field_oUaZx__c'],
      search_template_query: { limit, filters: [], orders: [{ fieldName: 'create_time', isAsc: false }] },
    });
    if (result.isError) throw new Error(result.text);
    const parsed = parseJson(result.text);
    if (parsed?.resultCode === 'FAIL' || parsed?.data?.error) throw new Error(parsed?.data?.error ?? result.text);
    const records = recordsIn(parsed);
    let count = 0;
    for (const record of records) {
      const input = crmFollowupEvent(record);
      if (!input || !this.db.getCustomer(String(input.customerId))) continue;
      this.db.upsertSourceEvent(input);
      count++;
    }
    return count;
  }

  private async fetchAllCrmRecords(baseArgs: Record<string, unknown>, baseFilters: Record<string, unknown>[] = []): Promise<Record<string, unknown>[]> {
    const query = async (filters: Record<string, unknown>[]) => {
      const result = await this.mcp.call('mcp__crm__data_record_query-by-fields', {
        ...baseArgs,
        search_template_query: { limit: 50, filters, orders: [{ fieldName: CRM_FIELDS.pageCursor, isAsc: false }] },
      });
      if (result.isError) throw new Error(result.text);
      const parsed = parseJson(result.text);
      if (parsed?.resultCode === 'FAIL' || parsed?.data?.error) throw new Error(parsed?.data?.error ?? result.text);
      const resultSet = parsed?.data?.recordResult ?? {};
      return { records: recordsIn(resultSet), total: Number(resultSet.totalNumber ?? 0) };
    };
    const first = await query(baseFilters);
    if (first.total <= first.records.length) return first.records;
    const collected = new Map<string, Record<string, unknown>>();
    const collect = (items: Record<string, unknown>[]) => items.forEach((item) => { const id = asText(item[CRM_FIELDS.id]); if (id) collected.set(id, item); });
    let page = first;
    let cursor: string | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      collect(page.records);
      const lastValue = page.records.at(-1)?.[CRM_FIELDS.pageCursor];
      if (lastValue == null) break;
      cursor = new Date(Number(lastValue)).toISOString();
      // Include all records sharing the boundary timestamp before moving below it.
      collect((await query([...baseFilters, { field_name: CRM_FIELDS.pageCursor, field_values: [String(lastValue)], operator: 'eq', connector: 'AND', value_type: 0 }])).records);
      page = await query([...baseFilters, { field_name: CRM_FIELDS.pageCursor, field_values: [cursor], operator: 'lt', connector: 'AND', value_type: 0 }]);
      if (!page.records.length) break;
    }
    if (collected.size !== first.total) throw new Error(`CRM 售后客户同步不完整：期望 ${first.total} 条，实际 ${collected.size} 条`);
    return [...collected.values()];
  }

  private async syncSingleCrmCustomer(customer: Customer): Promise<number> {
    const result = await this.mcp.call('mcp__crm__data_record_query-by-fields', {
      apiName: 'QueryRecordsByFields', object_api_name: CRM_OBJECT, select_fields: CRM_SELECT_FIELDS, need_count: false,
      search_template_query: { limit: 50, filters: [{ field_name: CRM_FIELDS.id, field_values: [customer.id], operator: 'eq', connector: 'AND', value_type: 0 }], orders: [] },
    });
    if (result.isError) throw new Error(result.text);
    const records = recordsIn(parseJson(result.text));
    const record = records.find((item) => asText(item[CRM_FIELDS.id]) === customer.id)
      ?? records.find((item) => asText(item[CRM_FIELDS.name]) === customer.name);
    if (!record) return 0;
    const input = crmCustomer(record);
    if (input) this.db.upsertCustomer(input);
    this.addCrmEvidence(customer, record);
    await this.syncCrmFollowupRecords();
    return 1;
  }

  private addCrmEvidence(customer: Customer, record: Record<string, unknown>): void {
    const special = asText(record[CRM_FIELDS.specialRenewalTerms]);
    if (special) this.db.addEvidence({ id: `crm-${hash(`${customer.id}:renewal:${special}`)}`, customerId: customer.id, kind: /不续约|取消|终止/.test(special) ? 'risk' : 'fact', label: '续约特殊约定', detail: special,
      occurredAt: asDate(record[CRM_FIELDS.updatedAt]) ?? new Date().toISOString(), confidence: 0.95, sourceSystem: 'crm', sourceUrl: customer.crmUrl });
    const needs = asText(record[CRM_FIELDS.customerNeeds]);
    if (needs) this.db.addEvidence({ id: `crm-${hash(`${customer.id}:needs:${needs}`)}`, customerId: customer.id, kind: 'opportunity', label: 'CRM 客户需求', detail: needs,
      occurredAt: asDate(record[CRM_FIELDS.updatedAt]) ?? new Date().toISOString(), confidence: 0.8, sourceSystem: 'crm', sourceUrl: customer.crmUrl });
  }

  private async ensureOnesqlGrammar(): Promise<void> {
    if (!this.onesqlGrammarReady) {
      this.onesqlGrammarReady = (async () => {
        const result = await this.mcp.call('mcp__ones__get_onesql_grammar_help', {});
        if (result.isError) throw new Error(result.text);
      })().catch((error) => {
        this.onesqlGrammarReady = undefined;
        throw error;
      });
    }
    await this.onesqlGrammarReady;
  }

  // 客户名称（field_n1qN0__c__r）是全称，与 ONES 客户信息选项通常一致；售后客户名称（简称）是次级变体。
  // 一个客户在 ONES 可能同时存在全称与简称两个选项（实测：敏锐达/思灵、信通院/工物所），工作项可能挂在
  // 任一选项名下——逐变体解析、全部用于 ONESQL 查询，缺一个就会漏同步该选项名下的工作项。
  // 每个变体独立解析：先查 label 精确等于该变体的 confirmed 身份缓存，miss 则实时精确唯一匹配并落缓存；
  // 解析失败的变体落候选事件，不做模糊归属。返回去重后的 optionId 列表（全称在前）。
  private async resolveOnesCustomerOptions(customer: Customer): Promise<string[]> {
    const names = [...new Set([customer.name, customer.shortName].filter((name): name is string => !!name))];
    const optionIds = new Set<string>();
    const candidates: Array<{ option: Record<string, unknown>; exact: boolean }> = [];

    for (const name of names) {
      const existing = this.db.listIdentities(customer.id).find((item) =>
        item.system === 'ones_customer_option' && item.status === 'confirmed' && String(item.label) === name);
      if (existing?.external_id) { optionIds.add(String(existing.external_id)); continue; }

      const result = await this.mcp.call('mcp__ones__search_for_issue_field_options', {
        fieldID: ONES_CUSTOMER_FIELD_ID,
        input: name,
      });
      if (result.isError) throw new Error(result.text);
      const value = parseJson(result.text);
      const rawOptions: unknown[] = Array.isArray(value?.data) ? value.data : recordsIn(value);
      const options: Record<string, unknown>[] = rawOptions
        .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
      const exact = options.filter((item) => asText(item.name ?? item.value) === name);
      if (exact.length === 1) {
        const optionId = asText(exact[0].uuid ?? exact[0].id);
        if (optionId) {
          this.db.upsertIdentity(customer.id, 'ones_customer_option', optionId, name, 'confirmed');
          optionIds.add(optionId);
          continue;
        }
      }
      for (const item of exact.length > 1 ? exact : options) {
        const optionId = asText(item.uuid ?? item.id);
        if (!optionId || candidates.some((entry) => asText(entry.option.uuid ?? entry.option.id) === optionId)) continue;
        candidates.push({ option: item, exact: exact.length > 1 && exact.includes(item) });
      }
    }

    for (const { option, exact } of candidates) {
      const optionId = asText(option.uuid ?? option.id)!;
      this.db.upsertSourceEvent({
        customerId: null,
        sourceSystem: 'ones',
        sourceType: 'customer_option_candidate',
        externalId: `${customer.id}:${optionId}`,
        title: `待确认 ONES 客户信息: ${asText(option.name ?? option.value) ?? optionId}`,
        occurredAt: new Date().toISOString(),
        payload: { crmCustomerId: customer.id, crmCustomerName: customer.name, crmCustomerShortName: customer.shortName, option },
        confidence: exact ? 0.5 : 0.2,
        attributionStatus: exact ? 'ambiguous' : 'unattributed',
      });
    }
    return [...optionIds];
  }

  private async syncOnesCustomer(customer: Customer): Promise<number> {
    await this.ensureOnesqlGrammar();
    const optionIds = await this.resolveOnesCustomerOptions(customer);
    if (!optionIds.length) return 0;

    const issues: Record<string, unknown>[] = [];
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const result = await this.mcp.call('mcp__ones__query_issues_by_onesql', { query: buildOnesCustomerQuery(optionIds, cursor) });
      if (result.isError) throw new Error(result.text);
      const parsed = parseOnesIssuePage(result.text);
      issues.push(...parsed.records);
      if (!parsed.hasNextPage || !parsed.endCursor) break;
      cursor = parsed.endCursor;
    }

    const supportIssues: Record<string, unknown>[] = [];
    for (const item of issues) {
      const sourceType = onesSourceType(item);
      if (!sourceType) continue;
      const id = asText(item.uuid ?? item.id);
      if (!id) continue;
      const displayId = asText(item.display_id ?? item.issue_number);
      const title = asText(item.field001) ?? 'ONES 工作项';
      const status = asText(item.field005);
      // JrvswW8P.name 返回选项名（即客户名称全称），与客户名称或售后客户名称（简称）任一一致即归属该客户。
      const customerName = asText(item[ONES_CUSTOMER_FIELD_ID]);
      if (customerName !== customer.name && customerName !== customer.shortName) {
        this.db.upsertSourceEvent({ customerId: null, sourceSystem: 'ones', sourceType, externalId: id, displayId, title,
          occurredAt: asOnesDate(item.field009 ?? item.field010) ?? new Date().toISOString(), payload: item,
          url: onesIssueUrl(id, displayId), confidence: 0.2, attributionStatus: 'ambiguous' });
        continue;
      }
      const workhourRecords = sourceType === 'customer_manhour'
        ? await this.fetchWorkhourRecords(id)
        : [];
      const payload = sourceType === 'customer_manhour' && workhourRecords.length
        ? { ...item, workhourRecords }
        : item;
      const event = this.db.upsertSourceEvent({
        customerId: customer.id,
        sourceSystem: 'ones',
        sourceType,
        externalId: id,
        displayId,
        title,
        occurredAt: asOnesDate(item.field009 ?? item.field010) ?? new Date().toISOString(),
        payload,
        url: onesIssueUrl(id, displayId),
        confidence: 1,
        attributionStatus: 'confirmed',
      });
      if (sourceType === 'support_ticket' || sourceType === 'operations_ticket') supportIssues.push(item);
      if (sourceType === 'suggestion_feedback' && /需要|希望|增购|扩容|采购|模块|账号/.test(title)) {
        this.db.addEvidence({ id: `ones-${hash(`${id}:opportunity`)}`, customerId: customer.id, sourceEventId: event.id,
          kind: 'opportunity', label: 'ONES 客户建议与需求', detail: title, occurredAt: event.occurredAt,
          confidence: 0.8, sourceSystem: 'ones', sourceUrl: event.url });
      }
      if ((sourceType === 'support_ticket' || sourceType === 'operations_ticket') && /阻塞|挂起|blocked/i.test(status ?? '')) {
        this.db.addEvidence({ id: `ones-${hash(`${id}:risk`)}`, customerId: customer.id, sourceEventId: event.id,
          kind: 'risk', label: 'ONES 工单阻塞', detail: `${title}${status ? `（${status}）` : ''}`, occurredAt: event.occurredAt,
          confidence: 0.9, sourceSystem: 'ones', sourceUrl: event.url });
      }
    }

    const isClosed = (item: Record<string, unknown>) => {
      const category = onesStatusCategory(item);
      // 状态类型优先；旧同步数据缺 category（当时只取状态名）才回退名称正则凑合判定。
      return category ? category === 'done' : /完成|关闭|已解决|done|closed|resolved/i.test(asText(item.field005) ?? '');
    };
    const open = supportIssues.filter((item) => !isClosed(item)).length;
    const blocked = supportIssues.filter((item) => /阻塞|挂起|blocked/i.test(asText(item.field005) ?? '')).length;
    this.db.updateSupportStats(customer.id, open, blocked);
    this.recompute(customer.id);
    return issues.length;
  }

  private async syncHemoryCustomer(customer: Customer): Promise<number> {
    void customer;
    return this.syncRecentHemory();
  }

  private async syncRecentHemory(): Promise<number> {
    const { startedAt } = shanghaiDayBounds(shanghaiDateKey());
    const windowStart = new Date(new Date(startedAt).getTime() - (HEMORY_SYNC_WINDOW_DAYS - 1) * 86_400_000).toISOString();
    return this.scanHemory([], windowStart, new Date().toISOString());
  }

  private async scanHemory(keywords: string[], startedAt: string, endedAt: string): Promise<number> {
    let after: string | undefined;
    const recordings = new Map<string, TranscriptLine[]>();
    for (let page = 0; page < 100; page++) {
      const result = await this.mcp.call('mcp__hemory__search_memory', {
        keywords, started_at: startedAt, ended_at: endedAt, after: after ?? null, limit: 1000,
      });
      if (result.isError) throw new Error(result.text);
      const parsed = parseTranscriptPage(result.text);
      for (const line of parsed.lines) {
        const values = recordings.get(line.recordingId) ?? [];
        values.push(line);
        recordings.set(line.recordingId, values);
      }
      if (!parsed.more || !parsed.cursor) break;
      after = parsed.cursor;
    }
    let count = 0;
    for (const [recordingId, lines] of recordings) {
      lines.sort((a, b) => a.spokenAt.localeCompare(b.spokenAt));
      const recording = this.db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'raw_transcript',
        externalId: recordingId, title: `Hemory 原始转写 ${recordingId}`, occurredAt: lines[0].spokenAt,
        confidence: 1, attributionStatus: 'unattributed', payload: { recordingId, startedAt: lines[0].spokenAt,
          endedAt: lines.at(-1)!.spokenAt, lines, transcript: lines.map((line) => `${line.speaker}: ${line.text}`).join('\n') } });
      const { events: fragments } = await this.segmentRecording(recording);
      count += fragments.length;
    }
    for (const customer of this.db.listCustomers()) this.recompute(customer.id);
    return count;
  }

  processHemoryEvidence(event: SourceEvent): void {
    if (!event.customerId || event.attributionStatus !== 'confirmed') return;
    const customer = this.db.getCustomer(event.customerId);
    const evidence = Array.isArray(event.payload?.evidence) ? event.payload.evidence : [];
    const customerLines = evidence.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const item = raw as Record<string, unknown>;
      const speaker = typeof item.speaker === 'string' ? item.speaker.trim() : '';
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      return text && caseSpeakerRole(speaker, customer?.csmName) === 'customer' ? [text] : [];
    });
    // 成果/风险/机会属于“客户声音”证据。旧片段没有逐句说话人时宁可不产出，不能把 CSM
    // 的总结误记成客户反馈；原始片段仍保留在案例上下文中供模型作为内部辅助材料审阅。
    const text = customerLines.join('\n');
    this.db.deleteEvidenceForSourceEvents([event.id]);
    if (!text) return;
    if (/不满|不续约|替换|投诉|预算取消|严重|阻塞/.test(text)) this.db.addEvidence({ id: `hemory-${hash(`${event.id}:risk`)}`, customerId: event.customerId, sourceEventId: event.id,
      kind: 'voice', label: '会议风险信号', detail: text, occurredAt: event.occurredAt, confidence: 0.75, sourceSystem: 'hemory' });
    if (/满意|认可|效果|提升|节省|成功|上线/.test(text)) this.db.addEvidence({ id: `hemory-${hash(`${event.id}:outcome`)}`, customerId: event.customerId, sourceEventId: event.id,
      kind: 'outcome', label: '客户成果反馈', detail: text, occurredAt: event.occurredAt, confidence: 0.7, sourceSystem: 'hemory' });
    if (/增购|扩容|采购|需要.{0,20}(模块|账号|服务)|预算.{0,12}(新增|增加)/.test(text)) this.db.addEvidence({ id: `hemory-${hash(`${event.id}:opportunity`)}`, customerId: event.customerId, sourceEventId: event.id,
      kind: 'opportunity', label: '会议增购信号', detail: text, occurredAt: event.occurredAt, confidence: 0.75, sourceSystem: 'hemory' });
  }

  recompute(customerId: string): void {
    const customer = this.db.getCustomer(customerId);
    if (!customer) return;
    const evidence = this.db.listEvidence(customerId);
    // 互动维度口径（csm-risk-v2）：最后互动取客户全量业务事件的最晚时间（lastInteractionAt），
    // 仅在无任何事件时回退 CRM 原始最后联系时间。
    const rates = this.db.onesCompletionRates(customerId);
    const risk = assessRisk(
      { ...customer, lastContactAt: this.db.lastInteractionAt(customerId) ?? customer.lastContactAt },
      evidence,
      new Date(),
      { suggestionRate: rates.suggestion_feedback, ticketRate: rates.support_ticket },
    );
    this.db.saveRisk(risk);

    const opportunityEvidence = evidence.filter((item) => item.kind === 'opportunity' || (item.kind === 'voice' && /增购|扩容|采购|需要|模块/.test(item.detail)));
    const independentSources = new Set(opportunityEvidence.map((item) => item.sourceSystem));
    const explicitNeed = opportunityEvidence.some((item) => /明确|需要|采购|增购|扩容|预算/.test(item.detail));
    if (risk.level !== 'high' && (explicitNeed || independentSources.size >= 2)) {
      this.db.upsertOpportunity({ customerId, type: 'needs_led_expansion', title: '需求驱动的增购假设',
        detail: opportunityEvidence.slice(0, 3).map((item) => item.detail).join('；'), confidence: Math.min(0.9, 0.5 + opportunityEvidence.length * 0.1),
        status: 'hypothesis', evidenceRefs: opportunityEvidence.map((item) => item.id!).filter(Boolean),
        discoveryQuestions: ['该需求是否已有明确使用范围和负责人？', '客户是否确认预算与时间窗口？'],
        recommendedAction: '与客户确认需求范围、决策人、预算和计划时间。' });
    }

    // 公开动态利好增购：近 90 天正向 web_signal（融资/中标/扩张等）≥1 条即成假设；high 风险客户不开新机会。
    const web = summarizeWebSignals(evidence, new Date());
    if (risk.level !== 'high' && web.positive.length > 0) {
      this.db.upsertOpportunity({ customerId, type: 'public_signal_expansion', title: '公开动态利好增购',
        detail: web.positive.slice(0, 3).map((item) => `${item.label}（${item.occurredAt.slice(0, 10)}）`).join('；'),
        confidence: Math.min(0.9, 0.5 + web.positive.length * 0.1),
        status: 'hypothesis', evidenceRefs: web.positive.map((item) => item.id!).filter(Boolean),
        discoveryQuestions: ['公开动态里的扩张/投入是否落到我方产品的使用场景？', '客户是否已进入预算或立项窗口？'],
        recommendedAction: '结合公开动态与客户确认扩张计划，评估增购切入点。' });
    }

    const delivered = this.db.listTimeline(customerId, 200).filter((item) => item.sourceSystem === 'ones' && isDeliveredOnesEvent(item));
    const outcomes = evidence.filter((item) => item.kind === 'outcome');
    const eligible = delivered.length > 0 && outcomes.length > 0;
    this.db.setCaseCandidate(customerId, eligible, eligible ? '存在已完成交付及客户成果反馈' : '需要同时具备完成交付和客户成果反馈',
      [...delivered.map((item) => item.id), ...outcomes.map((item) => item.id!).filter(Boolean)], eligible ? 0.85 : 0.3);
  }
}

export function shanghaiDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export type CaseSpeakerRole = 'customer' | 'csm' | 'unknown';

/** 案例信号的说话人归类：只有明确客户角色才能成为客户声音证据。 */
export function caseSpeakerRole(speaker: string | null | undefined, csmName?: string | null): CaseSpeakerRole {
  const normalized = String(speaker ?? '').trim();
  if (!normalized) return 'unknown';
  if (csmName?.trim() && normalized === csmName.trim()) return 'csm';
  if (/^(?:客户|甲方|用户|对方|贵方)(?:\d+|代表|老师)?$/i.test(normalized)) return 'customer';
  if (/(?:CSM|客户成功|ONES|我方|实施|售后|项目组)/i.test(normalized)) return 'csm';
  return 'unknown';
}

function eventStatusCategory(event: { payload?: Record<string, unknown> }): string | null {
  const status = event.payload?.field005;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  const category = (status as Record<string, unknown>).category;
  return typeof category === 'string' && category.trim() ? category.trim() : null;
}

function onesStatusName(event: { payload?: Record<string, unknown> }): string {
  const status = event.payload?.field005;
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    const item = status as Record<string, unknown>;
    return String(item.name ?? item.value ?? item.label ?? '');
  }
  return '';
}

const NEGATED_DELIVERY = /(?:未|尚未|没有|并未|待|计划|预计|拟|希望|需要).{0,8}(?:完成|关闭|上线|交付)|(?:完成|关闭|上线|交付).{0,8}(?:前|中|计划|目标|延期|推迟|失败)/;
const POSITIVE_DELIVERY_STATUS = /^(?:已完成|完成|已关闭|关闭|已解决|解决|已上线|上线|已交付|交付|done|closed|resolved)$/i;

/** ONES 事件是否属「已完成交付」：结构化状态类型优先，旧数据才回退严格状态名。 */
export function isDeliveredOnesEvent(event: { sourceType: string; title: string; payload?: Record<string, unknown> }): boolean {
  const category = eventStatusCategory(event);
  if (category) return category === 'done';
  const status = onesStatusName(event).trim();
  if (NEGATED_DELIVERY.test(`${event.title} ${status}`)) return false;
  return POSITIVE_DELIVERY_STATUS.test(status);
}

/** ONES 工时登记的 startTime 要求 ISO 8601 带时区偏移；按上海时区输出 YYYY-MM-DDTHH:mm:ss+08:00。 */
export function shanghaiIsoOffset(at: Date): string {
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(at);
  return `${text.replace(' ', 'T')}+08:00`;
}

export function shanghaiDayBounds(date: string, now = new Date()): { startedAt: string; endedAt: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必须是 YYYY-MM-DD');
  const start = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) throw new Error('invalid date');
  const next = new Date(start.getTime() + 86_400_000);
  const end = date === shanghaiDateKey(now) ? now : new Date(next.getTime() - 1);
  return { startedAt: start.toISOString(), endedAt: end.toISOString() };
}

function shanghaiSlot(date: string, hour: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`);
}

export function nextHemorySlot(now = new Date()): { at: Date; date: string; hour: number } {
  const date = shanghaiDateKey(now);
  for (const hour of [13, 20]) {
    const at = shanghaiSlot(date, hour);
    if (at > now) return { at, date, hour };
  }
  const tomorrow = shanghaiDateKey(new Date(shanghaiSlot(date, 20).getTime() + 5 * 3_600_000));
  return { at: shanghaiSlot(tomorrow, 13), date: tomorrow, hour: 13 };
}

export function schedulePortfolioSync(service: PortfolioSyncService): () => void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(2, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    timer = setTimeout(() => {
      service.refreshPortfolioSources();
      schedule();
    }, next.getTime() - now.getTime());
    timer.unref();
  };
  schedule();
  return () => timer && clearTimeout(timer);
}

export function scheduleHemorySync(service: PortfolioSyncService, db: WorkbenchDatabase): () => void {
  let timer: NodeJS.Timeout | undefined;
  const catchUp = () => {
    const now = new Date();
    const date = shanghaiDateKey(now);
    const passed = [13, 20].filter((hour) => shanghaiSlot(date, hour) <= now);
    const latest = passed.at(-1);
    if (latest && !db.hasSuccessfulSyncScope(`hemory:${date}:${latest}`)) service.refreshRecentHemory(latest);
  };
  const schedule = () => {
    const next = nextHemorySlot();
    timer = setTimeout(() => {
      service.refreshRecentHemory(next.hour);
      schedule();
    }, Math.max(0, next.at.getTime() - Date.now()));
    timer.unref();
  };
  catchUp();
  schedule();
  return () => timer && clearTimeout(timer);
}
