import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Runtime } from './bootstrap.js';
import { AgentSession, type AgentEvent } from './agent.js';
import type { ConfirmDraft } from './tools/confirm.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

interface PendingConfirm {
  draft: ConfirmDraft;
  resolve: (ok: boolean) => void;
}

interface Session {
  id: string;
  agent: AgentSession;
  events: Array<{ seq: number; event: AgentEvent | { type: 'user'; text: string } | { type: 'turn_start' } }>;
  clients: Set<http.ServerResponse>;
  pending: PendingConfirm | null;
  busy: boolean;
}

type StreamEvent = { seq: number; event: any };

const sessions = new Map<string, Session>();

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

function broadcast(session: Session, event: any): void {
  session.events.push({ seq: session.events.length + 1, event });
  const payload = `data: ${JSON.stringify({ seq: session.events.length, event })}\n\n`;
  for (const client of session.clients) {
    client.write(payload);
  }
}

function buildHandler(runtime: Runtime): http.RequestListener {
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

      // ── create session ──
      if (req.method === 'POST' && path === '/api/sessions') {
        const session: Session = {
          id: randomUUID(),
          agent: new AgentSession(runtime),
          events: [],
          clients: new Set(),
          pending: null,
          busy: false,
        };
        sessions.set(session.id, session);
        return json(res, 200, { id: session.id, mcpFailures: [...runtime.mcp.failures.entries()] });
      }

      const match = path.match(/^\/api\/sessions\/([0-9a-f-]+)(\/.*)?$/);
      const session = match ? sessions.get(match[1]) : undefined;
      if (!session) return json(res, 404, { error: 'session not found' });
      const sub = match![2] ?? '';

      // ── SSE event stream ──
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

      // ── send a message ──
      if (req.method === 'POST' && sub === '/messages') {
        if (session.busy) return json(res, 409, { error: '已有进行中的请求' });
        const body = await readBody(req);
        const text = String(body.message ?? '').trim();
        if (!text) return json(res, 400, { error: 'message is required' });

        session.busy = true;
        broadcast(session, { type: 'user', text });
        broadcast(session, { type: 'turn_start' });

        // Run the turn asynchronously; the HTTP handler returns immediately.
        void (async () => {
          try {
            await session.agent.send(text, {
              onEvent: (e) => broadcast(session, e),
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

      // ── confirm / reject a pending draft ──
      if (req.method === 'POST' && sub === '/confirm') {
        if (!session.pending) return json(res, 409, { error: 'no pending confirmation' });
        const body = await readBody(req);
        const ok = body.approve === true;
        session.pending.resolve(ok);
        session.pending = null;
        return json(res, 200, { ok, decided: ok ? 'approved' : 'rejected' });
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  };
}

export async function startServer(runtime: Runtime, port: number): Promise<http.Server> {
  const server = http.createServer(buildHandler(runtime));
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
