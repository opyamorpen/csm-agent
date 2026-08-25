import { createHash } from 'node:crypto';
import type { McpGateway } from '../agent.js';
import { WorkbenchDatabase } from './database.js';
import { assessRisk } from './risk.js';
import type { Customer, SourceEvent, SyncRun } from './types.js';

const CRM_FIELDS = {
  id: '_id',
  name: 'name',
  shortName: 'field_BP043__c',
  industry: 'field_zck4A__c',
  csm: 'field_Gsp41__c',
  handedToCsm: 'field_A71s2__c',
  renewalDate: 'field_4TdWq__c',
  contractValue: 'field_lb2Q1__c',
  products: 'UDMSel1__c',
  lastContactAt: 'last_followed_time',
  lastFollowup: 'field_kz1Pi__c',
  lost: 'field_6WC6d__c',
  lifeStatus: 'life_status',
  stage: 'field_Kt9bI__c',
  specialRenewalTerms: 'field_2JN6r__c',
  customerNeeds: 'field_2Kdas__c',
  updatedAt: 'last_modified_time',
} as const;

const CRM_SELECT_FIELDS = Object.values(CRM_FIELDS);

const ONES_CUSTOMER_FIELD_ID = process.env.ONES_CUSTOMER_FIELD_ID ?? 'JrvswW8P';
const ONES_WEB_BASE_URL = (process.env.ONES_WEB_BASE_URL ?? 'https://our.ones.pro').replace(/\/$/, '');
const ONES_TEAM_ID = process.env.ONES_TEAM_ID ?? 'RDjYMhKq';

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

function hasCsm(record: Record<string, unknown>): boolean {
  const csm = asText(record[CRM_FIELDS.csm]);
  const handed = asText(record[CRM_FIELDS.handedToCsm]);
  return !!csm || /是|已交接|true|1/i.test(handed ?? '');
}

