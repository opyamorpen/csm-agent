import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Runtime } from './bootstrap.js';
import { loadMcpServers, saveMcpServers, loadSearchConfig, saveSearchConfig, searchConfigStatus, type McpServerConfig } from './config.js';
import { CUSTOM_PROVIDER_ID, testCustomEndpoint } from './custom-llm.js';
import { AgentSession, type AgentEvent } from './agent.js';
import type { ConfirmDraft } from './tools/confirm.js';
import { CUSTOMER_CONTEXT_TOOL_NAME, mergeCustomerContext, extractCustomerContext, type CustomerContext } from './tools/customer.js';
import { CUSTOMER_PROFILE_TOOL_NAME, CUSTOMER_EVENTS_TOOL_NAME, makeWorkbenchToolHandlers } from './tools/workbench.js';
import { WEB_SEARCH_TOOL_NAME, RECORD_WEB_INTELLIGENCE_TOOL_NAME, makeWebSearchHandler, makeRecordWebIntelligenceHandler } from './tools/websearch.js';
import { ONES_DESK_FIELDS_TOOL_NAME, makeOnesDeskFieldsHandler } from './tools/onesdesk.js';
import { missingOnesDeskSpecFields, applyDeploymentTypeOverride, ONES_DESK_DEPLOYMENT_FIELD_ID } from './workbench/drafts.js';
import { Store, customerOf, makeRecordFromDraft, dataDir, type RecordEntry } from './store.js';
import { formatSessionTranscript, type TranscriptSession, type TranscriptEvent } from './transcript.js';
import { WorkbenchDatabase } from './workbench/database.js';
import type { Customer } from './workbench/types.js';
import { PortfolioSyncService, scheduleHemorySync, schedulePortfolioSync } from './workbench/sync.js';
import { CaseService } from './workbench/cases.js';
import { WecomTodoService, scheduleWecomSync } from './workbench/wecom.js';
import { HemoryDraftService, draftDisplayFields, shanghaiEventDate } from './workbench/drafts.js';
import type { DraftBatch, DraftItem, DraftGenerationJob, DraftItemType, SourceEvent } from './workbench/types.js';
import { HemorySegmentationService } from './workbench/hemory.js';
import { WeeklyReportService, weekMonday, weekRange } from './workbench/weekly.js';
import { WikiService } from './workbench/wiki.js';
import { readBuildInfo, serviceVersionInfo, startStalenessWatch, type BuildInfo } from './version.js';

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
  title: string;
  createdAt: number;
  updatedAt: number;
  /** id of the most recent confirm_write draft record in this session */
  lastRecordId: string | null;
  /** latest structured customer context resolved in this session */
  customer: CustomerContext | null;
  /** archived sessions stay loadable but are hidden from the default list */
  archived: boolean;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('request body too large'));
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

export function validateCustomerBoundDraft(draft: ConfirmDraft, customer: CustomerContext | null): string | null {
  if (!customer?.crm_customer_id || !customer.customer_name) return '当前 Agent 会话未绑定 CRM 售后客户，不能批准回写';
  const draftCustomerId = draft.fields.customer_id ?? draft.fields.crm_customer_id;
  if (draftCustomerId !== customer.crm_customer_id || draft.fields.customer_name !== customer.customer_name) {
    return '草稿中的 CRM 客户 ID/客户名称与当前客户不一致';
  }
  if (draft.target_system === 'crm') {
    return containsExactValue(draft.target_arguments, customer.crm_customer_id)
      ? null
      : 'CRM 回写参数未绑定当前 CSM 售后客户 ID';
  }
  if (draft.target_system !== 'ones') return 'target_system 只允许 crm 或 ones';
  if (draft.record_type === 'case' || draft.record_type === 'profile') return null;
  if (draft.record_type === 'workhour') {
    return customer.customer_manhour_issue_id && draft.target_arguments.issueID === customer.customer_manhour_issue_id
      ? null
      : '工时回写必须指向当前客户已绑定的“售后客户”工作项';
  }
  const fieldValues = Array.isArray(draft.target_arguments.fieldValues) ? draft.target_arguments.fieldValues : [];
  const customerFieldId = process.env.ONES_CUSTOMER_FIELD_ID ?? 'JrvswW8P';
  const binding = fieldValues.find((item) => isRecord(item) && item.fieldID === customerFieldId);
  return binding && customer.ones_customer_option_id && containsExactValue(binding.value, customer.ones_customer_option_id)
    ? null
    : `ONES 回写参数必须在 fieldValues 中绑定 ${customerFieldId}=${customer.ones_customer_option_id ?? '(未解析)'}`;
}

