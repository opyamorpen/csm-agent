export type RiskLevel = 'high' | 'medium' | 'low' | 'unknown';
export type ActionStatus = 'new' | 'accepted' | 'in_progress' | 'completed' | 'snoozed' | 'false_positive';
export type AttributionStatus = 'confirmed' | 'ambiguous' | 'unattributed' | 'ignored';
export type DraftItemType = 'internal_todo' | 'workhour' | 'followup' | 'suggestion' | 'ticket' | 'operations';
export type DraftItemStatus = 'draft' | 'ready' | 'writing' | 'written' | 'failed' | 'dismissed' | 'stale';
export type DraftGenerationStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type HemorySegmentationStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface CustomerInput {
  id: string;
  name: string;
  shortName?: string | null;
  industry?: string | null;
  /** CRM「使用版本」（field_Q2L6p__c）：公有云版 / 私有部署按年订阅版 / 私有部署一次性授权版。ONES 实例部署类型按它判定。 */
  usageVersion?: string | null;
  csmName?: string | null;
  csmWecomUserid?: string | null;
  sourceObject?: string | null;
  afterSalesStage?: string | null;
  renewalDate?: string | null;
  contractValue?: number | null;
  contractStatus?: string | null;
  products?: string[];
  lastContactAt?: string | null;
  supportOpenCount?: number | null;
  supportBlockedCount?: number | null;
  voiceRisk?: boolean | null;
  explicitNonrenewal?: boolean | null;
  nextAction?: string | null;
  nextActionDue?: string | null;
  crmUrl?: string | null;
  syncedAt?: string;
  source?: Record<string, unknown>;
}

export interface Customer extends CustomerInput {
  health: RiskLevel;
  createdAt: string;
  updatedAt: string;
  highValue?: boolean;
  renewalWithin120Days?: boolean;
  risk?: RiskAssessment | null;
  opportunityCount?: number;
  caseCandidate?: boolean;
  stale?: boolean;
}

