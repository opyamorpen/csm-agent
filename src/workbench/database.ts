import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ActionBulkResult,
  ActionItem,
  ActionItemInput,
  ActionStatus,
  AlertTriggerKey,
  CaseDraft,
  CasePublishAttempt,
  Customer,
  CustomerAlert,
  CustomerInput,
  DraftBatch,
  DraftGenerationJob,
  DraftJobKind,
  DraftItem,
  DraftItemType,
  DraftItemStatus,
  HemoryAttributionOverride,
  HemoryInheritanceDetail,
  HemorySegmentationInputMeta,
  HemorySegmentationJob,
  CompletionRate,
  EvidenceInput,
  OpportunityHypothesis,
  RiskAssessment,
  SourceEvent,
  SourceEventInput,
  SyncRun,
  WeeklyReport,
  WeeklyReportContent,
  WeeklyReportStats,
} from './types.js';
import { normalizeAfterSalesStage } from './types.js';
import { renewalWithin } from './risk.js';

type Row = Record<string, unknown>;

/** 待归属列表默认保留的上海自然日数量（含今天），超出仅在指定日期或全部状态下可见。 */
export const HEMORY_PENDING_WINDOW_DAYS = 7;

/**
 * 重切孪生的时间覆盖率阈值：候选片段覆盖「已处理片段」时长的比例达到该值即视为
 * 同一内容的重切副本（归属继承与消费台账扩展共用同一口径）。
 */
export const HEMORY_INHERIT_OVERLAP_RATIO = 0.6;

/** 片段时间轴（payload.startAt/endAt，ISO 时刻）；缺失或不可解析返回 null。 */
function hemorySegmentRange(event: SourceEvent): { start: number; end: number } | null {
  const startAt = event.payload?.startAt;
  const endAt = event.payload?.endAt;
  if (typeof startAt !== 'string' || typeof endAt !== 'string') return null;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * 候选片段对「已处理片段」的时间覆盖率（重叠毫秒 / 已处理片段时长）：
 * ≥ HEMORY_INHERIT_OVERLAP_RATIO 视为同一内容的重切孪生。不可计算返回 null；
 * 已处理片段零时长（单行片段）时退化为起点相同判定。
 */
export function hemoryOverlapRatio(candidate: SourceEvent, processed: SourceEvent): number | null {
  const a = hemorySegmentRange(candidate);
  const b = hemorySegmentRange(processed);
  if (!a || !b) return null;
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const duration = b.end - b.start;
  if (duration <= 0) return a.start === b.start ? 1 : 0;
  return overlap / duration;
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 从草稿 result_json 判断是否为“明确失败”载荷（execute 存储的是 {response: <原始文本>} 或本地结果）。
 * ONES：内层 result 为字符串且非 SUCCESS；CRM：resultCode 非 SUCCESS，或 save_status 存在且不在 SUCCESS/SAVED 白名单。
 * 无法识别（无失败信号或非 JSON）返回 null，保持 written 不动。
 */
function extractDraftFailurePayload(resultJson: string, targetSystem: string): { message: string } | null {
  const outer = parseJson<{ response?: unknown } | null>(resultJson, null);
  const text = typeof outer?.response === 'string' ? outer.response : resultJson;
  const inner = parseJson<Record<string, unknown> | null>(text, null);
  if (!inner || typeof inner !== 'object') return null;
  if (targetSystem === 'ones' && typeof inner.result === 'string' && inner.result !== 'SUCCESS') {
    return { message: String(inner.errorMsg ?? inner.errorCode ?? inner.result) };
  }
  if (targetSystem === 'crm') {
    if (typeof inner.resultCode === 'string' && inner.resultCode !== 'SUCCESS') {
      return { message: String((inner.data as Record<string, unknown> | undefined)?.message ?? inner.resultCode) };
    }
    const data = inner.data as Record<string, unknown> | undefined;
    const saveStatus = data?.save_status;
    if (typeof saveStatus === 'string' && saveStatus !== 'SUCCESS' && saveStatus !== 'SAVED') {
      return { message: `${saveStatus}: ${String(data?.failure_reason ?? '')}`.trim() };
    }
  }
  return null;
}

function bool(value: unknown): boolean | null {
  return value == null ? null : Number(value) === 1;
}

/** 上海自然日 → UTC ISO 闭区间；occurred_at 是 ISO 字符串，用区间比较避免 UTC 日期前缀把早 8 点前的录音错位到前一天。 */
function shanghaiDayRange(date: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必须是 YYYY-MM-DD');
  const start = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) throw new Error('invalid date');
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000 - 1).toISOString() };
}

/** 上海今天 00:00 对应的 UTC 时间点；待归属默认保留窗口以它为锚。 */
function shanghaiTodayStart(now = new Date()): Date {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return new Date(`${key}T00:00:00+08:00`);
}

/**
 * occurred_at 历史上混有三种格式：ISO Z（部分 ONES/CRM）、+08:00（Hemory）、naive 本地时间
 * （ONES Desk 三类由启动迁移写入，无时区后缀，实为上海时间）。naive 必须补 +08:00 解析，
 * 否则会被 Date.parse 当 UTC，聚合出的最晚时间偏早 8 小时；无法解析返回 null。
 * ONES payload 里的 field009/field010 同为 naive 上海时间，预警判定复用本函数。
 */
export function parseOccurredAt(value: string): number | null {
  const text = value.trim();
  const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? Date.parse(`${text.replace(' ', 'T')}+08:00`) : Date.parse(text);
  return Number.isNaN(at) ? null : at;
}