interface WorkbenchServices {
  db: WorkbenchDatabase;
  sync: PortfolioSyncService;
  cases: CaseService;
  wecom: WecomTodoService;
  drafts: HemoryDraftService;
  weekly: WeeklyReportService;
  wiki: WikiService;
}

function buildHandler(runtime: Runtime, store: Store, workbench: WorkbenchServices): http.RequestListener {
  const sessions = new Map<string, Session>();

  // 草稿确认视图共用最小必填项结构（displayFields），Web 卡片与 CLI 渲染同一份数据。
  const DRAFT_ITEM_STATUS_LABELS: Record<string, string> = { draft: '草稿', ready: '就绪', writing: '写入中', written: '已写入', failed: '失败', dismissed: '已忽略', stale: '已作废' };
  function decorateDraftBatch(batch: DraftBatch): DraftBatch {
    if (!batch.items) return batch;
    // actionableItemCount：仍需处理（可勾选确认）的条目数；为 0 的批次是纯已作废/已忽略批次，前端默认折叠。
    const actionableItemCount = batch.items.filter((item) => !['written', 'dismissed', 'stale'].includes(item.status)).length;
    return { ...batch, actionableItemCount, items: batch.items.map((item) => decorateDraftItem(item)) };
  }
  function decorateDraftItem(item: DraftItem): DraftItem {
    const customer = workbench.db.getCustomer(item.customerId) as Customer | undefined;
    const decorated = customer ? { ...item, displayFields: draftDisplayFields(workbench.db, item, customer) } : item;
    return { ...decorated, statusLabel: DRAFT_ITEM_STATUS_LABELS[item.status] ?? item.status };
  }
  // 失败生成任务的片段明细：客户名 + 上海日 + 逐片段摘要（截断），支撑「失败后选片段重新生成」。
  function decorateDraftJob(job: DraftGenerationJob): DraftGenerationJob & { dateKey?: string; fragments?: Array<{ id: string; occurredAt: string; topic: string; summary: string }> } {
    if (job.status !== 'failed') return job;
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

  // 片段消费台账可见性：每片段标注被哪些类型的已写入草稿消费（written 草稿 evidence_refs 反查，按客户一次构建）。
  function decorateHemoryFragments(fragments: SourceEvent[]): Array<SourceEvent & { consumedBy?: DraftItemType[] }> {
    const byCustomer = new Map<string, Map<string, DraftItemType[]>>();
    const consumedOf = (customerId: string): Map<string, DraftItemType[]> => {
      let map = byCustomer.get(customerId);
      if (!map) {
        map = new Map();
        for (const [type, ids] of workbench.db.writtenEvidenceByType(customerId)) {
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

  function makeAgent(session: Session): AgentSession {
    // Local workbench/web tools resolve the bound customer from the session's
    // context (falls back to lookup by name until the model confirms identity).
    const boundCustomer = () => {
      const id = session.customer?.crm_customer_id;
      if (id && workbench.db.getCustomer(id)) {
        const c = workbench.db.getCustomer(id)!;
        return { id: c.id, name: c.name };
      }
      const name = session.customer?.customer_name;
      if (name) {
        const matches = workbench.db.listCustomers(name).filter((c) => c.name === name || c.shortName === name);
        if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
      }
      return null;
    };
    const workbenchHandlers = makeWorkbenchToolHandlers({
      getCustomer: boundCustomer,
      overview: (id) => workbench.db.overview(id),
      timeline: (id, limit) => workbench.db.listTimeline(id, limit).map((e) => e as unknown as Record<string, unknown>),
    });
    const onesDeskFields = makeOnesDeskFieldsHandler({
      // CRM 使用版本是实例部署类型的唯一判定依据；未绑定客户时未同步，按私有云兜底。
      getUsageVersion: () => {
        const id = session.customer?.crm_customer_id;
        return id ? workbench.db.getCustomer(id)?.usageVersion ?? null : null;
      },
    });
    const searchConfig = loadSearchConfig();
    const webSearch = makeWebSearchHandler({
      getApiKey: () => loadSearchConfig().apiKey,
      getMaxResults: () => loadSearchConfig().maxResults ?? searchConfig.maxResults,
      getKeylessEnabled: () => loadSearchConfig().keylessFallback,
    });
    const recordWebIntelligence = makeRecordWebIntelligenceHandler({
      getCustomer: boundCustomer,
      addEvidence: (input) => workbench.db.addEvidence(input),
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
        [WEB_SEARCH_TOOL_NAME]: webSearch,
        [RECORD_WEB_INTELLIGENCE_TOOL_NAME]: recordWebIntelligence,
        [ONES_DESK_FIELDS_TOOL_NAME]: onesDeskFields,
        [CUSTOMER_CONTEXT_TOOL_NAME]: async (args, emit) => {
          const next = extractCustomerContext(args);
          if (Object.keys(next).length === 0) {
            return { text: '未提供有效字段，客户上下文未更新。' };
          }
          session.customer = mergeCustomerContext(session.customer, next);
          session.updatedAt = Date.now();
          emit({ type: 'customer_context', context: session.customer });
          return { text: `已记录客户上下文: ${session.customer.customer_name ?? '(未命名)'}` };
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
    });
  }

  function broadcast(session: Session, event: DisplayEvent): void {
    session.events.push({ seq: session.events.length + 1, event });
    session.updatedAt = Date.now();
    persist(session);
    const payload = `data: ${JSON.stringify({ seq: session.events.length, event })}\n\n`;
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
      title: stored.title || '新对话',
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      lastRecordId: null,
      customer: (stored.customer as CustomerContext | undefined) ?? null,
      archived: stored.archived === true,
    };
    const agent = makeAgent(session);
    session.agent = agent;
    agent.restore((stored.messages ?? []) as never);
    sessions.set(meta.id, session);
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      // ── static ──
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(await readFile(join(publicDir, 'index.html'), 'utf8'));
      }
      if (req.method === 'GET' && ['/app.js', '/style.css', '/app-icon.svg', '/wecom-todo.html', '/wecom-todo.js', '/build-info.js'].includes(path)) {
        const file = path.slice(1);
        const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8'
          : path.endsWith('.svg') ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8';
        // 构建戳必须每次取最新且不被中间层缓存：前端靠它发现「页面新、进程旧」的分裂。
        const headers: Record<string, string> = { 'Content-Type': type };
        if (path === '/build-info.js') headers['Cache-Control'] = 'no-store';
        res.writeHead(200, headers);
        return res.end(await readFile(join(publicDir, file), 'utf8'));
      }

      // ── build version（旧进程检测的权威端点；404 = 进程早于该机制） ──
      if (req.method === 'GET' && path === '/api/version') {
        return json(res, 200, serviceVersionInfo(loadedBuildInfo, serverStartedAt));
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
      if (req.method === 'POST' && path === '/api/hemory/sync') {
        const body = await readBody(req);
        return json(res, 202, typeof body.date === 'string' && body.date
          ? workbench.sync.refreshHemoryDate(body.date)
          : workbench.sync.refreshRecentHemory());
      }
      // 全量重切：遍历库内全部录音并按当前分段版本重切，与增量同步互斥；内部数据变更，无需外部写审批。
      if (req.method === 'POST' && path === '/api/hemory/resegment') {
        const body = await readBody(req);
        if (body.scope !== 'all') return json(res, 400, { error: '仅支持 {"scope":"all"}' });
        return json(res, 202, workbench.sync.resegmentAllHemory());
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
            isRecord(body.expectedHashes) ? Object.fromEntries(Object.entries(body.expectedHashes).map(([key, value]) => [key, String(value)])) : {}, 'csm');
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
            isRecord(body.expectedHashes) ? Object.fromEntries(Object.entries(body.expectedHashes).map(([key, value]) => [key, String(value)])) : {}, 'csm');
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
          void workbench.wecom.syncActive();
          const overview = workbench.db.overview(customerId);
          return overview ? json(res, 200, overview) : json(res, 404, { error: 'customer not found' });
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
      }

      if (req.method === 'GET' && path === '/api/action-items') {
        return json(res, 200, { actions: workbench.db.listActions(url.searchParams.get('customer_id') ?? undefined) });
      }
      if (req.method === 'POST' && path === '/api/action-items/bulk-accept') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (!ids.length) return json(res, 400, { error: 'ids 不能为空' });
        return json(res, 200, { items: workbench.db.bulkAcceptActions(ids) });
      }
      if (req.method === 'POST' && path === '/api/action-items/bulk-complete') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (!ids.length) return json(res, 400, { error: 'ids 不能为空' });
        const outcome = typeof body.outcome === 'string' && body.outcome.trim() ? body.outcome.trim() : undefined;
        return json(res, 200, { items: await workbench.wecom.bulkComplete(ids, outcome) });
      }
      const actionMatch = path.match(/^\/api\/action-items\/([0-9A-Za-z_-]+)(\/.*)?$/);
      if (actionMatch) {
        const actionId = actionMatch[1];
        const sub = actionMatch[2] ?? '';
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
          const allowed = ['new', 'accepted', 'in_progress', 'completed', 'snoozed', 'false_positive'];
          if (body.status && !allowed.includes(body.status)) return json(res, 400, { error: 'invalid action status' });
          const action = workbench.db.updateAction(actionId, body);
          return action ? json(res, 200, action) : json(res, 404, { error: 'action item not found' });
        }
        if (req.method === 'POST' && sub === '/complete') {
          const body = await readBody(req);
          try {
            await workbench.wecom.complete(actionId, typeof body.outcome === 'string' ? body.outcome : undefined);
            return json(res, 200, workbench.db.getAction(actionId));
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
        }
        if (req.method === 'POST' && sub === '/wecom-todo-intents') {
          try {
            return json(res, 201, workbench.wecom.createIntent(actionId));
          } catch (error) {
            return json(res, 400, { error: (error as Error).message, wecom: workbench.wecom.client.status() });
          }
        }
      }

      const todoIntentMatch = path.match(/^\/api\/wecom\/todo-intents\/([0-9a-f-]+)$/);
      if (req.method === 'GET' && todoIntentMatch) {
        const intent = workbench.wecom.getIntent(todoIntentMatch[1], url.searchParams.get('token') ?? '');
        return intent ? json(res, 200, intent) : json(res, 404, { error: '待办意图无效、已使用或已过期' });
      }
      if (req.method === 'GET' && path === '/api/wecom/status') {
        return json(res, 200, workbench.wecom.client.status());
      }
      if (req.method === 'GET' && path === '/api/wecom/js-sdk-config') {
        try {
          return json(res, 200, await workbench.wecom.client.jsSdkConfig(url.searchParams.get('url') ?? ''));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (req.method === 'POST' && path === '/api/wecom/todo-created') {
        const body = await readBody(req);
        try {
          workbench.wecom.todoCreated(String(body.intent ?? ''), String(body.token ?? ''), String(body.todoId ?? ''),
            typeof body.creatorUserid === 'string' ? body.creatorUserid : undefined);
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
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
        return json(res, 200, { batches: visible.map(decorateDraftBatch) });
      }
      // 生成任务状态查询：归属/重生成响应里的 jobId 在此轮询。失败任务不会创建批次，只能通过任务状态感知。
      if (req.method === 'GET' && path === '/api/draft-jobs') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
        // 无 ids 时列出最近失败任务（kind=hemory 日草稿）：失败明细的可发现入口，页面刷新后仍可见。
        const status = url.searchParams.get('status') ?? 'failed';
        const kind = url.searchParams.get('kind') === 'weekly_report' ? 'weekly_report' : 'hemory';
        const jobs = ids.length
          ? ids.map((id) => workbench.db.getDraftJob(id)).filter((job): job is DraftGenerationJob => !!job)
          : status === 'failed' ? workbench.db.listFailedDraftJobs(kind) : [];
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
          try { return json(res, 200, decorateDraftBatch(workbench.drafts.dismissBatch(batchId))); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
        if (req.method === 'POST' && sub === '/confirm') {
          const body = await readBody(req);
          try {
            const { items } = await workbench.drafts.confirm(batchId, Array.isArray(body.items) ? body.items : []);
            return json(res, 200, { items: items.map(decorateDraftItem) });
          } catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
      }
      const draftItemMatch = path.match(/^\/api\/draft-items\/([0-9a-f-]+)(\/.*)?$/);
      if (draftItemMatch) {
        const itemId = draftItemMatch[1];
        const sub = draftItemMatch[2] ?? '';
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
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
      }
      if (req.method === 'POST' && path === '/api/case-drafts') {
        const body = await readBody(req);
        try {
          return json(res, 201, workbench.cases.generate(String(body.customerId ?? '')));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      const caseMatch = path.match(/^\/api\/case-drafts\/([0-9a-f-]+)(\/.*)?$/);
      if (caseMatch) {
        const draftId = caseMatch[1];
        const sub = caseMatch[2] ?? '';
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
          const draft = workbench.db.updateCaseDraft(draftId, Number(body.version), String(body.title ?? ''), body.fields ?? {});
          return draft ? json(res, 200, draft) : json(res, 409, { error: '草稿版本已变化或不可编辑' });
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
          const report = workbench.weekly.get(reportId);
          return report ? json(res, 200, { report }) : json(res, 404, { error: 'weekly report not found' });
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
      if (req.method === 'GET' && path === '/api/config/mcp') {
        return json(res, 200, {
          servers: loadMcpServers(),
          failures: [...runtime.mcp.failures.entries()],
        });
      }
      if (req.method === 'PUT' && path === '/api/config/mcp') {
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
        });
      }
      if (req.method === 'PUT' && path === '/api/config/llm') {
        const body = await readBody(req);
        if (!body.provider || !body.model) return json(res, 400, { error: 'provider 与 model 必填' });
        const provider = String(body.provider);
        const model = String(body.model);
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : '';
        // custom: the endpoint URL is part of the identity; everything else
        // must not carry one.
        if (provider === CUSTOM_PROVIDER_ID) {
          if (!baseUrl) return json(res, 400, { error: '自定义服务商必须填写 Base URL' });
          if (!/^https?:\/\//i.test(baseUrl)) return json(res, 400, { error: 'Base URL 必须以 http(s):// 开头' });
        } else if (baseUrl) {
          return json(res, 400, { error: '只有自定义服务商支持 Base URL' });
        }
        try {
          const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey : undefined;
          // Verify a custom endpoint with a real streaming request before it
          // can be saved; a saved-but-broken config would break every session.
          if (provider === CUSTOM_PROVIDER_ID) {
            const savedKey = apiKey ?? (runtime.llm.provider === CUSTOM_PROVIDER_ID ? runtime.llm.apiKey : undefined);
            if (!savedKey) return json(res, 400, { error: '自定义端点缺少 API Key（新配置必填；旧配置未保存过 key）' });
            await testCustomEndpoint({ baseUrl, model, apiKey: savedKey });
          }
          runtime.setLlm({
            provider,
            model,
            apiKey,
            apiKeyEnv: runtime.llm.apiKeyEnv,
            ...(baseUrl ? { baseUrl } : {}),
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
        });
      }

      // ── Search (web intelligence) configuration ──
      if (req.method === 'GET' && path === '/api/config/search') {
        return json(res, 200, searchConfigStatus(loadSearchConfig()));
      }
      if (req.method === 'PUT' && path === '/api/config/search') {
        const body = await readBody(req);
        const current = loadSearchConfig();
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey : current.apiKey;
        const maxResults = body.maxResults == null ? current.maxResults : Math.min(10, Math.max(1, Number(body.maxResults) || 5));
        const keylessFallback = body.keylessFallback == null ? current.keylessFallback : body.keylessFallback !== false;
        saveSearchConfig({ provider: 'tavily', apiKey: apiKey && apiKey.trim() ? apiKey.trim() : undefined, maxResults, keylessFallback });
        return json(res, 200, { ok: true, ...searchConfigStatus(loadSearchConfig()) });
      }

      // ── records ──
      if (req.method === 'GET' && path === '/api/records') {
        const sorted = [...store.records].sort((a, b) => b.createdAt - a.createdAt);
        return json(res, 200, { records: sorted });
      }

      // ── session list ──
      // 会话列表默认剔除已归档；include=archived 返回全量（网页已归档区与 CLI --all 诊断口）。
      if (req.method === 'GET' && path === '/api/sessions') {
        const sessions = store.listSessions();
        const visible = url.searchParams.get('include') === 'archived'
          ? sessions
          : sessions.filter((s) => s.archived !== true);
        return json(res, 200, { sessions: visible });
      }

      // ── create session ──
      if (req.method === 'POST' && path === '/api/sessions') {
        const body = await readBody(req);
        const customerId = typeof body.customerId === 'string' ? body.customerId : '';
        const boundCustomer = customerId ? workbench.db.getCustomer(customerId) : undefined;
        if (customerId && !boundCustomer) return json(res, 404, { error: 'customer not found' });
        const identities = boundCustomer ? workbench.db.listIdentities(boundCustomer.id) : [];
        const option = identities.find((item) => item.system === 'ones_customer_option' && item.status === 'confirmed');
        const manhour = boundCustomer
          ? workbench.db.findCustomerManhourIssue(boundCustomer.id)
          : undefined;
        const customerContext: CustomerContext | null = boundCustomer ? {
          customer_name: boundCustomer.name,
          crm_customer_id: boundCustomer.id,
          ones_project: 'CSM 客户工作项',
          ones_customer_option_id: option?.external_id ? String(option.external_id) : undefined,
          customer_manhour_issue_id: manhour?.externalId,
          industry: boundCustomer.industry ?? undefined,
          usage_version: boundCustomer.usageVersion ?? undefined,
          health: boundCustomer.health,
          renewal_status: boundCustomer.renewalDate ?? undefined,
          summary: boundCustomer.nextAction ?? undefined,
        } : null;
        const now = Date.now();
        const session: Session = {
          id: randomUUID(),
          agent: null as unknown as AgentSession,
          events: [],
          clients: new Set(),
          pending: null,
          busy: false,
          title: boundCustomer ? `${boundCustomer.name} · Agent 草稿` : '新对话',
          createdAt: now,
          updatedAt: now,
          lastRecordId: null,
          customer: customerContext,
          archived: false,
        };
        session.agent = makeAgent(session);
        sessions.set(session.id, session);
        persist(session);
        return json(res, 200, { id: session.id, customer: customerContext, mcpFailures: [...runtime.mcp.failures.entries()] });
      }

      // ── per-session routes ──
      const match = path.match(/^\/api\/sessions\/([0-9a-f-]+)(\/.*)?$/);
      const session = match ? sessions.get(match[1]) : undefined;
      if (match && !session) return json(res, 404, { error: 'session not found' });
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

        // send a message
        if (req.method === 'POST' && sub === '/messages') {
          if (session.busy) return json(res, 409, { error: '已有进行中的请求' });
          if (session.archived) return json(res, 409, { error: '会话已归档，请先恢复' });
          const body = await readBody(req);
          const text = String(body.message ?? '').trim();
          if (!text) return json(res, 400, { error: 'message is required' });

          if (session.title === '新对话' && session.events.filter((e) => e.event.type === 'user').length === 0) {
            session.title = text.slice(0, 30);
          }

          session.busy = true;
          broadcast(session, { type: 'user', text });
          broadcast(session, { type: 'turn_start' });

          void (async () => {
            try {
              await session.agent.send(text, {
                onEvent: (e) => {
                  // Record state machine (local留痕; does not affect CRM/ONES)
                  if (e.type === 'confirm' && e.draft) {
                    const rec = makeRecordFromDraft(e.draft, session.id, randomUUID(), Date.now());
                    store.records.push(rec);
                    store.persistRecords();
                    session.lastRecordId = rec.id;
                  } else if (e.type === 'tool_result' && e.name && e.name !== 'confirm_write') {
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
                  broadcast(session, e as unknown as DisplayEvent);
                },
                requestConfirm: (draft) =>
                  new Promise<boolean | ConfirmDraft>((resolve) => {
                    session.pending = { draft, resolve };
                  }),
              });
            } catch (err) {
              broadcast(session, { type: 'text', text: `运行出错: ${(err as Error).message}` });
            } finally {
              session.pending = null;
              session.busy = false;
              broadcast(session, { type: 'turn_end' });
            }
          })();

          return json(res, 202, { ok: true });
        }

        // confirm / reject a pending draft
        if (req.method === 'POST' && sub === '/confirm') {
          if (!session.pending) return json(res, 409, { error: 'no pending confirmation' });
          const body = await readBody(req);
          const ok = body.approve === true;
          let approvedDraft: ConfirmDraft | null = null;
          if (ok) {
            approvedDraft = body.draft ? editedDraft(session.pending.draft, body.draft) : session.pending.draft;
            if (!approvedDraft) return json(res, 400, { error: '编辑后的草稿无效，目标系统和目标工具不可修改' });
            const target = runtime.mcp.resolve(approvedDraft.target_tool);
            if (!target || !runtime.mcp.isWrite(target.server, target.rawName)) {
              return json(res, 400, { error: '目标工具不是已连接的写工具' });
            }
            const bindingError = validateCustomerBoundDraft(approvedDraft, session.customer);
            if (bindingError) return json(res, 400, { error: bindingError });
            // ONES 工作项批准门：规格表字段（所属产品/所属模块/实例部署类型等）必须齐备，批准即写入，
            // 缺失会到 ONES 端才报错。agent 无法从 get_issue_fields 自行枚举选项（大选项集截断），必须用本地工具补齐。
            const specMissing = missingOnesDeskSpecFields(approvedDraft.record_type,
              Array.isArray(approvedDraft.target_arguments.fieldValues) ? approvedDraft.target_arguments.fieldValues as Array<Record<string, unknown>> : []);
            if (specMissing.length) {
              return json(res, 400, { error: `ONES 工作项缺少必填字段: ${specMissing.map((spec) => `${spec.label}(${spec.uuid})`).join('、')}（请调用 get_ones_desk_required_fields 获取选项 UUID 补齐后重新 confirm_write）` });
            }
            // 实例部署类型以 CRM 使用版本为唯一依据（公有云版→公有云，其余→私有云），与 Hemory 自动草稿同一规则。
            if (approvedDraft.record_type === 'suggestion' || approvedDraft.record_type === 'ticket') {
              const expected = applyDeploymentTypeOverride(approvedDraft.record_type as 'suggestion' | 'ticket', session.customer?.usage_version)[0];
              const actual = (Array.isArray(approvedDraft.target_arguments.fieldValues)
                ? approvedDraft.target_arguments.fieldValues as Array<Record<string, unknown>> : [])
                .find((value) => value.fieldID === ONES_DESK_DEPLOYMENT_FIELD_ID);
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
  // Preserve useful customer identities from pre-SQLite output records.
  for (const record of store.records) {
    const fields = record.fields ?? {};
    const id = typeof fields.customer_id === 'string' && fields.customer_id ? fields.customer_id : '';
    const name = typeof fields.customer_name === 'string' && fields.customer_name ? fields.customer_name : record.customer;
    if (id && name) db.upsertCustomer({ id, name, source: { legacyRecordId: record.id } });
  }
  // 闭包延迟引用 sync（下方才声明）：resumePending 在启动 5s 后才运行，届时 sync 必已赋值。
  const drafts = new HemoryDraftService(db, runtime.mcp, runtime, (customerId: string) => sync.syncOnesForCustomer(customerId));
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
  sync = new PortfolioSyncService(db, runtime.mcp, (recording) => hemorySegments.segmentRecordingDetailed(recording));
  const cases = new CaseService(db, runtime.mcp);
  const wiki = new WikiService(runtime.mcp);
  // 工时注入：读已同步的工时登记（payload 缓存优先），生成路径不打实时 MCP。
  const weekly = new WeeklyReportService(db, runtime.mcp, runtime, async (customerId: string) => {
    const data = await sync.listCustomerWorkhours(customerId);
    return { records: data.records.map((record) => ({ startTime: record.startTime, hours: record.hours, description: record.description, owner: record.owner?.name ?? undefined })) };
  });
  const wecom = new WecomTodoService(db);
  const stopPortfolio = schedulePortfolioSync(sync);
  const stopHemory = scheduleHemorySync(sync, db);
  const stopWecom = scheduleWecomSync(wecom);
  const resumeTimer = setTimeout(() => {
    hemorySegments.resumePending();
    drafts.resumePending();
    weekly.resumePending();
  }, 5_000);
  resumeTimer.unref();
  const server = http.createServer(buildHandler(runtime, store, { db, sync, cases, wecom, drafts, weekly, wiki }));
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
    stopWecom();
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
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