function crmCustomer(record: Record<string, unknown>): Parameters<WorkbenchDatabase['upsertCustomer']>[0] | null {
  const id = asText(record[CRM_FIELDS.id]) ?? asText(record.id);
  const name = asText(record[CRM_FIELDS.name]);
  if (!id || !name) return null;
  const lost = asBoolean(record[CRM_FIELDS.lost]);
  const lifeStatus = asText(record[CRM_FIELDS.lifeStatus]);
  const special = asText(record[CRM_FIELDS.specialRenewalTerms]);
  return {
    id,
    name,
    shortName: asText(record[CRM_FIELDS.shortName]),
    industry: asText(record[CRM_FIELDS.industry]),
    csmName: relatedName(record, CRM_FIELDS.csm),
    renewalDate: asDate(record[CRM_FIELDS.renewalDate]),
    contractValue: asNumber(record[CRM_FIELDS.contractValue]),
    contractStatus: lost ? '已流失' : lifeStatus,
    products: asList(record[CRM_FIELDS.products]),
    lastContactAt: asDate(record[CRM_FIELDS.lastContactAt]),
    explicitNonrenewal: lost === true || /不续约|终止|取消/.test(special ?? ''),
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

export function buildOnesCustomerQuery(optionId: string, cursor = ''): string {
  const deskTypes = ONES_CSM_SOURCES.filter((source) => source.projectName === 'ONES Desk')
    .map((source) => `'${source.issueTypeId}'`).join(', ');
  const hours = ONES_CSM_SOURCES.find((source) => source.sourceType === 'customer_manhour')!;
  const privateCloud = ONES_CSM_SOURCES.find((source) => source.sourceType === 'private_cloud_instance')!;
  return `SELECT uuid, field001, field005.name, field006.name, field007.name, ${ONES_CUSTOMER_FIELD_ID}.name, `
    + `TODATE(field009, 'YYYY-MM-DD HH:mm:ss'), TODATE(field010, 'YYYY-MM-DD HH:mm:ss'), field019, field020 `
    + `FROM issue WHERE v$cursor > '${onesqlLiteral(cursor)}' AND ${ONES_CUSTOMER_FIELD_ID} = '${onesqlLiteral(optionId)}' AND (`
    + `(field006 = 'GL3ysesFPdnAQNIU' AND field007 IN (${deskTypes})) OR `
    + `(field006 = '${hours.projectId}' AND field007 = '${hours.issueTypeId}') OR `
    + `(field006 = '${privateCloud.projectId}' AND field007 = '${privateCloud.issueTypeId}')) `
    + 'ORDER BY field010 DESC LIMIT 1000, 50';
}

export function onesSourceType(issue: Record<string, unknown>): string | null {
  const issueType = asText(issue.field007);
  return issueType ? ONES_SOURCE_BY_ISSUE_TYPE.get(issueType)?.sourceType ?? null : null;
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

  constructor(private readonly db: WorkbenchDatabase, private readonly mcp: McpGateway,
    private readonly segmentRecording: (recording: SourceEvent) => Promise<SourceEvent[]>) {}

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

  refreshPortfolioSources(): SyncRun {
    const run = this.db.createSyncRun('portfolio');
    void this.executePortfolio(run);
    return run;
  }

  refreshHemoryDate(date = shanghaiDateKey(), scheduledHour?: number): SyncRun {
    if (this.hemoryRun && this.db.getSyncRun(this.hemoryRun.id)?.status === 'running') return this.hemoryRun;
    const run = this.db.createSyncRun(`hemory:${date}${scheduledHour ? `:${scheduledHour}` : ''}`);
    this.hemoryRun = run;
    void this.executeHemory(run, date);
    return run;
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
      const hemoryCount = await this.syncRecentHemoryDay();
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

  private async executeHemory(run: SyncRun, date: string): Promise<void> {
    const delays = [0, 60_000, 5 * 60_000, 15 * 60_000];
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      try {
        const { startedAt, endedAt } = shanghaiDayBounds(date);
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
    for (const [source, task] of [
      ['crm', () => this.syncSingleCrmCustomer(customer)],
      ['ones', () => this.syncOnesCustomer(customer)],
      ['hemory', () => this.syncHemoryCustomer(customer)],
    ] as const) {
      try {
        statuses[source] = { status: 'succeeded', count: await task() };
      } catch (error) {
        statuses[source] = { status: 'failed', error: (error as Error).message };
      }
    }
    this.recompute(customerId);
    const failures = Object.values(statuses).filter((value) => value.status === 'failed');
    this.db.finishSyncRun(run.id, failures.length === 0 ? 'succeeded' : failures.length === 3 ? 'failed' : 'partial', statuses,
      failures.map((value) => value.error).filter(Boolean).join('; ') || undefined);
  }

  private async syncCrmCustomers(): Promise<number> {
    const result = await this.mcp.call('mcp__crm__data_record_query-by-fields', {
      apiName: 'QueryRecordsByFields',
      object_api_name: 'AccountObj',
      select_fields: CRM_SELECT_FIELDS,
      need_count: true,
      search_template_query: { limit: 2000, filters: [], orders: [{ fieldName: CRM_FIELDS.updatedAt, isAsc: false }] },
    });
    if (result.isError) throw new Error(result.text);
    const records = recordsIn(parseJson(result.text));
    let count = 0;
    for (const record of records) {
      if (!hasCsm(record)) continue;
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
    return count;
  }

  private async syncSingleCrmCustomer(customer: Customer): Promise<number> {
    const result = await this.mcp.call('mcp__crm__sales_account_query-account-by-name', { apiName: 'QueryAccountByName', name: customer.name });
    if (result.isError) throw new Error(result.text);
    const records = recordsIn(parseJson(result.text));
    const record = records.find((item) => asText(item[CRM_FIELDS.id]) === customer.id)
      ?? records.find((item) => asText(item[CRM_FIELDS.name]) === customer.name);
    if (!record) return 0;
    const input = crmCustomer(record);
    if (input) this.db.upsertCustomer(input);
    this.addCrmEvidence(customer, record);
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

  private async resolveOnesCustomerOption(customer: Customer): Promise<string | null> {
    const existing = this.db.listIdentities(customer.id).find((item) =>
      item.system === 'ones_customer_option' && item.status === 'confirmed' && item.label === customer.name);
    if (existing?.external_id) return String(existing.external_id);

    const result = await this.mcp.call('mcp__ones__search_for_issue_field_options', {
      fieldID: ONES_CUSTOMER_FIELD_ID,
      input: customer.name,
    });
    if (result.isError) throw new Error(result.text);
    const value = parseJson(result.text);
    const rawOptions: unknown[] = Array.isArray(value?.data) ? value.data : recordsIn(value);
    const options: Record<string, unknown>[] = rawOptions
      .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
    const exact = options.filter((item) => asText(item.name ?? item.value) === customer.name);
    if (exact.length === 1) {
      const optionId = asText(exact[0].uuid ?? exact[0].id);
      if (optionId) {
        this.db.upsertIdentity(customer.id, 'ones_customer_option', optionId, customer.name, 'confirmed');
        return optionId;
      }
    }

    for (const item of exact.length > 1 ? exact : options) {
      const optionId = asText(item.uuid ?? item.id);
      if (!optionId) continue;
      this.db.upsertSourceEvent({
        customerId: null,
        sourceSystem: 'ones',
        sourceType: 'customer_option_candidate',
        externalId: `${customer.id}:${optionId}`,
        title: `待确认 ONES 客户信息: ${asText(item.name ?? item.value) ?? optionId}`,
        occurredAt: new Date().toISOString(),
        payload: { crmCustomerId: customer.id, crmCustomerName: customer.name, option: item },
        confidence: exact.length > 1 ? 0.5 : 0.2,
        attributionStatus: exact.length > 1 ? 'ambiguous' : 'unattributed',
      });
    }
    return null;
  }

  private async syncOnesCustomer(customer: Customer): Promise<number> {
    await this.ensureOnesqlGrammar();
    const optionId = await this.resolveOnesCustomerOption(customer);
    if (!optionId) return 0;

    const issues: Record<string, unknown>[] = [];
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const result = await this.mcp.call('mcp__ones__query_issues_by_onesql', { query: buildOnesCustomerQuery(optionId, cursor) });
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
      const title = asText(item.field001) ?? 'ONES 工作项';
      const status = asText(item.field005);
      const customerName = asText(item[ONES_CUSTOMER_FIELD_ID]);
      if (customerName !== customer.name) {
        this.db.upsertSourceEvent({ customerId: null, sourceSystem: 'ones', sourceType, externalId: id, title,
          occurredAt: asOnesDate(item.field010 ?? item.field009) ?? new Date().toISOString(), payload: item,
          url: `${ONES_WEB_BASE_URL}/project/#/team/${ONES_TEAM_ID}/issue/${id}`, confidence: 0.2, attributionStatus: 'ambiguous' });
        continue;
      }
      const event = this.db.upsertSourceEvent({
        customerId: customer.id,
        sourceSystem: 'ones',
        sourceType,
        externalId: id,
        title,
        occurredAt: asOnesDate(item.field010 ?? item.field009) ?? new Date().toISOString(),
        payload: item,
        url: `${ONES_WEB_BASE_URL}/project/#/team/${ONES_TEAM_ID}/issue/${id}`,
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

    const isClosed = (item: Record<string, unknown>) => /完成|关闭|已解决|done|closed|resolved/i.test(asText(item.field005) ?? '');
    const open = supportIssues.filter((item) => !isClosed(item)).length;
    const blocked = supportIssues.filter((item) => /阻塞|挂起|blocked/i.test(asText(item.field005) ?? '')).length;
    this.db.updateSupportStats(customer.id, open, blocked);
    this.recompute(customer.id);
    return issues.length;
  }

  private async syncHemoryCustomer(customer: Customer): Promise<number> {
    void customer;
    return this.syncRecentHemoryDay();
  }

  private async syncRecentHemoryDay(): Promise<number> {
    const bounds = shanghaiDayBounds(shanghaiDateKey());
    return this.scanHemory([], bounds.startedAt, bounds.endedAt);
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
      const fragments = await this.segmentRecording(recording);
      count += fragments.length;
    }
    for (const customer of this.db.listCustomers()) this.recompute(customer.id);
    return count;
  }

  processHemoryEvidence(event: SourceEvent): void {
    if (!event.customerId || event.attributionStatus !== 'confirmed') return;
    const text = String(event.payload?.transcript ?? event.title);
    this.db.deleteEvidenceForSourceEvents([event.id]);
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
    const risk = assessRisk(customer, evidence);
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

    const delivered = this.db.listTimeline(customerId, 200).filter((item) => item.sourceSystem === 'ones' && /完成|关闭|上线|交付/.test(`${item.title} ${JSON.stringify(item.payload)}`));
    const outcomes = evidence.filter((item) => item.kind === 'outcome');
    const eligible = delivered.length > 0 && outcomes.length > 0;
    this.db.setCaseCandidate(customerId, eligible, eligible ? '存在已完成交付及客户成果反馈' : '需要同时具备完成交付和客户成果反馈',
      [...delivered.map((item) => item.id), ...outcomes.map((item) => item.id!).filter(Boolean)], eligible ? 0.85 : 0.3);
  }
}

export function shanghaiDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
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
    if (latest && !db.hasSuccessfulSyncScope(`hemory:${date}:${latest}`)) service.refreshHemoryDate(date, latest);
  };
  const schedule = () => {
    const next = nextHemorySlot();
    timer = setTimeout(() => {
      service.refreshHemoryDate(next.date, next.hour);
      schedule();
    }, Math.max(0, next.at.getTime() - Date.now()));
    timer.unref();
  };
  catchUp();
  schedule();
  return () => timer && clearTimeout(timer);
}
