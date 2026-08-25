import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Runtime } from './bootstrap.js';
import { loadMcpServers, saveMcpServers, type McpServerConfig } from './config.js';
import { AgentSession, type AgentEvent } from './agent.js';
import type { ConfirmDraft } from './tools/confirm.js';
import { CUSTOMER_CONTEXT_TOOL_NAME, mergeCustomerContext, extractCustomerContext, type CustomerContext } from './tools/customer.js';
import { Store, customerOf, makeRecordFromDraft, dataDir, type RecordEntry } from './store.js';
import { WorkbenchDatabase } from './workbench/database.js';
import { PortfolioSyncService, scheduleHemorySync, schedulePortfolioSync } from './workbench/sync.js';
import { CaseService } from './workbench/cases.js';
import { WecomTodoService, scheduleWecomSync } from './workbench/wecom.js';
import { HemoryDraftService } from './workbench/drafts.js';
import { HemorySegmentationService } from './workbench/hemory.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

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
}

function buildHandler(runtime: Runtime, store: Store, workbench: WorkbenchServices): http.RequestListener {
  const sessions = new Map<string, Session>();

  function makeAgent(session: Session): AgentSession {
    return new AgentSession({
      models: runtime.models,
      model: runtime.model,
      mcp: runtime.mcp,
      tools: runtime.tools,
      systemPrompt: runtime.systemPrompt,
      localTools: {
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
      if (req.method === 'GET' && ['/app.js', '/style.css', '/app-icon.svg', '/wecom-todo.html', '/wecom-todo.js'].includes(path)) {
        const file = path.slice(1);
        const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8'
          : path.endsWith('.svg') ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8';
        res.writeHead(200, { 'Content-Type': type });
        return res.end(await readFile(join(publicDir, file), 'utf8'));
      }

      // ── customer-centered workbench ──
      if (req.method === 'GET' && path === '/api/customers') {
        return json(res, 200, { customers: workbench.db.listCustomers(url.searchParams.get('q') ?? '') });
      }
      if (req.method === 'POST' && path === '/api/sync') {
        return json(res, 202, workbench.sync.refreshAll());
      }
      if (req.method === 'POST' && path === '/api/hemory/sync') {
        const body = await readBody(req);
        return json(res, 202, workbench.sync.refreshHemoryDate(typeof body.date === 'string' ? body.date : undefined));
      }
      if (req.method === 'GET' && path === '/api/hemory/fragments') {
        const fragments = workbench.db.listHemoryFragments({ status: url.searchParams.get('status') ?? 'pending',
          date: url.searchParams.get('date') ?? undefined, recordingId: url.searchParams.get('recording_id') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 100) });
        return json(res, 200, { fragments, nextCursor: fragments.at(-1)?.occurredAt ?? null });
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
          const jobs = [...byCustomer].flatMap(([id, ids]) => {
            const job = workbench.drafts.enqueue(id, ids);
            return job ? [job] : [];
          });
          return json(res, 200, { events, jobs });
        } catch (error) {
          return json(res, 409, { error: (error as Error).message });
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
        if (req.method === 'POST' && sub === '/refresh') {
          if (!workbench.db.getCustomer(customerId)) return json(res, 404, { error: 'customer not found' });
          return json(res, 202, workbench.sync.refreshCustomer(customerId));
        }
      }

      if (req.method === 'GET' && path === '/api/action-items') {
        return json(res, 200, { actions: workbench.db.listActions(url.searchParams.get('customer_id') ?? undefined) });
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
        return json(res, 200, { batches: workbench.db.listDraftBatches(url.searchParams.get('customer_id') ?? undefined) });
      }
      const draftBatchMatch = path.match(/^\/api\/draft-batches\/([0-9a-f-]+)(\/.*)?$/);
      if (draftBatchMatch) {
        const batchId = draftBatchMatch[1];
        const sub = draftBatchMatch[2] ?? '';
        if (req.method === 'GET' && sub === '') {
          const batch = workbench.db.getDraftBatch(batchId);
          return batch ? json(res, 200, batch) : json(res, 404, { error: 'draft batch not found' });
        }
        if (req.method === 'POST' && sub === '/preview') {
          const body = await readBody(req);
          try { return json(res, 200, await workbench.drafts.preview(batchId, Array.isArray(body.itemIds) ? body.itemIds.map(String) : [])); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
        }
        if (req.method === 'POST' && sub === '/confirm') {
          const body = await readBody(req);
          try { return json(res, 200, await workbench.drafts.confirm(batchId, Array.isArray(body.items) ? body.items : [])); }
          catch (error) { return json(res, 400, { error: (error as Error).message }); }
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
          return item ? json(res, 200, item) : json(res, 409, { error: '草稿版本已变化或不可编辑' });
        }
        if (req.method === 'POST' && sub === '/retry') {
          try { return json(res, 200, await workbench.drafts.retry(itemId)); }
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
          apiKeyEnv: runtime.llm.apiKeyEnv,
          apiKeyConfigured: !!runtime.llm.apiKey,
        });
      }
      if (req.method === 'PUT' && path === '/api/config/llm') {
        const body = await readBody(req);
        if (!body.provider || !body.model) return json(res, 400, { error: 'provider 与 model 必填' });
        try {
          runtime.setLlm({
            provider: String(body.provider),
            model: String(body.model),
            apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey : undefined,
            apiKeyEnv: runtime.llm.apiKeyEnv,
          });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        return json(res, 200, {
          ok: true,
          provider: runtime.llm.provider,
          model: runtime.llm.model,
          apiKeyConfigured: !!runtime.llm.apiKey,
        });
      }

      // ── records ──
      if (req.method === 'GET' && path === '/api/records') {
        const sorted = [...store.records].sort((a, b) => b.createdAt - a.createdAt);
        return json(res, 200, { records: sorted });
      }

      // ── session list ──
      if (req.method === 'GET' && path === '/api/sessions') {
        return json(res, 200, { sessions: store.listSessions() });
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
          ? workbench.db.listTimeline(boundCustomer.id, 500).find((item) => item.sourceSystem === 'ones' && item.sourceType === 'customer_manhour')
          : undefined;
        const customerContext: CustomerContext | null = boundCustomer ? {
          customer_name: boundCustomer.name,
          crm_customer_id: boundCustomer.id,
          ones_project: 'CSM 客户工作项',
          ones_customer_option_id: option?.external_id ? String(option.external_id) : undefined,
          customer_manhour_issue_id: manhour?.externalId,
          industry: boundCustomer.industry ?? undefined,
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

        // rename
        if (req.method === 'PATCH' && sub === '') {
          const body = await readBody(req);
          const title = String(body.title ?? '').trim();
          if (!title) return json(res, 400, { error: 'title is required' });
          session.title = title.slice(0, 80);
          session.updatedAt = Date.now();
          persist(session);
          return json(res, 200, { ok: true, title: session.title });
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
  const drafts = new HemoryDraftService(db, runtime.mcp, runtime);
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
  sync = new PortfolioSyncService(db, runtime.mcp, (recording) => hemorySegments.segmentRecording(recording));
  const cases = new CaseService(db, runtime.mcp);
  const wecom = new WecomTodoService(db);
  const stopPortfolio = schedulePortfolioSync(sync);
  const stopHemory = scheduleHemorySync(sync, db);
  const stopWecom = scheduleWecomSync(wecom);
  const resumeTimer = setTimeout(() => {
    hemorySegments.resumePending();
    drafts.resumePending();
  }, 5_000);
  resumeTimer.unref();
  const server = http.createServer(buildHandler(runtime, store, { db, sync, cases, wecom, drafts }));
  server.on('close', () => {
    stopPortfolio();
    stopHemory();
    stopWecom();
    clearTimeout(resumeTimer);
    db.close();
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