function customerFromRow(row: Row): Customer {
  return {
    id: String(row.id),
    name: String(row.name),
    shortName: row.short_name as string | null,
    industry: row.industry as string | null,
    usageVersion: row.usage_version as string | null,
    csmName: row.csm_name as string | null,
    csmWecomUserid: row.csm_wecom_userid as string | null,
    sourceObject: row.source_object as string | null,
    afterSalesStage: normalizeAfterSalesStage(row.after_sales_stage as string | null),
    renewalDate: row.renewal_date as string | null,
    contractValue: row.contract_value == null ? null : Number(row.contract_value),
    contractStatus: row.contract_status as string | null,
    products: parseJson<string[]>(row.products_json, []),
    lastContactAt: row.last_contact_at as string | null,
    supportOpenCount: row.support_open_count == null ? null : Number(row.support_open_count),
    supportBlockedCount: row.support_blocked_count == null ? null : Number(row.support_blocked_count),
    voiceRisk: bool(row.voice_risk),
    explicitNonrenewal: bool(row.explicit_nonrenewal),
    nextAction: row.next_action as string | null,
    nextActionDue: row.next_action_due as string | null,
    crmUrl: row.crm_url as string | null,
    health: String(row.health ?? 'unknown') as Customer['health'],
    syncedAt: row.synced_at as string | undefined,
    source: parseJson<Record<string, unknown>>(row.source_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function actionFromRow(row: Row): ActionItem {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    title: String(row.title),
    whyNow: String(row.why_now),
    owner: row.owner as string | null,
    dueAt: row.due_at as string | null,
    expectedOutcome: row.expected_outcome as string | null,
    evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []),
    sourceMeetingId: row.source_meeting_id as string | null,
    confidence: Number(row.confidence ?? 0),
    status: String(row.status) as ActionStatus,
    outcome: row.outcome as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function sourceEventFromRow(row: Row): SourceEvent {
  return {
    id: String(row.id), customerId: row.customer_id as string | null, sourceSystem: String(row.source_system),
    sourceType: String(row.source_type), externalId: String(row.external_id), displayId: row.display_id as string | null, title: String(row.title),
    occurredAt: String(row.occurred_at), syncedAt: String(row.synced_at), confidence: Number(row.confidence),
    url: row.url as string | null, payload: parseJson<Record<string, unknown>>(row.payload_json, {}), payloadHash: String(row.payload_hash),
    attributionStatus: String(row.attribution_status) as SourceEvent['attributionStatus'],
  };
}

function draftItemFromRow(row: Row): DraftItem {
  return {
    id: String(row.id), batchId: String(row.batch_id), customerId: String(row.customer_id), version: Number(row.version),
    type: String(row.type) as DraftItem['type'], status: String(row.status) as DraftItem['status'], title: String(row.title),
    summary: String(row.summary), fields: parseJson(row.fields_json, {}), targetSystem: String(row.target_system) as DraftItem['targetSystem'],
    targetObject: String(row.target_object), targetTool: row.target_tool as string | null,
    targetArguments: parseJson(row.target_arguments_json, {}), evidenceRefs: parseJson(row.evidence_refs_json, []),
    unknowns: parseJson(row.unknowns_json, []), validationErrors: parseJson(row.validation_errors_json, []),
    approvalHash: row.approval_hash as string | null, result: parseJson(row.result_json, null), error: row.error as string | null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function draftBatchFromRow(row: Row): DraftBatch {
  return {
    id: String(row.id), customerId: String(row.customer_id), fingerprint: String(row.fingerprint),
    sourceEventIds: parseJson(row.source_event_ids_json, []), generationVersion: String(row.generation_version),
    generator: String(row.generator), status: String(row.status), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function alertFromRow(row: Row): CustomerAlert {
  return {
    id: String(row.id), customerId: String(row.customer_id), triggerKey: String(row.trigger_key) as CustomerAlert['triggerKey'],
    status: String(row.status) as CustomerAlert['status'], reasons: parseJson(row.reasons_json, []), details: parseJson(row.details_json, {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    resolvedBy: row.resolved_by == null ? null : String(row.resolved_by), resolutionNote: String(row.resolution_note ?? ''),
  };
}

/** 登录用户（密码哈希只在 getUserByUsername 里随行带出，其余出口不携带）。 */
export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  wecomUserid: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
}

/** CLI/CI 个人访问令牌（PAT）的元信息视图：令牌本体只在创建时返回一次。 */
export interface AuthTokenRecord {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

function userFromRow(row: Row): AuthUser & { passwordHash?: string } {
  return {
    id: Number(row.id), username: String(row.username), displayName: String(row.display_name ?? ''),
    role: String(row.role) === 'admin' ? 'admin' : 'member',
    wecomUserid: row.wecom_userid == null ? null : String(row.wecom_userid),
    status: String(row.status) === 'disabled' ? 'disabled' : 'active',
    createdAt: String(row.created_at),
    ...(row.password_hash != null ? { passwordHash: String(row.password_hash) } : {}),
  };
}

export class WorkbenchDatabase {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'workbench.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** 全库一致性备份（WAL 下安全快照），重切等破坏性维护操作前调用。 */
  backupTo(targetPath: string): void {
    this.db.prepare('VACUUM INTO ?').run(targetPath);
  }

  /** 全部 Hemory 原始转写录音（不限于滚动同步窗口），重切命令的数据源。 */
  listHemoryRawTranscriptRecordings(): SourceEvent[] {
    return (this.db.prepare(`SELECT * FROM source_events WHERE source_system='hemory' AND source_type='raw_transcript'
      ORDER BY occurred_at DESC`).all() as Row[]).map(sourceEventFromRow);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT,
        industry TEXT,
        csm_name TEXT,
        csm_wecom_userid TEXT,
        source_object TEXT,
        after_sales_stage TEXT,
        renewal_date TEXT,
        contract_value REAL,
        contract_status TEXT,
        products_json TEXT NOT NULL DEFAULT '[]',
        last_contact_at TEXT,
        support_open_count INTEGER,
        support_blocked_count INTEGER,
        voice_risk INTEGER,
        explicit_nonrenewal INTEGER,
        next_action TEXT,
        next_action_due TEXT,
        crm_url TEXT,
        health TEXT NOT NULL DEFAULT 'unknown',
        synced_at TEXT,
        source_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_customers_renewal ON customers(renewal_date);
      CREATE INDEX IF NOT EXISTS idx_customers_value ON customers(contract_value DESC);

      CREATE TABLE IF NOT EXISTS customer_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(customer_id, alias)
      );
      CREATE INDEX IF NOT EXISTS idx_customer_aliases_alias ON customer_aliases(alias);

      CREATE TABLE IF NOT EXISTS external_identities (
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        system TEXT NOT NULL,
        external_id TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'confirmed',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(system, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_customer ON external_identities(customer_id);

      CREATE TABLE IF NOT EXISTS source_events (
        id TEXT PRIMARY KEY,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        source_system TEXT NOT NULL,
        source_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_id TEXT,
        title TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        url TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        payload_hash TEXT NOT NULL,
        attribution_status TEXT NOT NULL DEFAULT 'confirmed',
        UNIQUE(source_system, source_type, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_customer_time ON source_events(customer_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_source_attribution ON source_events(attribution_status);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        source_event_id TEXT REFERENCES source_events(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        detail TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_system TEXT NOT NULL,
        source_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_customer_kind ON evidence(customer_id, kind);

      CREATE TABLE IF NOT EXISTS risk_assessments (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        score INTEGER,
        level TEXT NOT NULL,
        coverage INTEGER NOT NULL,
        dimensions_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        unknowns_json TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_risk_customer_time ON risk_assessments(customer_id, generated_at DESC);

      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        discovery_questions_json TEXT NOT NULL,
        recommended_action TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        UNIQUE(customer_id, type, title)
      );

      CREATE TABLE IF NOT EXISTS opportunity_generations (
        customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
        input_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        generated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS case_candidates (
        customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
        eligible INTEGER NOT NULL,
        reason TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS case_drafts (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        published_page_id TEXT,
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS case_publish_attempts (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES case_drafts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        parent_page_id TEXT NOT NULL,
        request_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        page_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_case_publish_draft ON case_publish_attempts(draft_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS action_items (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        why_now TEXT NOT NULL,
        owner TEXT,
        due_at TEXT,
        expected_outcome TEXT,
        evidence_refs_json TEXT NOT NULL,
        source_meeting_id TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new',
        outcome TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_action_status_due ON action_items(status, due_at);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        source_status_json TEXT NOT NULL DEFAULT '{}',
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS hemory_attributions (
        event_id TEXT PRIMARY KEY REFERENCES source_events(id) ON DELETE CASCADE,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        attributed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hemory_attribution_customer ON hemory_attributions(customer_id, attributed_at DESC);

      CREATE TABLE IF NOT EXISTS hemory_segmentation_jobs (
        id TEXT PRIMARY KEY,
        recording_event_id TEXT NOT NULL REFERENCES source_events(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        segment_count INTEGER NOT NULL DEFAULT 0,
        generator TEXT,
        error TEXT,
        input_meta_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hemory_segmentation_status ON hemory_segmentation_jobs(status, updated_at);

      CREATE TABLE IF NOT EXISTS hemory_fragment_generations (
        event_id TEXT PRIMARY KEY REFERENCES source_events(id) ON DELETE CASCADE,
        recording_event_id TEXT NOT NULL REFERENCES source_events(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hemory_fragment_recording ON hemory_fragment_generations(recording_event_id, active);

      CREATE TABLE IF NOT EXISTS draft_batches (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL UNIQUE,
        source_event_ids_json TEXT NOT NULL,
        generation_version TEXT NOT NULL,
        generator TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_draft_batch_customer ON draft_batches(customer_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS draft_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES draft_batches(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        target_system TEXT NOT NULL,
        target_object TEXT NOT NULL,
        target_tool TEXT,
        target_arguments_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        unknowns_json TEXT NOT NULL,
        validation_errors_json TEXT NOT NULL,
        approval_hash TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_draft_item_batch ON draft_items(batch_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_draft_item_status ON draft_items(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS draft_generation_jobs (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL UNIQUE,
        source_event_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        kind TEXT NOT NULL DEFAULT 'hemory',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_draft_job_status ON draft_generation_jobs(status, updated_at);

      CREATE TABLE IF NOT EXISTS weekly_reports (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        week_start TEXT NOT NULL,
        week_end TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        content_json TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        generator TEXT,
        fingerprint TEXT NOT NULL,
        published_page_id TEXT,
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(customer_id, week_start)
      );
      CREATE INDEX IF NOT EXISTS idx_weekly_report_customer ON weekly_reports(customer_id, week_start DESC);

      CREATE TABLE IF NOT EXISTS customer_alerts (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        trigger_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        reasons_json TEXT NOT NULL DEFAULT '[]',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_customer_alerts_status ON customer_alerts(status);
      CREATE INDEX IF NOT EXISTS idx_customer_alerts_customer ON customer_alerts(customer_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_alerts_active ON customer_alerts(customer_id, trigger_key) WHERE status='active';

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        user_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        wecom_userid TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_customer_access (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        last_synced_at TEXT NOT NULL,
        PRIMARY KEY(user_id, customer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_customer_access_customer ON user_customer_access(customer_id);

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

      CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
    `);
    const sourceEventColumns = this.db.prepare('PRAGMA table_info(source_events)').all() as Row[];
    if (!sourceEventColumns.some((column) => String(column.name) === 'display_id')) {
      this.db.exec('ALTER TABLE source_events ADD COLUMN display_id TEXT;');
    }
    // 存量库补 audit_log.user_id（新库建表已带；审批与人工操作此后记录登录用户）
    const auditColumns = this.db.prepare('PRAGMA table_info(audit_log)').all() as Row[];
    if (!auditColumns.some((column) => String(column.name) === 'user_id')) {
      this.db.exec('ALTER TABLE audit_log ADD COLUMN user_id INTEGER;');
    }
    // 存量库补 source_events.owner_user_id（多人化：Hemory 录音归属同步它的用户）
    const sourceEventOwnerColumns = this.db.prepare('PRAGMA table_info(source_events)').all() as Row[];
    if (!sourceEventOwnerColumns.some((column) => String(column.name) === 'owner_user_id')) {
      this.db.exec('ALTER TABLE source_events ADD COLUMN owner_user_id INTEGER;');
    }
    const draftJobColumns = this.db.prepare('PRAGMA table_info(draft_generation_jobs)').all() as Row[];
    if (!draftJobColumns.some((column) => String(column.name) === 'kind')) {
      this.db.exec("ALTER TABLE draft_generation_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'hemory';");
    }
    if (!draftJobColumns.some((column) => String(column.name) === 'note')) {
      this.db.exec('ALTER TABLE draft_generation_jobs ADD COLUMN note TEXT;');
    }
    if (!draftJobColumns.some((column) => String(column.name) === 'progress')) {
      this.db.exec('ALTER TABLE draft_generation_jobs ADD COLUMN progress TEXT;');
    }
    const segmentationJobColumns = this.db.prepare('PRAGMA table_info(hemory_segmentation_jobs)').all() as Row[];
    if (!segmentationJobColumns.some((column) => String(column.name) === 'input_meta_json')) {
      this.db.exec('ALTER TABLE hemory_segmentation_jobs ADD COLUMN input_meta_json TEXT;');
    }
    const caseDraftColumns = this.db.prepare('PRAGMA table_info(case_drafts)').all() as Row[];
    if (!caseDraftColumns.some((column) => String(column.name) === 'fingerprint')) {
      this.db.exec('ALTER TABLE case_drafts ADD COLUMN fingerprint TEXT;');
    }
    if (!caseDraftColumns.some((column) => String(column.name) === 'generator')) {
      this.db.exec('ALTER TABLE case_drafts ADD COLUMN generator TEXT;');
    }
    const customerColumns = this.db.prepare('PRAGMA table_info(customers)').all() as Row[];
    if (!customerColumns.some((column) => String(column.name) === 'after_sales_stage')) {
      this.db.exec('ALTER TABLE customers ADD COLUMN after_sales_stage TEXT;');
    }
    if (!customerColumns.some((column) => String(column.name) === 'source_object')) {
      this.db.exec('ALTER TABLE customers ADD COLUMN source_object TEXT;');
    }
    if (!customerColumns.some((column) => String(column.name) === 'usage_version')) {
      this.db.exec('ALTER TABLE customers ADD COLUMN usage_version TEXT;');
    }
    this.db.exec(`
      UPDATE source_events
      SET occurred_at = json_extract(payload_json, '$.field009')
      WHERE source_system = 'ones'
        AND source_type IN ('suggestion_feedback', 'support_ticket', 'operations_ticket')
        AND json_type(payload_json, '$.field009') = 'text';
      UPDATE source_events
      SET display_id = CASE
        WHEN json_type(payload_json, '$.display_id') = 'text' THEN json_extract(payload_json, '$.display_id')
        WHEN json_type(payload_json, '$.issue_number') = 'text' THEN json_extract(payload_json, '$.issue_number')
        ELSE display_id
      END
      WHERE source_system = 'ones'
        AND display_id IS NULL;
    `);
    // 待办状态收敛两态（未完成 new / 已完成 completed）：历史上 accepted/「接受」流程与 in_progress/snoozed/false_positive
    // 等仅 CLI 可设的旧状态在开库时一律归入未完成；completed 不动，保持周报完成统计口径（幂等，新库无旧状态行）。
    this.db.prepare(`UPDATE action_items SET status='new', updated_at=? WHERE status NOT IN ('new','completed')`).run(nowIso());
    // 预警触发键 ones_inactivity → engagement_inactivity（口径升级为 CRM+ONES 同时停滞）：不迁移则存量 active 行
    // 不再被 evaluate 触达、成为孤儿；重命名后由启动对账按新口径重估（不满足者自动解除）。幂等。
    this.db.prepare(`UPDATE customer_alerts SET trigger_key='engagement_inactivity' WHERE trigger_key='ones_inactivity'`).run();
    // 案例草稿收敛单版本：每客户只保留 updated_at 最新一行（平局以 id 决胜），历史版本行连同旧配图
    // 与发布尝试记录（FK 级联）一并删除。幂等自愈：createCaseDraft 建行时同样清理，此处兜底存量库。
    this.db.exec(`
      DELETE FROM case_drafts WHERE id NOT IN (
        SELECT id FROM case_drafts c WHERE NOT EXISTS (
          SELECT 1 FROM case_drafts n WHERE n.customer_id = c.customer_id
            AND (n.updated_at > c.updated_at OR (n.updated_at = c.updated_at AND n.id > c.id))))
    `);
    // 公开动态证据按自然键 (customer, kind, source_url, occurred_at) 收敛：每键只保留最早一行。
    // 90 天新闻窗 + 两周轮换会反复命中同一条新闻，历史无唯一约束已产生重复行——不去重会持续堆积
    // 并按行数抬高风险「公开动态」负向档位（0/1/≥2）；清完存量再建唯一索引兜底（幂等，新库无行可清）。
    this.db.exec(`
      DELETE FROM evidence WHERE source_url IS NOT NULL AND id NOT IN (
        SELECT id FROM evidence e WHERE source_url IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM evidence older WHERE older.source_url IS NOT NULL
            AND older.customer_id = e.customer_id AND older.kind = e.kind
            AND older.source_url = e.source_url AND older.occurred_at = e.occurred_at
            AND (older.created_at < e.created_at OR (older.created_at = e.created_at AND older.id < e.id))
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_natural_key
        ON evidence(customer_id, kind, source_url, occurred_at);
    `);
    this.repairMiswrittenDraftItems();
  }

  /**
   * 翻转“假成功”草稿：written 但响应载荷是明确失败（ONES result 非 SUCCESS，或 CRM resultCode 非 SUCCESS /
   * save_status 未落库）。历史上 execute 只看 MCP isError，业务失败被标成 written 后无法重试也无法重新生成。
   * 幂等：翻转后 error 有值、result 保留原载荷，重启不再命中。
   */
  private repairMiswrittenDraftItems(): void {
    const rows = this.db.prepare("SELECT id, batch_id, target_system, result_json FROM draft_items WHERE status='written' AND error IS NULL AND result_json IS NOT NULL").all() as Row[];
    for (const row of rows) {
      const failure = extractDraftFailurePayload(String(row.result_json), String(row.target_system ?? ''));
      if (!failure) continue;
      const reason = `历史执行业务失败（已由数据修复翻转）: ${failure.message}`;
      this.db.prepare("UPDATE draft_items SET status='failed', error=?, updated_at=? WHERE id=?")
        .run(reason, nowIso(), String(row.id));
      this.audit('csm', 'repair_written_draft_status', 'draft_item', String(row.id), { targetSystem: String(row.target_system ?? ''), reason });
      this.refreshDraftBatchStatus(String(row.batch_id));
    }
  }

  upsertCustomer(input: CustomerInput): Customer {
    const now = nowIso();
    const previous = this.getCustomer(input.id);
    this.db.prepare(`
      INSERT INTO customers (
        id,name,short_name,industry,usage_version,csm_name,csm_wecom_userid,source_object,after_sales_stage,renewal_date,contract_value,contract_status,
        products_json,last_contact_at,support_open_count,support_blocked_count,voice_risk,explicit_nonrenewal,
        next_action,next_action_due,crm_url,health,synced_at,source_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, short_name=excluded.short_name, industry=excluded.industry, usage_version=excluded.usage_version,
        csm_name=excluded.csm_name, csm_wecom_userid=COALESCE(excluded.csm_wecom_userid,customers.csm_wecom_userid),
        source_object=excluded.source_object,
        after_sales_stage=excluded.after_sales_stage,
        renewal_date=excluded.renewal_date, contract_value=excluded.contract_value, contract_status=excluded.contract_status,
        products_json=excluded.products_json, last_contact_at=excluded.last_contact_at,
        support_open_count=COALESCE(excluded.support_open_count,customers.support_open_count),
        support_blocked_count=COALESCE(excluded.support_blocked_count,customers.support_blocked_count),
        voice_risk=COALESCE(excluded.voice_risk,customers.voice_risk),
        explicit_nonrenewal=COALESCE(excluded.explicit_nonrenewal,customers.explicit_nonrenewal),
        next_action=COALESCE(excluded.next_action,customers.next_action),
        next_action_due=COALESCE(excluded.next_action_due,customers.next_action_due),
        crm_url=excluded.crm_url, synced_at=excluded.synced_at, source_json=excluded.source_json, updated_at=excluded.updated_at
    `).run(
      input.id, input.name, input.shortName ?? null, input.industry ?? null, input.usageVersion ?? null, input.csmName ?? null,
      input.csmWecomUserid ?? null, input.sourceObject ?? 'object_Umwnn__c', normalizeAfterSalesStage(input.afterSalesStage), input.renewalDate ?? null, input.contractValue ?? null, input.contractStatus ?? null,
      json(input.products ?? []), input.lastContactAt ?? null, input.supportOpenCount ?? null, input.supportBlockedCount ?? null,
      input.voiceRisk == null ? null : Number(input.voiceRisk), input.explicitNonrenewal == null ? null : Number(input.explicitNonrenewal),
      input.nextAction ?? null, input.nextActionDue ?? null, input.crmUrl ?? null, previous?.health ?? 'unknown',
      input.syncedAt ?? now, json(input.source ?? {}), previous?.createdAt ?? now, now,
    );
    return this.getCustomer(input.id)!;
  }

  getCustomer(id: string): Customer | undefined {
    const row = this.db.prepare('SELECT * FROM customers WHERE id=?').get(id) as Row | undefined;
    return row ? customerFromRow(row) : undefined;
  }

  /** 精确全称/简称匹配（不限可见性，含隐藏历史行）：维护类入口（客户合并）按名称定位候选用。 */
  listCustomersByExactName(name: string): Customer[] {
    return (this.db.prepare('SELECT * FROM customers WHERE name=? OR short_name=?').all(name, name) as Row[])
      .map((row) => customerFromRow(row));
  }

  /**
   * 合并重复客户（同一 CRM 客户双行/幽灵行修复）：from 行的全部挂载数据改挂到 into 行后删除
   * from 行。逐表 UPDATE OR IGNORE 改挂；唯一键冲突的残留行（into 侧已有同自然键记录）以 into
   * 侧为准丢弃；customer_id 为主键的 1:1 表（机会生成态/案例候选）在 into 侧已有行时同样丢弃
   * from 行。customers 字段只回填 into 侧为 NULL 的列（目标行数据权威）。全程单事务，逐表计数落审计。
   */
  mergeCustomers(fromId: string, intoId: string, actor = 'csm', userId?: number): {
    from: string;
    into: string;
    tables: Record<string, { moved: number; dropped: number }>;
    fieldsFilled: string[];
  } {
    if (fromId === intoId) throw new Error('from 与 into 不能是同一客户');
    const from = this.getCustomer(fromId);
    const into = this.getCustomer(intoId);
    if (!from) throw new Error(`客户不存在（from）: ${fromId}`);
    if (!into) throw new Error(`客户不存在（into）: ${intoId}`);
    // 引用 customer_id 的全部表（建表口径）；customer_id 为主键的 1:1 表单列，走丢弃分支。
    const regularTables = ['customer_aliases', 'external_identities', 'source_events', 'evidence', 'risk_assessments',
      'opportunities', 'case_drafts', 'action_items', 'sync_runs', 'hemory_attributions', 'draft_batches',
      'draft_items', 'draft_generation_jobs', 'weekly_reports', 'customer_alerts', 'user_customer_access'];
    const pkTables = ['opportunity_generations', 'case_candidates'];
    const result = { from: fromId, into: intoId, tables: {} as Record<string, { moved: number; dropped: number }>, fieldsFilled: [] as string[] };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of regularTables) {
        const moved = Number(this.db.prepare(`UPDATE OR IGNORE ${table} SET customer_id=? WHERE customer_id=?`).run(intoId, fromId).changes);
        const dropped = Number(this.db.prepare(`DELETE FROM ${table} WHERE customer_id=?`).run(fromId).changes);
        result.tables[table] = { moved, dropped };
      }
      for (const table of pkTables) {
        const intoRow = this.db.prepare(`SELECT 1 FROM ${table} WHERE customer_id=?`).get(intoId);
        const dropped = Number(this.db.prepare(`DELETE FROM ${table} WHERE customer_id=?`).run(fromId).changes);
        result.tables[table] = { moved: intoRow ? 0 : dropped, dropped: intoRow ? dropped : 0 };
      }
      const fillable: Array<[column: string, value: string | number]> = ([
        ['short_name', from.shortName], ['industry', from.industry], ['usage_version', from.usageVersion],
        ['csm_name', from.csmName], ['csm_wecom_userid', from.csmWecomUserid], ['after_sales_stage', from.afterSalesStage],
        ['renewal_date', from.renewalDate], ['contract_value', from.contractValue], ['contract_status', from.contractStatus],
        ['last_contact_at', from.lastContactAt], ['support_open_count', from.supportOpenCount],
        ['support_blocked_count', from.supportBlockedCount], ['next_action', from.nextAction],
        ['next_action_due', from.nextActionDue], ['crm_url', from.crmUrl],
      ] as Array<[string, unknown]>).filter(([, value]) => value != null && String(value) !== '') as Array<[string, string | number]>;
      for (const [column, value] of fillable) {
        const filled = Number(this.db.prepare(`UPDATE customers SET ${column}=?, updated_at=? WHERE id=? AND ${column} IS NULL`)
          .run(value, nowIso(), intoId).changes);
        if (filled) result.fieldsFilled.push(column);
      }
      this.db.prepare('DELETE FROM customers WHERE id=?').run(fromId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.audit(actor, 'customers_merge', 'customer', intoId, { ...result, tables: result.tables }, userId);
    return result;
  }

  listCustomers(query = '', sort: 'default' | 'renewal_date' | 'renewal_amount' = 'default', userId?: number): Customer[] {
    const rows = this.db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM opportunities o WHERE o.customer_id=c.id AND o.status!='dismissed') AS opportunity_count,
        COALESCE((SELECT eligible FROM case_candidates cc WHERE cc.customer_id=c.id),0) AS case_candidate
      FROM customers c
      WHERE COALESCE(c.source_object, '') = 'object_Umwnn__c'
        AND TRIM(COALESCE(c.after_sales_stage, '')) <> '流失'
        AND COALESCE(c.contract_status, '') <> '已流失'
        AND (?='' OR c.name LIKE ? OR COALESCE(c.short_name,'') LIKE ? OR COALESCE(c.csm_name,'') LIKE ?
          OR EXISTS (SELECT 1 FROM customer_aliases ca WHERE ca.customer_id=c.id AND ca.alias LIKE ?))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM user_customer_access a WHERE a.user_id=? AND a.customer_id=c.id))
    `).all(query, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, userId ?? null, userId ?? null) as Row[];
    const customers = rows.map((row) => {
      const customer = customerFromRow(row);
      customer.risk = this.latestRisk(customer.id);
      customer.health = customer.risk?.level ?? customer.health;
      customer.opportunityCount = Number(row.opportunity_count ?? 0);
      customer.caseCandidate = Number(row.case_candidate ?? 0) === 1;
      customer.renewalWithin120Days = renewalWithin(customer, 120);
      customer.stale = !customer.syncedAt || Date.now() - new Date(customer.syncedAt).getTime() > 36 * 3_600_000;
      return customer;
    });
    const values = customers.map((item) => item.contractValue ?? 0).sort((a, b) => a - b);
    const threshold = values.length ? values[Math.max(0, Math.ceil(values.length * 0.8) - 1)] : Infinity;
    for (const customer of customers) customer.highValue = customer.contractValue != null && customer.contractValue >= threshold;
    if (sort === 'renewal_date') {
      return customers.sort((a, b) => {
        const aTime = a.renewalDate ? Date.parse(a.renewalDate) : Number.POSITIVE_INFINITY;
        const bTime = b.renewalDate ? Date.parse(b.renewalDate) : Number.POSITIVE_INFINITY;
        return aTime - bTime || a.name.localeCompare(b.name, 'zh-CN');
      });
    }
    if (sort === 'renewal_amount') {
      return customers.sort((a, b) =>
        (b.contractValue == null ? Number.NEGATIVE_INFINITY : b.contractValue)
        - (a.contractValue == null ? Number.NEGATIVE_INFINITY : a.contractValue)
        || a.name.localeCompare(b.name, 'zh-CN'));
    }
    const riskOrder = { high: 0, medium: 1, unknown: 2, low: 3 };
    return customers.sort((a, b) =>
      Number(b.renewalWithin120Days) - Number(a.renewalWithin120Days)
      || Number(b.highValue) - Number(a.highValue)
      || riskOrder[a.health] - riskOrder[b.health]
      || (b.contractValue ?? 0) - (a.contractValue ?? 0));
  }

  setCustomerHealth(customerId: string, health: Customer['health']): void {
    this.db.prepare('UPDATE customers SET health=?, updated_at=? WHERE id=?').run(health, nowIso(), customerId);
  }

  // ── 客户可见性映射（多人化：你的凭证拉到的客户 = 你可见的客户；领导账号权限大 → 拉到区域全集）──

  /** 授予用户对客户的可见性（幂等 upsert；CRM/ONES 同步命中即调用）。 */
  grantCustomerAccess(userId: number, customerIds: string[]): void {
    if (!customerIds.length) return;
    const stmt = this.db.prepare('INSERT INTO user_customer_access(user_id,customer_id,last_synced_at) VALUES(?,?,?) ' +
      'ON CONFLICT(user_id,customer_id) DO UPDATE SET last_synced_at=excluded.last_synced_at');
    const now = nowIso();
    for (const customerId of customerIds) stmt.run(userId, customerId, now);
  }

  /** 一次性迁移：把存量全部客户授予指定用户（单用户时代升级，历史客户全归 admin）。 */
  grantAllCustomersToUser(userId: number): number {
    const rows = this.db.prepare(`INSERT INTO user_customer_access(user_id,customer_id,last_synced_at)
      SELECT ?, id, ? FROM customers c
      WHERE COALESCE(c.source_object,'')='object_Umwnn__c'
        AND TRIM(COALESCE(c.after_sales_stage,''))<>'流失' AND COALESCE(c.contract_status,'')<>'已流失'
      ON CONFLICT(user_id,customer_id) DO UPDATE SET last_synced_at=excluded.last_synced_at`).run(userId, nowIso());
    return Number(rows.changes);
  }

  customerAccessExists(userId: number, customerId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM user_customer_access WHERE user_id=? AND customer_id=?').get(userId, customerId);
  }

  countCustomerAccess(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM user_customer_access').get() as Row).n);
  }

  /** 某用户可见的全部客户 ID（粗粒度集合，供业务列表过滤）。 */
  customerIdsVisibleTo(userId: number): Set<string> {
    return new Set((this.db.prepare('SELECT customer_id FROM user_customer_access WHERE user_id=?').all(userId) as Row[])
      .map((row) => String(row.customer_id)));
  }

  /** 某用户自己的 Hemory 录音 ID 集（vault 归属）：待归属片段收件箱的可见边界。 */
  hemoryRecordingIdsOwnedBy(userId: number): Set<string> {
    return new Set((this.db.prepare("SELECT external_id FROM source_events WHERE source_system='hemory' AND source_type='raw_transcript' AND owner_user_id=?")
      .all(userId) as Row[]).map((row) => String(row.external_id)));
  }

  /** 客户别名（工作台本地叠加层，同步不覆盖）：供口语简称/品牌名解析，顺序稳定。 */
  listCustomerAliases(customerId: string): string[] {
    return (this.db.prepare('SELECT alias FROM customer_aliases WHERE customer_id=? ORDER BY id').all(customerId) as Row[])
      .map((row) => String(row.alias));
  }

  /**
   * 整组替换客户别名。跨客户冲突校验只针对**可见活跃**客户（与 listCustomers 同一过滤口径）：
   * 别名撞其他可见客户的名称/简称/别名会人为制造解析歧义，直接拒绝；隐藏的旧 AccountObj 行不参与
   * （如旧行 short_name「青禾晶元」不应阻止把该品牌名维护为当前活跃客户的别名）。
   */
  setCustomerAliases(customerId: string, aliases: unknown, actor = 'csm'): string[] {
    if (!this.getCustomer(customerId)) throw new Error('customer not found');
    const next = [...new Set((Array.isArray(aliases) ? aliases : [aliases])
      .map((alias) => String(alias).trim()).filter(Boolean))];
    for (const alias of next) {
      const clash = this.db.prepare(`
        SELECT c.name FROM customers c
        WHERE c.id<>? AND COALESCE(c.source_object,'')='object_Umwnn__c'
          AND TRIM(COALESCE(c.after_sales_stage,''))<>'流失' AND COALESCE(c.contract_status,'')<>'已流失'
          AND (c.name=? OR COALESCE(c.short_name,'')=?)
        LIMIT 1
      `).get(customerId, alias, alias) as Row | undefined
        ?? this.db.prepare(`SELECT a.customer_id FROM customer_aliases a WHERE a.customer_id<>? AND a.alias=? LIMIT 1`)
          .get(customerId, alias) as Row | undefined;
      if (clash) throw new Error(`别名「${alias}」与其他客户（${String(clash.name ?? clash.customer_id)}）的名称/简称/别名冲突，拒绝维护以避免解析歧义`);
    }
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM customer_aliases WHERE customer_id=?').run(customerId);
      const insert = this.db.prepare('INSERT INTO customer_aliases(customer_id,alias,created_at,updated_at) VALUES(?,?,?,?)');
      for (const alias of next) insert.run(customerId, alias, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.audit(actor, 'customer_aliases_update', 'customer', customerId, { aliases: next });
    return this.listCustomerAliases(customerId);
  }

  updateSupportStats(customerId: string, openCount: number, blockedCount: number): void {
    this.db.prepare('UPDATE customers SET support_open_count=?,support_blocked_count=?,updated_at=? WHERE id=?')
      .run(openCount, blockedCount, nowIso(), customerId);
  }

  upsertIdentity(customerId: string, system: string, externalId: string, label: string, status = 'confirmed', evidenceRefs: string[] = []): void {
    this.db.prepare(`
      INSERT INTO external_identities(customer_id,system,external_id,label,status,evidence_json,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(system,external_id) DO UPDATE SET customer_id=excluded.customer_id,label=excluded.label,status=excluded.status,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
    `).run(customerId, system, externalId, label, status, json(evidenceRefs), nowIso());
  }

  listIdentities(customerId: string): Row[] {
    return this.db.prepare('SELECT * FROM external_identities WHERE customer_id=? ORDER BY system').all(customerId) as Row[];
  }

  /** 候选事件的 payload 里带 crmCustomerId，但事件本身无客户归属，按前缀匹配取回。 */
  listSourceEvents(sourceSystem: string, sourceType: string, customerId: string): Row[] {
    return this.db.prepare(
      'SELECT * FROM source_events WHERE source_system=? AND source_type=? AND external_id LIKE ? ORDER BY occurred_at DESC',
    ).all(sourceSystem, sourceType, `${customerId}:%`) as Row[];
  }

  upsertSourceEvent(input: SourceEventInput): SourceEvent {
    const payload = input.payload ?? {};
    const payloadHash = createHash('sha256').update(json(payload)).digest('hex');
    const id = input.id ?? randomUUID();
    const syncedAt = input.syncedAt ?? nowIso();
    const attribution = input.attributionStatus ?? (input.customerId ? 'confirmed' : 'unattributed');
    this.db.prepare(`
      INSERT INTO source_events(id,customer_id,source_system,source_type,external_id,display_id,title,occurred_at,synced_at,confidence,url,payload_json,payload_hash,attribution_status,owner_user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_system,source_type,external_id) DO UPDATE SET
        customer_id=excluded.customer_id,display_id=COALESCE(excluded.display_id,source_events.display_id),title=excluded.title,occurred_at=excluded.occurred_at,synced_at=excluded.synced_at,
        confidence=excluded.confidence,url=excluded.url,payload_json=excluded.payload_json,payload_hash=excluded.payload_hash,attribution_status=excluded.attribution_status
    `).run(id, input.customerId ?? null, input.sourceSystem, input.sourceType, input.externalId, input.displayId ?? null, input.title, input.occurredAt,
      syncedAt, input.confidence ?? 1, input.url ?? null, json(payload), payloadHash, attribution, input.ownerUserId ?? null);
    const row = this.db.prepare('SELECT * FROM source_events WHERE source_system=? AND source_type=? AND external_id=?')
      .get(input.sourceSystem, input.sourceType, input.externalId) as Row;
    if (input.sourceSystem === 'hemory' && input.sourceType === 'ai_topic_segment') {
      const override = this.db.prepare('SELECT * FROM hemory_attributions WHERE event_id=?').get(String(row.id)) as Row | undefined;
      if (override) {
        this.db.prepare('UPDATE source_events SET customer_id=?,attribution_status=? WHERE id=?')
          .run(override.customer_id == null ? null : String(override.customer_id), String(override.status), String(row.id));
        row.customer_id = override.customer_id ?? null;
        row.attribution_status = override.status;
      }
    }
    return sourceEventFromRow(row);
  }

  findSourceEvent(sourceSystem: string, sourceType: string, externalId: string): SourceEvent | undefined {
    const row = this.db.prepare('SELECT * FROM source_events WHERE source_system=? AND source_type=? AND external_id=?')
      .get(sourceSystem, sourceType, externalId) as Row | undefined;
    return row ? sourceEventFromRow(row) : undefined;
  }

  getSourceEvent(id: string): SourceEvent | undefined {
    const row = this.db.prepare('SELECT * FROM source_events WHERE id=?').get(id) as Row | undefined;
    return row ? sourceEventFromRow(row) : undefined;
  }

  /** 客户绑定的「客户工时管理 / 售后客户」工作项：精确查询而非 listTimeline 截断窗口内查找。 */
  findCustomerManhourIssue(customerId: string): SourceEvent | undefined {
    const row = this.db.prepare("SELECT * FROM source_events WHERE customer_id=? AND source_system='ones' AND source_type='customer_manhour' AND attribution_status='confirmed' ORDER BY occurred_at DESC, external_id DESC LIMIT 1")
      .get(customerId) as Row | undefined;
    return row ? sourceEventFromRow(row) : undefined;
  }

  listTimeline(customerId: string, limit = 100): SourceEvent[] {
    // 停用的 Hemory 片段（被新代际取代）不再进入客户时间线，避免重切后新旧并存；未登记代际的历史行不受影响。
    const rows = this.db.prepare(`SELECT * FROM source_events WHERE customer_id=?
      AND NOT EXISTS (SELECT 1 FROM hemory_fragment_generations g WHERE g.event_id=source_events.id AND g.active=0)
      ORDER BY occurred_at DESC, external_id DESC LIMIT ?`).all(customerId, limit) as Row[];
    return rows.map(sourceEventFromRow);
  }

  /** 案例生成使用的完整客户事件集；与分页 UI 无关，不截断长期客户历史。 */
  listCaseContextEvents(customerId: string): SourceEvent[] {
    const rows = this.db.prepare(`SELECT * FROM source_events WHERE customer_id=?
      AND attribution_status='confirmed'
      AND source_type!='customer_snapshot'
      AND NOT EXISTS (SELECT 1 FROM hemory_fragment_generations g WHERE g.event_id=source_events.id AND g.active=0)
      ORDER BY datetime(occurred_at), external_id`).all(customerId) as Row[];
    return rows.map(sourceEventFromRow);
  }

  /**
   * ONES 工作项完成率（全量口径，不受 listTimeline 截断窗口影响）：suggestion_feedback / support_ticket / operations_ticket。
   * 完成判定与概览数据卡一致——payload.field005.category==='done'，绝不拿状态名猜；
   * 任一记录缺 category → stale=true（旧同步数据，「刷新三套系统」后出数）。
   */
  onesCompletionRates(customerId: string): Record<'suggestion_feedback' | 'support_ticket' | 'operations_ticket', CompletionRate> {
    const rates = {} as Record<'suggestion_feedback' | 'support_ticket' | 'operations_ticket', CompletionRate>;
    const rows = this.db.prepare(`SELECT source_type,payload_json FROM source_events
      WHERE customer_id=? AND source_system='ones' AND attribution_status='confirmed'
      AND source_type IN ('suggestion_feedback','support_ticket','operations_ticket')`).all(customerId) as Row[];
    const byType = new Map<string, { done: number; total: number; stale: boolean }>();
    for (const row of rows) {
      const type = String(row.source_type);
      const stat = byType.get(type) ?? { done: 0, total: 0, stale: false };
      const payload = parseJson(row.payload_json, {}) as Record<string, unknown>;
      const status = payload?.field005;
      const category = status && typeof status === 'object' && !Array.isArray(status)
        ? (status as Record<string, unknown>).category : null;
      stat.total += 1;
      if (typeof category === 'string' && category) {
        if (category === 'done') stat.done += 1;
      } else {
        stat.stale = true;
      }
      byType.set(type, stat);
    }
    for (const type of ['suggestion_feedback', 'support_ticket', 'operations_ticket'] as const) {
      const stat = byType.get(type) ?? { done: 0, total: 0, stale: false };
      rates[type] = { type, done: stat.done, total: stat.total, stale: stat.stale, pct: stat.total ? Math.round((stat.done / stat.total) * 100) : 0 };
    }
    return rates;
  }


  listUnattributed(limit = 100): SourceEvent[] {
    const rows = this.db.prepare("SELECT * FROM source_events WHERE attribution_status NOT IN ('confirmed','ignored') ORDER BY occurred_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(sourceEventFromRow);
  }

  listHemoryFragments(filters: { status?: string; customerId?: string; date?: string; since?: string; until?: string; recordingId?: string; limit?: number; cursor?: string; days?: number } = {}): SourceEvent[] {
    const clauses = ["source_system='hemory'", "source_type='ai_topic_segment'", 'g.active=1'];
    const args: Array<string | number | null> = [];
    if (filters.customerId) { clauses.push('customer_id=?'); args.push(filters.customerId); }
    if (filters.status && filters.status !== 'all') {
      if (filters.status === 'pending') clauses.push("attribution_status NOT IN ('confirmed','ignored')");
      else { clauses.push('attribution_status=?'); args.push(filters.status); }
    }
    // occurred_at 历史上混有 +08:00 与 Z 两种 ISO 格式，比较/排序必须先经 datetime() 归一化，否则同日字面时刻会错位。
    if (filters.date) {
      const range = shanghaiDayRange(filters.date);
      clauses.push('datetime(occurred_at)>=datetime(?)', 'datetime(occurred_at)<=datetime(?)');
      args.push(range.start, range.end);
    }
    // 时间段过滤（since/until，ISO 时刻、闭区间）：与 date 一样必须经 datetime() 归一化，支持只填一边的开区间。
    if (filters.since) { clauses.push('datetime(occurred_at)>=datetime(?)'); args.push(filters.since); }
    if (filters.until) { clauses.push('datetime(occurred_at)<=datetime(?)'); args.push(filters.until); }
    // 待归属默认只保留最近 7 个上海自然日，避免长期不处理导致列表堆积；显式日期/时间段/全部状态不受限。
    if (filters.status === 'pending' && !filters.date && !filters.since && !filters.until) {
      const days = Math.max(0, filters.days ?? HEMORY_PENDING_WINDOW_DAYS);
      if (days > 0) {
        const start = new Date(shanghaiTodayStart().getTime() - (days - 1) * 86_400_000);
        clauses.push('datetime(occurred_at)>=datetime(?)');
        args.push(start.toISOString());
      }
    }
    if (filters.recordingId) { clauses.push("json_extract(payload_json,'$.recordingId')=?"); args.push(filters.recordingId); }
    if (filters.cursor) { clauses.push('datetime(occurred_at)<datetime(?)'); args.push(filters.cursor); }
    const limit = Math.min(500, Math.max(1, filters.limit ?? 100));
    const rows = this.db.prepare(`SELECT e.* FROM source_events e JOIN hemory_fragment_generations g ON g.event_id=e.id WHERE ${clauses.map((clause) => clause.replace(/\b(source_system|source_type|attribution_status|payload_json)\b/g, 'e.$1').replace(/\boccurred_at\b/g, 'e.occurred_at')).join(' AND ')} ORDER BY datetime(e.occurred_at) DESC LIMIT ?`)
      .all(...args, limit) as Row[];
    return rows.map(sourceEventFromRow);
  }

  getHemoryAttribution(eventId: string): HemoryAttributionOverride | undefined {
    const row = this.db.prepare('SELECT * FROM hemory_attributions WHERE event_id=?').get(eventId) as Row | undefined;
    return row ? { eventId: String(row.event_id), customerId: row.customer_id as string | null,
      status: String(row.status) as HemoryAttributionOverride['status'], actor: String(row.actor), payloadHash: String(row.payload_hash),
      attributedAt: String(row.attributed_at) } : undefined;
  }

  listConfirmedHemorySegments(customerId: string): SourceEvent[] {
    // hemory_fragment_generations 只由分段服务维护；测试与历史数据可能缺失登记，
    // 因此对没有登记行的片段回退为直接按 source_events 过滤。
    const registered = this.db.prepare(`SELECT e.* FROM source_events e JOIN hemory_fragment_generations g ON g.event_id=e.id
      WHERE e.customer_id=? AND e.source_system='hemory' AND e.source_type='ai_topic_segment' AND e.attribution_status='confirmed' AND g.active=1`).all(customerId) as Row[];
    const rows = registered.length
      ? registered
      : this.db.prepare(`SELECT * FROM source_events WHERE customer_id=? AND source_system='hemory' AND source_type='ai_topic_segment'
          AND attribution_status='confirmed' AND id NOT IN (SELECT event_id FROM hemory_fragment_generations WHERE active=0)`).all(customerId) as Row[];
    return rows.map(sourceEventFromRow).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  /** 客户在某上海自然日的全部已确认活跃片段；occurred_at 混有 +08:00/Z 格式，必须 datetime() 归一化。 */
  listConfirmedHemorySegmentsForDay(customerId: string, date: string): SourceEvent[] {
    const range = shanghaiDayRange(date);
    return this.listConfirmedHemorySegments(customerId)
      .filter((event) => {
        const at = new Date(event.occurredAt);
        return at.getTime() >= new Date(range.start).getTime() && at.getTime() <= new Date(range.end).getTime();
      });
  }

  /**
   * 每日沟通记录的“已发布”信号：当天已 written 的 followup 草稿引用的证据事件、
   * 以及本地同步到的 CRM 跟进记录（含手动录入）事件 occurredAt 的最大值。
   * 返回 null 表示当天无已发布记录；调用方以此作为豁免截断点。
   */
  followupPublishedCutoff(customerId: string, date: string): string | null {
    const range = shanghaiDayRange(date);
    const inRange = (value: string) => {
      const at = new Date(value).getTime();
      return at >= new Date(range.start).getTime() && at <= new Date(range.end).getTime();
    };
    let cutoff: number | null = null;
    const touch = (value: string) => {
      if (!inRange(value)) return;
      const at = new Date(value).getTime();
      if (cutoff == null || at > cutoff) cutoff = at;
    };
    for (const row of this.db.prepare(`SELECT di.evidence_refs_json FROM draft_items di
        WHERE di.customer_id=? AND di.type='followup' AND di.status='written'`).all(customerId) as Row[]) {
      for (const eventId of parseJson<string[]>(row.evidence_refs_json, [])) {
        const event = this.getSourceEvent(eventId);
        if (event?.customerId === customerId && event.sourceSystem === 'hemory') touch(event.occurredAt);
      }
    }
    for (const row of this.db.prepare(`SELECT occurred_at FROM source_events
        WHERE customer_id=? AND source_system='crm' AND source_type='crm_followup'`).all(customerId) as Row[]) {
      touch(String(row.occurred_at));
    }
    return cutoff == null ? null : new Date(cutoff).toISOString();
  }

  findDraftBatchByFingerprint(fingerprint: string): DraftBatch | undefined {
    const row = this.db.prepare('SELECT * FROM draft_batches WHERE fingerprint=?').get(fingerprint) as Row | undefined;
    return row ? { ...draftBatchFromRow(row), items: this.listDraftItems(String(row.id)) } : undefined;
  }

  attributeHemoryFragments(eventIds: string[], customerId: string | null, expectedHashes: Record<string, string>, actor = 'csm'): SourceEvent[] {
    if (customerId && !this.getCustomer(customerId)) throw new Error('customer not found');
    const now = nowIso();
    const changed: SourceEvent[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const eventId of [...new Set(eventIds)]) {
        const event = this.getSourceEvent(eventId);
        if (!event || event.sourceSystem !== 'hemory' || event.sourceType !== 'ai_topic_segment') throw new Error(`Hemory fragment not found: ${eventId}`);
        if (expectedHashes[eventId] && expectedHashes[eventId] !== event.payloadHash) throw new Error(`片段内容已变化，请刷新后重试: ${eventId}`);
        const previousCustomerId = event.customerId ?? null;
        const status = customerId ? 'confirmed' : 'unattributed';
        this.db.prepare(`INSERT INTO hemory_attributions(event_id,customer_id,status,actor,payload_hash,attributed_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(event_id) DO UPDATE SET customer_id=excluded.customer_id,status=excluded.status,actor=excluded.actor,payload_hash=excluded.payload_hash,attributed_at=excluded.attributed_at`)
          .run(eventId, customerId, status, actor, event.payloadHash, now);
        this.db.prepare('UPDATE source_events SET customer_id=?,attribution_status=?,confidence=? WHERE id=?')
          .run(customerId, status, customerId ? 1 : 0.2, eventId);
        this.audit(actor, customerId ? 'attribute_hemory_fragment' : 'clear_hemory_attribution', 'source_event', eventId,
          { previousCustomerId, customerId, payloadHash: event.payloadHash });
        changed.push(this.getSourceEvent(eventId)!);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  /** 忽略片段：从待归属列表隐藏且重同步不再进入；写入 override，恢复走 attributeHemoryFragments(ids, null)。 */
  ignoreHemoryFragments(eventIds: string[], expectedHashes: Record<string, string>, actor = 'csm'): SourceEvent[] {
    const now = nowIso();
    const changed: SourceEvent[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const eventId of [...new Set(eventIds)]) {
        const event = this.getSourceEvent(eventId);
        if (!event || event.sourceSystem !== 'hemory' || event.sourceType !== 'ai_topic_segment') throw new Error(`Hemory fragment not found: ${eventId}`);
        if (expectedHashes[eventId] && expectedHashes[eventId] !== event.payloadHash) throw new Error(`片段内容已变化，请刷新后重试: ${eventId}`);
        const previousCustomerId = event.customerId ?? null;
        this.db.prepare(`INSERT INTO hemory_attributions(event_id,customer_id,status,actor,payload_hash,attributed_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(event_id) DO UPDATE SET customer_id=excluded.customer_id,status=excluded.status,actor=excluded.actor,payload_hash=excluded.payload_hash,attributed_at=excluded.attributed_at`)
          .run(eventId, null, 'ignored', actor, event.payloadHash, now);
        this.db.prepare('UPDATE source_events SET customer_id=?,attribution_status=?,confidence=? WHERE id=?')
          .run(null, 'ignored', 0, eventId);
        this.audit(actor, 'ignore_hemory_fragment', 'source_event', eventId, { previousCustomerId, payloadHash: event.payloadHash });
        changed.push(this.getSourceEvent(eventId)!);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  createHemorySegmentationJob(recordingEventId: string, fingerprint: string): HemorySegmentationJob {
    const existing = this.db.prepare('SELECT * FROM hemory_segmentation_jobs WHERE fingerprint=?').get(fingerprint) as Row | undefined;
    if (existing) return this.hemorySegmentationJobFromRow(existing);
    const now = nowIso();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO hemory_segmentation_jobs(id,recording_event_id,fingerprint,status,attempts,segment_count,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, recordingEventId, fingerprint, 'pending', 0, 0, now, now);
    return this.getHemorySegmentationJob(id)!;
  }

  private hemorySegmentationJobFromRow(row: Row): HemorySegmentationJob {
    const inputMeta = parseJson<HemorySegmentationInputMeta | null>(row.input_meta_json, null);
    return {
      id: String(row.id), recordingEventId: String(row.recording_event_id), fingerprint: String(row.fingerprint),
      status: String(row.status) as HemorySegmentationJob['status'], attempts: Number(row.attempts),
      segmentCount: Number(row.segment_count ?? 0), generator: row.generator as string | null,
      error: row.error as string | null, inputMeta,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  getHemorySegmentationJob(id: string): HemorySegmentationJob | undefined {
    const row = this.db.prepare('SELECT * FROM hemory_segmentation_jobs WHERE id=?').get(id) as Row | undefined;
    return row ? this.hemorySegmentationJobFromRow(row) : undefined;
  }

  listPendingHemorySegmentationJobs(): HemorySegmentationJob[] {
    return (this.db.prepare("SELECT * FROM hemory_segmentation_jobs WHERE status IN ('pending','running','failed') ORDER BY updated_at").all() as Row[])
      .map((row) => this.hemorySegmentationJobFromRow(row));
  }

  listRecentHemorySegmentationJobs(limit = 50): HemorySegmentationJob[] {
    return (this.db.prepare('SELECT * FROM hemory_segmentation_jobs ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[])
      .map((row) => this.hemorySegmentationJobFromRow(row));
  }

  /** 该录音最近一次非 skipped 分段 job（succeeded 优先；重切闸门用它取转写基准与现状）。 */
  latestEffectiveHemorySegmentationJob(recordingEventId: string): HemorySegmentationJob | undefined {
    const row = this.db.prepare(`SELECT * FROM hemory_segmentation_jobs WHERE recording_event_id=? AND status!='skipped'
      ORDER BY CASE WHEN status='succeeded' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`).get(recordingEventId) as Row | undefined;
    return row ? this.hemorySegmentationJobFromRow(row) : undefined;
  }

  updateHemorySegmentationJob(id: string, status: HemorySegmentationJob['status'], input: { segmentCount?: number; generator?: string; error?: string | null; inputMeta?: HemorySegmentationInputMeta } = {}): HemorySegmentationJob | undefined {
    this.db.prepare(`UPDATE hemory_segmentation_jobs SET status=?,attempts=CASE WHEN ?='running' THEN attempts+1 ELSE attempts END,
      segment_count=COALESCE(?,segment_count),generator=COALESCE(?,generator),error=?,input_meta_json=COALESCE(?,input_meta_json),updated_at=? WHERE id=?`)
      .run(status, status, input.segmentCount ?? null, input.generator ?? null, input.error ?? null,
        input.inputMeta ? json(input.inputMeta) : null, nowIso(), id);
    return this.getHemorySegmentationJob(id);
  }

  /** 定向重置分段 job（重切逃生门）：清空失败状态与重试额度，回到全新 pending。 */
  resetHemorySegmentationJob(id: string): HemorySegmentationJob | undefined {
    this.db.prepare(`UPDATE hemory_segmentation_jobs SET status='pending',attempts=0,error=NULL,updated_at=? WHERE id=?`)
      .run(nowIso(), id);
    return this.getHemorySegmentationJob(id);
  }

  /** 启动恢复：running 分段 job 是进程被杀的残留（执行体只在内存里），额度被重启烧掉不是模型失败，
   * 重置回 pending/attempts=0 交给 resumePending 重跑；真正 failed 的 job 不被动。 */
  resetInterruptedHemorySegmentationJobs(): number {
    const now = nowIso();
    const result = this.db.prepare(`UPDATE hemory_segmentation_jobs SET status='pending',attempts=0,error=NULL,updated_at=? WHERE status='running'`).run(now);
    return Number(result.changes);
  }

  /** 启动恢复：内存里未跑完的 SyncRun 永远不会再推进，落 failed 终态防止永久 running 孤儿。 */
  failOrphanedSyncRuns(): number {
    const now = nowIso();
    const result = this.db.prepare(`UPDATE sync_runs SET status='failed',finished_at=?,error=COALESCE(error,?) WHERE status='running'`)
      .run(now, '服务重启中断');
    return Number(result.changes);
  }

  activateHemoryFragments(recordingEventId: string, fingerprint: string, eventIds: string[]): string[] {
    const activeRows = this.db.prepare('SELECT event_id FROM hemory_fragment_generations WHERE recording_event_id=? AND active=1')
      .all(recordingEventId) as Row[];
    const next = new Set(eventIds);
    const superseded = activeRows.map((row) => String(row.event_id)).filter((id) => !next.has(id));
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE hemory_fragment_generations SET active=0,updated_at=? WHERE recording_event_id=?').run(now, recordingEventId);
      const statement = this.db.prepare(`INSERT INTO hemory_fragment_generations(event_id,recording_event_id,fingerprint,active,created_at,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET recording_event_id=excluded.recording_event_id,fingerprint=excluded.fingerprint,active=1,updated_at=excluded.updated_at`);
      for (const eventId of eventIds) statement.run(eventId, recordingEventId, fingerprint, 1, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (superseded.length) {
      this.markDraftsStaleForEvents(superseded);
      this.deleteEvidenceForSourceEvents(superseded);
    }
    this.audit('agent', 'activate_hemory_segmentation', 'source_event', recordingEventId, { fingerprint, eventIds, superseded });
    return superseded;
  }

  countActiveHemoryFragments(recordingEventId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM hemory_fragment_generations WHERE recording_event_id=? AND active=1')
      .get(recordingEventId) as Row;
    return Number(row.count ?? 0);
  }

  listActiveHemoryFragmentsForRecording(recordingEventId: string): SourceEvent[] {
    return (this.db.prepare(`SELECT e.* FROM source_events e JOIN hemory_fragment_generations g ON g.event_id=e.id
      WHERE g.recording_event_id=? AND g.active=1 ORDER BY e.occurred_at`).all(recordingEventId) as Row[]).map(sourceEventFromRow);
  }

  /**
   * 重切换代后把被取代片段的人工归属按时间覆盖率继承到新片段：每个 unattributed 新片段取
   * 重叠绝对时长最长的已处理前驱（confirmed/ignored，含归属 override），覆盖率 ≥
   * HEMORY_INHERIT_OVERLAP_RATIO（以「已处理片段」时长为基准）才继承——低于阈值视为真新内容
   * 保持待处理。dryRun 只返回计划不落库；继承写 hemory_attributions override（与人工归属
   * 同路径，actor=agent），confirmed 且客户仍存在时连客户归属一起继承。
   */
  inheritHemoryAttributions(recordingEventId: string, options: { dryRun?: boolean; actor?: string } = {}):
      { applied: HemoryInheritanceDetail[]; } {
    const actor = options.actor ?? 'agent';
    const pending = this.listActiveHemoryFragmentsForRecording(recordingEventId)
      .filter((event) => event.attributionStatus === 'unattributed');
    if (!pending.length) return { applied: [] };
    const predecessors = (this.db.prepare(`SELECT e.* FROM source_events e JOIN hemory_fragment_generations g ON g.event_id=e.id
      WHERE g.recording_event_id=? AND g.active=0 AND e.attribution_status IN ('confirmed','ignored')`).all(recordingEventId) as Row[])
      .map(sourceEventFromRow);
    if (!predecessors.length) return { applied: [] };
    const plan: HemoryInheritanceDetail[] = [];
    for (const candidate of pending) {
      let best: { predecessor: SourceEvent; ratio: number } | undefined;
      for (const predecessor of predecessors) {
        const ratio = hemoryOverlapRatio(candidate, predecessor);
        if (ratio == null || ratio < HEMORY_INHERIT_OVERLAP_RATIO) continue;
        if (!best || ratio > best.ratio) best = { predecessor, ratio };
      }
      if (!best) continue;
      const status = best.predecessor.attributionStatus as 'confirmed' | 'ignored';
      const customerId = status === 'confirmed' ? best.predecessor.customerId ?? null : null;
      if (customerId && !this.getCustomer(customerId)) continue;
      plan.push({ eventId: candidate.id, predecessorId: best.predecessor.id, status,
        customerId, overlapRatio: best.ratio });
    }
    if (!plan.length || options.dryRun) return { applied: plan };
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of plan) {
        const event = this.getSourceEvent(item.eventId)!;
        const status = item.status;
        this.db.prepare(`INSERT INTO hemory_attributions(event_id,customer_id,status,actor,payload_hash,attributed_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(event_id) DO UPDATE SET customer_id=excluded.customer_id,status=excluded.status,actor=excluded.actor,payload_hash=excluded.payload_hash,attributed_at=excluded.attributed_at`)
          .run(item.eventId, item.customerId, status, actor, event.payloadHash, now);
        this.db.prepare('UPDATE source_events SET customer_id=?,attribution_status=?,confidence=? WHERE id=?')
          .run(item.customerId, status, item.customerId ? 1 : 0, item.eventId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const item of plan) {
      this.audit(actor, 'inherit_hemory_attribution', 'source_event', item.eventId,
        { predecessorId: item.predecessorId, status: item.status, customerId: item.customerId, overlapRatio: Number(item.overlapRatio.toFixed(3)) });
    }
    return { applied: plan };
  }

  /** 与 listConfirmedHemorySegments 回退语义一致：已登记代际的片段看 active，未登记的历史行视为活跃。 */
  isHemoryFragmentActive(eventId: string): boolean {
    const row = this.db.prepare('SELECT active FROM hemory_fragment_generations WHERE event_id=?').get(eventId) as Row | undefined;
    return row ? Number(row.active) === 1 : true;
  }

  addEvidence(input: EvidenceInput): string {
    const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT OR REPLACE INTO evidence(id,customer_id,source_event_id,kind,label,detail,occurred_at,confidence,source_system,source_url,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.customerId, input.sourceEventId ?? null, input.kind, input.label, input.detail,
      input.occurredAt, input.confidence, input.sourceSystem, input.sourceUrl ?? null, nowIso());
    return id;
  }

  /** 幂等落公开动态证据：同自然键 (customer, kind, source_url, occurred_at) 已存在时返回既有行（created=false）不重复插入。
   * 同步轮换与 record_web_intelligence 工具共用——90 天新闻窗 + 两周轮换会反复命中同一条旧闻，不去重会堆积并抬风险负向档位。 */
  addEvidenceIdempotent(input: EvidenceInput): { id: string; created: boolean } {
    if (input.sourceUrl) {
      const existing = this.db.prepare('SELECT id FROM evidence WHERE customer_id=? AND kind=? AND source_url=? AND occurred_at=?')
        .get(input.customerId, input.kind, input.sourceUrl, input.occurredAt) as Row | undefined;
      if (existing) return { id: String(existing.id), created: false };
    }
    return { id: this.addEvidence(input), created: true };
  }

  listEvidence(customerId: string): EvidenceInput[] {
    return (this.db.prepare('SELECT * FROM evidence WHERE customer_id=? ORDER BY occurred_at DESC').all(customerId) as Row[]).map((row) => ({
      id: String(row.id), customerId: String(row.customer_id), sourceEventId: row.source_event_id as string | null,
      kind: String(row.kind), label: String(row.label), detail: String(row.detail), occurredAt: String(row.occurred_at),
      confidence: Number(row.confidence), sourceSystem: String(row.source_system), sourceUrl: row.source_url as string | null,
    }));
  }

  deleteEvidenceForSourceEvents(eventIds: string[]): void {
    const statement = this.db.prepare('DELETE FROM evidence WHERE source_event_id=?');
    for (const id of eventIds) statement.run(id);
  }

  saveRisk(risk: RiskAssessment): void {
    this.db.prepare(`INSERT INTO risk_assessments(id,customer_id,score,level,coverage,dimensions_json,evidence_refs_json,unknowns_json,rule_version,generated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(risk.id, risk.customerId, risk.score, risk.level, risk.coverage, json(risk.dimensions), json(risk.evidenceRefs),
      json(risk.unknowns), risk.ruleVersion, risk.generatedAt);
    this.setCustomerHealth(risk.customerId, risk.level);
  }

  latestRisk(customerId: string): RiskAssessment | null {
    const row = this.db.prepare('SELECT * FROM risk_assessments WHERE customer_id=? ORDER BY generated_at DESC LIMIT 1').get(customerId) as Row | undefined;
    return row ? {
      id: String(row.id), customerId: String(row.customer_id), score: row.score == null ? null : Number(row.score),
      level: String(row.level) as RiskAssessment['level'], coverage: Number(row.coverage),
      dimensions: parseJson(row.dimensions_json, {}), evidenceRefs: parseJson(row.evidence_refs_json, []), unknowns: parseJson(row.unknowns_json, []),
      ruleVersion: String(row.rule_version), generatedAt: String(row.generated_at),
    } : null;
  }

  saveAlert(input: Omit<CustomerAlert, 'status' | 'createdAt' | 'updatedAt' | 'resolvedAt' | 'resolvedBy' | 'resolutionNote'> & Partial<Pick<CustomerAlert, 'createdAt'>>): CustomerAlert {
    const now = nowIso();
    const value: CustomerAlert = {
      ...input, status: 'active', createdAt: input.createdAt ?? now, updatedAt: now,
      resolvedAt: null, resolvedBy: null, resolutionNote: '',
    };
    this.db.prepare(`INSERT INTO customer_alerts(id,customer_id,trigger_key,status,reasons_json,details_json,created_at,updated_at,resolved_at,resolved_by,resolution_note)
      VALUES(?,?,?,'active',?,?,?,?,NULL,NULL,'')`)
      .run(value.id, value.customerId, value.triggerKey, json(value.reasons), json(value.details), value.createdAt, now);
    return value;
  }

  /** active 预警原地刷新原因/事实快照（保留发现时间 created_at）。 */
  updateAlert(id: string, reasons: string[], details: Record<string, unknown>): void {
    this.db.prepare('UPDATE customer_alerts SET reasons_json=?,details_json=?,updated_at=? WHERE id=? AND status=?')
      .run(json(reasons), json(details), nowIso(), id, 'active');
  }

  /** 置 resolved（幂等：仅 active 行生效）；note 为人工消除原因或系统自动解除说明。 */
  resolveAlert(id: string, resolvedBy: string, note: string): CustomerAlert | null {
    const now = nowIso();
    const changed = this.db.prepare("UPDATE customer_alerts SET status='resolved',updated_at=?,resolved_at=?,resolved_by=?,resolution_note=? WHERE id=? AND status='active'")
      .run(now, now, resolvedBy, note, id).changes;
    if (!changed) return null;
    return this.getAlert(id);
  }

  getAlert(id: string): CustomerAlert | null {
    const row = this.db.prepare('SELECT * FROM customer_alerts WHERE id=?').get(id) as Row | undefined;
    return row ? alertFromRow(row) : null;
  }

  activeAlert(customerId: string, triggerKey: AlertTriggerKey): CustomerAlert | null {
    const row = this.db.prepare("SELECT * FROM customer_alerts WHERE customer_id=? AND trigger_key=? AND status='active'").get(customerId, triggerKey) as Row | undefined;
    return row ? alertFromRow(row) : null;
  }

  /** 该触发键的全部已消除预警：重报抑制按「已确认事实的最全集」比对，不依赖单行排序（同毫秒 resolve 会平局）。 */
  listResolvedAlerts(customerId: string, triggerKey: AlertTriggerKey): CustomerAlert[] {
    return (this.db.prepare(`SELECT * FROM customer_alerts WHERE customer_id=? AND trigger_key=? AND status='resolved'
      ORDER BY resolved_at DESC`).all(customerId, triggerKey) as Row[]).map(alertFromRow);
  }

  listAlerts(options: { status?: 'active' | 'resolved' | 'all'; customerId?: string } = {}): Array<CustomerAlert & { customerName: string | null; customerShortName: string | null }> {
    const status = options.status ?? 'active';
    const clauses: string[] = [];
    const args: string[] = [];
    if (status !== 'all') {
      clauses.push('a.status=?');
      args.push(status);
    }
    if (options.customerId) {
      clauses.push('a.customer_id=?');
      args.push(options.customerId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT a.*, c.name AS customer_name, c.short_name AS customer_short_name
      FROM customer_alerts a LEFT JOIN customers c ON c.id=a.customer_id${where}
      ORDER BY a.updated_at DESC`).all(...args) as Row[];
    return rows.map((row) => ({
      ...alertFromRow(row),
      customerName: row.customer_name == null ? null : String(row.customer_name),
      customerShortName: row.customer_short_name == null ? null : String(row.customer_short_name),
    }));
  }

  countAlerts(status: 'active' | 'resolved'): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM customer_alerts WHERE status=?').get(status) as Row).n);
  }

  upsertOpportunity(input: Omit<OpportunityHypothesis, 'id' | 'generatedAt'> & { id?: string; generatedAt?: string }): OpportunityHypothesis {
    const value: OpportunityHypothesis = { ...input, id: input.id ?? randomUUID(), generatedAt: input.generatedAt ?? nowIso() };
    this.db.prepare(`INSERT INTO opportunities(id,customer_id,type,title,detail,confidence,status,evidence_refs_json,discovery_questions_json,recommended_action,generated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_id,type,title) DO UPDATE SET detail=excluded.detail,confidence=excluded.confidence,status=excluded.status,
      evidence_refs_json=excluded.evidence_refs_json,discovery_questions_json=excluded.discovery_questions_json,recommended_action=excluded.recommended_action,generated_at=excluded.generated_at`)
      .run(value.id, value.customerId, value.type, value.title, value.detail, value.confidence, value.status, json(value.evidenceRefs),
        json(value.discoveryQuestions), value.recommendedAction, value.generatedAt);
    return value;
  }

  listOpportunities(customerId: string): OpportunityHypothesis[] {
    return (this.db.prepare('SELECT * FROM opportunities WHERE customer_id=? ORDER BY generated_at DESC').all(customerId) as Row[]).map((row) => ({
      id: String(row.id), customerId: String(row.customer_id), type: String(row.type), title: String(row.title), detail: String(row.detail),
      confidence: Number(row.confidence), status: String(row.status) as OpportunityHypothesis['status'], evidenceRefs: parseJson(row.evidence_refs_json, []),
      discoveryQuestions: parseJson(row.discovery_questions_json, []), recommendedAction: String(row.recommended_action), generatedAt: String(row.generated_at),
    }));
  }

  /** 一次 LLM 分析结果全量替换该客户的增购机会假设（旧规则/v1 假设一并清掉）。 */
  replaceOpportunities(customerId: string, items: Array<Omit<OpportunityHypothesis, 'id' | 'customerId' | 'generatedAt'>>): void {
    this.db.prepare('DELETE FROM opportunities WHERE customer_id=?').run(customerId);
    for (const item of items) this.upsertOpportunity({ ...item, customerId });
  }

  getOpportunityGeneration(customerId: string): { inputFingerprint: string; status: string; error: string | null; generatedAt: string } | null {
    const row = this.db.prepare('SELECT * FROM opportunity_generations WHERE customer_id=?').get(customerId) as Row | undefined;
    return row ? {
      inputFingerprint: String(row.input_fingerprint), status: String(row.status), error: row.error == null ? null : String(row.error),
      generatedAt: String(row.generated_at),
    } : null;
  }

  saveOpportunityGeneration(customerId: string, inputFingerprint: string, status: 'succeeded' | 'failed', error?: string): void {
    this.db.prepare(`INSERT INTO opportunity_generations(customer_id,input_fingerprint,status,error,generated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET input_fingerprint=excluded.input_fingerprint,status=excluded.status,error=excluded.error,generated_at=excluded.generated_at`)
      .run(customerId, inputFingerprint, status, error ?? null, nowIso());
  }

  setCaseCandidate(customerId: string, eligible: boolean, reason: string, evidenceRefs: string[], confidence: number): void {
    this.db.prepare(`INSERT INTO case_candidates(customer_id,eligible,reason,evidence_refs_json,confidence,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET eligible=excluded.eligible,reason=excluded.reason,evidence_refs_json=excluded.evidence_refs_json,confidence=excluded.confidence,updated_at=excluded.updated_at`)
      .run(customerId, Number(eligible), reason, json(evidenceRefs), confidence, nowIso());
  }

  getCaseCandidate(customerId: string): Row | null {
    return (this.db.prepare('SELECT * FROM case_candidates WHERE customer_id=?').get(customerId) as Row | undefined) ?? null;
  }

  createCaseDraft(customerId: string, title: string, fields: Record<string, unknown>, evidenceRefs: string[], meta?: { fingerprint?: string | null; generator?: string | null }): CaseDraft {
    const now = nowIso();
    const draft: CaseDraft = { id: randomUUID(), customerId, version: 1, status: 'draft', title, fields, evidenceRefs,
      fingerprint: meta?.fingerprint ?? null, generator: meta?.generator ?? null, createdAt: now, updatedAt: now };
    this.db.prepare(`INSERT INTO case_drafts(id,customer_id,version,status,title,fields_json,evidence_refs_json,fingerprint,generator,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(draft.id, customerId, 1, 'draft', title, json(fields), json(evidenceRefs), meta?.fingerprint ?? null, meta?.generator ?? null, now, now);
    // 单版本保留（用户拍板）：新稿落库即删除同客户历史版本行，旧配图随行删除、发布尝试记录 FK 级联清理。
    this.db.prepare('DELETE FROM case_drafts WHERE customer_id=? AND id<>?').run(customerId, draft.id);
    return draft;
  }

  getCaseDraft(id: string): CaseDraft | undefined {
    const row = this.db.prepare('SELECT * FROM case_drafts WHERE id=?').get(id) as Row | undefined;
    return row ? {
      id: String(row.id), customerId: String(row.customer_id), version: Number(row.version), status: String(row.status) as CaseDraft['status'],
      title: String(row.title), fields: parseJson(row.fields_json, {}), evidenceRefs: parseJson(row.evidence_refs_json, []),
      fingerprint: (row.fingerprint as string | null) ?? null, generator: (row.generator as string | null) ?? null,
      publishedPageId: row.published_page_id as string | null, publishedAt: row.published_at as string | null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    } : undefined;
  }

  listCaseDrafts(customerId?: string): CaseDraft[] {
    // id DESC 平局决胜：与 migrate() 的「保留最新一行」清理口径一致，updated_at 相同时以 id 定序。
    const rows = customerId
      ? this.db.prepare('SELECT id FROM case_drafts WHERE customer_id=? ORDER BY updated_at DESC, id DESC').all(customerId) as Row[]
      : this.db.prepare('SELECT id FROM case_drafts ORDER BY updated_at DESC, id DESC').all() as Row[];
    return rows.map((row) => this.getCaseDraft(String(row.id))!);
  }

  updateCaseDraft(id: string, expectedVersion: number, title: string, fields: Record<string, unknown>): CaseDraft | null {
    const result = this.db.prepare(`UPDATE case_drafts SET title=?,fields_json=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='draft'`)
      .run(title, json(fields), nowIso(), id, expectedVersion);
    return Number(result.changes) === 1 ? this.getCaseDraft(id)! : null;
  }

  markCasePublished(id: string, expectedVersion: number, pageId: string): CaseDraft | null {
    const now = nowIso();
    const result = this.db.prepare(`UPDATE case_drafts SET status='published',published_page_id=?,published_at=?,updated_at=? WHERE id=? AND version=? AND status='draft'`)
      .run(pageId, now, now, id, expectedVersion);
    return Number(result.changes) === 1 ? this.getCaseDraft(id)! : null;
  }

  private casePublishAttemptFromRow(row: Row): CasePublishAttempt {
    return {
      id: String(row.id), draftId: String(row.draft_id), version: Number(row.version),
      parentPageId: String(row.parent_page_id), requestHash: String(row.request_hash),
      status: String(row.status) as CasePublishAttempt['status'], pageId: row.page_id as string | null,
      error: row.error as string | null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  getCasePublishAttemptByHash(requestHash: string): CasePublishAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM case_publish_attempts WHERE request_hash=?').get(requestHash) as Row | undefined;
    return row ? this.casePublishAttemptFromRow(row) : undefined;
  }

  beginCasePublishAttempt(draftId: string, version: number, parentPageId: string, requestHash: string): { attempt: CasePublishAttempt; acquired: boolean } {
    const existing = this.getCasePublishAttemptByHash(requestHash);
    if (existing) {
      if (existing.status === 'failed') {
        const retried = this.db.prepare("UPDATE case_publish_attempts SET status='pending',error=NULL,updated_at=? WHERE id=? AND status='failed'")
          .run(nowIso(), existing.id);
        if (Number(retried.changes) === 1) return { attempt: this.getCasePublishAttemptByHash(requestHash)!, acquired: true };
      }
      return { attempt: this.getCasePublishAttemptByHash(requestHash)!, acquired: false };
    }
    const now = nowIso();
    const id = randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO case_publish_attempts(id,draft_id,version,parent_page_id,request_hash,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?)`).run(id, draftId, version, parentPageId, requestHash, now, now);
    const attempt = this.getCasePublishAttemptByHash(requestHash)!;
    return { attempt, acquired: attempt.id === id };
  }

  updateCasePublishAttempt(id: string, status: CasePublishAttempt['status'], values: { pageId?: string | null; error?: string | null } = {}): CasePublishAttempt {
    this.db.prepare('UPDATE case_publish_attempts SET status=?,page_id=?,error=?,updated_at=? WHERE id=?')
      .run(status, values.pageId ?? null, values.error ?? null, nowIso(), id);
    const row = this.db.prepare('SELECT * FROM case_publish_attempts WHERE id=?').get(id) as Row;
    return this.casePublishAttemptFromRow(row);
  }

  completeCasePublishAttempt(attemptId: string, draftId: string, expectedVersion: number, pageId: string): CaseDraft | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = nowIso();
      const result = this.db.prepare(`UPDATE case_drafts SET status='published',published_page_id=?,published_at=?,updated_at=?
        WHERE id=? AND version=? AND status='draft'`).run(pageId, now, now, draftId, expectedVersion);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare("UPDATE case_publish_attempts SET status='succeeded',page_id=?,error=NULL,updated_at=? WHERE id=? AND status='pending'")
        .run(pageId, now, attemptId);
      this.db.exec('COMMIT');
      return this.getCaseDraft(draftId)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createAction(input: ActionItemInput): ActionItem {
    const id = input.id ?? randomUUID();
    const now = nowIso();
    this.db.prepare(`INSERT OR IGNORE INTO action_items(id,customer_id,title,why_now,owner,due_at,expected_outcome,evidence_refs_json,source_meeting_id,confidence,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.customerId, input.title, input.whyNow, input.owner ?? null,
      input.dueAt ?? null, input.expectedOutcome ?? null, json(input.evidenceRefs ?? []), input.sourceMeetingId ?? null, input.confidence ?? 0, 'new', now, now);
    return this.getAction(id)!;
  }

  getAction(id: string): ActionItem | undefined {
    const row = this.db.prepare('SELECT * FROM action_items WHERE id=?').get(id) as Row | undefined;
    return row ? actionFromRow(row) : undefined;
  }

  listActions(customerId?: string): ActionItem[] {
    const sql = `SELECT * FROM action_items ${customerId ? 'WHERE customer_id=?' : ''}
      ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, COALESCE(due_at,'9999')`;
    const rows = (customerId ? this.db.prepare(sql).all(customerId) : this.db.prepare(sql).all()) as Row[];
    return rows.map(actionFromRow);
  }

  updateAction(id: string, patch: Partial<ActionItemInput> & { status?: ActionStatus; outcome?: string | null }): ActionItem | null {
    const current = this.getAction(id);
    if (!current) return null;
    this.db.prepare(`UPDATE action_items SET title=?,why_now=?,owner=?,due_at=?,expected_outcome=?,evidence_refs_json=?,status=?,outcome=?,updated_at=? WHERE id=?`)
      .run(patch.title ?? current.title, patch.whyNow ?? current.whyNow, patch.owner ?? current.owner ?? null,
        patch.dueAt ?? current.dueAt ?? null,
        patch.expectedOutcome ?? current.expectedOutcome ?? null, json(patch.evidenceRefs ?? current.evidenceRefs ?? []),
        patch.status ?? current.status, patch.outcome ?? current.outcome ?? null, nowIso(), id);
    return this.getAction(id)!;
  }

  completeAction(id: string, outcome?: string, actor = 'csm'): ActionItem | null {
    const action = this.getAction(id);
    if (!action) return null;
    // 不传 outcome 只流转完成态、不记录实际结果；仅 CLI --outcome 显式传入时落库。
    const updated = this.updateAction(id, { status: 'completed', outcome: outcome ?? null })!;
    this.audit(actor, 'complete_action', 'action_item', id, { outcome });
    return updated;
  }

  /** 批量完成：逐项处理互不影响——不存在 failed、已完成 skipped、未完成置 completed 并逐条审计。 */
  bulkCompleteActions(ids: string[], outcome?: string, actor = 'csm'): ActionBulkResult[] {
    const results: ActionBulkResult[] = [];
    for (const id of [...new Set(ids)]) {
      const action = this.getAction(id);
      if (!action) {
        results.push({ id, title: null, result: 'failed', error: '待办不存在' });
        continue;
      }
      if (action.status !== 'new') {
        results.push({ id, title: action.title, result: 'skipped', reason: '当前状态已完成，仅未完成可完成' });
        continue;
      }
      this.completeAction(id, outcome, actor);
      results.push({ id, title: action.title, result: 'completed' });
    }
    return results;
  }

  createSyncRun(scope: string, customerId?: string | null): SyncRun {
    const run: SyncRun = { id: randomUUID(), scope, customerId, status: 'running', startedAt: nowIso(), sourceStatus: {} };
    this.db.prepare('INSERT INTO sync_runs(id,scope,customer_id,status,started_at,source_status_json) VALUES(?,?,?,?,?,?)')
      .run(run.id, scope, customerId ?? null, 'running', run.startedAt, '{}');
    return run;
  }

  finishSyncRun(id: string, status: SyncRun['status'], sourceStatus: SyncRun['sourceStatus'], error?: string): SyncRun {
    this.db.prepare('UPDATE sync_runs SET status=?,finished_at=?,source_status_json=?,error=? WHERE id=?').run(status, nowIso(), json(sourceStatus), error ?? null, id);
    return this.getSyncRun(id)!;
  }

  getSyncRun(id: string): SyncRun | undefined {
    const row = this.db.prepare('SELECT * FROM sync_runs WHERE id=?').get(id) as Row | undefined;
    return row ? this.syncRunFromRow(row) : undefined;
  }

  private syncRunFromRow(row: Row): SyncRun {
    return { id: String(row.id), scope: String(row.scope), customerId: row.customer_id as string | null, status: String(row.status) as SyncRun['status'],
      startedAt: String(row.started_at), finishedAt: row.finished_at as string | null, sourceStatus: parseJson(row.source_status_json, {}), error: row.error as string | null };
  }

  /** 该客户最近的公开动态轮次（run 即报告：sourceStatus.web_intelligence.findings 存本轮明细），最新在前。 */
  listWebIntelRuns(customerId: string, limit = 10): SyncRun[] {
    return (this.db.prepare("SELECT * FROM sync_runs WHERE scope='web_intelligence' AND customer_id=? ORDER BY started_at DESC LIMIT ?")
      .all(customerId, limit) as Row[]).map((row) => this.syncRunFromRow(row));
  }

  hasSuccessfulSyncScope(scope: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sync_runs WHERE scope=? AND status='succeeded' LIMIT 1").get(scope);
  }

  /** 最近一次备份 run（scope backup:<上海日期>，任意触发方式）；从未跑过返回 undefined。 */
  latestBackupRun(): SyncRun | undefined {
    const row = this.db.prepare("SELECT * FROM sync_runs WHERE scope LIKE 'backup:%' ORDER BY started_at DESC LIMIT 1").get() as Row | undefined;
    return row ? this.syncRunFromRow(row) : undefined;
  }

  /** 该客户最近一次成功公开动态检索的完成时间；从未成功过返回 null。 */
  latestWebIntelSyncAt(customerId: string): Date | null {
    const row = this.db.prepare("SELECT finished_at FROM sync_runs WHERE scope='web_intelligence' AND customer_id=? AND status='succeeded' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
      .get(customerId) as Row | undefined;
    if (!row?.finished_at) return null;
    const at = new Date(String(row.finished_at));
    return Number.isNaN(at.getTime()) ? null : at;
  }

  /** 该客户最近一次公开动态检索尝试的开始时间（含失败）；从未尝试过返回 null。轮换队列按它排序。 */
  latestWebIntelAttemptAt(customerId: string): Date | null {
    const row = this.db.prepare("SELECT started_at FROM sync_runs WHERE scope='web_intelligence' AND customer_id=? ORDER BY started_at DESC LIMIT 1")
      .get(customerId) as Row | undefined;
    if (!row?.started_at) return null;
    const at = new Date(String(row.started_at));
    return Number.isNaN(at.getTime()) ? null : at;
  }

  createDraftJob(customerId: string, fingerprint: string, sourceEventIds: string[], kind: DraftJobKind = 'hemory'): DraftGenerationJob {
    const existing = this.db.prepare('SELECT * FROM draft_generation_jobs WHERE fingerprint=?').get(fingerprint) as Row | undefined;
    if (existing) return this.draftJobFromRow(existing);
    const now = nowIso();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO draft_generation_jobs(id,customer_id,fingerprint,source_event_ids_json,status,attempts,kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, customerId, fingerprint, json(sourceEventIds), 'pending', 0, kind, now, now);
    return this.getDraftJob(id)!;
  }

  private draftJobFromRow(row: Row): DraftGenerationJob {
    return { id: String(row.id), customerId: String(row.customer_id), fingerprint: String(row.fingerprint),
      sourceEventIds: parseJson(row.source_event_ids_json, []), status: String(row.status) as DraftGenerationJob['status'],
      attempts: Number(row.attempts), error: row.error as string | null,
      kind: (String(row.kind ?? 'hemory') === 'weekly_report' ? 'weekly_report' : String(row.kind ?? 'hemory') === 'case_report' ? 'case_report' : 'hemory'),
      note: row.note as string | null,
      progress: row.progress as string | null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  getDraftJob(id: string): DraftGenerationJob | undefined {
    const row = this.db.prepare('SELECT * FROM draft_generation_jobs WHERE id=?').get(id) as Row | undefined;
    return row ? this.draftJobFromRow(row) : undefined;
  }

  findDraftJobByFingerprint(fingerprint: string): DraftGenerationJob | undefined {
    const row = this.db.prepare('SELECT * FROM draft_generation_jobs WHERE fingerprint=?').get(fingerprint) as Row | undefined;
    return row ? this.draftJobFromRow(row) : undefined;
  }

  listPendingDraftJobs(kind: DraftJobKind = 'hemory'): DraftGenerationJob[] {
    const rows = this.db.prepare("SELECT * FROM draft_generation_jobs WHERE kind=? AND status IN ('pending','running','failed') ORDER BY updated_at").all(kind) as Row[];
    return rows.map((row) => this.draftJobFromRow(row));
  }

  /** 进行中（pending/running）任务：草稿列表「重新生成中」标记的数据源；与含 failed 的 resume 语义分开。 */
  listActiveDraftJobs(kind: DraftJobKind = 'hemory'): DraftGenerationJob[] {
    const rows = this.db.prepare("SELECT * FROM draft_generation_jobs WHERE kind=? AND status IN ('pending','running') ORDER BY created_at").all(kind) as Row[];
    return rows.map((row) => this.draftJobFromRow(row));
  }

  /** 某客户全部进行中（pending/running）生成任务：页面重开后恢复进度展示的查询。 */
  listActiveDraftJobsByCustomer(customerId: string): DraftGenerationJob[] {
    const rows = this.db.prepare("SELECT * FROM draft_generation_jobs WHERE customer_id=? AND status IN ('pending','running') ORDER BY created_at").all(customerId) as Row[];
    return rows.map((row) => this.draftJobFromRow(row));
  }

  /** 失败任务清单（最近 limit 条，默认 50）：失败明细展示与 CLI 入口；不含已被新任务取代的 superseded。 */
  listFailedDraftJobs(kind: DraftJobKind = 'hemory', limit = 50): DraftGenerationJob[] {
    const rows = this.db.prepare("SELECT * FROM draft_generation_jobs WHERE kind=? AND status='failed' ORDER BY updated_at DESC LIMIT ?").all(kind, limit) as Row[];
    return rows.map((row) => this.draftJobFromRow(row));
  }

  /** 执行时回写实际参与的片段集合：失败任务的 sourceEventIds 即失败明细的真实集合。 */
  updateDraftJobSourceEventIds(id: string, sourceEventIds: string[]): void {
    this.db.prepare('UPDATE draft_generation_jobs SET source_event_ids_json=?,updated_at=? WHERE id=?')
      .run(json(sourceEventIds), nowIso(), id);
  }

  /** 同客户同日重建时宣告旧失败任务已被取代：不再出现在失败列表，重启也不再重试。 */
  supersedeFailedDraftJobsForDay(customerId: string, dateKey: string): void {
    const range = shanghaiDayRange(dateKey);
    const rows = this.db.prepare("SELECT id,source_event_ids_json FROM draft_generation_jobs WHERE customer_id=? AND status='failed'").all(customerId) as Row[];
    for (const row of rows) {
      const ids = parseJson<string[]>(row.source_event_ids_json, []);
      const inDay = ids.some((id) => {
        const event = this.getSourceEvent(id);
        if (!event) return false;
        const at = new Date(event.occurredAt).getTime();
        return at >= new Date(range.start).getTime() && at <= new Date(range.end).getTime();
      });
      if (inDay) this.db.prepare("UPDATE draft_generation_jobs SET status='superseded',updated_at=? WHERE id=?").run(nowIso(), String(row.id));
    }
  }

  /** 忽略草稿批次：未写入项软删除为 dismissed（保留审计轨迹），written/writing 项不受影响。 */
  dismissDraftBatch(batchId: string): DraftBatch | undefined {
    const batch = this.getDraftBatch(batchId);
    if (!batch) return undefined;
    this.db.prepare("UPDATE draft_items SET status='dismissed',updated_at=? WHERE batch_id=? AND status NOT IN ('written','writing')")
      .run(nowIso(), batchId);
    this.refreshDraftBatchStatus(batchId);
    return this.getDraftBatch(batchId);
  }

  /** 忽略单条草稿：与批次忽略同语义的逐条软删除；written/writing 项与不存在的条目拒绝。 */
  dismissDraftItem(itemId: string): DraftItem | undefined {
    const item = this.getDraftItem(itemId);
    if (!item) return undefined;
    if (['written', 'writing'].includes(item.status)) throw new Error('已写入或写入中的草稿不能忽略');
    this.db.prepare("UPDATE draft_items SET status='dismissed',updated_at=? WHERE id=?").run(nowIso(), itemId);
    this.refreshDraftBatchStatus(item.batchId);
    return this.getDraftItem(itemId);
  }

  updateDraftJob(id: string, status: DraftGenerationJob['status'], error?: string | null, note?: string | null): DraftGenerationJob | undefined {
    this.db.prepare(`UPDATE draft_generation_jobs SET status=?,attempts=CASE WHEN ?='running' THEN attempts+1 ELSE attempts END,error=?,note=COALESCE(?,note),updated_at=? WHERE id=?`)
      .run(status, status, error ?? null, note ?? null, nowIso(), id);
    return this.getDraftJob(id);
  }

  /**
   * 只写进度文案：绝不动 status/attempts（updateDraftJob 的 running 会 attempts+1，
   * 进度心跳若复用会把重试次数刷爆），终态写入后进度保留最后值仅供诊断。
   */
  updateDraftJobProgress(id: string, progress: string): void {
    this.db.prepare('UPDATE draft_generation_jobs SET progress=?,updated_at=? WHERE id=?').run(progress, nowIso(), id);
  }

  /**
   * 已写入草稿的消费台账：客户维度各草稿类型已消费（written 草稿 evidence_refs 引用）的片段 ID 集合。
   * 计算式推导不落新表——written 是唯一权威状态，假 written 被 repair 翻转后消费自动解除。
   */
  writtenEvidenceByType(customerId: string): Map<DraftItemType, Set<string>> {
    const consumed = new Map<DraftItemType, Set<string>>();
    const rows = this.db.prepare("SELECT type,evidence_refs_json FROM draft_items WHERE customer_id=? AND status='written'").all(customerId) as Row[];
    for (const row of rows) {
      const type = String(row.type) as DraftItemType;
      let set = consumed.get(type);
      if (!set) { set = new Set<string>(); consumed.set(type, set); }
      for (const eventId of parseJson<string[]>(row.evidence_refs_json, [])) set.add(eventId);
    }
    return consumed;
  }

  /**
   * 跨代际消费台账：在 writtenEvidenceByType 之上，把被 written 草稿引用的停用（active=0）
   * 片段的「活跃孪生」并入同类型已消费集合——孪生 = 同录音、时间覆盖率（以旧片段时长为基准）
   * ≥ HEMORY_INHERIT_OVERLAP_RATIO。重切后新片段 ID 不同，原始台账天然看不见它们；不扩展会
   * 对同一内容重复提案。纯计算式推导（不改 written 草稿的 evidence_refs，审计完整性），
   * 假 written 被修复翻转后扩展消费自动解除。
   */
  expandedWrittenEvidenceByType(customerId: string): Map<DraftItemType, Set<string>> {
    const consumed = this.writtenEvidenceByType(customerId);
    const referenced = [...new Set([...consumed.values()].flatMap((ids) => [...ids]))]
      .map((id) => this.getSourceEvent(id))
      .filter((event): event is SourceEvent => !!event && event.sourceSystem === 'hemory' && event.sourceType === 'ai_topic_segment'
        && !this.isHemoryFragmentActive(event.id));
    if (!referenced.length) return consumed;
    const twinsByRecording = new Map<string, SourceEvent[]>();
    for (const old of referenced) {
      const rows = this.db.prepare(`SELECT e.* FROM source_events e JOIN hemory_fragment_generations g ON g.event_id=e.id
        WHERE g.recording_event_id=(SELECT recording_event_id FROM hemory_fragment_generations WHERE event_id=?)
        AND g.active=1`).all(old.id) as Row[];
      const active = rows.map(sourceEventFromRow).filter((event) => event.attributionStatus !== 'ignored');
      if (active.length) twinsByRecording.set(old.id, active);
    }
    if (!twinsByRecording.size) return consumed;
    for (const [type, ids] of consumed) {
      for (const id of ids) {
        const twins = twinsByRecording.get(id);
        if (!twins) continue;
        for (const twin of twins) {
          const ratio = hemoryOverlapRatio(twin, this.getSourceEvent(id)!);
          if (ratio != null && ratio >= HEMORY_INHERIT_OVERLAP_RATIO) ids.add(twin.id);
        }
      }
    }
    return consumed;
  }

  /**
   * 客户在 [since, until] 闭区间（ISO 时刻）内的全部业务事件，覆盖所有 source_type。
   * 口径与时间线一致：排除 crm/customer_snapshot 元数据与被重切停用（active=0）的 Hemory 片段；
   * occurred_at 混有 Z/+08:00/naive 三种历史格式，比较必须经 datetime() 归一化。
   */
  listSourceEventsInRange(customerId: string, filters: { since: string; until: string; sourceTypes?: string[] }): SourceEvent[] {
    const clauses = [
      'customer_id=?',
      "NOT (source_system='crm' AND source_type='customer_snapshot')",
      'NOT EXISTS (SELECT 1 FROM hemory_fragment_generations g WHERE g.event_id=source_events.id AND g.active=0)',
      'datetime(occurred_at)>=datetime(?)',
      'datetime(occurred_at)<=datetime(?)',
    ];
    const args: Array<string | number> = [customerId, filters.since, filters.until];
    if (filters.sourceTypes?.length) {
      clauses.push(`source_type IN (${filters.sourceTypes.map(() => '?').join(',')})`);
      args.push(...filters.sourceTypes);
    }
    const rows = this.db.prepare(`SELECT * FROM source_events WHERE ${clauses.join(' AND ')} ORDER BY datetime(occurred_at)`)
      .all(...args) as Row[];
    return rows.map(sourceEventFromRow);
  }

  /**
   * 该客户全部 ONES 工作项中 field010 更新时间落在 [since, until] 闭区间的条目（不限创建时间，
   * 供周报按「本周有更新」聚合）。时间比较在 JS 侧做：field010 是 naive 上海时间，
   * SQLite datetime() 会按 UTC 解析错位 8 小时；field010 缺失的条目无法判定，不纳入。
   */
  listOnesWorkItemsUpdatedInRange(customerId: string, since: string, until: string): SourceEvent[] {
    const rows = this.db.prepare(`SELECT * FROM source_events WHERE customer_id=? AND source_system='ones'
      AND source_type IN ('suggestion_feedback','support_ticket','operations_ticket','private_cloud_instance')`).all(customerId) as Row[];
    const start = new Date(since).getTime();
    const end = new Date(until).getTime();
    return (rows.map(sourceEventFromRow) as SourceEvent[]).filter((event) => {
      const updated = event.payload?.field010;
      if (typeof updated !== 'string' || !updated.trim()) return false;
      const at = parseOccurredAt(updated);
      return at != null && at >= start && at <= end;
    });
  }

  private weeklyReportFromRow(row: Row): WeeklyReport {
    return {
      id: String(row.id), customerId: String(row.customer_id), weekStart: String(row.week_start), weekEnd: String(row.week_end),
      version: Number(row.version), status: String(row.status) as WeeklyReport['status'],
      content: parseJson<WeeklyReportContent>(row.content_json, { summary: '', accomplishments: [], next_week_plan: [], risks: [] }),
      stats: parseJson<WeeklyReportStats>(row.stats_json, { communications: 0, newSuggestions: 0, newTickets: 0, newOperations: 0,
        resolvedSuggestions: null, resolvedTickets: null, resolvedOperations: null, blockedTickets: null, openTickets: null,
        workhours: null, actionsCompleted: null, notes: [] }),
      generator: row.generator as string | null, fingerprint: String(row.fingerprint),
      publishedPageId: row.published_page_id as string | null, publishedAt: row.published_at as string | null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  /** 同客户同周唯一：生成/重建走 UPSERT（version 递进，已发布状态被重建重置为 draft）。 */
  upsertWeeklyReport(input: { customerId: string; weekStart: string; weekEnd: string; content: WeeklyReportContent; stats: WeeklyReportStats; generator: string | null; fingerprint: string }): WeeklyReport {
    const now = nowIso();
    this.db.prepare(`INSERT INTO weekly_reports(id,customer_id,week_start,week_end,version,status,content_json,stats_json,generator,fingerprint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(customer_id,week_start) DO UPDATE SET week_end=excluded.week_end,version=version+1,status='draft',
        content_json=excluded.content_json,stats_json=excluded.stats_json,generator=excluded.generator,fingerprint=excluded.fingerprint,
        published_page_id=NULL,published_at=NULL,updated_at=excluded.updated_at`)
      .run(randomUUID(), input.customerId, input.weekStart, input.weekEnd, 1, 'draft', json(input.content), json(input.stats),
        input.generator, input.fingerprint, now, now);
    return this.getWeeklyReportByWeek(input.customerId, input.weekStart)!;
  }

  getWeeklyReport(id: string): WeeklyReport | undefined {
    const row = this.db.prepare('SELECT * FROM weekly_reports WHERE id=?').get(id) as Row | undefined;
    return row ? this.weeklyReportFromRow(row) : undefined;
  }

  getWeeklyReportByWeek(customerId: string, weekStart: string): WeeklyReport | undefined {
    const row = this.db.prepare('SELECT * FROM weekly_reports WHERE customer_id=? AND week_start=?').get(customerId, weekStart) as Row | undefined;
    return row ? this.weeklyReportFromRow(row) : undefined;
  }

  listWeeklyReports(customerId: string): WeeklyReport[] {
    return (this.db.prepare('SELECT * FROM weekly_reports WHERE customer_id=? ORDER BY week_start DESC').all(customerId) as Row[])
      .map((row) => this.weeklyReportFromRow(row));
  }

  updateWeeklyReport(id: string, expectedVersion: number, content: WeeklyReportContent): WeeklyReport | null {
    const result = this.db.prepare(`UPDATE weekly_reports SET content_json=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='draft'`)
      .run(json(content), nowIso(), id, expectedVersion);
    return Number(result.changes) === 1 ? this.getWeeklyReport(id)! : null;
  }

  markWeeklyReportPublished(id: string, expectedVersion: number, pageId: string): WeeklyReport | null {
    const now = nowIso();
    const result = this.db.prepare(`UPDATE weekly_reports SET status='published',published_page_id=?,published_at=?,updated_at=? WHERE id=? AND version=? AND status='draft'`)
      .run(pageId, now, now, id, expectedVersion);
    return Number(result.changes) === 1 ? this.getWeeklyReport(id)! : null;
  }

  createDraftBatch(input: Omit<DraftBatch, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'items'> & { id?: string }): DraftBatch {
    const existing = this.db.prepare('SELECT * FROM draft_batches WHERE fingerprint=?').get(input.fingerprint) as Row | undefined;
    if (existing) return draftBatchFromRow(existing);
    const now = nowIso();
    const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT INTO draft_batches(id,customer_id,fingerprint,source_event_ids_json,generation_version,generator,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, input.customerId, input.fingerprint, json(input.sourceEventIds), input.generationVersion,
      input.generator, 'draft', now, now);
    return this.getDraftBatch(id)!;
  }

  createDraftItem(input: Omit<DraftItem, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string }): DraftItem {
    const now = nowIso();
    const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT INTO draft_items(id,batch_id,customer_id,version,type,status,title,summary,fields_json,target_system,target_object,target_tool,
      target_arguments_json,evidence_refs_json,unknowns_json,validation_errors_json,approval_hash,result_json,error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.batchId, input.customerId, 1, input.type, input.status, input.title,
      input.summary, json(input.fields), input.targetSystem, input.targetObject, input.targetTool ?? null, json(input.targetArguments),
      json(input.evidenceRefs), json(input.unknowns), json(input.validationErrors), input.approvalHash ?? null, json(input.result ?? null),
      input.error ?? null, now, now);
    return this.getDraftItem(id)!;
  }

  getDraftBatch(id: string): DraftBatch | undefined {
    const row = this.db.prepare('SELECT * FROM draft_batches WHERE id=?').get(id) as Row | undefined;
    if (!row) return undefined;
    const batch = draftBatchFromRow(row);
    batch.items = this.listDraftItems(id);
    return batch;
  }

  listDraftBatches(customerId?: string): DraftBatch[] {
    const rows = customerId
      ? this.db.prepare('SELECT * FROM draft_batches WHERE customer_id=? ORDER BY updated_at DESC').all(customerId) as Row[]
      : this.db.prepare('SELECT * FROM draft_batches ORDER BY updated_at DESC').all() as Row[];
    return rows.map((row) => ({ ...draftBatchFromRow(row), items: this.listDraftItems(String(row.id)) }));
  }

  listDraftItems(batchId: string): DraftItem[] {
    return (this.db.prepare('SELECT * FROM draft_items WHERE batch_id=? ORDER BY created_at').all(batchId) as Row[]).map(draftItemFromRow);
  }

  getDraftItem(id: string): DraftItem | undefined {
    const row = this.db.prepare('SELECT * FROM draft_items WHERE id=?').get(id) as Row | undefined;
    return row ? draftItemFromRow(row) : undefined;
  }

  updateDraftItem(id: string, expectedVersion: number, patch: Partial<Pick<DraftItem, 'title' | 'summary' | 'fields' | 'targetTool' | 'targetArguments' | 'unknowns' | 'validationErrors' | 'status'>>): DraftItem | null {
    const current = this.getDraftItem(id);
    if (!current || current.version !== expectedVersion || ['written', 'writing', 'dismissed', 'stale'].includes(current.status)) return null;
    const status = patch.status ?? (patch.validationErrors?.length ? 'draft' : current.status === 'failed' ? 'draft' : current.status);
    const result = this.db.prepare(`UPDATE draft_items SET title=?,summary=?,fields_json=?,target_tool=?,target_arguments_json=?,unknowns_json=?,
      validation_errors_json=?,status=?,version=version+1,approval_hash=NULL,error=NULL,updated_at=? WHERE id=? AND version=?`)
      .run(patch.title ?? current.title, patch.summary ?? current.summary, json(patch.fields ?? current.fields),
        patch.targetTool === undefined ? current.targetTool : patch.targetTool, json(patch.targetArguments ?? current.targetArguments),
        json(patch.unknowns ?? current.unknowns), json(patch.validationErrors ?? current.validationErrors), status, nowIso(), id, expectedVersion);
    return Number(result.changes) === 1 ? this.getDraftItem(id)! : null;
  }

  setDraftItemExecution(id: string, status: DraftItemStatus, input: { approvalHash?: string | null; result?: Record<string, unknown> | null; error?: string | null } = {}): DraftItem | undefined {
    this.db.prepare('UPDATE draft_items SET status=?,approval_hash=COALESCE(?,approval_hash),result_json=?,error=?,updated_at=? WHERE id=?')
      .run(status, input.approvalHash ?? null, json(input.result ?? null), input.error ?? null, nowIso(), id);
    const item = this.getDraftItem(id);
    if (item) this.refreshDraftBatchStatus(item.batchId);
    return item;
  }

  markDraftsStaleForEvents(eventIds: string[], keepBatchId?: string): void {
    const wanted = new Set(eventIds);
    for (const row of this.db.prepare('SELECT id,source_event_ids_json FROM draft_batches').all() as Row[]) {
      if (keepBatchId && String(row.id) === keepBatchId) continue;
      if (!parseJson<string[]>(row.source_event_ids_json, []).some((id) => wanted.has(id))) continue;
      this.db.prepare("UPDATE draft_items SET status='stale',updated_at=? WHERE batch_id=? AND status NOT IN ('written','dismissed')")
        .run(nowIso(), String(row.id));
      this.refreshDraftBatchStatus(String(row.id));
    }
  }

  refreshDraftBatchStatus(batchId: string): void {
    const statuses = (this.db.prepare('SELECT status FROM draft_items WHERE batch_id=?').all(batchId) as Row[]).map((row) => String(row.status));
    const status = !statuses.length ? 'draft' : statuses.every((value) => value === 'written') ? 'written'
      : statuses.some((value) => value === 'writing') ? 'writing' : statuses.some((value) => value === 'failed') ? 'partial'
        : statuses.every((value) => ['stale', 'dismissed'].includes(value)) ? 'stale' : 'draft';
    this.db.prepare('UPDATE draft_batches SET status=?,updated_at=? WHERE id=?').run(status, nowIso(), batchId);
  }

  audit(actor: string, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}, userId?: number): void {
    this.db.prepare('INSERT INTO audit_log(id,actor,action,entity_type,entity_id,details_json,created_at,user_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), actor, action, entityType, entityId, json(details), nowIso(), userId ?? null);
  }

  // ── 用户与登录凭证（多人共用：密码登录 + CLI 令牌；企微扫码在 users.wecom_userid 上对接）──

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n);
  }

  createUser(input: { username: string; displayName?: string; passwordHash: string; role?: 'admin' | 'member'; wecomUserid?: string }): AuthUser {
    const now = nowIso();
    const result = this.db.prepare('INSERT INTO users(username,display_name,password_hash,role,wecom_userid,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(input.username, input.displayName ?? input.username, input.passwordHash, input.role ?? 'member', input.wecomUserid ?? null, 'active', now, now);
    return this.getUserById(Number(result.lastInsertRowid))!;
  }

  getUserByUsername(username: string): (AuthUser & { passwordHash: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(username) as Row | undefined;
    if (!row) return undefined;
    // SELECT * 必含 password_hash；显式覆写把可选类型收窄成必带。
    return { ...userFromRow(row), passwordHash: String(row.password_hash) };
  }

  getUserById(id: number): AuthUser | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as Row | undefined;
    return row ? userFromRow(row) : undefined;
  }

  listUsers(): AuthUser[] {
    // 显式列：用户名册永不携带密码哈希。
    return (this.db.prepare('SELECT id,username,display_name,role,wecom_userid,status,created_at FROM users ORDER BY id').all() as Row[])
      .map((row) => userFromRow(row));
  }

  updateUser(id: number, patch: { displayName?: string; role?: 'admin' | 'member'; status?: 'active' | 'disabled'; wecomUserid?: string | null; passwordHash?: string }): AuthUser | undefined {
    const current = this.getUserById(id);
    if (!current) return undefined;
    this.db.prepare('UPDATE users SET display_name=?,role=?,status=?,wecom_userid=?,password_hash=?,updated_at=? WHERE id=?')
      .run(patch.displayName ?? current.displayName, patch.role ?? current.role, patch.status ?? current.status,
        patch.wecomUserid === undefined ? current.wecomUserid : patch.wecomUserid,
        patch.passwordHash ?? this.getPasswordHash(id), nowIso(), id);
    return this.getUserById(id);
  }

  private getPasswordHash(id: number): string {
    return String((this.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id) as Row).password_hash);
  }

  createAuthSession(tokenHash: string, userId: number, expiresAt: string): void {
    const now = nowIso();
    this.db.prepare('INSERT INTO auth_sessions(token_hash,user_id,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?)')
      .run(tokenHash, userId, now, now, expiresAt);
  }

  findAuthSession(tokenHash: string): { user: AuthUser; expiresAt: string; lastSeenAt: string } | null {
    const row = this.db.prepare(
      'SELECT s.expires_at AS expires_at, s.last_seen_at AS last_seen_at, u.id AS id, u.username AS username, u.display_name AS display_name, u.role AS role, u.status AS status, u.wecom_userid AS wecom_userid, u.created_at AS created_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?'
    ).get(tokenHash) as Row | undefined;
    return row ? { user: userFromRow(row), expiresAt: String(row.expires_at), lastSeenAt: String(row.last_seen_at) } : null;
  }

  touchAuthSession(tokenHash: string, expiresAt: string): void {
    this.db.prepare('UPDATE auth_sessions SET last_seen_at=?,expires_at=? WHERE token_hash=?').run(nowIso(), expiresAt, tokenHash);
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash);
  }

  deleteUserAuthSessions(userId: number): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(userId);
  }

  createAuthToken(tokenHash: string, userId: number, name: string): AuthTokenRecord {
    const now = nowIso();
    const id = randomUUID();
    this.db.prepare('INSERT INTO auth_tokens(id,token_hash,user_id,name,created_at,last_used_at) VALUES(?,?,?,?,?,?)')
      .run(id, tokenHash, userId, name, now, now);
    return { id, name, createdAt: now, lastUsedAt: now };
  }

  findAuthToken(tokenHash: string): AuthUser | null {
    const row = this.db.prepare(
      'SELECT u.id AS id, u.username AS username, u.display_name AS display_name, u.role AS role, u.status AS status, u.wecom_userid AS wecom_userid, u.created_at AS created_at FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?'
    ).get(tokenHash) as Row | undefined;
    return row ? userFromRow(row) : null;
  }

  touchAuthToken(tokenHash: string): void {
    this.db.prepare('UPDATE auth_tokens SET last_used_at=? WHERE token_hash=?').run(nowIso(), tokenHash);
  }

  listAuthTokens(userId: number): AuthTokenRecord[] {
    return (this.db.prepare('SELECT id,name,created_at,last_used_at FROM auth_tokens WHERE user_id=? ORDER BY created_at DESC').all(userId) as Row[])
      .map((row) => ({ id: String(row.id), name: String(row.name), createdAt: String(row.created_at), lastUsedAt: String(row.last_used_at) }));
  }

  deleteAuthToken(id: string, userId: number): boolean {
    return this.db.prepare('DELETE FROM auth_tokens WHERE id=? AND user_id=?').run(id, userId).changes > 0;
  }

  deleteAuthTokenByHash(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_tokens WHERE token_hash=?').run(tokenHash);
  }

  /**
   * 客户「最后互动时间」：该客户全部业务事件 occurred_at 与 CRM 最后联系时间（last_contact_at）的最大值。
   * 覆盖 ONES 建议/工单/运维/工时/私有云、CRM 跟进记录（含手动录入）、Hemory 活跃片段；
   * 排除 crm/customer_snapshot（记录修改属元数据，不算互动）与被新代际停用的片段（同时间线口径）。
   * occurred_at 混有 Z/+08:00/naive 三种格式，须逐行经 parseOccurredAt 解析，不能字符串比较。
   */
  lastInteractionAt(customerId: string): string | null {
    let latest: number | null = null;
    const touch = (value: string | null | undefined) => {
      if (!value) return;
      const at = parseOccurredAt(value);
      if (at != null && (latest == null || at > latest)) latest = at;
    };
    touch(this.getCustomer(customerId)?.lastContactAt ?? null);
    const rows = this.db.prepare(`SELECT occurred_at FROM source_events WHERE customer_id=?
      AND NOT (source_system='crm' AND source_type='customer_snapshot')
      AND NOT EXISTS (SELECT 1 FROM hemory_fragment_generations g WHERE g.event_id=source_events.id AND g.active=0)`).all(customerId) as Row[];
    for (const row of rows) touch(row.occurred_at as string | null);
    return latest == null ? null : new Date(latest).toISOString();
  }

  /** 预警判定用：该客户全部确认归属的 ONES source_events（含 payload 快照与 synced_at 新鲜度）。 */
  listOnesSourceEvents(customerId: string): SourceEvent[] {
    return (this.db.prepare(`SELECT * FROM source_events WHERE customer_id=? AND source_system='ones' AND attribution_status='confirmed'`)
      .all(customerId) as Row[]).map(sourceEventFromRow);
  }

  /** 预警判定用：该客户确认归属的 CRM 跟进记录（occurred_at + synced_at；同步侧只拉全局最近 200 条，覆盖有限）。 */
  listCrmFollowupEvents(customerId: string): SourceEvent[] {
    return (this.db.prepare(`SELECT * FROM source_events WHERE customer_id=? AND source_system='crm' AND source_type='crm_followup' AND attribution_status='confirmed'`)
      .all(customerId) as Row[]).map(sourceEventFromRow);
  }

  overview(customerId: string): Record<string, unknown> | null {
    const customer = this.getCustomer(customerId);
    if (!customer) return null;
    return {
      customer,
      aliases: this.listCustomerAliases(customerId),
      lastInteractionAt: this.lastInteractionAt(customerId),
      identities: this.listIdentities(customerId),
      risk: this.latestRisk(customerId),
      // 增购机会：按可信度降序 + 逐条附信息来源（evidenceRefs 解析成可读 sources；引用已失效的证据自然消失）。
      // 同一来源 URL 去重（webintel 多角度可能对同一链接存两条证据）；Hemory 无 URL 按证据 id，不同录音不误伤。
      opportunities: (() => {
        const evidenceById = new Map(this.listEvidence(customerId).map((item) => [item.id!, item]));
        return this.listOpportunities(customerId)
          .sort((a, b) => b.confidence - a.confidence)
          .map((item) => {
            const unique = new Map<string, { label: string; sourceSystem: string; sourceUrl: string | null; occurredAt: string }>();
            for (const id of item.evidenceRefs) {
              const entry = evidenceById.get(id);
              if (!entry) continue;
              const key = `${entry.sourceSystem}|${entry.sourceUrl ?? entry.id}`;
              if (!unique.has(key)) unique.set(key, { label: entry.label, sourceSystem: entry.sourceSystem, sourceUrl: entry.sourceUrl ?? null, occurredAt: entry.occurredAt });
            }
            const sources = [...unique.values()];
            return { ...item, sources: sources.slice(0, 4), sourceCount: sources.length };
          });
      })(),
      caseCandidate: this.getCaseCandidate(customerId),
      caseDrafts: this.listCaseDrafts(customerId),
      actions: this.listActions(customerId),
      // 客户详情预警横幅数据源：仅 active 行（已消除的在全局预警视图查看）。
      alerts: this.listAlerts({ status: 'active', customerId }),
      completionRates: this.onesCompletionRates(customerId),
      timeline: this.listTimeline(customerId, 30),
      sourceCounts: this.db.prepare(`SELECT source_system,COUNT(*) AS count,MAX(synced_at) AS last_synced_at FROM source_events
        WHERE customer_id=? AND NOT EXISTS (SELECT 1 FROM hemory_fragment_generations g WHERE g.event_id=source_events.id AND g.active=0)
        GROUP BY source_system`).all(customerId),
    };
  }
}
