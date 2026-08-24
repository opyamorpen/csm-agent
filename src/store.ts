import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ConfirmDraft } from './tools/confirm.js';

export type RecordStatus = 'draft' | 'approved' | 'written' | 'rejected';

export interface RecordEntry {
  id: string;
  sessionId: string;
  type: string; // followup | profile | case
  title: string;
  customer: string;
  target: string; // crm | ones
  status: RecordStatus;
  fields: Record<string, unknown>;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
  events: Array<{ seq: number; event: unknown }>;
}

/** Default data home for sessions + records. Override with CSM_DATA_DIR. */
export function dataDir(): string {
  return process.env.CSM_DATA_DIR ?? join(homedir(), '.csm-agent');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export class Store {
  readonly sessionsDir: string;
  readonly recordsFile: string;
  records: RecordEntry[];

  constructor(readonly dir: string) {
    this.sessionsDir = join(dir, 'sessions');
    this.recordsFile = join(dir, 'records.json');
    mkdirSync(this.sessionsDir, { recursive: true });
    this.records = this.loadRecords();
  }

  private loadRecords(): RecordEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.recordsFile, 'utf8'));
      return Array.isArray(raw?.records) ? (raw.records as RecordEntry[]) : [];
    } catch {
      return [];
    }
  }

  persistRecords(): void {
    atomicWrite(this.recordsFile, JSON.stringify({ records: this.records }, null, 2));
  }

  listSessions(): SessionMeta[] {
    try {
      return readdirSync(this.sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const s = this.loadSession(f.replace(/\.json$/, ''));
          return s ? { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt } : null;
        })
        .filter((s): s is SessionMeta => s !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  loadSession(id: string): StoredSession | undefined {
    try {
      return JSON.parse(readFileSync(join(this.sessionsDir, `${id}.json`), 'utf8')) as StoredSession;
    } catch {
      return undefined;
    }
  }

  saveSession(s: StoredSession): void {
    atomicWrite(join(this.sessionsDir, `${s.id}.json`), JSON.stringify(s, null, 2));
  }

  deleteSession(id: string): void {
    try {
      unlinkSync(join(this.sessionsDir, `${id}.json`));
    } catch {
      /* ignore */
    }
  }

  exists(id: string): boolean {
    return existsSync(join(this.sessionsDir, `${id}.json`));
  }
}

/** Extract a customer label from a confirm draft's fields. */
export function customerOf(draft: ConfirmDraft): string {
  const f = draft?.fields;
  if (!f || typeof f !== 'object') return '';
  const name = (f as Record<string, unknown>).customer_name;
  const id = (f as Record<string, unknown>).customer_id;
  return typeof name === 'string' && name ? name : typeof id === 'string' ? id : '';
}

/** Build a RecordEntry from a confirm_write draft. */
export function makeRecordFromDraft(draft: ConfirmDraft, sessionId: string, id: string, now: number): RecordEntry {
  return {
    id,
    sessionId,
    type: typeof draft.record_type === 'string' ? draft.record_type : '',
    title: typeof draft.title === 'string' ? draft.title : '(无标题)',
    customer: customerOf(draft),
    target: typeof draft.target_system === 'string' ? draft.target_system : '',
    status: 'draft',
    fields: (draft.fields ?? {}) as Record<string, unknown>,
    createdAt: now,
    updatedAt: now,
  };
}