export function normalizeAfterSalesStage(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export function isLostAfterSalesStage(value: string | null | undefined): boolean {
  return normalizeAfterSalesStage(value) === '流失';
}

export interface SourceEventInput {
  id?: string;
  customerId?: string | null;
  sourceSystem: 'crm' | 'ones' | 'hemory' | 'wecom' | string;
  sourceType: string;
  externalId: string;
  displayId?: string | null;
  title: string;
  occurredAt: string;
  syncedAt?: string;
  confidence?: number;
  url?: string | null;
  payload?: Record<string, unknown>;
  attributionStatus?: AttributionStatus;
}

export interface SourceEvent extends SourceEventInput {
  id: string;
  syncedAt: string;
  payloadHash: string;
  attributionStatus: AttributionStatus;
}

export interface WorkhourRecord {
  id: string;
  owner?: { id?: string; name?: string } | null;
  startTime: string;
  hours: number;
  description: string;
}

export interface HemoryAttributionOverride {
  eventId: string;
  customerId: string | null;
  status: AttributionStatus;
  actor: string;
  payloadHash: string;
  attributedAt: string;
}

export interface EvidenceInput {
  id?: string;
  customerId: string;
  sourceEventId?: string | null;
  kind: 'risk' | 'opportunity' | 'outcome' | 'voice' | 'fact' | string;
  label: string;
  detail: string;
  occurredAt: string;
  confidence: number;
  sourceSystem: string;
  sourceUrl?: string | null;
}

export interface RiskAssessment {
  id: string;
  customerId: string;
  score: number | null;
  level: RiskLevel;
  coverage: number;
  dimensions: Record<string, { score: number; weight: number; known: boolean; reason: string }>;
  evidenceRefs: string[];
  unknowns: string[];
  ruleVersion: string;
  generatedAt: string;
}

export interface OpportunityHypothesis {
  id: string;
  customerId: string;
  type: string;
  title: string;
  detail: string;
  confidence: number;
  status: 'hypothesis' | 'validated' | 'dismissed';
  evidenceRefs: string[];
  discoveryQuestions: string[];
  recommendedAction: string;
  generatedAt: string;
}

export interface ActionItemInput {
  id?: string;
  customerId: string;
  title: string;
  whyNow: string;
  owner?: string | null;
  ownerWecomUserid?: string | null;
  dueAt?: string | null;
  expectedOutcome?: string | null;
  evidenceRefs?: string[];
  sourceMeetingId?: string | null;
  confidence?: number;
}

export interface ActionItem extends ActionItemInput {
  id: string;
  status: ActionStatus;
  outcome?: string | null;
  createdAt: string;
  updatedAt: string;
  wecomTodoId?: string | null;
}

export interface CaseDraft {
  id: string;
  customerId: string;
  version: number;
  status: 'draft' | 'published';
  title: string;
  fields: Record<string, unknown>;
  evidenceRefs: string[];
  publishedPageId?: string | null;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftBatch {
  id: string;
  customerId: string;
  fingerprint: string;
  sourceEventIds: string[];
  generationVersion: string;
  generator: string;
  status: string;
  items?: DraftItem[];
  createdAt: string;
  updatedAt: string;
}

export interface DraftDisplayField {
  key: string;
  label: string;
  value: string;
}

export interface DraftItem {
  id: string;
  batchId: string;
  customerId: string;
  version: number;
  type: DraftItemType;
  status: DraftItemStatus;
  title: string;
  summary: string;
  fields: Record<string, unknown>;
  targetSystem: 'local' | 'crm' | 'ones';
  targetObject: string;
  targetTool: string | null;
  targetArguments: Record<string, unknown>;
  evidenceRefs: string[];
  unknowns: string[];
  validationErrors: string[];
  approvalHash?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  displayFields?: DraftDisplayField[];
  createdAt: string;
  updatedAt: string;
}

export interface DraftGenerationJob {
  id: string;
  customerId: string;
  fingerprint: string;
  sourceEventIds: string[];
  status: DraftGenerationStatus;
  attempts: number;
  error?: string | null;
  /** 生成任务种类：hemory 日草稿（默认）或 weekly_report 实施周报；resume 与轮询按 kind 认领。 */
  kind?: 'hemory' | 'weekly_report';
  createdAt: string;
  updatedAt: string;
}

/** 实施周报四章节内容（LLM 叙述部分）。 */
export interface WeeklyReportContent {
  /** ① 本周执行摘要（总括叙述 3~6 句） */
  summary: string;
  /** ② 本周完成情况：分小类逐条列出，每条带日期与来源引用 */
  accomplishments: Array<{ category: string; date: string; text: string; source: string }>;
  /** ③ 下周工作计划：主要来自 Hemory 片段中的约定与承诺，逐条标注来源 */
  next_week_plan: Array<{ text: string; source: string }>;
  /** ④ 问题风险与阻塞：主要来自 Hemory 片段中的问题信号 + 阻塞工单/风险评级 */
  risks: Array<{ text: string; source: string }>;
}

/** 实施周报代码确定性统计（叙述之外的一眼指标）。 */
export interface WeeklyReportStats {
  communications: number;
  newSuggestions: number;
  newTickets: number;
  newOperations: number;
  resolvedTickets: number | null;
  blockedTickets: number | null;
  openTickets: number | null;
  workhours: number | null;
  actionsCompleted: number | null;
  /** 统计口径附注（如「本周解决」为快照近似口径） */
  notes: string[];
}

export interface WeeklyReport {
  id: string;
  customerId: string;
  weekStart: string;
  weekEnd: string;
  version: number;
  status: 'draft' | 'published';
  content: WeeklyReportContent;
  stats: WeeklyReportStats;
  generator: string | null;
  fingerprint: string;
  publishedPageId?: string | null;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HemorySegmentationJob {
  id: string;
  recordingEventId: string;
  fingerprint: string;
  status: HemorySegmentationStatus;
  attempts: number;
  segmentCount: number;
  generator?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncRun {
  id: string;
  scope: string;
  customerId?: string | null;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  startedAt: string;
  finishedAt?: string | null;
  sourceStatus: Record<string, { status: string; count?: number; error?: string }>;
  error?: string | null;
}
