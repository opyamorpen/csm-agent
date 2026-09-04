import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Runtime } from './bootstrap.js';
import { loadMcpServers, saveMcpServers, loadSearchConfig, saveSearchConfig, searchConfigStatus, type McpServerConfig } from './config.js';
import { CUSTOM_PROVIDER_ID, testCustomEndpoint } from './custom-llm.js';
import { AgentSession, AgentAbortedError, type AgentEvent } from './agent.js';
import type { ConfirmDraft } from './tools/confirm.js';
import { CUSTOMER_CONTEXT_TOOL_NAME, extractCustomerContext, type CustomerContext } from './tools/customer.js';
import { CUSTOMER_PROFILE_TOOL_NAME, CUSTOMER_EVENTS_TOOL_NAME, makeWorkbenchToolHandlers } from './tools/workbench.js';
import { CUSTOMER_DETAIL_TOOL_NAME, makeCustomerDetailResult } from './tools/customer-detail.js';
import { WEB_SEARCH_TOOL_NAME, RECORD_WEB_INTELLIGENCE_TOOL_NAME, makeWebSearchHandler, makeRecordWebIntelligenceHandler } from './tools/websearch.js';
import { ONES_DESK_FIELDS_TOOL_NAME, makeOnesDeskFieldsHandler } from './tools/onesdesk.js';
import { missingOnesDeskSpecFields, missingOnesDeskDescription, unknownOnesDeskFieldIds, applyDeploymentTypeOverride, ONES_DESK_DEPLOYMENT_FIELD_ID, resolveOnesOption } from './workbench/drafts.js';
import { Store, customerOf, makeRecordFromDraft, dataDir, type RecordEntry } from './store.js';
import { formatSessionTranscript, type TranscriptSession, type TranscriptEvent } from './transcript.js';
import { WorkbenchDatabase } from './workbench/database.js';
import type { AuthUser } from './workbench/database.js';
import {
  issueToken, tokenFingerprint, hashPassword, verifyPassword, PHANTOM_HASH, validatePassword, generatePassword,
  USERNAME_PATTERN, LoginRateLimiter, cookieValue, SESSION_COOKIE, sessionCookieHeader, clearSessionCookieHeader,
  sessionExpiry, SESSION_TTL_MS, ensureBootstrapAdmin,
} from './auth.js';
import { evaluateCustomerAlerts } from './workbench/alerts.js';
import type { Customer } from './workbench/types.js';
import { PortfolioSyncService, scheduleHemorySync, schedulePortfolioSync, scheduleWebIntelSync } from './workbench/sync.js';
import { WebIntelService } from './workbench/webintel.js';
import { OpportunityService } from './workbench/opportunity.js';
import { RISK_RULE_VERSION } from './workbench/risk.js';
import { CaseService, caseNarrativeWarnings } from './workbench/cases.js';
import { HemoryDraftService, draftDisplayFields, shanghaiEventDate, draftEditContract, applyDraftEdits, confirmDraftEditContract, applyConfirmDraftEdits } from './workbench/drafts.js';
import type { DraftBatch, DraftItem, DraftGenerationJob, DraftItemType, SourceEvent } from './workbench/types.js';
import { HemorySegmentationService, hemorySegmentationFingerprint } from './workbench/hemory.js';
import { WeeklyReportService, weekMonday, weekRange } from './workbench/weekly.js';
import { WikiService } from './workbench/wiki.js';
import { readBuildInfo, serviceVersionInfo, startStalenessWatch, type BuildInfo } from './version.js';
import { consumeRestoreMarker, listBackups, nextBackupSlot, scheduleBackup, triggerBackup } from './backup.js';
import { AttachmentError, classifyAttachment, buildContentBlocks, storeAttachments, getStoredAttachment, removeSessionAttachments, attachmentFilePath, type IncomingAttachment } from './attachments.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

// startServer 填充：进程启动时加载的构建信息（旧进程检测的内存锚点）与服务启动时刻。
let loadedBuildInfo: BuildInfo | null = null;
let serverStartedAt = new Date().toISOString();

interface PendingConfirm {
  draft: ConfirmDraft;
  resolve: (decision: boolean | ConfirmDraft) => void;
}

type DisplayEvent = { type: string } & Record<string, unknown>;

interface Session {
  id: string;
  agent: AgentSession;
  events: Array<{ seq: number; event: DisplayEvent }>;
  clients: Set<http.ServerResponse>;
  pending: PendingConfirm | null;
  busy: boolean;
  /** 单调 seq 计数器：持久事件与瞬态 delta 共用，重连/刷新后去重才可靠。 */
  seqCounter: number;
  /** 当前 turn 的中止开关；仅在 busy 期间存在。 */
  abort: AbortController | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** id of the most recent confirm_write draft record in this session */
  lastRecordId: string | null;
  /** 存量会话的只读客户标签（全解耦前的绑定遗留；新会话恒为 null，任何行为不再读取它） */
  customer: CustomerContext | null;
  /** archived sessions stay loadable but are hidden from the default list */
  archived: boolean;
  /** 归属登录用户：会话是个人工作区，仅属主本人可读写（存量旧会话在装载时归入 admin）。 */
  userId: number;
}

/** 事件帧 seq 判断：text_delta/thinking_delta 只流给在线客户端，不落盘不回放。 */
const TRANSIENT_EVENT_TYPES = new Set(['text_delta', 'thinking_delta']);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function validateServers(servers: unknown): string | null {
  if (!Array.isArray(servers)) return 'servers 必须是数组';
  for (const s of servers as Array<Record<string, unknown>>) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) return '每个服务器都需要 name';
    const transport = s.transport;
    if (transport !== 'stdio' && transport !== 'streamable-http') {
      return `服务器 "${s.name}": transport 必须是 stdio 或 streamable-http`;
    }
    if (transport === 'stdio' && typeof s.command !== 'string') {
      return `服务器 "${s.name}": stdio 需要 command`;
    }
    if (transport === 'streamable-http' && typeof s.url !== 'string') {
      return `服务器 "${s.name}": streamable-http 需要 url`;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function containsExactValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactValue(item, expected));
  return isRecord(value) && Object.values(value).some((item) => containsExactValue(item, expected));
}

function editedDraft(original: ConfirmDraft, value: unknown): ConfirmDraft | null {
  if (!isRecord(value)) return null;
  if (value.target_system !== original.target_system || value.target_tool !== original.target_tool) return null;
  if (!isRecord(value.fields) || !isRecord(value.target_arguments)) return null;
  return {
    target_system: String(value.target_system),
    target_object: String(value.target_object ?? original.target_object),
    record_type: String(value.record_type ?? original.record_type),
    title: String(value.title ?? original.title),
    summary: String(value.summary ?? original.summary),
    fields: value.fields,
    target_tool: String(value.target_tool),
    target_arguments: value.target_arguments,
  };
}

/** 案例精修只允许修改五段公开正文；证据、客户绑定与上下文快照由生成服务维护。 */
function pickNarrativeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  // v8 章节字段（含派生表/里程碑）+ 存量旧稿五段键：只透传公开正文，内部字段由 update 原样保留。
  const keys = ['company_info', 'business_scope', 'competitive_strategy', 'project_background', 'business_status',
    'demands', 'solution_sections', 'value_items', 'lessons', 'summary', 'system_usage', 'milestones',
    'background', 'challenges', 'requirements', 'solution', 'value'];
  for (const key of keys) {
    if (fields[key] !== undefined) picked[key] = fields[key];
  }
  return picked;
}

/**
 * 落盘事件尾部是否存在未闭合轮次（turn_start 之后没有 turn_end）。
 * 服务重启（构建自愈/崩溃）会丢掉在途轮次——含挂起中的确认卡（requestConfirm 停住期间
 * 服务端 busy 恒为 true，turn_end 只在轮次真正结束时才发）：悬空的 turn_start 在 SSE 回放时
 * 会把前端 busy 钉死（发送键卡成「停止」，再点即 409「当前没有进行中的对话」）。
 * 启动装载时用本函数检测并补一帧 stopped turn_end，回放自洽；stopped 让前端禁用孤儿确认卡。
 * 中段悬空但末轮已闭合的历史返回 false——补帧只在尾部追加，中段缺失对回放状态机无影响。
 */
export function hasUnterminatedTurn(events: Array<{ event: { type?: string } }>): boolean {
  let inTurn = false;
  for (const { event } of events) {
    if (event.type === 'turn_start') inTurn = true;
    else if (event.type === 'turn_end') inTurn = false;
  }
  return inTurn;
}

/** 审批用权威客户绑定：从工作台库解析出的客户行与派生 ID（ONES confirmed 选项 / 售后工时项）。 */
export interface DraftCustomerBinding {
  customer: Customer;
  onesOptionId?: string;
  manhourIssueId?: string;
}

function bindingOfCustomer(db: WorkbenchDatabase, customer: Customer): DraftCustomerBinding {
  const option = resolveOnesOption(db, customer);
  const manhour = db.findCustomerManhourIssue(customer.id);
  return { customer, onesOptionId: option?.id, manhourIssueId: manhour?.externalId };
}

export type CustomerMatchedBy = 'id' | 'exact' | 'alias' | 'substring';

export type CustomerResolution =
  | { status: 'resolved'; customer: Customer; matchedBy: CustomerMatchedBy }
  | { status: 'ambiguous'; candidates: Customer[] }
  | { status: 'not_found'; suggestions: Customer[] };

/**
 * CRM _id 直取（模型乱填的非 ID 串自然落空）；否则按名称解析，口径与 CLI 一致：
 * ① 全称/简称/别名精确等值；② 唯一子串兜底（口语缩略如「中科晶禾」→「天津中科晶禾电子科技有限责任公司」，
 * 仅当可见活跃客户中恰好一个含该子串时成立，≥2 字符门槛）。任何一层命中多个即歧义——宁可不归属。
 * not_found 时带回 LIKE 相近候选（≤5 个），供 resolve_customer 向模型给出可确认的候选清单。
 */
export function resolveCustomerForContext(db: WorkbenchDatabase, context: { crm_customer_id?: string; customer_name?: string }): CustomerResolution {
  const id = typeof context.crm_customer_id === 'string' ? context.crm_customer_id.trim() : '';
  if (id) {
    const byId = db.getCustomer(id);
    if (byId) return { status: 'resolved', customer: byId, matchedBy: 'id' };
  }
  const name = typeof context.customer_name === 'string' ? context.customer_name.trim() : '';
  if (!name) return { status: 'not_found', suggestions: [] };
  const candidates = db.listCustomers(name);
  const aliasesOf = new Map(candidates.map((c) => [c.id, db.listCustomerAliases(c.id)]));
  const exactTier = candidates.filter((c) => c.name === name || c.shortName === name || (aliasesOf.get(c.id) ?? []).includes(name));
  if (exactTier.length === 1) {
    const customer = exactTier[0]!;
    return { status: 'resolved', customer, matchedBy: customer.name === name || customer.shortName === name ? 'exact' : 'alias' };
  }
  if (exactTier.length > 1) return { status: 'ambiguous', candidates: exactTier };
  if (name.length >= 2) {
    const substringTier = candidates.filter((c) => c.name.includes(name) || (c.shortName ?? '').includes(name)
      || (aliasesOf.get(c.id) ?? []).some((alias) => alias.includes(name)));
    if (substringTier.length === 1) return { status: 'resolved', customer: substringTier[0]!, matchedBy: 'substring' };
    if (substringTier.length > 1) return { status: 'ambiguous', candidates: substringTier };
  }
  return { status: 'not_found', suggestions: candidates.slice(0, 5) };
}

/** 兼容入口：只关心客户本体（读工具与草稿绑定门），解析细节见 resolveCustomerForContext。 */
function uniqueCustomerByContext(db: WorkbenchDatabase, context: { crm_customer_id?: string; customer_name?: string }): Customer | undefined {
  const resolution = resolveCustomerForContext(db, context);
  return resolution.status === 'resolved' ? resolution.customer : undefined;
}

/**
 * 两级解析草稿客户：fields.customer_id 库内直取 → fields.customer_name 唯一匹配
 * （全称/简称/别名精确，或唯一子串兜底——与读工具同一条解析链，避免对话里能解析、写单时又绑不上）。
 * 外部写的客户身份完全以草稿自含信息为准（贴图/聊天记录提单：客户名就在贴入内容里），
 * 会话不承载客户状态——「这次写入」必须绑定客户，对话本身不需要。
 */
export function resolveDraftCustomer(db: WorkbenchDatabase, draft: ConfirmDraft): DraftCustomerBinding | null {
  const byDraft = uniqueCustomerByContext(db, {
    crm_customer_id: typeof draft.fields?.customer_id === 'string' ? draft.fields.customer_id : undefined,
    customer_name: typeof draft.fields?.customer_name === 'string' ? draft.fields.customer_name : undefined,
  });
  return byDraft ? bindingOfCustomer(db, byDraft) : null;
}

/** 草稿自含客户解析出的 CRM 使用版本（结构化编辑契约与部署类型锁定的依据）；草稿无可解析客户时为 null。 */
function draftUsageVersion(db: WorkbenchDatabase, draft: ConfirmDraft): string | null {
  return resolveDraftCustomer(db, draft)?.customer.usageVersion ?? null;
}

/** ONES Desk 批准时确定性绑定客户选项：模型自行搜索的选项仅参考，以解析客户 confirmed 选项为准（与部署类型覆盖同一哲学）。返回错误串或 null（已就地规范化）。 */
export function applyDraftCustomerOptionBinding(draft: ConfirmDraft, binding: DraftCustomerBinding): string | null {
  if (draft.target_system !== 'ones') return null;
  if (!(draft.record_type === 'suggestion' || draft.record_type === 'ticket' || draft.record_type === 'operations')) return null;
  const customerFieldId = process.env.ONES_CUSTOMER_FIELD_ID ?? 'JrvswW8P';
  if (!binding.onesOptionId) return `客户「${binding.customer.name}」未解析到已确认的 ONES 客户选项（请刷新客户同步后重试）`;
  const fieldValues = Array.isArray(draft.target_arguments.fieldValues) ? draft.target_arguments.fieldValues as Array<Record<string, unknown>> : [];
  draft.target_arguments.fieldValues = [
    ...fieldValues.filter((item) => !(isRecord(item) && item.fieldID === customerFieldId)),
    { fieldID: customerFieldId, value: binding.onesOptionId },
  ];
  return null;
}

