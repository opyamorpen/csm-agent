import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ActionItem,
  ActionItemInput,
  ActionStatus,
  CaseDraft,
  Customer,
  CustomerInput,
  DraftBatch,
  DraftGenerationJob,
  DraftItem,
  DraftItemStatus,
  HemoryAttributionOverride,
  HemorySegmentationJob,
  EvidenceInput,
  OpportunityHypothesis,
  RiskAssessment,
  SourceEvent,
  SourceEventInput,
  SyncRun,
} from './types.js';
import { normalizeAfterSalesStage } from './types.js';
import { renewalWithin } from './risk.js';

type Row = Record<string, unknown>;

/** 待归属列表默认保留的上海自然日数量（含今天），超出仅在指定日期或全部状态下可见。 */
export const HEMORY_PENDING_WINDOW_DAYS = 7;

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
 */
function parseOccurredAt(value: string): number | null {
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
    ownerWecomUserid: row.owner_wecom_userid as string | null,
    dueAt: row.due_at as string | null,
    expectedOutcome: row.expected_outcome as string | null,
    evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []),
    sourceMeetingId: row.source_meeting_id as string | null,
    confidence: Number(row.confidence ?? 0),
    status: String(row.status) as ActionStatus,
    outcome: row.outcome as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    wecomTodoId: row.wecom_todo_id as string | null,
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

      CREATE TABLE IF NOT EXISTS action_items (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        why_now TEXT NOT NULL,
        owner TEXT,
        owner_wecom_userid TEXT,
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

      CREATE TABLE IF NOT EXISTS wecom_todo_links (
        action_item_id TEXT PRIMARY KEY REFERENCES action_items(id) ON DELETE CASCADE,
        todo_id TEXT NOT NULL UNIQUE,
        creator_userid TEXT,
        status INTEGER NOT NULL DEFAULT 1,
        attendees_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        replaced_by_todo_id TEXT
      );

      CREATE TABLE IF NOT EXISTS todo_intents (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        action_item_id TEXT NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );

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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_draft_job_status ON draft_generation_jobs(status, updated_at);

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const sourceEventColumns = this.db.prepare('PRAGMA table_info(source_events)').all() as Row[];
    if (!sourceEventColumns.some((column) => String(column.name) === 'display_id')) {
      this.db.exec('ALTER TABLE source_events ADD COLUMN display_id TEXT;');
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

  listCustomers(query = '', sort: 'default' | 'renewal_date' | 'renewal_amount' = 'default'): Customer[] {
    const rows = this.db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM opportunities o WHERE o.customer_id=c.id AND o.status!='dismissed') AS opportunity_count,
        COALESCE((SELECT eligible FROM case_candidates cc WHERE cc.customer_id=c.id),0) AS case_candidate
      FROM customers c
      WHERE COALESCE(c.source_object, '') = 'object_Umwnn__c'
        AND TRIM(COALESCE(c.after_sales_stage, '')) <> '流失'
        AND COALESCE(c.contract_status, '') <> '已流失'
        AND (?='' OR c.name LIKE ? OR COALESCE(c.short_name,'') LIKE ? OR COALESCE(c.csm_name,'') LIKE ?)
    `).all(query, `%${query}%`, `%${query}%`, `%${query}%`) as Row[];
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
      INSERT INTO source_events(id,customer_id,source_system,source_type,external_id,display_id,title,occurred_at,synced_at,confidence,url,payload_json,payload_hash,attribution_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_system,source_type,external_id) DO UPDATE SET
        customer_id=excluded.customer_id,display_id=COALESCE(excluded.display_id,source_events.display_id),title=excluded.title,occurred_at=excluded.occurred_at,synced_at=excluded.synced_at,
        confidence=excluded.confidence,url=excluded.url,payload_json=excluded.payload_json,payload_hash=excluded.payload_hash,attribution_status=excluded.attribution_status
    `).run(id, input.customerId ?? null, input.sourceSystem, input.sourceType, input.externalId, input.displayId ?? null, input.title, input.occurredAt,
      syncedAt, input.confidence ?? 1, input.url ?? null, json(payload), payloadHash, attribution);
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

  listTimeline(customerId: string, limit = 100): SourceEvent[] {
    // 停用的 Hemory 片段（被新代际取代）不再进入客户时间线，避免重切后新旧并存；未登记代际的历史行不受影响。
    const rows = this.db.prepare(`SELECT * FROM source_events WHERE customer_id=?
      AND NOT EXISTS (SELECT 1 FROM hemory_fragment_generations g WHERE g.event_id=source_events.id AND g.active=0)
      ORDER BY occurred_at DESC, external_id DESC LIMIT ?`).all(customerId, limit) as Row[];
    return rows.map(sourceEventFromRow);
  }

  listUnattributed(limit = 100): SourceEvent[] {
    const rows = this.db.prepare("SELECT * FROM source_events WHERE attribution_status NOT IN ('confirmed','ignored') ORDER BY occurred_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(sourceEventFromRow);
  }

  listHemoryFragments(filters: { status?: string; date?: string; recordingId?: string; limit?: number; cursor?: string; days?: number } = {}): SourceEvent[] {
    const clauses = ["source_system='hemory'", "source_type='ai_topic_segment'", 'g.active=1'];
    const args: Array<string | number | null> = [];
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
    // 待归属默认只保留最近 7 个上海自然日，避免长期不处理导致列表堆积；显式日期/全部状态不受限。
    if (filters.status === 'pending' && !filters.date) {
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
    return {
      id: String(row.id), recordingEventId: String(row.recording_event_id), fingerprint: String(row.fingerprint),
      status: String(row.status) as HemorySegmentationJob['status'], attempts: Number(row.attempts),
      segmentCount: Number(row.segment_count ?? 0), generator: row.generator as string | null,
      error: row.error as string | null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
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

  updateHemorySegmentationJob(id: string, status: HemorySegmentationJob['status'], input: { segmentCount?: number; generator?: string; error?: string | null } = {}): HemorySegmentationJob | undefined {
    this.db.prepare(`UPDATE hemory_segmentation_jobs SET status=?,attempts=CASE WHEN ?='running' THEN attempts+1 ELSE attempts END,
      segment_count=COALESCE(?,segment_count),generator=COALESCE(?,generator),error=?,updated_at=? WHERE id=?`)
      .run(status, status, input.segmentCount ?? null, input.generator ?? null, input.error ?? null, nowIso(), id);
    return this.getHemorySegmentationJob(id);
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

  setCaseCandidate(customerId: string, eligible: boolean, reason: string, evidenceRefs: string[], confidence: number): void {
    this.db.prepare(`INSERT INTO case_candidates(customer_id,eligible,reason,evidence_refs_json,confidence,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET eligible=excluded.eligible,reason=excluded.reason,evidence_refs_json=excluded.evidence_refs_json,confidence=excluded.confidence,updated_at=excluded.updated_at`)
      .run(customerId, Number(eligible), reason, json(evidenceRefs), confidence, nowIso());
  }

  getCaseCandidate(customerId: string): Row | null {
    return (this.db.prepare('SELECT * FROM case_candidates WHERE customer_id=?').get(customerId) as Row | undefined) ?? null;
  }

  createCaseDraft(customerId: string, title: string, fields: Record<string, unknown>, evidenceRefs: string[]): CaseDraft {
    const now = nowIso();
    const draft: CaseDraft = { id: randomUUID(), customerId, version: 1, status: 'draft', title, fields, evidenceRefs, createdAt: now, updatedAt: now };
    this.db.prepare(`INSERT INTO case_drafts(id,customer_id,version,status,title,fields_json,evidence_refs_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(draft.id, customerId, 1, 'draft', title, json(fields), json(evidenceRefs), now, now);
    return draft;
  }

  getCaseDraft(id: string): CaseDraft | undefined {
    const row = this.db.prepare('SELECT * FROM case_drafts WHERE id=?').get(id) as Row | undefined;
    return row ? {
      id: String(row.id), customerId: String(row.customer_id), version: Number(row.version), status: String(row.status) as CaseDraft['status'],
      title: String(row.title), fields: parseJson(row.fields_json, {}), evidenceRefs: parseJson(row.evidence_refs_json, []),
      publishedPageId: row.published_page_id as string | null, publishedAt: row.published_at as string | null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    } : undefined;
  }

  listCaseDrafts(customerId?: string): CaseDraft[] {
    const rows = customerId
      ? this.db.prepare('SELECT id FROM case_drafts WHERE customer_id=? ORDER BY updated_at DESC').all(customerId) as Row[]
      : this.db.prepare('SELECT id FROM case_drafts ORDER BY updated_at DESC').all() as Row[];
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

  createAction(input: ActionItemInput): ActionItem {
    const id = input.id ?? randomUUID();
    const now = nowIso();
    this.db.prepare(`INSERT OR IGNORE INTO action_items(id,customer_id,title,why_now,owner,owner_wecom_userid,due_at,expected_outcome,evidence_refs_json,source_meeting_id,confidence,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.customerId, input.title, input.whyNow, input.owner ?? null, input.ownerWecomUserid ?? null,
      input.dueAt ?? null, input.expectedOutcome ?? null, json(input.evidenceRefs ?? []), input.sourceMeetingId ?? null, input.confidence ?? 0, 'new', now, now);
    return this.getAction(id)!;
  }

  getAction(id: string): ActionItem | undefined {
    const row = this.db.prepare(`SELECT a.*,w.todo_id AS wecom_todo_id FROM action_items a LEFT JOIN wecom_todo_links w ON w.action_item_id=a.id WHERE a.id=?`).get(id) as Row | undefined;
    return row ? actionFromRow(row) : undefined;
  }

  listActions(customerId?: string): ActionItem[] {
    const sql = `SELECT a.*,w.todo_id AS wecom_todo_id FROM action_items a LEFT JOIN wecom_todo_links w ON w.action_item_id=a.id ${customerId ? 'WHERE a.customer_id=?' : ''}
      ORDER BY CASE a.status WHEN 'new' THEN 0 WHEN 'accepted' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END, COALESCE(a.due_at,'9999')`;
    const rows = (customerId ? this.db.prepare(sql).all(customerId) : this.db.prepare(sql).all()) as Row[];
    return rows.map(actionFromRow);
  }

  updateAction(id: string, patch: Partial<ActionItemInput> & { status?: ActionStatus; outcome?: string | null }): ActionItem | null {
    const current = this.getAction(id);
    if (!current) return null;
    this.db.prepare(`UPDATE action_items SET title=?,why_now=?,owner=?,owner_wecom_userid=?,due_at=?,expected_outcome=?,evidence_refs_json=?,status=?,outcome=?,updated_at=? WHERE id=?`)
      .run(patch.title ?? current.title, patch.whyNow ?? current.whyNow, patch.owner ?? current.owner ?? null,
        patch.ownerWecomUserid ?? current.ownerWecomUserid ?? null, patch.dueAt ?? current.dueAt ?? null,
        patch.expectedOutcome ?? current.expectedOutcome ?? null, json(patch.evidenceRefs ?? current.evidenceRefs ?? []),
        patch.status ?? current.status, patch.outcome ?? current.outcome ?? null, nowIso(), id);
    return this.getAction(id)!;
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
    return row ? { id: String(row.id), scope: String(row.scope), customerId: row.customer_id as string | null, status: String(row.status) as SyncRun['status'],
      startedAt: String(row.started_at), finishedAt: row.finished_at as string | null, sourceStatus: parseJson(row.source_status_json, {}), error: row.error as string | null } : undefined;
  }

  hasSuccessfulSyncScope(scope: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sync_runs WHERE scope=? AND status='succeeded' LIMIT 1").get(scope);
  }

  createTodoIntent(actionItemId: string, ttlMinutes = 10): { id: string; token: string; expiresAt: string } {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.db.prepare('INSERT INTO todo_intents(id,token_hash,action_item_id,status,expires_at,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, tokenHash, actionItemId, 'pending', expiresAt, nowIso());
    return { id, token, expiresAt };
  }

  consumeTodoIntent(id: string, token: string): { actionItemId: string } | null {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = this.db.prepare(`SELECT * FROM todo_intents WHERE id=? AND token_hash=? AND status='pending' AND expires_at>?`).get(id, tokenHash, nowIso()) as Row | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE todo_intents SET status='consumed',consumed_at=? WHERE id=?").run(nowIso(), id);
    return { actionItemId: String(row.action_item_id) };
  }

  peekTodoIntent(id: string, token: string): { actionItemId: string } | null {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = this.db.prepare(`SELECT action_item_id FROM todo_intents WHERE id=? AND token_hash=? AND status='pending' AND expires_at>?`).get(id, tokenHash, nowIso()) as Row | undefined;
    return row ? { actionItemId: String(row.action_item_id) } : null;
  }

  linkWecomTodo(actionItemId: string, todoId: string, creatorUserid?: string, attendees: string[] = []): void {
    const now = nowIso();
    this.db.prepare(`INSERT INTO wecom_todo_links(action_item_id,todo_id,creator_userid,status,attendees_json,created_at,last_synced_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(action_item_id) DO UPDATE SET todo_id=excluded.todo_id,creator_userid=excluded.creator_userid,status=excluded.status,
      attendees_json=excluded.attendees_json,last_synced_at=excluded.last_synced_at`).run(actionItemId, todoId, creatorUserid ?? null, 1, json(attendees), now, now);
  }

  getWecomTodoLink(actionItemId: string): Row | null {
    return (this.db.prepare('SELECT * FROM wecom_todo_links WHERE action_item_id=?').get(actionItemId) as Row | undefined) ?? null;
  }

  listActiveWecomTodoLinks(): Row[] {
    return this.db.prepare('SELECT * FROM wecom_todo_links WHERE status=1').all() as Row[];
  }

  updateWecomTodoStatus(actionItemId: string, status: number, attendees: unknown[] = []): void {
    this.db.prepare('UPDATE wecom_todo_links SET status=?,attendees_json=?,last_synced_at=? WHERE action_item_id=?').run(status, json(attendees), nowIso(), actionItemId);
    if (status === 0) this.updateAction(actionItemId, { status: 'completed', outcome: '已在企业微信待办中完成' });
  }

  createDraftJob(customerId: string, fingerprint: string, sourceEventIds: string[]): DraftGenerationJob {
    const existing = this.db.prepare('SELECT * FROM draft_generation_jobs WHERE fingerprint=?').get(fingerprint) as Row | undefined;
    if (existing) return this.draftJobFromRow(existing);
    const now = nowIso();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO draft_generation_jobs(id,customer_id,fingerprint,source_event_ids_json,status,attempts,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, customerId, fingerprint, json(sourceEventIds), 'pending', 0, now, now);
    return this.getDraftJob(id)!;
  }

  private draftJobFromRow(row: Row): DraftGenerationJob {
    return { id: String(row.id), customerId: String(row.customer_id), fingerprint: String(row.fingerprint),
      sourceEventIds: parseJson(row.source_event_ids_json, []), status: String(row.status) as DraftGenerationJob['status'],
      attempts: Number(row.attempts), error: row.error as string | null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  getDraftJob(id: string): DraftGenerationJob | undefined {
    const row = this.db.prepare('SELECT * FROM draft_generation_jobs WHERE id=?').get(id) as Row | undefined;
    return row ? this.draftJobFromRow(row) : undefined;
  }

  findDraftJobByFingerprint(fingerprint: string): DraftGenerationJob | undefined {
    const row = this.db.prepare('SELECT * FROM draft_generation_jobs WHERE fingerprint=?').get(fingerprint) as Row | undefined;
    return row ? this.draftJobFromRow(row) : undefined;
  }

  listPendingDraftJobs(): DraftGenerationJob[] {
    const rows = this.db.prepare("SELECT * FROM draft_generation_jobs WHERE status IN ('pending','running','failed') ORDER BY updated_at").all() as Row[];
    return rows.map((row) => this.draftJobFromRow(row));
  }

  updateDraftJob(id: string, status: DraftGenerationJob['status'], error?: string | null): DraftGenerationJob | undefined {
    this.db.prepare(`UPDATE draft_generation_jobs SET status=?,attempts=CASE WHEN ?='running' THEN attempts+1 ELSE attempts END,error=?,updated_at=? WHERE id=?`)
      .run(status, status, error ?? null, nowIso(), id);
    return this.getDraftJob(id);
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

  audit(actor: string, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}): void {
    this.db.prepare('INSERT INTO audit_log(id,actor,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), actor, action, entityType, entityId, json(details), nowIso());
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

  overview(customerId: string): Record<string, unknown> | null {
    const customer = this.getCustomer(customerId);
    if (!customer) return null;
    return {
      customer,
      lastInteractionAt: this.lastInteractionAt(customerId),
      identities: this.listIdentities(customerId),
      risk: this.latestRisk(customerId),
      opportunities: this.listOpportunities(customerId),
      caseCandidate: this.getCaseCandidate(customerId),
      caseDrafts: this.listCaseDrafts(customerId),
      actions: this.listActions(customerId),
      timeline: this.listTimeline(customerId, 30),
      sourceCounts: this.db.prepare(`SELECT source_system,COUNT(*) AS count,MAX(synced_at) AS last_synced_at FROM source_events
        WHERE customer_id=? AND NOT EXISTS (SELECT 1 FROM hemory_fragment_generations g WHERE g.event_id=source_events.id AND g.active=0)
        GROUP BY source_system`).all(customerId),
    };
  }
}
