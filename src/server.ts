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
import { Store, makeRecordFromDraft, dataDir, type RecordEntry } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

interface PendingConfirm {
  draft: ConfirmDraft;
  resolve: (ok: boolean) => void;
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
    req.on('data', (chunk) => (raw += chunk));
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

function buildHandler(runtime: Runtime, store: Store): http.RequestListener {
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
      if (req.method === 'GET' && (path === '/app.js' || path === '/style.css')) {
        const file = path === '/app.js' ? 'app.js' : 'style.css';
        const type = path === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
        res.writeHead(200, { 'Content-Type': type });
        return res.end(await readFile(join(publicDir, file), 'utf8'));
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
        await runtime.reload(servers);
        return json(res, 200, {
          ok: true,
          servers: loadMcpServers(),
          failures: [...runtime.mcp.failures.entries()],
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
        const now = Date.now();
        const session: Session = {
          id: randomUUID(),
          agent: null as unknown as AgentSession,
          events: [],
          clients: new Set(),
          pending: null,
          busy: false,
          title: '新对话',
          createdAt: now,
          updatedAt: now,
          lastRecordId: null,
          customer: null,
        };
        session.agent = makeAgent(session);
        sessions.set(session.id, session);
        persist(session);
        return json(res, 200, { id: session.id, mcpFailures: [...runtime.mcp.failures.entries()] });
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
                  new Promise<boolean>((resolve) => {
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
          session.pending.resolve(ok);
          session.pending = null;

          const rec = session.lastRecordId
            ? store.records.find((r) => r.id === session.lastRecordId)
            : undefined;
          if (rec) {
            rec.status = ok ? 'approved' : 'rejected';
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
  const server = http.createServer(buildHandler(runtime, store));
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