/** 客户上下文富集（resolve_customer 无状态解析）：唯一命中工作台客户时补全 CRM _id、ONES 选项、售后工时项与使用版本。 */
export function enrichCustomerContext(db: WorkbenchDatabase, context: CustomerContext | null): CustomerContext | null {
  const customer = uniqueCustomerByContext(db, { crm_customer_id: context?.crm_customer_id, customer_name: context?.customer_name });
  if (!customer) return null;
  const binding = bindingOfCustomer(db, customer);
  return {
    ...context,
    customer_name: customer.name,
    crm_customer_id: customer.id,
    ...(binding.onesOptionId ? { ones_customer_option_id: binding.onesOptionId } : {}),
    ...(binding.manhourIssueId ? { customer_manhour_issue_id: binding.manhourIssueId } : {}),
    ...(customer.usageVersion ? { usage_version: customer.usageVersion } : {}),
  } as CustomerContext;
}

export function validateCustomerBoundDraft(draft: ConfirmDraft, binding: DraftCustomerBinding | null): string | null {
  if (!binding) {
    return '草稿未携带可唯一解析的客户（fields.customer_id 或 customer_name 须与工作台客户唯一匹配：全称/简称/别名精确或唯一子串），请确认客户名称后重新 confirm_write';
  }
  const { customer, onesOptionId, manhourIssueId } = binding;
  if (draft.target_system === 'crm') {
    return containsExactValue(draft.target_arguments, customer.id)
      ? null
      : `CRM 回写参数未绑定当前 CSM 售后客户 ID（${customer.id}）`;
  }
  if (draft.target_system !== 'ones') return 'target_system 只允许 crm 或 ones';
  if (draft.record_type === 'case' || draft.record_type === 'profile') return null;
  if (draft.record_type === 'workhour') {
    return manhourIssueId && draft.target_arguments.issueID === manhourIssueId
      ? null
      : '工时回写必须指向当前客户已绑定的“售后客户”工作项';
  }
  const fieldValues = Array.isArray(draft.target_arguments.fieldValues) ? draft.target_arguments.fieldValues : [];
  const customerFieldId = process.env.ONES_CUSTOMER_FIELD_ID ?? 'JrvswW8P';
  const bindingEntry = fieldValues.find((item) => isRecord(item) && item.fieldID === customerFieldId);
  return bindingEntry && onesOptionId && containsExactValue(bindingEntry.value, onesOptionId)
    ? null
    : `ONES 回写参数必须在 fieldValues 中绑定 ${customerFieldId}=${onesOptionId ?? '(未解析，请刷新客户同步后重试)'}`;
}

interface WorkbenchServices {
  db: WorkbenchDatabase;
  sync: PortfolioSyncService;
  cases: CaseService;
  drafts: HemoryDraftService;
  weekly: WeeklyReportService;
  wiki: WikiService;
  opportunities: OpportunityService;
}

/** 一次已通过验证的请求身份：用户 + 凭证形态（cookie 会话 / Bearer PAT 或会话）。 */
interface AuthContext {
  user: AuthUser;
  kind: 'cookie' | 'token';
  credential: 'session' | 'pat';
  tokenHash: string;
}

function authenticate(db: WorkbenchDatabase, req: http.IncomingMessage): AuthContext | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token) return null;
    const { tokenHash } = tokenFingerprint(token);
    const tokenUser = db.findAuthToken(tokenHash);
    if (tokenUser) {
      db.touchAuthToken(tokenHash);
      return { user: tokenUser, kind: 'token', credential: 'pat', tokenHash };
    }
    const session = db.findAuthSession(tokenHash);
    if (session) {
      const expiry = sessionExpiry(session.expiresAt, session.lastSeenAt);
      if (expiry.expired) {
        db.deleteAuthSession(tokenHash);
        return null;
      }
      if (expiry.nextExpiresAt) db.touchAuthSession(tokenHash, expiry.nextExpiresAt);
      return { user: session.user, kind: 'token', credential: 'session', tokenHash };
    }
    return null;
  }
  const cookieToken = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (!cookieToken) return null;
  const { tokenHash } = tokenFingerprint(cookieToken);
  const session = db.findAuthSession(tokenHash);
  if (!session) return null;
  const expiry = sessionExpiry(session.expiresAt, session.lastSeenAt);
  if (expiry.expired) {
    db.deleteAuthSession(tokenHash);
    return null;
  }
  if (expiry.nextExpiresAt) db.touchAuthSession(tokenHash, expiry.nextExpiresAt);
  return { user: session.user, kind: 'cookie', credential: 'session', tokenHash };
}

/** 用户对外视图：永不携带密码哈希与企微 userid。 */
function publicUser(user: AuthUser): { id: number; username: string; displayName: string; role: string; status: string } {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, status: user.status };
}

export function buildHandler(runtime: Runtime, store: Store, workbench: WorkbenchServices, legacyUserId: number | undefined): http.RequestListener {
  const sessions = new Map<string, Session>();
  const loginRateLimiter = new LoginRateLimiter();
  // 会话属主判定：库内会话带 userId；存量单用户时代的旧会话文件无字段，按 admin（legacy）兜底。
  const sessionOwner = (userId: number | undefined): number => userId ?? legacyUserId ?? -1;

  // 视觉（图片输入）能力：builtin 目录模型自动带，custom 由配置声明；附件图片走 image 块的前提。
  const visionSupported = () => runtime.model.input.includes('image');

  // 草稿确认视图共用最小必填项结构（displayFields），Web 卡片与 CLI 渲染同一份数据。
  const DRAFT_ITEM_STATUS_LABELS: Record<string, string> = { draft: '草稿', ready: '就绪', writing: '写入中', written: '已写入', failed: '失败', dismissed: '已忽略', stale: '已作废' };
  function decorateDraftBatch(batch: DraftBatch, activeDays?: Set<string>): DraftBatch {
    // 重新生成中标记：服务端权威下发（进行中任务覆盖同客户×上海日），三端与刷新后一致。
    const regenerating = workbench.drafts.batchRegenerating(batch, activeDays);
    if (!batch.items) return { ...batch, regenerating };
    // actionableItemCount：仍需处理（可勾选确认）的条目数；为 0 的批次是纯已作废/已忽略批次，前端默认折叠。
    const actionableItemCount = batch.items.filter((item) => !['written', 'dismissed', 'stale'].includes(item.status)).length;
    return { ...batch, regenerating, actionableItemCount, items: batch.items.map((item) => decorateDraftItem(item)) };
  }
  function decorateDraftItem(item: DraftItem): DraftItem {
    const customer = workbench.db.getCustomer(item.customerId) as Customer | undefined;
    const decorated = customer ? { ...item, displayFields: draftDisplayFields(workbench.db, item, customer) } : item;
    return { ...decorated, statusLabel: DRAFT_ITEM_STATUS_LABELS[item.status] ?? item.status };
  }
  // 结构化编辑契约：仍可编辑（未写入/未忽略/未作废）的草稿附带表单字段定义；其余状态不带。
  function editContractOf(item: DraftItem) {
    if (['written', 'writing', 'dismissed', 'stale'].includes(item.status)) return undefined;
    const customer = workbench.db.getCustomer(item.customerId) as Customer | undefined;
    return customer ? draftEditContract(workbench.db, item, customer) : undefined;
  }
  // 失败生成任务的片段明细：客户名 + 上海日 + 逐片段摘要（截断），支撑「失败后选片段重新生成」。
  // weekly_report 任务补算 weekStart（首个可解析种子事件的周界，与 process() 同逻辑）：页面重开后恢复进度需对周。
  // 在途 heretry 任务补 dateKey（横幅按「客户 · 日期」标注）。heretry/case/weekly 三类生成任务：
  // running 但不在本进程处理集合 = 孤儿（服务重启遗留、resume 因 attempts 耗尽不再认领，永不终结）
  // → stalled，前端/CLI 据此提前退出并引导重新生成。
  function decorateDraftJob(job: DraftGenerationJob): DraftGenerationJob & { dateKey?: string; fragments?: Array<{ id: string; occurredAt: string; topic: string; summary: string }>; weekStart?: string; stalled?: boolean } {
    if (job.status === 'failed') {
      const fragments: Array<{ id: string; occurredAt: string; topic: string; summary: string }> = [];
      let dateKey = '';
      for (const id of job.sourceEventIds) {
        const event = workbench.db.getSourceEvent(id);
        if (!event) continue;
        if (!dateKey) dateKey = shanghaiEventDate(event);
        const summary = String(event.payload?.summary ?? '').trim();
        fragments.push({ id: event.id, occurredAt: event.occurredAt, topic: event.title, summary: summary.slice(0, 120) });
      }
      return { ...job, dateKey: dateKey || undefined, fragments };
    }
    const processing = job.kind === 'hemory' ? workbench.drafts.isJobProcessing(job.id)
      : job.kind === 'case_report' ? workbench.cases.isJobProcessing(job.id)
      : job.kind === 'weekly_report' ? workbench.weekly.isJobProcessing(job.id)
      : null;
    const stalled = processing === false && job.status === 'running';
    if (job.kind === 'hemory' && (job.status === 'pending' || job.status === 'running')) {
      for (const id of job.sourceEventIds) {
        const event = workbench.db.getSourceEvent(id);
        if (event) return { ...job, dateKey: shanghaiEventDate(event), ...(stalled ? { stalled: true } : {}) };
      }
      return stalled ? { ...job, stalled: true } : job;
    }
    if (job.kind === 'case_report') return stalled ? { ...job, stalled: true } : job;
    if (job.kind === 'weekly_report') {
      for (const id of job.sourceEventIds) {
        const event = workbench.db.getSourceEvent(id);
        if (event) return { ...job, weekStart: weekMonday(event.occurredAt), ...(stalled ? { stalled: true } : {}) };
      }
      return stalled ? { ...job, stalled: true } : job;
    }
    return job;
  }

  // 片段消费台账可见性：每片段标注被哪些类型的已写入草稿消费（written 草稿 evidence_refs 反查，
  // 跨代际扩展到重切孪生，按客户一次构建）。
  function decorateHemoryFragments(fragments: SourceEvent[]): Array<SourceEvent & { consumedBy?: DraftItemType[] }> {
    const byCustomer = new Map<string, Map<string, DraftItemType[]>>();
    const consumedOf = (customerId: string): Map<string, DraftItemType[]> => {
      let map = byCustomer.get(customerId);
      if (!map) {
        map = new Map();
        for (const [type, ids] of workbench.db.expandedWrittenEvidenceByType(customerId)) {
          for (const id of ids) {
            const list = map.get(id) ?? [];
            list.push(type);
            map.set(id, list);
          }
        }
        byCustomer.set(customerId, map);
      }
      return map;
    };
    return fragments.map((fragment) => {
      if (!fragment.customerId) return fragment;
      const consumedBy = consumedOf(fragment.customerId).get(fragment.id);
      return consumedBy?.length ? { ...fragment, consumedBy } : fragment;
    });
  }

  /**
   * 存量孪生一次性修复：遍历全部录音，把停用世代的 confirmed/ignored 归属按时间覆盖率继承到
   * 活跃世代待处理片段（复用 inheritHemoryAttributions）；同时对最近一次 succeeded job 回填
   * 转写基准 inputMeta（仅当按当前录音 payload 重算的指纹与该 job 指纹一致，证明 job 跑在
   * 当前转写上）——回填后重切闸门对已处理完的录音立即生效。apply=false 为 dry-run 只报告。
   */
  function repairHemoryInheritance(apply: boolean, actor = 'csm'): Array<{
    recordingId: string; recordingEventId: string; title: string; inherited: Array<{ eventId: string; predecessorId: string; status: string; customerId: string | null; overlapRatio: number }>; metaBackfilled: boolean;
  }> {
    const report: Array<{ recordingId: string; recordingEventId: string; title: string; inherited: Array<{ eventId: string; predecessorId: string; status: string; customerId: string | null; overlapRatio: number }>; metaBackfilled: boolean }> = [];
    for (const recording of workbench.db.listHemoryRawTranscriptRecordings()) {
      const recordingEventId = recording.id;
      const pending = workbench.db.listActiveHemoryFragmentsForRecording(recordingEventId)
        .some((event) => event.attributionStatus === 'unattributed');
      let metaBackfilled = false;
      if (apply) {
        const job = workbench.db.latestEffectiveHemorySegmentationJob(recordingEventId);
        if (job && job.status === 'succeeded' && !job.inputMeta && job.fingerprint === hemorySegmentationFingerprint(recording)) {
          const lines = Array.isArray(recording.payload?.lines) ? recording.payload.lines : [];
          const endedAt = lines.length && typeof (lines.at(-1) as { spokenAt?: unknown })?.spokenAt === 'string'
            ? String((lines.at(-1) as { spokenAt: string }).spokenAt) : '';
          workbench.db.updateHemorySegmentationJob(job.id, job.status, { inputMeta: { lines: lines.length, endedAt, version: job.generator ?? '' } });
          metaBackfilled = true;
        }
      }
      if (!pending) { if (metaBackfilled) report.push({ recordingId: String(recording.payload?.recordingId ?? recording.externalId), recordingEventId, title: recording.title, inherited: [], metaBackfilled }); continue; }
      const result = workbench.db.inheritHemoryAttributions(recordingEventId, { dryRun: !apply });
      const inherited = result.applied.map((item) => ({ eventId: item.eventId, predecessorId: item.predecessorId, status: item.status, customerId: item.customerId, overlapRatio: item.overlapRatio }));
      if (inherited.length || metaBackfilled) {
        report.push({ recordingId: String(recording.payload?.recordingId ?? recording.externalId), recordingEventId, title: recording.title, inherited, metaBackfilled });
      }
    }
    if (apply && report.length) {
      workbench.db.audit(actor, 'repair_hemory_inheritance', 'hemory', 'inheritance',
        { recordings: report.length, inherited: report.reduce((sum, item) => sum + item.inherited.length, 0), metaBackfilled: report.filter((item) => item.metaBackfilled).length });
    }
    return report;
  }

  function makeAgent(session: Session): AgentSession {
    // 本地工具从调用参数解析客户（全称/简称/别名精确或唯一子串匹配，或权威 CRM _id 直取）——
    // 会话不承载客户状态，身份只存在于对话文本、工具参数与回写草稿 fields。
    const resolveCustomerByNameOrId = (name?: string, id?: string): { id: string; name: string } | null => {
      const customer = uniqueCustomerByContext(workbench.db, { customer_name: name, crm_customer_id: id });
      return customer ? { id: customer.id, name: customer.name } : null;
    };
    const workbenchHandlers = makeWorkbenchToolHandlers({
      resolveCustomer: resolveCustomerByNameOrId,
      overview: (id) => workbench.db.overview(id),
      timeline: (id, limit) => workbench.db.listTimeline(id, limit).map((e) => e as unknown as Record<string, unknown>),
    });
    const onesDeskFields = makeOnesDeskFieldsHandler({
      // CRM 使用版本是实例部署类型的唯一判定依据；调用未带 customer_name 或未命中时按私有云兜底。
      getUsageVersion: (customerName) => {
        const customer = customerName ? uniqueCustomerByContext(workbench.db, { customer_name: customerName }) : undefined;
        return customer?.usageVersion ?? null;
      },
    });
    const searchConfig = loadSearchConfig();
    const webSearch = makeWebSearchHandler({
      getApiKey: () => loadSearchConfig().apiKey,
      getMaxResults: () => loadSearchConfig().maxResults ?? searchConfig.maxResults,
      getKeylessEnabled: () => loadSearchConfig().keylessFallback,
    });
    const recordWebIntelligence = makeRecordWebIntelligenceHandler({
      resolveCustomer: (name) => resolveCustomerByNameOrId(name),
      // 落库即重算：web_signal 证据直接参与风险「公开动态」维度与增购机会假设，
      // 此前不重算导致 agent 落库后风险/机会视图滞后到下一次同步。
      // 幂等落库：与同步轮换同一自然键去重，agent 反复检索同一条新闻不堆积重复行。
      addEvidence: (input) => {
        const { id } = workbench.db.addEvidenceIdempotent(input);
        if (input.customerId) workbench.sync.recompute(input.customerId);
        return id;
      },
    });
    return new AgentSession({
      models: runtime.models,
      model: runtime.model,
      mcp: runtime.mcp,
      tools: runtime.tools,
      systemPrompt: runtime.systemPrompt,
      // Sessions created before an MCP reconnect or model switch must pick up
      // the latest runtime state on every turn (restored sessions otherwise
      // stay frozen on a stale, possibly empty, tool list).
      live: {
        getSystemPrompt: () => runtime.systemPrompt,
        getTools: () => runtime.tools,
        getModel: () => runtime.model,
      },
      localTools: {
        [CUSTOMER_PROFILE_TOOL_NAME]: workbenchHandlers.profile,
        [CUSTOMER_EVENTS_TOOL_NAME]: workbenchHandlers.events,
        [CUSTOMER_DETAIL_TOOL_NAME]: (args) => makeCustomerDetailResult({
          resolveCustomer: resolveCustomerByNameOrId,
          overview: (id) => workbench.db.overview(id),
          timeline: (id, limit) => workbench.db.listTimeline(id, limit).map((e) => e as unknown as Record<string, unknown>),
          workhours: async (id) => workbench.sync.listCustomerWorkhours(id) as unknown as Record<string, unknown>,
          hemoryFragments: (id, limit) => workbench.db.listHemoryFragments({ customerId: id, status: 'confirmed', limit })
            .map((e) => e as unknown as Record<string, unknown>),
          webIntelRounds: (id) => workbench.db.listWebIntelRuns(id, 3)
            .map((run) => run as unknown as Record<string, unknown>),
          // 案例：候选 + 草稿列表 + 最新草稿正文 markdown（客户可读的成品形态）。
          cases: async (id) => {
            const drafts = workbench.db.listCaseDrafts(id);
            const latest = drafts[0] ? workbench.cases.detail(drafts[0].id) : undefined;
            return {
              caseCandidate: workbench.db.getCaseCandidate(id),
              caseDrafts: drafts,
              latestDraftMarkdown: latest?.markdown ?? null,
              warnings: latest?.warnings ?? [],
            } as unknown as Record<string, unknown>;
          },
          // 周报：列表 + 最新一期客户版正文 markdown。
          weeklyReports: async (id) => {
            const reports = workbench.weekly.list(id);
            const latest = reports[0] ? workbench.weekly.detailWithMarkdown(reports[0].id) : undefined;
            return { reports, latestMarkdown: latest?.markdown ?? null, warnings: latest?.warnings ?? [] };
          },
          actions: (id) => workbench.db.listActions(id).map((a) => a as unknown as Record<string, unknown>),
        }, args),
        [WEB_SEARCH_TOOL_NAME]: webSearch,
        [RECORD_WEB_INTELLIGENCE_TOOL_NAME]: recordWebIntelligence,
        [ONES_DESK_FIELDS_TOOL_NAME]: onesDeskFields,
        [CUSTOMER_CONTEXT_TOOL_NAME]: async (args) => {
          const query = extractCustomerContext(args);
          if (!query.customer_name && !query.crm_customer_id) {
            return { text: '未提供 customer_name 或 crm_customer_id，无法解析客户身份。' };
          }
          // 无状态解析：把名称/ID 解析为工作台权威标识（CRM _id、ONES 选项、售后工时项、使用版本），
          // 结果只返回给模型——供后续本地工具的 customer_name 与回写草稿 fields 复用，不写任何会话状态。
          const resolution = resolveCustomerForContext(workbench.db, {
            customer_name: query.customer_name,
            crm_customer_id: query.crm_customer_id,
          });
          if (resolution.status !== 'resolved') {
            // 失败必须带候选：零匹配给 LIKE 相近客户、歧义给撞名清单——模型据此向用户确认，而不是干问全称。
            const label = `「${query.customer_name ?? query.crm_customer_id}」`;
            const clue = resolution.status === 'ambiguous'
              ? `多个客户匹配：${resolution.candidates.map((c) => c.name).join('、')}。`
              : resolution.suggestions.length ? `工作台相近客户：${resolution.suggestions.map((c) => c.name).join('、')}。` : '';
            return {
              text: `未在工作台唯一匹配到客户${label}（支持全称/简称/别名的精确匹配与唯一子串匹配）。${clue}` +
                '请与用户确认客户全称（或 CRM _id）后重试；客户的其他叫法可让用户维护别名（工作台客户页或 csm-agent customers aliases）。' +
                '确认客户名称前，本地读工具与回写不可用。',
            };
          }
          const { customer, matchedBy } = resolution;
          const binding = bindingOfCustomer(workbench.db, customer);
          const how = matchedBy === 'substring' ? `（按唯一子串「${query.customer_name}」匹配）`
            : matchedBy === 'alias' ? `（按别名「${query.customer_name}」匹配）` : '';
          return {
            text: `已解析客户：${customer.name}${how}（CRM _id=${customer.id}` +
              `${binding.onesOptionId ? `，ONES option=${binding.onesOptionId}` : '，ONES option 未解析（confirmed 身份缺失，回写 ONES 前需刷新客户同步）'}` +
              `，使用版本=${customer.usageVersion ?? 'unknown'}）。后续本地工具请带 customer_name="${customer.name}"，回写草稿 fields 用同名同 ID。`,
          };
        },
      },
    });
  }

  function persist(session: Session): void {
    store.saveSession({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.agent.context.messages as unknown[],
      events: session.events as Array<{ seq: number; event: unknown }>,
      customer: session.customer,
      archived: session.archived,
      userId: session.userId,
    });
  }

  function broadcast(session: Session, event: DisplayEvent): void {
    if (TRANSIENT_EVENT_TYPES.has(event.type as string)) {
      // 瞬态帧：分配 seq 但只发给在线客户端——落盘/回放仍是整段事件，刷新重连不重播碎片。
      const seq = ++session.seqCounter;
      const payload = `data: ${JSON.stringify({ seq, event })}\n\n`;
      for (const client of session.clients) client.write(payload);
      return;
    }
    const seq = ++session.seqCounter;
    session.events.push({ seq, event });
    session.updatedAt = Date.now();
    persist(session);
    const payload = `data: ${JSON.stringify({ seq, event })}\n\n`;
    for (const client of session.clients) {
      client.write(payload);
    }
  }

  function removeSession(id: string): void {
    const s = sessions.get(id);
    if (s) {
      for (const c of s.clients) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
      sessions.delete(id);
    }
    store.deleteSession(id);
    // 会话附件（落盘文件与 manifest）随会话一并清理。
    removeSessionAttachments(id).catch(() => {});
  }

  // ── load persisted sessions at boot ──
  for (const meta of store.listSessions()) {
    const stored = store.loadSession(meta.id);
    if (!stored) continue;
    const session: Session = {
      id: meta.id,
      agent: null as unknown as AgentSession,
      events: (stored.events ?? []) as Array<{ seq: number; event: DisplayEvent }>,
      clients: new Set(),
      pending: null,
      busy: false,
      seqCounter: (stored.events ?? []).reduce((max, e) => Math.max(max, e.seq), 0),
      abort: null,
      title: stored.title || '新对话',
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      lastRecordId: null,
      customer: (stored.customer as CustomerContext | undefined) ?? null,
      archived: stored.archived === true,
      userId: sessionOwner(stored.userId),
    };
    const agent = makeAgent(session);
    session.agent = agent;
    agent.restore((stored.messages ?? []) as never);
    sessions.set(meta.id, session);
    // 启动自愈：重启前被中断的轮次补一帧 stopped turn_end（分配 seq 并落盘），
    // 否则悬空 turn_start 会在 SSE 回放时把前端 busy 钉死成「停止」死路。
    if (hasUnterminatedTurn(session.events)) broadcast(session, { type: 'turn_end', stopped: true });
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      // ── static ──
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        // 磁盘即真相（调样式即刷即生效）：主文档不落任何中间层缓存。
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(await readFile(join(publicDir, 'index.html'), 'utf8'));
      }
      if (req.method === 'GET' && ['/app.js', '/style.css', '/app-icon.svg', '/build-info.js', '/cursor-effects.js'].includes(path)) {
        const file = path.slice(1);
        const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8'
          : path.endsWith('.svg') ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8';
        // 构建戳必须每次取最新且不被中间层缓存：前端靠它发现「页面新、进程旧」的分裂。
        // app.js/style.css 同理：无 Last-Modified/ETag 时内核仍可能启发式缓存，改版后旧壳里跑新 API。
        const headers: Record<string, string> = { 'Content-Type': type };
        if (path !== '/app-icon.svg') headers['Cache-Control'] = 'no-store';
        res.writeHead(200, headers);
        return res.end(await readFile(join(publicDir, file), 'utf8'));
      }

      // ── build version（旧进程检测的权威端点；404 = 进程早于该机制） ──
      if (req.method === 'GET' && path === '/api/version') {
        return json(res, 200, serviceVersionInfo(loadedBuildInfo, serverStartedAt));
      }

      // ── 登录（唯一免鉴权的业务端点；version 之上已处理）──
      if (req.method === 'POST' && path === '/api/auth/login') {
        const body = await readBody(req);
        const username = String(body.username ?? '').trim();
        const password = String(body.password ?? '');
        if (!username || !password) return json(res, 400, { error: '用户名与密码必填' });
        const rateKey = `${req.socket.remoteAddress ?? '?'}|${username}`;
        const lock = loginRateLimiter.checkLocked(rateKey);
        if (lock.locked) {
          return json(res, 429, { error: `失败次数过多，请 ${Math.ceil(lock.retryAfterSec / 60)} 分钟后再试`, retryAfterSec: lock.retryAfterSec });
        }
        const found = workbench.db.getUserByUsername(username);
        // 用户不存在也走完同一条 scrypt 校验（幻影哈希），抹平用户名枚举计时差。
        const passwordOk = verifyPassword(password, found?.passwordHash ?? PHANTOM_HASH);
        if (!found || !passwordOk) {
          loginRateLimiter.recordFailure(rateKey);
          return json(res, 401, { error: '用户名或密码错误' });
        }
        loginRateLimiter.recordSuccess(rateKey);
        if (found.status === 'disabled') return json(res, 403, { error: '账号已被禁用，请联系管理员' });
        // CLI/CI 登录：带 tokenName 时签发 PAT（无过期、可吊销）而非 cookie 会话，令牌只回显这一次。
        if (typeof body.tokenName === 'string' && body.tokenName.trim()) {
          const { token, tokenHash } = issueToken();
          const record = workbench.db.createAuthToken(tokenHash, found.id, body.tokenName.trim().slice(0, 80));
          workbench.db.audit(found.username, 'auth.login', 'user', String(found.id), { via: 'token', name: record.name }, found.id);
          return json(res, 200, { token, tokenKind: 'pat', user: publicUser(found) });
        }
        const { token, tokenHash } = issueToken();
        workbench.db.createAuthSession(tokenHash, found.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
        workbench.db.audit(found.username, 'auth.login', 'user', String(found.id), { via: 'cookie' }, found.id);
        res.setHeader('Set-Cookie', sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)));
        return json(res, 200, { user: publicUser(found) });
      }

      // ── 鉴权门：除上方白名单外，所有 /api/* 必须携带有效凭证（cookie 会话或 Bearer）──
      let auth: AuthContext | null = null;
      if (path.startsWith('/api/')) {
        auth = authenticate(workbench.db, req);
        if (!auth) return json(res, 401, { error: '未登录或凭证已失效' });
        if (auth.user.status === 'disabled') return json(res, 403, { error: '账号已被禁用' });
        // CSRF：cookie 凭证的变更请求必须同源（SameSite=Lax 已挡大半，Origin 复核兜底；Bearer 不受 CSRF 影响）。
        if (auth.kind === 'cookie' && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
          const origin = req.headers.origin;
          if (origin) {
            let sameOrigin = false;
            try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
            if (!sameOrigin) return json(res, 403, { error: '跨站请求被拒绝' });
          }
        }
      }
      // 下方全部路由都是 /api/*（静态与白名单已在上方返回），非空断言安全。
      const authCtx = auth as AuthContext;
      const actor = authCtx.user.username;
      const requireAdmin = (): boolean => authCtx.user.role === 'admin';

      // ── 账号与会话 ──
      if (req.method === 'GET' && path === '/api/auth/me') {
        return json(res, 200, { user: publicUser(authCtx.user) });
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        if (authCtx.credential === 'session') {
          workbench.db.deleteAuthSession(authCtx.tokenHash);
          res.setHeader('Set-Cookie', clearSessionCookieHeader());
        } else {
          workbench.db.deleteAuthTokenByHash(authCtx.tokenHash);
        }
        workbench.db.audit(actor, 'auth.logout', 'user', String(authCtx.user.id), { credential: authCtx.credential }, authCtx.user.id);
        return json(res, 200, { ok: true });
      }
      // PAT（个人访问令牌）：CLI/CI 的长效凭证，本人可建可吊销，令牌本体只在创建响应出现一次。
      if (req.method === 'POST' && path === '/api/auth/tokens') {
        const body = await readBody(req);
        const name = (typeof body.name === 'string' ? body.name : '').trim() || 'unnamed';
        const { token, tokenHash } = issueToken();
        const record = workbench.db.createAuthToken(tokenHash, authCtx.user.id, name.slice(0, 80));
        workbench.db.audit(actor, 'auth.token_create', 'user', String(authCtx.user.id), { name: record.name }, authCtx.user.id);
        return json(res, 200, { token, tokenRecord: record });
      }
      if (req.method === 'GET' && path === '/api/auth/tokens') {
        return json(res, 200, { tokens: workbench.db.listAuthTokens(authCtx.user.id) });
      }
      const patMatch = path.match(/^\/api\/auth\/tokens\/([0-9a-f-]+)$/);
      if (req.method === 'DELETE' && patMatch) {
        const ok = workbench.db.deleteAuthToken(patMatch[1]!, authCtx.user.id);
        if (ok) workbench.db.audit(actor, 'auth.token_revoke', 'user', String(authCtx.user.id), { tokenId: patMatch[1] }, authCtx.user.id);
        return json(res, 200, { ok });
      }

      // ── 用户管理（admin）──
      if (path === '/api/users' || /^\/api\/users\/\d+/.test(path)) {
        if (!requireAdmin()) return json(res, 403, { error: '需要管理员权限' });
        if (req.method === 'GET' && path === '/api/users') {
          return json(res, 200, { users: workbench.db.listUsers().map(publicUser) });
        }
        if (req.method === 'POST' && path === '/api/users') {
          const body = await readBody(req);
          const username = String(body.username ?? '').trim();
          if (!USERNAME_PATTERN.test(username)) return json(res, 400, { error: '用户名须 2–32 位字母/数字/_ . -，且以字母或数字开头' });
          if (workbench.db.getUserByUsername(username)) return json(res, 409, { error: `用户名 ${username} 已存在` });
          const role = body.role === 'admin' ? 'admin' : 'member';
          const supplied = typeof body.password === 'string' && body.password ? body.password : '';
          if (supplied) {
            const invalid = validatePassword(supplied);
            if (invalid) return json(res, 400, { error: invalid });
          }
          const password = supplied || generatePassword();
          const user = workbench.db.createUser({
            username,
            displayName: String(body.displayName ?? '').trim() || username,
            role, passwordHash: hashPassword(password),
            ...(typeof body.wecomUserid === 'string' && body.wecomUserid.trim() ? { wecomUserid: body.wecomUserid.trim() } : {}),
          });
          workbench.db.audit(actor, 'user.create', 'user', String(user.id), { role }, user.id);
          return json(res, 200, { user: publicUser(user), ...(supplied ? {} : { initialPassword: password }) });
        }
        const userMatch = path.match(/^\/api\/users\/(\d+)(\/.*)?$/);
        if (userMatch) {
          const targetId = Number(userMatch[1]);
          const target = workbench.db.getUserById(targetId);
          const sub = userMatch[2] ?? '';
          if (!target) return json(res, 404, { error: 'user not found' });
          if (req.method === 'PATCH' && sub === '') {
            const body = await readBody(req);
            const patch: { displayName?: string; role?: 'admin' | 'member'; status?: 'active' | 'disabled'; wecomUserid?: string | null; passwordHash?: string } = {};
            if (typeof body.displayName === 'string' && body.displayName.trim()) patch.displayName = body.displayName.trim();
            if (body.role === 'admin' || body.role === 'member') patch.role = body.role;
            if (body.status === 'active' || body.status === 'disabled') patch.status = body.status;
            if (body.wecomUserid === null) patch.wecomUserid = null;
            else if (typeof body.wecomUserid === 'string' && body.wecomUserid.trim()) patch.wecomUserid = body.wecomUserid.trim();
            if (typeof body.password === 'string' && body.password) {
              const invalid = validatePassword(body.password);
              if (invalid) return json(res, 400, { error: invalid });
              patch.passwordHash = hashPassword(body.password);
            }
            // 最后一名管理员不可降级/禁用，否则系统将无人管理。
            if ((patch.role === 'member' || patch.status === 'disabled') && target.role === 'admin' && target.status === 'active') {
              const otherAdmins = workbench.db.listUsers().filter((u) => u.role === 'admin' && u.status === 'active' && u.id !== targetId);
              if (!otherAdmins.length) return json(res, 409, { error: '最后一名管理员不可降级或禁用' });
            }
            const updated = workbench.db.updateUser(targetId, patch);
            if (patch.passwordHash || patch.status === 'disabled') workbench.db.deleteUserAuthSessions(targetId);
            workbench.db.audit(actor, 'user.update', 'user', String(targetId), {
              ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
              ...(patch.role !== undefined ? { role: patch.role } : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.wecomUserid !== undefined ? { wecomBound: patch.wecomUserid != null } : {}),
              ...(patch.passwordHash ? { passwordReset: true } : {}),
            }, targetId);
            return json(res, 200, { user: publicUser(updated!) });
          }
          if (req.method === 'POST' && sub === '/reset-password') {
            const body = await readBody(req);
            const supplied = typeof body.password === 'string' && body.password ? body.password : '';
            if (supplied) {
              const invalid = validatePassword(supplied);
              if (invalid) return json(res, 400, { error: invalid });
            }
            const password = supplied || generatePassword();
            workbench.db.updateUser(targetId, { passwordHash: hashPassword(password) });
            // 密码重置即收回该用户全部在线会话（PAT 保留：属独立长效凭证，可另行吊销）。
            workbench.db.deleteUserAuthSessions(targetId);
            workbench.db.audit(actor, 'user.reset_password', 'user', String(targetId), {}, targetId);
            return json(res, 200, { ok: true, ...(supplied ? {} : { password }) });
          }
        }
      }

      // ── 备份（每日 04:00 上海时区自动全量备份，保留最近 3 份；CLI 入口 csm-agent backup）──
      if (req.method === 'POST' && path === '/api/backup/run') {
        // 归档内含全部配置与密钥：触发权收敛到管理员。
        if (!requireAdmin()) return json(res, 403, { error: '需要管理员权限' });
        try {
          return json(res, 202, triggerBackup(workbench.db, dataDir(), 'manual', actor).run);
        } catch (error) {
          return json(res, 409, { error: (error as Error).message });
        }
      }
      if (req.method === 'GET' && path === '/api/backups') {
        return json(res, 200, { backups: listBackups(dataDir()), lastRun: workbench.db.latestBackupRun() ?? null,
          nextScheduledAt: nextBackupSlot().at.toISOString() });
      }

      // ── customer-centered workbench ──
      if (req.method === 'GET' && path === '/api/customers') {
        const requestedSort = url.searchParams.get('sort');
        const sort = requestedSort === 'renewal_date' || requestedSort === 'renewal_amount' ? requestedSort : 'default';
        return json(res, 200, { customers: workbench.db.listCustomers(url.searchParams.get('q') ?? '', sort) });
      }
      if (req.method === 'POST' && path === '/api/sync') {
        return json(res, 202, workbench.sync.refreshAll());
      }
      // 公开动态轮换手动排空（验收/补查用）：串行处理全部入选客户（14 天门内跳过、当天已尝试不重复）；
      // 日常由 09:00–19:00 整点 tick 自动推进，本端点与 tick 互斥。
      if (req.method === 'POST' && path === '/api/web-intel/rotation') {
        return json(res, 202, workbench.sync.refreshWebIntelRotation());
      }
      if (req.method === 'POST' && path === '/api/hemory/sync') {
        const body = await readBody(req);
        return json(res, 202, typeof body.date === 'string' && body.date
          ? workbench.sync.refreshHemoryDate(body.date)
          : workbench.sync.refreshRecentHemory());
      }
      // 全量重切：遍历库内全部录音并按当前分段版本重切，与增量同步互斥；内部数据变更，无需外部写审批。
      // recordingId = 定向重切单条录音（分段失败逃生门）：先重置该录音的分段 job 再重切。
      if (req.method === 'POST' && path === '/api/hemory/resegment') {
        const body = await readBody(req);
        if (typeof body.recordingId === 'string' && body.recordingId) {
          return json(res, 202, workbench.sync.resegmentHemoryRecording(body.recordingId));
        }
        if (body.scope !== 'all') return json(res, 400, { error: '仅支持 {"scope":"all"} 或 {"recordingId":"..."}' });
        return json(res, 202, workbench.sync.resegmentAllHemory());
      }
      if (req.method === 'GET' && path === '/api/hemory/segmentation-jobs') {
        return json(res, 200, { jobs: workbench.db.listRecentHemorySegmentationJobs() });
      }
      if (req.method === 'GET' && path === '/api/hemory/fragments') {
        const daysParam = url.searchParams.get('days');
        // since/until 为 ISO 时刻（如 2026-08-27T14:00:00+08:00），垃圾输入直接 400，避免静默得到空列表。
        const since = url.searchParams.get('since')?.trim() || undefined;
        const until = url.searchParams.get('until')?.trim() || undefined;
        if (since != null && Number.isNaN(Date.parse(since))) return json(res, 400, { error: 'since 必须是合法的 ISO 日期时间，例如 2026-08-27T14:00:00+08:00' });
        if (until != null && Number.isNaN(Date.parse(until))) return json(res, 400, { error: 'until 必须是合法的 ISO 日期时间，例如 2026-08-27T15:30:00+08:00' });
        const fragments = workbench.db.listHemoryFragments({ status: url.searchParams.get('status') ?? 'pending',
          customerId: url.searchParams.get('customer_id')?.trim() || undefined,
          date: url.searchParams.get('date') ?? undefined, since, until,
          recordingId: url.searchParams.get('recording_id') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 100),
          days: daysParam == null ? undefined : Math.max(0, Number(daysParam) || 0) });
        return json(res, 200, { fragments: decorateHemoryFragments(fragments), nextCursor: fragments.at(-1)?.occurredAt ?? null });
      }
      if (req.method === 'PUT' && path === '/api/hemory/fragments/ignore') {
        const body = await readBody(req);
        const eventIds = Array.isArray(body.eventIds) ? body.eventIds.map(String) : [];
        if (!eventIds.length) return json(res, 400, { error: 'eventIds 不能为空' });
        const previousCustomers = new Set(eventIds.map((id: string) => workbench.db.getSourceEvent(id)?.customerId).filter(Boolean) as string[]);
        try {
          const events = workbench.db.ignoreHemoryFragments(eventIds,
            isRecord(body.expectedHashes) ? Object.fromEntries(Object.entries(body.expectedHashes).map(([key, value]) => [key, String(value)])) : {}, actor);
          workbench.db.markDraftsStaleForEvents(eventIds);
          workbench.db.deleteEvidenceForSourceEvents(eventIds);
          for (const id of previousCustomers) workbench.sync.recompute(id);
          return json(res, 200, { events });
        } catch (error) {
          return json(res, 409, { error: (error as Error).message });
        }
      }
      if (req.method === 'PUT' && path === '/api/hemory/fragments/attribution') {
        const body = await readBody(req);
        const eventIds = Array.isArray(body.eventIds) ? body.eventIds.map(String) : [];
        if (!eventIds.length) return json(res, 400, { error: 'eventIds 不能为空' });
        const customerId = body.customerId == null || body.customerId === '' ? null : String(body.customerId);
        const previousCustomers = new Set(eventIds.map((id: string) => workbench.db.getSourceEvent(id)?.customerId).filter(Boolean) as string[]);
        try {
          const events = workbench.db.attributeHemoryFragments(eventIds, customerId,
            isRecord(body.expectedHashes) ? Object.fromEntries(Object.entries(body.expectedHashes).map(([key, value]) => [key, String(value)])) : {}, actor);
          workbench.db.markDraftsStaleForEvents(eventIds);
          workbench.db.deleteEvidenceForSourceEvents(eventIds);
          const byCustomer = new Map<string, string[]>();
          for (const event of events) {
            if (!event.customerId) continue;
            workbench.sync.processHemoryEvidence(event);
            const ids = byCustomer.get(event.customerId) ?? [];
            ids.push(event.id);
            byCustomer.set(event.customerId, ids);
          }
          for (const id of new Set([...previousCustomers, ...byCustomer.keys()])) workbench.sync.recompute(id);
          const jobs = [...byCustomer].flatMap(([id, ids]) => workbench.drafts.enqueue(id, ids));
          return json(res, 200, { events, jobs });
        } catch (error) {
          return json(res, 409, { error: (error as Error).message });
        }
      }
      // 片段级强制重生成：选中片段确定要重建的「客户+上海日」，各天全量已确认片段参与；jobs 与归属端点同形，前端复用同一轮询。
      if (req.method === 'POST' && path === '/api/hemory/fragments/regenerate') {
        const body = await readBody(req);
        const eventIds = Array.isArray(body.eventIds) ? body.eventIds.map(String) : [];
        if (!eventIds.length) return json(res, 400, { error: 'eventIds 不能为空' });
        try {
          return json(res, 200, workbench.drafts.regenerateByEventIds(eventIds));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      // 存量孪生一次性修复：把停用世代的 confirmed/ignored 归属按时间覆盖率继承到活跃世代待处理片段，
      // 并回填分段 job 的转写基准（inputMeta）。默认 dry-run 只返回逐录音修复计划。
      if (req.method === 'POST' && path === '/api/hemory/fragments/inherit') {
        const body = await readBody(req);
        const apply = body.apply === true;
        const plan = repairHemoryInheritance(apply, actor);
        return json(res, 200, { apply, recordings: plan.length, inherited: plan.reduce((sum: number, item) => sum + item.inherited.length, 0),
          metaBackfilled: plan.reduce((sum: number, item) => sum + (item.metaBackfilled ? 1 : 0), 0), details: plan });
      }
      const syncMatch = path.match(/^\/api\/sync-runs\/([0-9a-f-]+)$/);
      if (req.method === 'GET' && syncMatch) {
        const run = workbench.db.getSyncRun(syncMatch[1]);
        return run ? json(res, 200, run) : json(res, 404, { error: 'sync run not found' });
      }
      const customerMatch = path.match(/^\/api\/customers\/([^/]+)(\/.*)?$/);
      if (customerMatch) {
        const customerId = decodeURIComponent(customerMatch[1]);
        const sub = customerMatch[2] ?? '';
        if (req.method === 'GET' && sub === '/overview') {
          const overview = workbench.db.overview(customerId);
          return overview ? json(res, 200, overview) : json(res, 404, { error: 'customer not found' });
        }
        // 客户别名维护（工作台本地叠加层，同步不覆盖）：整组替换；跨客户撞名/撞别名 400 拒绝。
        if (req.method === 'PUT' && sub === '/aliases') {
          if (!workbench.db.getCustomer(customerId)) return json(res, 404, { error: 'customer not found' });
          const body = await readBody(req);
          const aliases = Array.isArray(body.aliases) ? body.aliases : [];
          try {
            return json(res, 200, { aliases: workbench.db.setCustomerAliases(customerId, aliases, actor) });
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
        if (req.method === 'GET' && sub === '/timeline') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
          return json(res, 200, { events: workbench.db.listTimeline(customerId, limit) });
        }
        if (req.method === 'GET' && sub === '/workhours') {
          if (!workbench.db.getCustomer(customerId)) return json(res, 404, { error: 'customer not found' });
          return json(res, 200, await workbench.sync.listCustomerWorkhours(customerId));
        }
        if (req.method === 'GET' && sub === '/weekly-reports') {
          if (!workbench.db.getCustomer(customerId)) return json(res, 404, { error: 'customer not found' });
          return json(res, 200, { reports: workbench.weekly.list(customerId) });
        }
        if (req.method === 'POST' && sub === '/weekly-reports') {
          const body = await readBody(req);
          if (!workbench.db.getCustomer(customerId)) return json(res, 404, { error: 'customer not found' });
          const weekStart = typeof body.weekStart === 'string' && body.weekStart.trim() ? body.weekStart.trim() : new Date().toISOString();
          try {
            return json(res, 202, workbench.weekly.generate(customerId, weekStart, body.force === true));
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
        if (req.method === 'POST' && sub === '/refresh') {
          if (!workbench.db.getCustomer(customerId)) return json(res, 404, { error: 'customer not found' });
          return json(res, 202, workbench.sync.refreshCustomer(customerId));
        }
        // 公开动态检索：强制刷新（忽略 14 天门），检索+落库+重算风险/机会，同步返回结果。
        if (req.method === 'POST' && sub === '/web-intel') {
          const customer = workbench.db.getCustomer(customerId);
          if (!customer) return json(res, 404, { error: 'customer not found' });
          try {
            const result = await workbench.sync.runWebIntelForCustomer(customerId, { force: true });
            workbench.sync.recompute(customerId);
            const body: Record<string, unknown> = { ...result, risk: workbench.db.latestRisk(customerId) };
            if (result.status === 'failed') return json(res, 502, body);
            return json(res, 200, body);
          } catch (error) {
            return json(res, 502, { error: (error as Error).message });
          }
        }
        // 公开动态轮次报告（run 即报告）：最近 N 轮的检索明细（findings 含 is_new 新增标记），最新在前。
        if (req.method === 'GET' && sub === '/web-intel/rounds') {
          if (!workbench.db.getCustomer(customerId)) return json(res, 404, { error: 'customer not found' });
          const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10));
          return json(res, 200, { rounds: workbench.db.listWebIntelRuns(customerId, limit) });
        }
        // 增购机会重新分析：强制（忽略指纹/时长门），从会议录音片段 + 公开动态证据重新产出假设，
        // 失败保留旧假设；返回最新列表（含 sources）供三端同源展示。
        if (req.method === 'POST' && sub === '/opportunities/refresh') {
          const customer = workbench.db.getCustomer(customerId);
          if (!customer) return json(res, 404, { error: 'customer not found' });
          const result = await workbench.opportunities.analyze(customerId, { force: true });
          const body: Record<string, unknown> = { ...result, opportunities: workbench.db.overview(customerId)?.opportunities ?? [] };
          if (result.status === 'failed') return json(res, 502, { ...body, error: result.reason ?? '增购机会分析失败' });
          return json(res, 200, body);
        }
      }

      if (req.method === 'GET' && path === '/api/action-items') {
        return json(res, 200, { actions: workbench.db.listActions(url.searchParams.get('customer_id') ?? undefined) });
      }
      if (req.method === 'POST' && path === '/api/action-items/bulk-complete') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (!ids.length) return json(res, 400, { error: 'ids 不能为空' });
        const outcome = typeof body.outcome === 'string' && body.outcome.trim() ? body.outcome.trim() : undefined;
        return json(res, 200, { items: workbench.db.bulkCompleteActions(ids, outcome) });
      }
      const actionMatch = path.match(/^\/api\/action-items\/([0-9A-Za-z_-]+)(\/.*)?$/);
      if (actionMatch) {
        const actionId = actionMatch[1];
        const sub = actionMatch[2] ?? '';
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
          const allowed = ['new', 'completed'];
          if (body.status && !allowed.includes(body.status)) return json(res, 400, { error: 'invalid action status' });
          const action = workbench.db.updateAction(actionId, body);
          return action ? json(res, 200, action) : json(res, 404, { error: 'action item not found' });
        }
        if (req.method === 'POST' && sub === '/complete') {
          const body = await readBody(req);
          const action = workbench.db.completeAction(actionId, typeof body.outcome === 'string' ? body.outcome : undefined);
          return action ? json(res, 200, action) : json(res, 404, { error: 'action item not found' });
        }
      }

      // ── 风险预警名单：只读列表 + 人工消除（消除必须写明原因/动作，写审计）。 ──
      if (req.method === 'GET' && path === '/api/alerts') {
        const statusParam = url.searchParams.get('status');
        const status = statusParam === 'resolved' || statusParam === 'all' ? statusParam : 'active';
        const customerId = url.searchParams.get('customer_id')?.trim() || undefined;
        return json(res, 200, {
          alerts: workbench.db.listAlerts({ status, customerId }),
          counts: { active: workbench.db.countAlerts('active'), resolved: workbench.db.countAlerts('resolved') },
        });
      }
      const alertMatch = path.match(/^\/api\/alerts\/([0-9A-Za-z-]+)(\/.*)?$/);
      if (alertMatch && req.method === 'POST' && alertMatch[2] === '/resolve') {
        const body = await readBody(req);
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (!note) return json(res, 400, { error: '消除风险必须填写原因/动作（note）' });
        const alert = workbench.db.getAlert(alertMatch[1]);
        if (!alert) return json(res, 404, { error: 'alert not found' });
        const resolved = workbench.db.resolveAlert(alert.id, actor, note);
        if (!resolved) return json(res, 409, { error: '该预警已消除，无需重复操作' });
        workbench.db.audit(actor, 'alert.resolve', 'customer_alert', alert.id, { triggerKey: alert.triggerKey, note }, authCtx.user.id);
        return json(res, 200, resolved);
      }

      if (req.method === 'GET' && path === '/api/case-drafts') {
        return json(res, 200, { drafts: workbench.db.listCaseDrafts(url.searchParams.get('customer_id') ?? undefined) });
      }

      if (req.method === 'GET' && path === '/api/draft-batches') {
        const batches = workbench.db.listDraftBatches(url.searchParams.get('customer_id') ?? undefined);
        // 草稿箱只展示待处理草稿：已写入项默认剔除，全写入的批次整批隐藏；include=written 恢复全量（诊断口）。
        const visible = url.searchParams.get('include') === 'written'
          ? batches
          : batches
            .map((batch) => (batch.items ? { ...batch, items: batch.items.filter((item) => item.status !== 'written') } : batch))
            .filter((batch) => (batch.items ? batch.items.length > 0 : true));
        // 重新生成中日集合按请求算一次，批次装饰复用（单批次 GET 则在装饰内自算）。
        const activeDays = workbench.drafts.activeRegenerationDays();
        return json(res, 200, { batches: visible.map((batch) => decorateDraftBatch(batch, activeDays)) });
      }
      // 生成任务状态查询：归属/重生成响应里的 jobId 在此轮询。失败任务不会创建批次，只能通过任务状态感知。
      if (req.method === 'GET' && path === '/api/draft-jobs') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
        // 无 ids 时列出最近失败任务（kind=hemory 日草稿）：失败明细的可发现入口，页面刷新后仍可见。
        const status = url.searchParams.get('status') ?? 'failed';
        const kindParam = url.searchParams.get('kind');
        const kind = kindParam === 'weekly_report' ? 'weekly_report' : kindParam === 'case_report' ? 'case_report' : 'hemory';
        const customerId = url.searchParams.get('customer_id') ?? '';
        let jobs: DraftGenerationJob[];
        if (ids.length) {
          jobs = ids.map((id) => workbench.db.getDraftJob(id)).filter((job): job is DraftGenerationJob => !!job);
        } else if (customerId && status === 'active') {
          // 某客户全部在途任务（页面重开恢复进度展示用），可用 kind 再过滤。
          jobs = workbench.db.listActiveDraftJobsByCustomer(customerId)
            .filter((job) => !kindParam || job.kind === kind);
        } else if (status === 'active') {
          // 全局在途任务（Web 刷新恢复横幅 / CLI draft jobs --active），可用 kind 过滤。
          jobs = workbench.db.listActiveDraftJobs(kind);
        } else {
          jobs = status === 'failed' ? workbench.db.listFailedDraftJobs(kind) : [];
        }
        return json(res, 200, { jobs: jobs.map(decorateDraftJob) });
      }
      const draftBatchMatch = path.match(/^\/api\/draft-batches\/([0-9a-f-]+)(\/.*)?$/);
      if (draftBatchMatch) {
        const batchId = draftBatchMatch[1];
        const sub = draftBatchMatch[2] ?? '';
        if (req.method === 'GET' && sub === '') {
          const batch = workbench.db.getDraftBatch(batchId);
          return batch ? json(res, 200, decorateDraftBatch(batch)) : json(res, 404, { error: 'draft batch not found' });
        }
        if (req.method === 'POST' && sub === '/preview') {
          const body = await readBody(req);
          try { return json(res, 200, await workbench.drafts.preview(batchId, Array.isArray(body.itemIds) ? body.itemIds.map(String) : [])); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
        if (req.method === 'POST' && sub === '/regenerate') {
          try { return json(res, 200, { jobs: workbench.drafts.regenerate(batchId) }); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
        if (req.method === 'POST' && sub === '/dismiss') {
          try { return json(res, 200, decorateDraftBatch(workbench.drafts.dismissBatch(batchId, actor))); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
        if (req.method === 'POST' && sub === '/confirm') {
          const body = await readBody(req);
          try {
            const { items } = await workbench.drafts.confirm(batchId, Array.isArray(body.items) ? body.items : [], actor);
            return json(res, 200, { items: items.map(decorateDraftItem) });
          } catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
      }
      const draftItemMatch = path.match(/^\/api\/draft-items\/([0-9a-f-]+)(\/.*)?$/);
      if (draftItemMatch) {
        const itemId = draftItemMatch[1];
        const sub = draftItemMatch[2] ?? '';
        if (req.method === 'GET' && sub === '') {
          const item = workbench.db.getDraftItem(itemId);
          if (!item) return json(res, 404, { error: 'draft item not found' });
          return json(res, 200, { ...decorateDraftItem(item), editContract: editContractOf(item) });
        }
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
          // 结构化编辑分支：只提交「字段键→新值」，服务端按类型契约合并回 targetArguments，
          // 结构化部分（客户绑定/项目/类型/工具）不经手，杜绝编辑破坏参数结构。
          if (isRecord(body.edits)) {
            const item = workbench.db.getDraftItem(itemId);
            if (!item) return json(res, 404, { error: 'draft item not found' });
            if (['written', 'writing', 'dismissed', 'stale'].includes(item.status)) return json(res, 409, { error: '草稿已写入或已忽略，不可编辑' });
            const customer = workbench.db.getCustomer(item.customerId) as Customer | undefined;
            if (!customer) return json(res, 409, { error: '草稿客户不存在，不可结构化编辑' });
            const { patch, errors } = applyDraftEdits(item, body.edits, customer.usageVersion);
            if (errors.length) return json(res, 400, { error: errors.join('；') });
            const updated = workbench.db.updateDraftItem(itemId, Number(body.version), {
              title: patch.title, summary: undefined,
              targetArguments: patch.targetArguments,
              unknowns: Array.isArray(body.unknowns) ? body.unknowns.map(String) : undefined,
              validationErrors: [],
            });
            return updated ? json(res, 200, { ...decorateDraftItem(updated), editContract: editContractOf(updated) }) : json(res, 409, { error: '草稿版本已变化或不可编辑' });
          }
          const item = workbench.db.updateDraftItem(itemId, Number(body.version), {
            title: typeof body.title === 'string' ? body.title : undefined, summary: typeof body.summary === 'string' ? body.summary : undefined,
            fields: isRecord(body.fields) ? body.fields : undefined, targetTool: body.targetTool === null || typeof body.targetTool === 'string' ? body.targetTool : undefined,
            targetArguments: isRecord(body.targetArguments) ? body.targetArguments : undefined,
            unknowns: Array.isArray(body.unknowns) ? body.unknowns.map(String) : undefined,
            validationErrors: Array.isArray(body.validationErrors) ? body.validationErrors.map(String) : undefined,
          });
          return item ? json(res, 200, decorateDraftItem(item)) : json(res, 409, { error: '草稿版本已变化或不可编辑' });
        }
        if (req.method === 'POST' && sub === '/retry') {
          try { return json(res, 200, decorateDraftItem(await workbench.drafts.retry(itemId))); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
        if (req.method === 'POST' && sub === '/dismiss') {
          try { return json(res, 200, decorateDraftItem(workbench.drafts.dismissItem(itemId, actor))); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
      }
      if (req.method === 'POST' && path === '/api/case-drafts') {
        const body = await readBody(req);
        try {
          return json(res, 202, workbench.cases.generate(String(body.customerId ?? ''), Boolean(body.force)));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      const caseMatch = path.match(/^\/api\/case-drafts\/([0-9a-f-]+)(\/.*)?$/);
      if (caseMatch) {
        const draftId = caseMatch[1];
        const sub = caseMatch[2] ?? '';
        if (req.method === 'GET' && sub === '') {
          const detail = workbench.cases.detail(draftId);
          return detail ? json(res, 200, detail) : json(res, 404, { error: '案例草稿不存在' });
        }
        // 导出 Word（v8：与复制/Wiki 发布同源内容口径的 docx 版式，附件下载；读操作走审计记录）。
        if (req.method === 'GET' && sub === '/export') {
          try {
            const exported = await workbench.cases.exportDocx(draftId);
            if (!exported) return json(res, 404, { error: '案例草稿不存在' });
            res.writeHead(200, {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
              'Content-Length': exported.buffer.length,
            });
            return void res.end(exported.buffer);
          } catch (error) {
            return json(res, 500, { error: `导出 Word 失败: ${(error as Error).message}` });
          }
        }
        if (req.method === 'POST' && sub === '/regenerate') {
          const draft = workbench.db.getCaseDraft(draftId);
          if (!draft) return json(res, 404, { error: '案例草稿不存在' });
          try { return json(res, 202, workbench.cases.generate(draft.customerId, true)); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
          const fields = isRecord(body.fields) ? body.fields : {};
          const draft = workbench.cases.update(draftId, Number(body.version), typeof body.title === 'string' ? body.title : undefined, fields);
          // 写回护栏（非阻断）：编辑结果异常（条目失控/超长/内部残留）时随响应返回 warnings，由 CSM 复核。
          const warnings = draft ? caseNarrativeWarnings(draft.fields) : [];
          return draft ? json(res, 200, { ...draft, warnings: warnings.length ? warnings : undefined }) : json(res, 409, { error: '草稿版本已变化或不可编辑' });
        }
        if (req.method === 'POST' && sub === '/publish-preview') {
          const body = await readBody(req);
          try {
            return json(res, 200, workbench.cases.publishPreview(draftId, String(body.parentPageID ?? process.env.ONES_CASE_PARENT_PAGE_ID ?? '')));
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
        if (req.method === 'POST' && sub === '/publish') {
          const body = await readBody(req);
          try {
            const parentPageID = String(body.parentPageID ?? process.env.ONES_CASE_PARENT_PAGE_ID ?? '');
            return json(res, 200, await workbench.cases.publish(draftId, Number(body.version), parentPageID, String(body.approvalHash ?? '')));
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
      }

      // ── weekly reports（实施周报：生成走 draft-jobs 轮询，发布走哈希审批门） ──
      // 周界元信息：前端周选择器对齐周一用（字面路径须在 :id 正则之前）。
      if (req.method === 'GET' && path === '/api/weekly-reports/week-meta') {
        const anchor = url.searchParams.get('date') ?? '';
        const monday = weekMonday(anchor || new Date().toISOString());
        return json(res, 200, { weekStart: monday, ...weekRange(monday) });
      }
      const weeklyMatch = path.match(/^\/api\/weekly-reports\/([0-9a-f-]+)(\/.*)?$/);
      if (weeklyMatch) {
        const reportId = weeklyMatch[1];
        const sub = weeklyMatch[2] ?? '';
        if (req.method === 'GET' && sub === '') {
          // markdown 是服务端权威渲染的客户版正文（Web 复制与 CLI 默认输出共用），warnings 为内部证据残留提示。
          const detail = workbench.weekly.detailWithMarkdown(reportId);
          return detail ? json(res, 200, { report: detail.report, markdown: detail.markdown, warnings: detail.warnings }) : json(res, 404, { error: 'weekly report not found' });
        }
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
          const content = body.content;
          if (!isRecord(content) || typeof content.summary !== 'string') return json(res, 400, { error: 'content 缺少 summary 字段' });
          try {
            const report = workbench.weekly.update(reportId, Number(body.version), content as never);
            return report ? json(res, 200, { report }) : json(res, 409, { error: '周报版本已变化或已发布' });
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
        if (req.method === 'POST' && sub === '/regenerate') {
          const report = workbench.weekly.get(reportId);
          if (!report) return json(res, 404, { error: 'weekly report not found' });
          try {
            return json(res, 202, workbench.weekly.generate(report.customerId, report.weekStart, true));
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
        if (req.method === 'POST' && sub === '/publish-preview') {
          const body = await readBody(req);
          try {
            const parentPageID = String(body.parentPageID ?? process.env.ONES_WEEKLY_PARENT_PAGE_ID ?? '');
            return json(res, 200, workbench.weekly.publishPreview(reportId, parentPageID));
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
        if (req.method === 'POST' && sub === '/publish') {
          const body = await readBody(req);
          try {
            const parentPageID = String(body.parentPageID ?? process.env.ONES_WEEKLY_PARENT_PAGE_ID ?? '');
            const published = await workbench.weekly.publish(reportId, Number(body.version), parentPageID, String(body.approvalHash ?? ''));
            return json(res, 200, { report: published });
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
      }

      // ── ONES Wiki 只读浏览（发布位置层级选择器的数据源） ──
      if (req.method === 'GET' && path === '/api/ones-wiki/spaces') {
        try { return json(res, 200, { spaces: await workbench.wiki.listSpaces() }); }
        catch (error) { return json(res, 400, { error: (error as Error).message }); }
      }
      if (req.method === 'GET' && path === '/api/ones-wiki/pages') {
        const spaceId = url.searchParams.get('space_id') ?? '';
        const keyword = url.searchParams.get('q') ?? '';
        try {
          if (keyword) return json(res, 200, { pages: await workbench.wiki.searchPages(keyword) });
          return json(res, 200, { pages: await workbench.wiki.listPages(spaceId) });
        } catch (error) { return json(res, 400, { error: (error as Error).message }); }
      }

      // ── ONES Desk 必填字段契约（只读规则可见口；verify=1 实时核对选项 UUID 漂移） ──
      if (req.method === 'GET' && path === '/api/ones-desk-fields') {
        try { return json(res, 200, await workbench.drafts.deskFieldContract(url.searchParams.get('verify') === '1')); }
        catch (error) { return json(res, 400, { error: (error as Error).message }); }
      }

      // ── MCP configuration (read + save/reconnect) ──
      // 阶段 1 仍为全局单套配置（含明文 token）：读写收敛到管理员；阶段 2 改为按用户「我的连接」。
      if (req.method === 'GET' && path === '/api/config/mcp') {
        if (!requireAdmin()) return json(res, 403, { error: '需要管理员权限' });
        return json(res, 200, {
          servers: loadMcpServers(),
          failures: [...runtime.mcp.failures.entries()],
        });
      }
      if (req.method === 'PUT' && path === '/api/config/mcp') {
        if (!requireAdmin()) return json(res, 403, { error: '需要管理员权限' });
        const body = await readBody(req);
        const err = validateServers(body.servers);
        if (err) return json(res, 400, { error: err });
        const servers = body.servers as McpServerConfig[];
        saveMcpServers(servers);
        await runtime.reloadMcp(servers);
        return json(res, 200, {
          ok: true,
          servers: loadMcpServers(),
          failures: [...runtime.mcp.failures.entries()],
        });
      }

      // ── LLM configuration (read + save/switch) ──
      if (req.method === 'GET' && path === '/api/config/llm') {
        return json(res, 200, {
          provider: runtime.llm.provider,
          model: runtime.llm.model,
          baseUrl: runtime.llm.baseUrl,
          apiKeyEnv: runtime.llm.apiKeyEnv,
          apiKeyConfigured: !!runtime.llm.apiKey,
          // 视觉（图片输入）能力：附件图片与设置页开关共用这一权威出口。
          vision: visionSupported(),
          // custom 端点协议（openai 缺省 / anthropic 兼容端点），设置页据此回填。
          protocol: runtime.llm.protocol === 'anthropic' ? 'anthropic' : 'openai',
        });
      }
      if (req.method === 'PUT' && path === '/api/config/llm') {
        // LLM 密钥是全部署共享配置：仅管理员可切换。
        if (!requireAdmin()) return json(res, 403, { error: '需要管理员权限' });
        const body = await readBody(req);
        if (!body.provider || !body.model) return json(res, 400, { error: 'provider 与 model 必填' });
        const provider = String(body.provider);
        const model = String(body.model);
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : '';
        const protocolRaw = typeof body.protocol === 'string' ? body.protocol.trim() : '';
        // custom: the endpoint URL is part of the identity; everything else
        // must not carry one.
        if (provider === CUSTOM_PROVIDER_ID) {
          if (!baseUrl) return json(res, 400, { error: '自定义服务商必须填写 Base URL' });
          if (!/^https?:\/\//i.test(baseUrl)) return json(res, 400, { error: 'Base URL 必须以 http(s):// 开头' });
          if (protocolRaw && !['openai', 'anthropic'].includes(protocolRaw)) {
            return json(res, 400, { error: 'protocol 只接受 openai / anthropic' });
          }
        } else if (baseUrl) {
          return json(res, 400, { error: '只有自定义服务商支持 Base URL' });
        } else if (protocolRaw) {
          return json(res, 400, { error: '只有自定义服务商支持协议选择' });
        }
        try {
          const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey : undefined;
          // Verify a custom endpoint with a real streaming request before it
          // can be saved; a saved-but-broken config would break every session.
          // 协议未显式传时沿用旧值（旧版 UI 改模型不得静默翻转 anthropic 配置）。
          const protocol = provider === CUSTOM_PROVIDER_ID
            ? (protocolRaw || (runtime.llm.provider === CUSTOM_PROVIDER_ID && runtime.llm.protocol === 'anthropic' ? 'anthropic' : 'openai'))
            : undefined;
          if (provider === CUSTOM_PROVIDER_ID) {
            const savedKey = apiKey ?? (runtime.llm.provider === CUSTOM_PROVIDER_ID ? runtime.llm.apiKey : undefined);
            if (!savedKey) return json(res, 400, { error: '自定义端点缺少 API Key（新配置必填；旧配置未保存过 key）' });
            await testCustomEndpoint({ baseUrl, model, apiKey: savedKey, ...(protocol === 'anthropic' ? { protocol } : {}) });
          }
          const vision = typeof body.vision === 'boolean' ? body.vision : undefined;
          runtime.setLlm({
            provider,
            model,
            apiKey,
            apiKeyEnv: runtime.llm.apiKeyEnv,
            ...(baseUrl ? { baseUrl } : {}),
            // custom 端点无法探测视觉能力，靠用户声明；未显式传时沿用旧值（避免换模型/改 key 时静默丢配置）。
            ...(provider === CUSTOM_PROVIDER_ID
              ? {
                  vision: vision ?? runtime.llm.vision === true,
                  ...(protocol === 'anthropic' ? { protocol: 'anthropic' as const } : {}),
                }
              : {}),
          });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        return json(res, 200, {
          ok: true,
          provider: runtime.llm.provider,
          model: runtime.llm.model,
          baseUrl: runtime.llm.baseUrl,
          apiKeyConfigured: !!runtime.llm.apiKey,
          vision: visionSupported(),
          protocol: runtime.llm.protocol === 'anthropic' ? 'anthropic' : 'openai',
        });
      }

      // ── Search (web intelligence) configuration ──
      if (req.method === 'GET' && path === '/api/config/search') {
        return json(res, 200, searchConfigStatus(loadSearchConfig()));
      }
      if (req.method === 'PUT' && path === '/api/config/search') {
        // 搜索密钥同为共享配置：仅管理员可写。
        if (!requireAdmin()) return json(res, 403, { error: '需要管理员权限' });
        const body = await readBody(req);
        const current = loadSearchConfig();
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey : current.apiKey;
        const maxResults = body.maxResults == null ? current.maxResults : Math.min(10, Math.max(1, Number(body.maxResults) || 5));
        const keylessFallback = body.keylessFallback == null ? current.keylessFallback : body.keylessFallback !== false;
        saveSearchConfig({ provider: 'tavily', apiKey: apiKey && apiKey.trim() ? apiKey.trim() : undefined, maxResults, keylessFallback });
        return json(res, 200, { ok: true, ...searchConfigStatus(loadSearchConfig()) });
      }

      // ── records ──
      // 写入审批记录挂在会话上：随会话属主可见（存量无主记录归 admin）。
      if (req.method === 'GET' && path === '/api/records') {
        const sorted = [...store.records]
          .filter((r) => sessionOwner(sessions.get(r.sessionId)?.userId) === authCtx.user.id)
          .sort((a, b) => b.createdAt - a.createdAt);
        return json(res, 200, { records: sorted });
      }

      // ── session list ──
      // 会话列表默认剔除已归档；include=archived 返回全量（网页已归档区与 CLI --all 诊断口）。
      // 会话是个人工作区：只看自己的（存量旧会话按 admin 归属兜底）。
      if (req.method === 'GET' && path === '/api/sessions') {
        const mine = store.listSessions().filter((s) => sessionOwner(s.userId) === authCtx.user.id);
        const visible = url.searchParams.get('include') === 'archived'
          ? mine
          : mine.filter((s) => s.archived !== true);
        return json(res, 200, { sessions: visible });
      }

      // ── create session ──
      if (req.method === 'POST' && path === '/api/sessions') {
        // 会话与客户完全解耦：不读 customerId（传了忽略）、不组装绑定上下文。
        // 客户身份只存在于对话文本、本地工具参数与回写草稿 fields。
        const now = Date.now();
      const session: Session = {
        id: randomUUID(),
        agent: null as unknown as AgentSession,
        events: [],
        clients: new Set(),
        pending: null,
        busy: false,
        seqCounter: 0,
        abort: null,
        title: '新对话',
          createdAt: now,
          updatedAt: now,
          lastRecordId: null,
          customer: null,
          archived: false,
        userId: authCtx.user.id,
        };
        session.agent = makeAgent(session);
        sessions.set(session.id, session);
        persist(session);
        return json(res, 200, { id: session.id, customer: null, mcpFailures: [...runtime.mcp.failures.entries()] });
      }

      // ── per-session routes ──
      const match = path.match(/^\/api\/sessions\/([0-9a-f-]+)(\/.*)?$/);
      const session = match ? sessions.get(match[1]) : undefined;
      if (match && !session) return json(res, 404, { error: 'session not found' });
      // 会话属主校验：个人工作区仅本人可读写（含 SSE 回放、附件、确认审批）。
      if (session && session.userId !== authCtx.user.id) return json(res, 403, { error: '无权访问他人的会话' });
      if (session) {
        const sub = match![2] ?? '';

        // SSE event stream
        if (req.method === 'GET' && sub === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('retry: 1000\n\n');
          for (const { seq, event } of session.events) {
            res.write(`data: ${JSON.stringify({ seq, event })}\n\n`);
          }
          session.clients.add(res);
          req.on('close', () => session.clients.delete(res));
          return;
        }

        // rename / archive
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
          const title = typeof body.title === 'string' ? body.title.trim() : undefined;
          const archived = typeof body.archived === 'boolean' ? body.archived : undefined;
          if (title === undefined && archived === undefined) {
            return json(res, 400, { error: 'title or archived is required' });
          }
          if (title !== undefined) {
            if (!title) return json(res, 400, { error: 'title is required' });
            session.title = title.slice(0, 80);
          }
          if (archived !== undefined) {
            // 归档切换不改 updatedAt，避免归档项在 include=archived 列表里跳到顶部。
            session.archived = archived;
          }
          if (title !== undefined) session.updatedAt = Date.now();
          persist(session);
          return json(res, 200, { ok: true, title: session.title, archived: session.archived });
        }

        // share/export full conversation transcript（归档会话也可导出，恢复前仍可查看内容）
        if (req.method === 'GET' && sub === '/export') {
          const customer = session.customer as { customer_name?: string; crm_customer_id?: string } | null;
          return json(res, 200, {
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            customerId: customer?.crm_customer_id,
            customerName: customer?.customer_name,
            archived: session.archived,
            transcript: formatSessionTranscript({
              title: session.title,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              events: session.events as Array<{ seq: number; event: TranscriptEvent }>,
              customer: session.customer as TranscriptSession['customer'],
            }),
          });
        }

        // delete
        if (req.method === 'DELETE' && sub === '') {
          removeSession(session.id);
          return json(res, 200, { ok: true });
        }

        // delete a record
        const recMatch = sub.match(/^\/records\/([0-9a-f-]+)$/);
        if (req.method === 'DELETE' && recMatch) {
          const idx = store.records.findIndex((r) => r.id === recMatch[1]);
          if (idx >= 0) {
            store.records.splice(idx, 1);
            store.persistRecords();
          }
          return json(res, 200, { ok: true });
        }

        // 附件内容下载/预览（消息气泡内的图片与附件链接；manifest 权威校验防路径穿越）
        const attachMatch = sub.match(/^\/attachments\/([0-9A-Za-z._-]+)$/);
        if (req.method === 'GET' && attachMatch) {
          const meta = await getStoredAttachment(session.id, attachMatch[1]);
          if (!meta) return json(res, 404, { error: 'attachment not found' });
          let bytes: Buffer;
          try {
            bytes = await readFile(attachmentFilePath(session.id, meta.id, meta.name));
          } catch {
            return json(res, 404, { error: 'attachment not found' });
          }
          res.writeHead(200, { 'Content-Type': meta.mimeType, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=3600' });
          return res.end(bytes);
        }

        // send a message（可带本地附件：文本/PDF 内容注入上下文，图片在视觉模型下走 image 块）
        if (req.method === 'POST' && sub === '/messages') {
          if (session.busy) return json(res, 409, { error: '已有进行中的请求' });
          if (session.archived) return json(res, 409, { error: '会话已归档，请先恢复' });
          // 附件内嵌 base64（约 1.33×），20MB 上限 ≈ 15MB 原始文件 + 消息文本；其余路由仍是 1MB。
          const body = await readBody(req, 20_000_000);
          const text = String(body.message ?? '').trim();
          const incomingAttachments: IncomingAttachment[] = Array.isArray(body.attachments)
            ? (body.attachments as Array<Record<string, unknown>>).map((item) => ({
              name: String(item.name ?? ''), mimeType: String(item.mimeType ?? ''), data: String(item.data ?? ''),
            }))
            : [];
          if (!text && !incomingAttachments.length) return json(res, 400, { error: 'message is required' });

          // 视觉预检：含图片且当前模型不支持时早退，避免把注定拒绝的文件先落盘。
          const vision = visionSupported();
          for (const item of incomingAttachments) {
            if (classifyAttachment(item.mimeType, item.name) === 'image' && !vision) {
              return json(res, 400, { error: `附件「${item.name}」是图片，但当前模型不支持图片输入（视觉模型）。请在设置中切换支持视觉的模型，或勾选「支持图片输入」后重试。` });
            }
          }

          let stored: Awaited<ReturnType<typeof storeAttachments>>;
          let contentForAgent: Awaited<ReturnType<typeof buildContentBlocks>> | string;
          try {
            stored = await storeAttachments(session.id, incomingAttachments);
            contentForAgent = stored.length
              ? await buildContentBlocks(text, session.id, stored, { vision })
              : text;
          } catch (error) {
            if (error instanceof AttachmentError) return json(res, 400, { error: (error as Error).message });
            throw error;
          }

          if (session.title === '新对话' && session.events.filter((e) => e.event.type === 'user').length === 0) {
            session.title = (text || stored[0]?.name || '新对话').slice(0, 30);
          }

          session.busy = true;
          session.abort = new AbortController();
          const signal = session.abort.signal;
          // 展示事件只带附件元信息：base64 不进 SSE 回放，避免会话刷新/重连时重复下行大负载。
          broadcast(session, { type: 'user', text, ...(stored.length ? { attachments: stored } : {}) });
          broadcast(session, { type: 'turn_start' });

          void (async () => {
            let turnUsage: { input: number; output: number; total: number } | undefined;
            let stopped = false;
            try {
              await session.agent.send(contentForAgent, {
                onEvent: (e) => {
                  // Record state machine (local留痕; does not affect CRM/ONES)
                  if (e.type === 'confirm' && e.draft) {
                    const rec = makeRecordFromDraft(e.draft, session.id, randomUUID(), Date.now());
                    store.records.push(rec);
                    store.persistRecords();
                    session.lastRecordId = rec.id;
                    // 确认卡附带结构化编辑契约：有契约的类型（工单/建议/工时/跟进/待办/私有云实例）
                    // 渲染中文表单，无契约（case/profile 等）前端回退原始 JSON 编辑。
                    // confirm 事件在这里下发后必须 return，不得再走末尾的通用广播——
                    // 双下发会让前端按事件渲染出两张同题确认卡、审计记录也翻倍（真实事故）。
                    broadcast(session, { ...e, editContract: confirmDraftEditContract(e.draft, draftUsageVersion(workbench.db, e.draft)) } as unknown as DisplayEvent);
                  } else {
                    if (e.type === 'tool_result' && e.name && e.name !== 'confirm_write') {
                      const t = runtime.mcp.resolve(e.name);
                      if (t && runtime.mcp.isWrite(t.server, t.rawName) && session.lastRecordId) {
                        const rec = store.records.find((r) => r.id === session.lastRecordId && r.status === 'approved');
                        if (rec) {
                          rec.status = 'written';
                          rec.result = typeof e.result === 'string' ? e.result.slice(0, 500) : undefined;
                          rec.updatedAt = Date.now();
                          store.persistRecords();
                          session.lastRecordId = null;
                        }
                      }
                    }
                    if (e.type === 'done' && e.usage) turnUsage = e.usage;
                    broadcast(session, e as unknown as DisplayEvent);
                  }
                },
                requestConfirm: (draft) =>
                  new Promise<boolean | ConfirmDraft>((resolve) => {
                    session.pending = { draft, resolve };
                  }),
              }, signal);
            } catch (err) {
              const aborted = err instanceof AgentAbortedError || signal.aborted || (err as Error).name === 'AbortError';
              if (aborted) {
                // 停止通知走 assistant text 事件：SSE、会话落盘、分享导出三端一致，天然审计留痕。
                broadcast(session, { type: 'text', text: '（对话已手动停止）' });
                stopped = true;
              } else {
                broadcast(session, { type: 'text', text: `运行出错: ${(err as Error).message}` });
              }
            } finally {
              session.pending = null;
              session.abort = null;
              session.busy = false;
              broadcast(session, { type: 'turn_end', usage: turnUsage, stopped: stopped || undefined });
            }
          })();

          return json(res, 202, { ok: true });
        }

        // stop the running turn（挂起中的 confirm_write 草稿自动按拒绝处理——停止即不写）
        if (req.method === 'POST' && sub === '/stop') {
          if (!session.busy) return json(res, 409, { error: '当前没有进行中的对话' });
          if (session.pending) {
            const pending = session.pending;
            session.pending = null;
            pending.resolve(false);
            const rec = session.lastRecordId ? store.records.find((r) => r.id === session.lastRecordId) : undefined;
            if (rec) {
              rec.status = 'rejected';
              rec.updatedAt = Date.now();
              store.persistRecords();
              session.lastRecordId = null;
            }
          }
          session.abort?.abort();
          return json(res, 200, { ok: true });
        }

        // confirm / reject a pending draft
        if (req.method === 'POST' && sub === '/confirm') {
          if (!session.pending) return json(res, 409, { error: 'no pending confirmation' });
          const body = await readBody(req);
          const ok = body.approve === true;
          let approvedDraft: ConfirmDraft | null = null;
          if (ok) {
            // 结构化编辑分支：客户端只提交字段键→新值，服务端按类型契约合并；合并失败（未知选项等）报 400。
            // 部署类型锁定等编辑契约的权威使用版本由草稿自含客户解析（会话不承载客户状态）。
            if (isRecord(body.edits)) {
              const merged = applyConfirmDraftEdits(session.pending.draft, body.edits, draftUsageVersion(workbench.db, session.pending.draft));
              if (!merged.draft) return json(res, 400, { error: `草稿编辑未通过: ${merged.errors.join('；')}` });
              approvedDraft = merged.draft;
            } else {
              approvedDraft = body.draft ? editedDraft(session.pending.draft, body.draft) : session.pending.draft;
              if (!approvedDraft) return json(res, 400, { error: '编辑后的草稿无效，目标系统和目标工具不可修改' });
            }
            // 案例对话精修分支：confirm_write 带 case_draft_id 即本地草稿更新（case_drafts 表），
            // 不是外部写——跳过 MCP 写工具校验，批准即应用，版本乐观锁防并发编辑。
            const caseDraftId = approvedDraft.fields?.case_draft_id;
            if (approvedDraft.record_type === 'case' && typeof caseDraftId === 'string' && caseDraftId) {
              const caseDraft = workbench.db.getCaseDraft(caseDraftId);
              if (!caseDraft) return json(res, 400, { error: `案例草稿不存在: ${caseDraftId}` });
              // 归属校验按草稿自含客户（fields.customer_id/customer_name）解析——会话不承载客户状态。
              const refineBinding = resolveDraftCustomer(workbench.db, approvedDraft);
              if (!refineBinding || caseDraft.customerId !== refineBinding.customer.id) {
                return json(res, 400, { error: '案例草稿与草稿携带的客户不一致（fields.customer_id/customer_name 须与案例草稿归属客户一致）' });
              }
              if (caseDraft.status !== 'draft') return json(res, 400, { error: '案例草稿已发布，不可再精修' });
              const expectedVersion = Number(approvedDraft.fields?.case_version ?? caseDraft.version);
              if (expectedVersion !== caseDraft.version) {
                return json(res, 400, { error: `案例草稿版本已变化（当前 v${caseDraft.version}），请重新发起精修` });
              }
              const bindingError = validateCustomerBoundDraft(approvedDraft, refineBinding);
              if (bindingError) return json(res, 400, { error: bindingError });
              const updated = workbench.cases.update(caseDraft.id, caseDraft.version, approvedDraft.title || caseDraft.title,
                pickNarrativeFields(approvedDraft.fields));
              if (!updated) return json(res, 400, { error: '案例草稿更新失败（版本已变化或已发布）' });
              // 写回护栏（非阻断）：精修稿异常（条目失控/超长/内部残留）随响应返回，由 CSM 复核。
              const refineWarnings = caseNarrativeWarnings(updated.fields);
              workbench.db.audit('agent', 'refine_case_draft', 'case_draft', updated.id, { version: updated.version, sessionId: session.id, warnings: refineWarnings, approvedBy: actor });
              session.pending.resolve(approvedDraft);
              session.pending = null;
              const refineRecord = session.lastRecordId
                ? store.records.find((r) => r.id === session.lastRecordId)
                : undefined;
              if (refineRecord) {
                refineRecord.status = 'written';
                refineRecord.type = approvedDraft.record_type;
                refineRecord.title = approvedDraft.title;
                refineRecord.customer = customerOf(approvedDraft);
                refineRecord.target = 'local';
                refineRecord.fields = approvedDraft.fields;
                refineRecord.updatedAt = Date.now();
                store.persistRecords();
                session.lastRecordId = null;
              }
              return json(res, 200, { ok: true, decided: 'approved', refined: true, draft: updated, warnings: refineWarnings.length ? refineWarnings : undefined });
            }
            const target = runtime.mcp.resolve(approvedDraft.target_tool);
            if (!target || !runtime.mcp.isWrite(target.server, target.rawName)) {
              return json(res, 400, { error: '目标工具不是已连接的写工具' });
            }
            // 客户身份以（可能编辑过的）草稿为准做最终解析与校验；ONES Desk 的客户字段在批准前
            // 确定性绑定为解析客户的 confirmed 选项（模型自行搜索的选项仅参考），批准 hash 绑定规范化后参数。
            const binding = resolveDraftCustomer(workbench.db, approvedDraft);
            const rawName = typeof approvedDraft.fields?.customer_name === 'string' ? approvedDraft.fields.customer_name.trim() : '';
            if (binding && rawName && rawName !== binding.customer.name && rawName !== binding.customer.shortName) {
              return json(res, 400, { error: '草稿中的客户 ID 与客户名称指向不同客户，请修正后重新提交' });
            }
            const optionError = binding ? applyDraftCustomerOptionBinding(approvedDraft, binding) : null;
            if (optionError) return json(res, 400, { error: optionError });
            if (binding) {
              approvedDraft.fields.customer_id = binding.customer.id;
              approvedDraft.fields.customer_name = binding.customer.name;
            }
            const bindingError = validateCustomerBoundDraft(approvedDraft, binding);
            if (bindingError) return json(res, 400, { error: bindingError });
            // ONES 工作项批准门：规格表字段（所属产品/所属模块/实例部署类型等）必须齐备，批准即写入，
            // 缺失会到 ONES 端才报错。agent 无法从 get_issue_fields 自行枚举选项（大选项集截断），必须用本地工具补齐。
            const deskFieldValues = Array.isArray(approvedDraft.target_arguments.fieldValues)
              ? approvedDraft.target_arguments.fieldValues as Array<Record<string, unknown>> : [];
            const specMissing = missingOnesDeskSpecFields(approvedDraft.record_type, deskFieldValues);
            if (specMissing.length) {
              return json(res, 400, { error: `ONES 工作项缺少必填字段: ${specMissing.map((spec) => `${spec.label}(${spec.uuid})`).join('、')}（请调用 get_ones_desk_required_fields 获取选项 UUID 补齐后重新 confirm_write）` });
            }
            // 描述必须写进 field016（真实验收发现模型把描述写进发明的 field002），且 fieldValues 不允许
            // 规格字段/客户信息/描述之外的未知字段 ID——未知 ID 只有到 ONES 端才会报错，必须在门禁拦下。
            if (missingOnesDeskDescription(approvedDraft.record_type, deskFieldValues)) {
              return json(res, 400, { error: 'ONES 工作项描述必须写入 field016（fieldValues 携带 {"fieldID":"field016","value":"完整描述"}），不得省略或改用其他字段' });
            }
            const unknownFields = unknownOnesDeskFieldIds(approvedDraft.record_type, deskFieldValues);
            if (unknownFields.length) {
              return json(res, 400, { error: `ONES 工作项 fieldValues 含未知字段: ${unknownFields.join('、')}（只允许规格字段、客户信息 JrvswW8P 与描述字段 field016），请移除后重新 confirm_write` });
            }
            // 实例部署类型以 CRM 使用版本为唯一依据（公有云版→公有云，其余→私有云），与 Hemory 自动草稿同一规则；
            // 使用版本取解析客户（草稿自含、工作台库）的权威值。
            if (approvedDraft.record_type === 'suggestion' || approvedDraft.record_type === 'ticket') {
              const deskUsageVersion = binding?.customer.usageVersion ?? null;
              const expected = applyDeploymentTypeOverride(approvedDraft.record_type as 'suggestion' | 'ticket', deskUsageVersion)[0];
              const actual = deskFieldValues.find((value) => value.fieldID === ONES_DESK_DEPLOYMENT_FIELD_ID);
              if (!expected || !actual || String(actual.value) !== expected.value) {
                return json(res, 400, { error: `实例部署类型必须按 CRM 使用版本判定为 ${expected?.value ?? '(规则解析失败)'}，当前草稿为 ${actual?.value ?? '(缺失)'}（公有云版→公有云，其余→私有云）` });
              }
            }
          }
          session.pending.resolve(approvedDraft ?? false);
          session.pending = null;

          const rec = session.lastRecordId
            ? store.records.find((r) => r.id === session.lastRecordId)
            : undefined;
          if (rec) {
            rec.status = ok ? 'approved' : 'rejected';
            if (approvedDraft) {
              rec.type = approvedDraft.record_type;
              rec.title = approvedDraft.title;
              rec.customer = customerOf(approvedDraft);
              rec.target = approvedDraft.target_system;
              rec.fields = approvedDraft.fields;
            }
            rec.updatedAt = Date.now();
            store.persistRecords();
            if (!ok) session.lastRecordId = null;
          }
          return json(res, 200, { ok, decided: ok ? 'approved' : 'rejected' });
        }
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  };
}

export async function startServer(runtime: Runtime, port: number): Promise<http.Server> {
  const store = new Store(dataDir());
  const db = new WorkbenchDatabase(dataDir());
  // 多人化引导：空库首启创建 admin（CSM_ADMIN_PASSWORD 或随机生成并打印一次）；
  // 存量单用户部署的历史数据（会话/客户/草稿）一律归属该 admin，升级后除多一步登录外行为不变。
  ensureBootstrapAdmin(db);
  const legacyUserId = db.getUserByUsername('admin')?.id ?? db.listUsers()[0]?.id;
  // Preserve useful customer identities from pre-SQLite output records.
  for (const record of store.records) {
    const fields = record.fields ?? {};
    const id = typeof fields.customer_id === 'string' && fields.customer_id ? fields.customer_id : '';
    const name = typeof fields.customer_name === 'string' && fields.customer_name ? fields.customer_name : record.customer;
    if (id && name) db.upsertCustomer({ id, name, source: { legacyRecordId: record.id } });
  }
  // 闭包延迟引用 sync（下方才声明）：resumePending 在启动 5s 后才运行，届时 sync 必已赋值。
  const drafts = new HemoryDraftService(db, runtime.mcp, runtime, (customerId: string) => sync.syncOnesForCustomer(customerId));
  // 增购机会 v2：从会议录音片段 + 公开动态证据 LLM 分析产出假设（串行队列 + 指纹/时长门控在服务内部）。
  const opportunities = new OpportunityService(db, runtime);
  let sync: PortfolioSyncService;
  const hemorySegments = new HemorySegmentationService(db, runtime, (events) => {
    const byCustomer = new Map<string, string[]>();
    for (const event of events) {
      if (!event.customerId || event.attributionStatus !== 'confirmed') continue;
      sync.processHemoryEvidence(event);
      const ids = byCustomer.get(event.customerId) ?? [];
      ids.push(event.id);
      byCustomer.set(event.customerId, ids);
    }
    for (const [customerId, eventIds] of byCustomer) {
      drafts.enqueue(customerId, eventIds);
      sync.recompute(customerId);
    }
  });
  sync = new PortfolioSyncService(db, runtime.mcp, (recording) => hemorySegments.segmentRecordingDetailed(recording),
    // 公开动态检索注入（同步路径与 agent 工具同源）：key/keyless 与 web_search 工具共用同一配置。
    (customer, options) => new WebIntelService(db, runtime, {
      getApiKey: () => loadSearchConfig().apiKey,
      getMaxResults: () => loadSearchConfig().maxResults ?? 5,
      getKeylessEnabled: () => loadSearchConfig().keylessFallback,
    }).refresh(customer, options),
    // 增购机会分析注入：recompute 落证据后异步调度，服务内部有指纹 + 24h 门控与失败降级。
    (customerId) => opportunities.analyze(customerId));
  const cases = new CaseService(db, runtime.mcp, runtime, {
    // 案例生成时联网检索（与 web_search 工具/公开动态同步同源配置）。
    getApiKey: () => loadSearchConfig().apiKey,
    getMaxResults: () => loadSearchConfig().maxResults ?? 5,
    getKeylessEnabled: () => loadSearchConfig().keylessFallback,
  });
  const wiki = new WikiService(runtime.mcp);
  // 工时注入：读已同步的工时登记（payload 缓存优先），生成路径不打实时 MCP。
  const weekly = new WeeklyReportService(db, runtime.mcp, runtime, async (customerId: string) => {
    const data = await sync.listCustomerWorkhours(customerId);
    return { records: data.records.map((record) => ({ startTime: record.startTime, hours: record.hours, description: record.description, owner: record.owner?.name ?? undefined })) };
  });
  // 启动恢复：进程内未跑完的 SyncRun 与被重启烧掉额度的分段 job 都是残留脏数据——
  // 前者落 failed 终态，后者重置回 pending 交给 5s 后的 resumePending 重跑。
  // 必须先于下方调度器挂载：scheduleHemorySync 启动即补跑漏槽并创建 running run，
  // 清扫若落在其后会把刚建的补跑 run 误标「服务重启中断」（异步工作仍在跑、run 记录全花）。
  const orphanedRuns = db.failOrphanedSyncRuns();
  const resetJobs = db.resetInterruptedHemorySegmentationJobs();
  if (orphanedRuns || resetJobs) {
    db.audit('system', 'recover_interrupted_sync_jobs', 'sync_run', 'startup', { orphanedRuns, resetSegmentationJobs: resetJobs });
  }
  // 备份恢复标记消费：CLI 离线恢复后落 backup_restore 审计（CLI 不直接写 DB，保持单写者）。
  consumeRestoreMarker(db, dataDir());
  const stopPortfolio = schedulePortfolioSync(sync);
  const stopHemory = scheduleHemorySync(sync, db);
  // 公开动态自动轮换：每日 20:00–次日 08:00（上海错峰时段、token 更便宜）每小时检索 1 个客户，约两周全员轮换（最久未查优先）。
  const stopWebIntel = scheduleWebIntelSync(sync);
  // 备份调度（每日 04:00 上海 + 启动补跑）：挂载必须在上方孤儿清扫之后（补跑会建 running run，
  // 清扫在前是 ca89b9c 事故定下的启动顺序契约）。
  const stopBackup = scheduleBackup(db, dataDir());
  // 风险模型升级（ruleVersion 变化）后启动即全量重算：纯本地计算，无外部调用，
  // 否则升级部署后库里还压着旧版评分（UI 维度标签对不上 key）。
  for (const customer of db.listCustomers()) {
    if (db.latestRisk(customer.id)?.ruleVersion !== RISK_RULE_VERSION) sync.recompute(customer.id);
  }
  // 预警名单启动对账：evaluate 是幂等状态机（无变化零写入、消除后重报有抑制），
  // 全客户扫一遍纯本地查询，部署后不必等 02:00 同步名单即可见，也顺带自愈任何漏算。
  for (const customer of db.listCustomers()) {
    try {
      evaluateCustomerAlerts(db, customer.id);
    } catch (error) {
      console.error(`[alerts] customer ${customer.id} 预警评估失败: ${String(error)}`);
    }
  }
  // 增购机会 v2 首轮引导：无生成记录（或失败超过重试门）的客户排一次分析——
  // 部署后不必等 02:00 全量同步或手动刷新，旧规则双假设即被替换；门控命中的秒级跳过，重启无感。
  for (const customer of db.listCustomers()) opportunities.schedule(customer.id);
  const resumeTimer = setTimeout(() => {
    hemorySegments.resumePending();
    drafts.resumePending();
    weekly.resumePending();
    cases.resumePending();
  }, 5_000);
  resumeTimer.unref();
  const server = http.createServer(buildHandler(runtime, store, { db, sync, cases, drafts, weekly, wiki, opportunities }, legacyUserId));
  // 旧进程检测的锚点：进程启动时加载的构建 + 受监管时的磁盘变化自检。
  loadedBuildInfo = readBuildInfo();
  serverStartedAt = new Date().toISOString();
  const staleTimer = startStalenessWatch(loadedBuildInfo, {
    onReload: () => {
      // 受监管（launchd KeepAlive / Mac App terminationHandler）时退位让新构建上线；
      // 未受监管的手动进程不自动退出（可用性优先），只把 stale 标记暴露给 /api/version 与前端横幅。
      if (process.env.CSM_SUPERVISED === '1') {
        console.log(`[build] 检测到新构建（当前 ${loadedBuildInfo?.buildId}），受监管进程自动退出换新`);
        server.close(() => process.exit(0));
        // server.close 只等既有连接排空；残留 keep-alive 连接不该拖住换新，兜底强制退出。
        setTimeout(() => process.exit(0), 3_000).unref();
      } else {
        console.warn(`[build] 磁盘构建已更新而进程未受监管（当前 ${loadedBuildInfo?.buildId}），等待人工重启；/api/version 将报告 stale`);
      }
    },
  });
  server.on('close', () => {
    stopPortfolio();
    stopHemory();
    stopWebIntel();
    stopBackup();
    clearTimeout(resumeTimer);
    if (staleTimer) clearInterval(staleTimer);
    db.close();
  });
  // 端口被占时给出可读指引而不是裸崩：最常见的情形就是旧进程还在跑旧构建。
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用（通常是旧的服务进程仍在运行）。请执行 csm-agent service restart，或结束占用该端口的进程后重试。`);
      process.exit(1);
    }
    throw error;
  });
  // 监听地址显式收敛：默认只绑本机回环（此前不传 host 会绑全部网卡，鉴权上线前等于 API 裸奔到局域网）。
  // 多人局域网/公网部署用 CSM_HOST 打开（阶段 5 部署形态定后再配 TLS 反代）。
  const host = process.env.CSM_HOST ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}
