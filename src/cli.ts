#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { ConfirmDraft } from './tools/confirm.js';
import { installService, readServiceLogs, restartService, serviceStatus, uninstallService } from './service.js';

const baseUrl = (process.env.CSM_BASE_URL ?? `http://127.0.0.1:${process.env.CSM_PORT ?? 3210}`).replace(/\/$/, '');
const rawArgs = process.argv.slice(2);
const jsonOutput = rawArgs.includes('--json');
const args = rawArgs.filter((arg) => arg !== '--json');

interface CustomerSummary {
  id: string;
  name: string;
  shortName?: string | null;
  csmName?: string | null;
  afterSalesStage?: string | null;
  health: string;
  renewalDate?: string | null;
  contractValue?: number | null;
  supportOpenCount?: number | null;
  supportBlockedCount?: number | null;
}

const ONES_WORK_ITEM_TYPES = new Set(['suggestion_feedback', 'support_ticket', 'operations_ticket']);

function nestedSourceValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  return String(record.name ?? record.value ?? record.label ?? '');
}

function onesWorkItemRow(event: any): { id: string; title: string; status: string; createdAt: string } {
  return {
    id: event.displayId ?? 'unknown',
    title: event.title ?? '',
    status: nestedSourceValue(event.payload?.field005) || 'unknown',
    createdAt: event.payload?.field009 || event.occurredAt || 'unknown',
  };
}

const CLI_CAPABILITIES = [
  { command: 'serve', workflow: 'service', access: 'local', api: [] },
  { command: 'doctor', workflow: 'diagnostics', access: 'read', api: ['/api/customers', '/api/config/llm', '/api/wecom/status'] },
  { command: 'customers', workflow: 'customer-portfolio', access: 'read', api: ['/api/customers'], sorts: ['default', 'renewal_date', 'renewal_amount'] },
  { command: 'customer', workflow: 'customer-overview', access: 'read', api: ['/api/customers/:id/overview'] },
  { command: 'timeline', workflow: 'customer-timeline', access: 'read', api: ['/api/customers/:id/timeline'] },
  { command: 'workhours', workflow: 'customer-workhours', access: 'read', api: ['/api/customers/:id/workhours'] },
  { command: 'action', workflow: 'action-items', access: 'read-write', api: ['/api/action-items', '/api/action-items/:id', '/api/action-items/:id/complete', '/api/action-items/:id/wecom-todo-intents'] },
  { command: 'case', workflow: 'case-drafts', access: 'approved-write', api: ['/api/case-drafts', '/api/case-drafts/:id', '/api/case-drafts/:id/publish-preview', '/api/case-drafts/:id/publish'] },
  { command: 'sync', workflow: 'source-sync', access: 'write', api: ['/api/sync', '/api/customers/:id/refresh', '/api/sync-runs/:id'] },
  { command: 'hemory', workflow: 'hemory-attribution', access: 'read-write', api: ['/api/hemory/sync', '/api/hemory/resegment', '/api/hemory/fragments', '/api/hemory/fragments/attribution', '/api/hemory/fragments/ignore'] },
  { command: 'drafts', workflow: 'hemory-drafts', access: 'read', api: ['/api/draft-batches', '/api/draft-batches?include=written'] },
  { command: 'draft', workflow: 'hemory-drafts', access: 'approved-write', api: ['/api/draft-batches', '/api/draft-items/:id', '/api/draft-batches/:id/preview', '/api/draft-batches/:id/confirm', '/api/draft-batches/:id/regenerate', '/api/draft-items/:id/retry'] },
  { command: 'service', workflow: 'macos-service', access: 'local', api: [] },
  { command: 'wecom', workflow: 'wecom-todo', access: 'read', api: ['/api/wecom/status'] },
  { command: 'agent', workflow: 'customer-agent', access: 'approved-write', api: ['/api/sessions', '/api/sessions/:id/events', '/api/sessions/:id/messages', '/api/sessions/:id/confirm'] },
  { command: 'api', workflow: 'api-fallback', access: 'read-write', api: ['/api/*'] },
] as const;

async function request<T = any>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, options);
  } catch (error) {
    throw new Error(`无法连接 ${baseUrl}；请先运行 npm run dev。${(error as Error).message}`);
  }
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

async function customers(query = '', sort: 'default' | 'renewal_date' | 'renewal_amount' = 'default'): Promise<CustomerSummary[]> {
  const body = await request<{ customers: CustomerSummary[] }>(`/api/customers?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}`);
  return body.customers ?? [];
}

async function resolveCustomer(input: string): Promise<CustomerSummary> {
  if (!input) throw new Error('缺少客户 ID 或名称');
  const all = await customers();
  const exact = all.filter((customer) => customer.id === input || customer.name === input || customer.shortName === input);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`客户不唯一: ${exact.map((item) => `${item.name}(${item.id})`).join(', ')}`);
  const candidates = all.filter((customer) => customer.name.includes(input) || customer.shortName?.includes(input));
  if (candidates.length === 1) return candidates[0];
  throw new Error(candidates.length ? `请使用客户 ID；候选: ${candidates.slice(0, 10).map((item) => `${item.name}(${item.id})`).join(', ')}` : '未找到客户');
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function help(): void {
  console.log(`CSM Agent 调试 CLI

用法:
  csm-agent serve [端口]
  csm-agent doctor
  csm-agent customers [搜索词] [--sort default|renewal_date|renewal_amount] [--json]
  csm-agent customer <客户ID或名称> [--json]
  csm-agent timeline <客户ID或名称> [sourceType] [--json]
  csm-agent workhours <客户ID或名称> [--json]
  csm-agent actions [客户ID或名称] [--json]
  csm-agent action update <行动ID> <JSON>
  csm-agent action complete <行动ID> [实际结果]
  csm-agent action wecom <行动ID>
  csm-agent cases [客户ID或名称] [--json]
  csm-agent case generate <客户ID或名称>
  csm-agent case update <草稿ID> <版本> <JSON>
  csm-agent case preview <草稿ID> [ONES父页面ID]
  csm-agent case publish <草稿ID> <版本> <ONES父页面ID> <批准哈希>
  csm-agent sync [客户ID或名称]
  csm-agent hemory sync [YYYY-MM-DD]
  csm-agent hemory resegment --all
  csm-agent hemory inbox [YYYY-MM-DD] [--days N] [--json]
  csm-agent hemory assign <客户ID或名称> <片段ID...>
  csm-agent hemory clear <片段ID...>
  csm-agent hemory ignore <片段ID...>
  csm-agent drafts [客户ID或名称] [--all] [--json]
  csm-agent draft review <批次ID>
  csm-agent draft retry <草稿ID>
  csm-agent draft regenerate <批次ID>
  csm-agent service install [端口]
  csm-agent service status|restart|uninstall|logs
  csm-agent wecom
  csm-agent agent <客户ID或名称> <指令>
  csm-agent api <GET|POST|PATCH|PUT|DELETE> </api/path> [JSON]
  csm-agent capabilities [--json]
  csm-agent version

仓库内可用 npm run cli -- <命令> 获得相同行为。默认连接 ${baseUrl}，可用 CSM_BASE_URL 覆盖。
所有 Agent 写入仍经过服务端客户绑定和人工批准。`);
}

function version(): void {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  console.log(packageJson.version ?? 'unknown');
}

async function serve(portInput?: string): Promise<void> {
  if (portInput) {
    const port = Number(portInput);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 的整数');
    process.env.CSM_PORT = String(port);
  }
  await import('./index.js');
}

async function showCustomers(input: string[]): Promise<void> {
  const values = [...input];
  let sort: 'default' | 'renewal_date' | 'renewal_amount' = 'default';
  const sortIndex = values.findIndex((value) => value === '--sort' || value.startsWith('--sort='));
  if (sortIndex >= 0) {
    const inline = values[sortIndex].startsWith('--sort=');
    const raw = inline ? values[sortIndex].slice('--sort='.length) : values[sortIndex + 1];
    if (raw !== 'default' && raw !== 'renewal_date' && raw !== 'renewal_amount') throw new Error('排序必须是 default、renewal_date 或 renewal_amount');
    sort = raw;
    values.splice(sortIndex, inline ? 1 : 2);
  }
  const list = await customers(values.join(' '), sort);
  if (jsonOutput) return print(list);
  console.table(list.map((customer) => ({
    id: customer.id,
    customer: customer.name,
    csm: customer.csmName ?? 'unknown',
    stage: customer.afterSalesStage ?? 'unknown',
    health: customer.health,
    renewal: customer.renewalDate?.slice(0, 10) ?? 'unknown',
    renewalAmount: customer.contractValue ?? 'unknown',
    openTickets: customer.supportOpenCount ?? 'unknown',
    blocked: customer.supportBlockedCount ?? 'unknown',
  })));
  console.log(`共 ${list.length} 个 CRM CSM 售后客户`);
}

async function showCustomer(input: string): Promise<void> {
  const customer = await resolveCustomer(input);
  const overview = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/overview`);
  if (jsonOutput) return print(overview);
  const counts: Record<string, number> = {};
  for (const event of overview.timeline ?? []) counts[event.sourceType] = (counts[event.sourceType] ?? 0) + 1;
  console.log(`${overview.customer.name} (${overview.customer.id})`);
  console.log(`CSM: ${overview.customer.csmName ?? 'unknown'}  风险: ${overview.risk?.level ?? 'unknown'} / ${overview.risk?.score ?? 'unknown'}  覆盖率: ${overview.risk?.coverage ?? 0}%`);
  console.log(`续约: ${overview.customer.renewalDate ?? 'unknown'}  合同价值: ${overview.customer.contractValue ?? 'unknown'}  最后互动: ${overview.lastInteractionAt ?? overview.customer.lastContactAt ?? 'unknown'}`);
  console.log(`ONES 分类: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
  console.log(`机会假设: ${(overview.opportunities ?? []).length}  行动: ${(overview.actions ?? []).length}  案例草稿: ${(overview.caseDrafts ?? []).length}`);
  console.log('身份映射:');
  console.table((overview.identities ?? []).map((item: any) => ({ system: item.system, externalId: item.external_id, label: item.label, status: item.status })));
}

async function showTimeline(customerInput: string, sourceType?: string): Promise<void> {
  const customer = await resolveCustomer(customerInput);
  const body = await request<{ events: any[] }>(`/api/customers/${encodeURIComponent(customer.id)}/timeline?limit=500`);
  const events = sourceType ? body.events.filter((event) => event.sourceType === sourceType) : body.events;
  if (sourceType && ONES_WORK_ITEM_TYPES.has(sourceType)) {
    const records = events.map(onesWorkItemRow).sort((left, right) => {
      const leftTime = Date.parse(left.createdAt);
      const rightTime = Date.parse(right.createdAt);
      return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime) || right.id.localeCompare(left.id);
    });
    if (jsonOutput) return print(records);
    console.table(records);
    console.log(`共 ${records.length} 条 ONES 工作项，按创建时间倒序`);
    return;
  }
  if (jsonOutput) return print(events);
  console.table(events.map((event) => ({
    occurredAt: event.occurredAt,
    system: event.sourceSystem,
    type: event.sourceType,
    title: String(event.title).slice(0, 80),
    attribution: event.attributionStatus,
    externalId: event.externalId,
  })));
  console.log(`共 ${events.length} 条事件${sourceType ? `，类型 ${sourceType}` : ''}`);
}

async function showWorkhours(customerInput: string): Promise<void> {
  const customer = await resolveCustomer(customerInput);
  const body = await request<{ issueId: string | null; totalHours: number | null; remainingHours: number | null; records: any[] }>(
    `/api/customers/${encodeURIComponent(customer.id)}/workhours`,
  );
  const records = [...(body.records ?? [])].sort((left, right) => {
    const leftTime = Date.parse(left.startTime);
    const rightTime = Date.parse(right.startTime);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime) || String(right.id ?? '').localeCompare(String(left.id ?? ''));
  });
  if (jsonOutput) return print({ ...body, records });
  console.log(`${customer.name} · 已登记总工时 ${body.totalHours == null ? 'unknown' : `${Number(body.totalHours).toFixed(1)} 小时`} · 剩余工时 ${body.remainingHours == null ? 'unknown' : `${Number(body.remainingHours).toFixed(1)} 小时`}`);
  console.table(records.map((record) => ({
    owner: record.owner?.name ?? 'unknown',
    date: record.startTime ?? 'unknown',
    hours: `${Number(record.hours ?? 0).toFixed(1)} 小时`,
    description: record.description || '无描述',
  })));
  console.log(`共 ${records.length} 条工时登记，按工时日期倒序`);
}

async function showActions(customerInput?: string): Promise<void> {
  const customer = customerInput ? await resolveCustomer(customerInput) : null;
  const body = await request<{ actions: any[] }>(`/api/action-items${customer ? `?customer_id=${encodeURIComponent(customer.id)}` : ''}`);
  if (jsonOutput) return print(body.actions);
  console.table(body.actions.map((action) => ({ id: action.id, customerId: action.customerId, status: action.status,
    owner: action.owner ?? 'unknown', dueAt: action.dueAt ?? 'unknown', title: action.title })));
}

async function showCases(customerInput?: string): Promise<void> {
  const customer = customerInput ? await resolveCustomer(customerInput) : null;
  const body = await request<{ drafts: any[] }>(`/api/case-drafts${customer ? `?customer_id=${encodeURIComponent(customer.id)}` : ''}`);
  if (jsonOutput) return print(body.drafts);
  console.table(body.drafts.map((draft) => ({ id: draft.id, customerId: draft.customerId, version: draft.version,
    status: draft.status, title: draft.title, publishedPageId: draft.publishedPageId ?? '' })));
}

function parseObject(input: string, label: string): Record<string, unknown> {
  if (!input) throw new Error(`${label} 缺少 JSON 参数`);
  const value: unknown = JSON.parse(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} JSON 必须是对象`);
  return value as Record<string, unknown>;
}

async function actionCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'list') return showActions(values.join(' ') || undefined);
  const actionId = values.shift() ?? '';
  if (!actionId) throw new Error(`action ${subcommand || '(空)'} 缺少行动 ID`);
  if (subcommand === 'update') {
    const body = parseObject(values.join(' '), 'action update');
    return print(await request(`/api/action-items/${encodeURIComponent(actionId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
  }
  if (subcommand === 'complete') {
    return print(await request(`/api/action-items/${encodeURIComponent(actionId)}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: values.join(' ') }),
    }));
  }
  if (subcommand === 'wecom') {
    return print(await request(`/api/action-items/${encodeURIComponent(actionId)}/wecom-todo-intents`, { method: 'POST' }));
  }
  throw new Error('action 子命令只允许 list/update/complete/wecom');
}

async function caseCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'list') return showCases(values.join(' ') || undefined);
  if (subcommand === 'generate') {
    const customer = await resolveCustomer(values.join(' '));
    return print(await request('/api/case-drafts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: customer.id }),
    }));
  }
  const draftId = values.shift() ?? '';
  if (!draftId) throw new Error(`case ${subcommand || '(空)'} 缺少草稿 ID`);
  if (subcommand === 'update') {
    const version = Number(values.shift());
    if (!Number.isInteger(version) || version < 1) throw new Error('case update 版本必须是正整数');
    const body = parseObject(values.join(' '), 'case update');
    return print(await request(`/api/case-drafts/${encodeURIComponent(draftId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, version }),
    }));
  }
  if (subcommand === 'preview') {
    return print(await request(`/api/case-drafts/${encodeURIComponent(draftId)}/publish-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPageID: values.join(' ') }),
    }));
  }
  if (subcommand === 'publish') {
    const version = Number(values.shift());
    const parentPageID = values.shift() ?? '';
    const approvalHash = values.shift() ?? '';
    if (!Number.isInteger(version) || version < 1) throw new Error('case publish 版本必须是正整数');
    if (!approvalHash) throw new Error('case publish 缺少 publish-preview 返回的批准哈希');
    return print(await request(`/api/case-drafts/${encodeURIComponent(draftId)}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, parentPageID, approvalHash }),
    }));
  }
  throw new Error('case 子命令只允许 list/generate/update/preview/publish');
}

async function rawApi(methodInput: string, path: string, json?: string): Promise<void> {
  const method = methodInput.toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new Error('api method 只允许 GET/POST/PATCH/PUT/DELETE');
  if (!path.startsWith('/api/')) throw new Error('api path 必须以 /api/ 开头');
  const body = json ? JSON.parse(json) : undefined;
  print(await request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function waitSync(id: string, maxAttempts = 600): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const run = await request<any>(`/api/sync-runs/${id}`);
    process.stdout.write(`\r同步 ${run.status} ${JSON.stringify(run.sourceStatus ?? {})}`.slice(0, 180).padEnd(180));
    if (run.status !== 'running') {
      process.stdout.write('\n');
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('等待同步超时，任务仍可能在后台运行');
}

async function sync(input?: string): Promise<void> {
  const run = input
    ? await resolveCustomer(input).then((customer) => request<any>(`/api/customers/${encodeURIComponent(customer.id)}/refresh`, { method: 'POST' }))
    : await request<any>('/api/sync', { method: 'POST' });
  const completed = await waitSync(run.id);
  print(completed);
  if (completed.status === 'failed') process.exitCode = 2;
}

async function hemoryCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'sync') {
    // 不带日期时为滚动增量同步（最近 7 天去重补新）；带日期则同步该上海自然日。
    const run = await request<any>('/api/hemory/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: values.shift() || undefined }) });
    return print(await waitSync(run.id));
  }
  if (subcommand === 'resegment') {
    if (!values.includes('--all')) throw new Error('hemory resegment 需要 --all（全量重切库内全部录音）');
    const run = await request<any>('/api/hemory/resegment', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }) });
    // 逐录音两阶段模型调用耗时较长，等待上限放宽到 60 分钟。
    const completed = await waitSync(run.id, 3600);
    const summary = completed.sourceStatus?.hemory ?? {};
    if (!jsonOutput) {
      console.log(`录音总数 ${summary.recordings ?? '?'}，成功 ${summary.recordings != null ? Number(summary.recordings) - Number(summary.failedRecordings ?? 0) : '?'}，`
        + `失败 ${summary.failedRecordings ?? 0}，新片段 ${summary.count ?? '?'}，丢弃段 ${summary.discardedSegments ?? '?'}。`);
      if (summary.backupPath) console.log(`备份：${summary.backupPath}`);
      console.log('超过 7 个上海自然日的录音，其待归属片段需用 hermory inbox --days=N 或日期过滤查看。');
    }
    print(completed);
    if (completed.status !== 'succeeded') process.exitCode = 2;
    return;
  }
  if (subcommand === 'inbox') {
    const days = values.find((value) => /^--days=\d+$/.test(value));
    const date = values.find((value) => !value.startsWith('--') && /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? '';
    const body = await request<any>(`/api/hemory/fragments?status=pending&limit=500${date ? `&date=${encodeURIComponent(date)}` : ''}${days ? `&days=${days.slice(7)}` : ''}`);
    if (jsonOutput) return print(body.fragments);
    console.table((body.fragments ?? []).map((item: any) => ({ id: item.id, start: item.payload?.startAt ?? item.occurredAt,
      end: item.payload?.endAt ?? item.occurredAt, recording: item.payload?.recordingId, topic: item.payload?.topic ?? item.title,
      part: item.payload?.topicGroupId ? `${item.payload?.topicPartIndex}/${item.payload?.topicPartCount}` : '',
      summary: String(item.payload?.summary ?? '').slice(0, 80), speakers: (item.payload?.speakers ?? []).join(','), status: item.attributionStatus })));
    return;
  }
  if (subcommand === 'assign' || subcommand === 'clear' || subcommand === 'ignore') {
    const customer = subcommand === 'assign' ? await resolveCustomer(values.shift() ?? '') : null;
    const eventIds = values;
    if (!eventIds.length) throw new Error(`hemory ${subcommand} 缺少片段 ID`);
    const all = await request<any>('/api/hemory/fragments?status=all&limit=500');
    const expectedHashes = Object.fromEntries((all.fragments ?? []).filter((item: any) => eventIds.includes(item.id)).map((item: any) => [item.id, item.payloadHash]));
    if (subcommand === 'ignore') {
      return print(await request('/api/hemory/fragments/ignore', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventIds, expectedHashes }) }));
    }
    return print(await request('/api/hemory/fragments/attribution', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventIds, customerId: customer?.id ?? null, expectedHashes }) }));
  }
  throw new Error('hemory 子命令只允许 sync/resegment/inbox/assign/clear/ignore');
}

// 草稿确认视图：与 Web 卡片共用服务端 displayFields，按最小必填项逐行结构化输出。
function printDraftItems(items: any[]): void {
  for (const item of items) {
    console.log(`\n[${item.id}] ${draftTypeLabel(item.type)} ｜ ${item.status} ｜ ${item.title}`);
    if (item.displayFields?.length) for (const field of item.displayFields) console.log(`  ${field.label}: ${field.value}`);
    else console.log(`  摘要: ${item.summary}`);
    if (item.targetObject) console.log(`  目标: ${item.targetObject}${item.targetTool ? ` ｜ ${item.targetTool}` : ''}`);
    if (item.unknowns?.length) console.log(`  待确认: ${item.unknowns.join('、')}`);
    if (item.validationErrors?.length) console.log(`  校验错误: ${item.validationErrors.join('；')}`);
    if (item.error) console.log(`  失败原因: ${item.error}`);
  }
}

function draftTypeLabel(type: string): string {
  return ({ internal_todo: 'Agent 待办', workhour: '工时', followup: '沟通记录', suggestion: '需求', ticket: '工单', operations: '运维工单' } as Record<string, string>)[type] || type;
}

async function showDrafts(rawArgs: string[]): Promise<void> {
  // --all 与草稿箱 Web 端显示契约一致：默认隐藏已写入草稿，--all 恢复全量（诊断/对账用）。
  const includeAll = rawArgs.includes('--all');
  const customerInput = rawArgs.filter((arg) => arg !== '--all').join(' ').trim();
  const customer = customerInput ? await resolveCustomer(customerInput) : null;
  const query = `${customer ? `customer_id=${encodeURIComponent(customer.id)}` : ''}${customer && includeAll ? '&' : ''}${includeAll ? 'include=written' : ''}`;
  const body = await request<any>(`/api/draft-batches${query ? `?${query}` : ''}`);
  if (jsonOutput) return print(body.batches);
  const rows = (body.batches ?? []).flatMap((batch: any) => (batch.items ?? []).map((item: any) => ({ batch: batch.id, id: item.id,
    customerId: item.customerId, type: item.type, status: item.status, version: item.version, target: item.targetObject || '', title: item.title })));
  if (!rows.length) console.log(includeAll ? '没有任何草稿批次' : '没有待处理草稿（csm-agent drafts --all 查看全部）');
  else console.table(rows);
}

async function editBatchItems(batch: any): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-agent-batch-'));
  const path = join(dir, 'draft-batch.json');
  try {
    writeFileSync(path, JSON.stringify({ items: batch.items }, null, 2), 'utf8');
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const result = spawnSync(editor, [path], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`编辑器退出状态 ${result.status}`);
    const edited = JSON.parse(readFileSync(path, 'utf8')) as { items?: any[] };
    const original = new Map((batch.items ?? []).map((item: any) => [item.id, item]));
    for (const item of edited.items ?? []) {
      const before: any = original.get(item.id);
      if (!before || JSON.stringify(item) === JSON.stringify(before)) continue;
      await request(`/api/draft-items/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: before.version, title: item.title, summary: item.summary, fields: item.fields,
          targetTool: item.targetTool, targetArguments: item.targetArguments, unknowns: item.unknowns, validationErrors: item.validationErrors }) });
    }
    return request(`/api/draft-batches/${encodeURIComponent(batch.id)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function reviewDraftBatch(batchId: string): Promise<void> {
  let batch = await request<any>(`/api/draft-batches/${encodeURIComponent(batchId)}`);
  if (jsonOutput) print(batch);
  else {
    console.log(`批次 ${batch.id} ｜ 客户 ${batch.customerId} ｜ ${batch.status} ｜ ${batch.generator}`);
    printDraftItems(batch.items ?? []);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const first = (await rl.question('输入 [e] 编辑，直接回车预览全部可用草稿，其他内容取消: ')).trim().toLowerCase();
    if (first && first !== 'e') return;
    if (first === 'e') batch = await editBatchItems(batch);
    const itemIds = (batch.items ?? []).filter((item: any) => !['written', 'dismissed', 'stale'].includes(item.status)).map((item: any) => item.id);
    const preview = await request<any>(`/api/draft-batches/${encodeURIComponent(batchId)}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds }) });
    if (jsonOutput) print(preview);
    else {
      console.log('\n预览校验结果：');
      for (const item of preview.items ?? []) console.log(`  ${item.id}: ${item.validationErrors?.length ? item.validationErrors.join('；') : '可写入'}`);
    }
    if (preview.items.some((item: any) => item.validationErrors?.length)) throw new Error('存在不可写草稿，请编辑后重新 review');
    const answer = (await rl.question('批准以上草稿逐项写入？[y/N]: ')).trim().toLowerCase();
    if (answer !== 'y') return;
    const confirmed = await request(`/api/draft-batches/${encodeURIComponent(batchId)}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: preview.items.map(({ id, version, approvalHash }: any) => ({ id, version, approvalHash })) }) });
    if (jsonOutput) print(confirmed);
    else printDraftItems((confirmed as any).items ?? []);
  } finally { rl.close(); }
}

async function waitForRegeneratedBatch(customerId: string, fingerprints: string[]): Promise<any | null> {
  for (let i = 0; i < 30; i++) {
    const body = await request<any>(`/api/draft-batches?customer_id=${encodeURIComponent(customerId)}`);
    const batch = (body.batches ?? []).find((item: any) => fingerprints.includes(item.fingerprint));
    if (batch) return batch;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

async function regenerateDraftBatch(batchId: string): Promise<void> {
  const original = await request<any>(`/api/draft-batches/${encodeURIComponent(batchId)}`);
  // 批次已按客户+上海日组织；跨天批次重生成会按天各建一个新批次，逐个等待。
  const { jobs } = await request<any>(`/api/draft-batches/${encodeURIComponent(batchId)}/regenerate`, { method: 'POST' });
  if (jsonOutput) return print({ jobs, supersededBatchId: original.id, customerId: original.customerId });
  console.log(`已提交 ${jobs.length} 个重新生成任务（旧批次 ${original.id} 的未写入草稿已作废），等待新批次生成…`);
  const fingerprints: string[] = jobs.map((job: any) => job.fingerprint);
  const printed = new Set<string>();
  for (const fingerprint of fingerprints) {
    const batch = await waitForRegeneratedBatch(original.customerId, [fingerprint]);
    if (!batch) {
      console.log(`任务 ${fingerprint} 60 秒内未生成新批次，可稍后运行 csm-agent drafts 查看。`);
      continue;
    }
    if (printed.has(batch.id)) continue;
    printed.add(batch.id);
    console.log(`新批次 ${batch.id} 已生成（${batch.items?.length ?? 0} 条草稿）：`);
    console.table((batch.items ?? []).map((item: any) => ({ type: item.type, status: item.status, title: item.title })));
    console.log(`下一步：csm-agent draft review ${batch.id}`);
  }
}

async function draftCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'review') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('draft review 缺少批次 ID');
    return reviewDraftBatch(id);
  }
  if (subcommand === 'retry') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('draft retry 缺少草稿 ID');
    return print(await request(`/api/draft-items/${encodeURIComponent(id)}/retry`, { method: 'POST' }));
  }
  if (subcommand === 'regenerate') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('draft regenerate 缺少批次 ID');
    return regenerateDraftBatch(id);
  }
  throw new Error('draft 子命令只允许 review/retry/regenerate');
}

function serviceCommand(subcommand: string, values: string[]): void {
  if (subcommand === 'install') return print(installService(Number(values.shift() ?? process.env.CSM_PORT ?? 3210)));
  if (subcommand === 'status') return print(serviceStatus());
  if (subcommand === 'restart') return print(restartService());
  if (subcommand === 'uninstall') return print(uninstallService());
  if (subcommand === 'logs') return print(readServiceLogs(Number(values.shift() ?? 100)));
  throw new Error('service 子命令只允许 install/status/restart/uninstall/logs');
}

async function editDraft(draft: ConfirmDraft): Promise<ConfirmDraft> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-agent-draft-'));
  const path = join(dir, 'draft.json');
  try {
    writeFileSync(path, JSON.stringify(draft, null, 2), 'utf8');
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const result = spawnSync(editor, [path], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`编辑器退出状态 ${result.status}`);
    return JSON.parse(readFileSync(path, 'utf8')) as ConfirmDraft;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function confirmDraft(sessionId: string, draft: ConfirmDraft): Promise<void> {
  console.log('\n--- 待确认草稿 ---');
  print(draft);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('批准写入？[y]批准 / [e]编辑后批准 / 其他拒绝: ')).trim().toLowerCase();
    const edited = answer === 'e' ? await editDraft(draft) : draft;
    const approve = answer === 'y' || answer === 'e';
    const result = await request(`/api/sessions/${sessionId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve, draft: approve ? edited : undefined }),
    });
    print(result);
  } finally {
    rl.close();
  }
}

async function streamAgent(sessionId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`);
  if (!response.ok || !response.body) throw new Error(`SSE 连接失败: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = block.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6));
      const event = payload.event ?? {};
      if (event.type === 'text') console.log(`\n[Agent] ${event.text}`);
      else if (event.type === 'tool_call') console.log(`\n[工具调用] ${event.name} ${JSON.stringify(event.arguments)}`);
      else if (event.type === 'tool_result' && event.name !== 'confirm_write') console.log(`[工具结果] ${event.name}: ${String(event.result ?? '').slice(0, 800)}`);
      else if (event.type === 'confirm') await confirmDraft(sessionId, event.draft);
      else if (event.type === 'turn_end') {
        await reader.cancel();
        return;
      }
    }
  }
}

async function runCustomerAgent(customerInput: string, prompt: string): Promise<void> {
  const customer = await resolveCustomer(customerInput);
  const session = await request<any>('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId: customer.id }),
  });
  console.log(`Agent 会话 ${session.id}，已绑定 ${session.customer.customer_name} / CRM ${session.customer.crm_customer_id} / ONES option ${session.customer.ones_customer_option_id ?? 'unknown'}`);
  const stream = streamAgent(session.id);
  await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: prompt }),
  });
  await stream;
}

async function doctor(): Promise<void> {
  const [list, wecom, llm] = await Promise.all([customers(), request('/api/wecom/status'), request('/api/config/llm')]);
  const sample = list[0];
  const overview = sample ? await request<any>(`/api/customers/${encodeURIComponent(sample.id)}/overview`) : null;
  print({ baseUrl, api: 'ok', customers: list.length, sampleCustomer: sample?.id ?? null,
    sampleTimelineEvents: overview?.timeline?.length ?? 0, llm, wecom });
}

async function main(): Promise<void> {
  const command = args.shift() ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'version' || command === '--version' || command === '-v') return version();
  if (command === 'capabilities') return print(CLI_CAPABILITIES);
  if (command === 'serve') return serve(args.shift());
  if (command === 'doctor') return doctor();
  if (command === 'customers') return showCustomers(args);
  if (command === 'customer') return showCustomer(args.join(' '));
  if (command === 'timeline') {
    const customer = args.shift() ?? '';
    return showTimeline(customer, args.shift());
  }
  if (command === 'workhours') return showWorkhours(args.join(' '));
  if (command === 'actions') return showActions(args.join(' ') || undefined);
  if (command === 'action') return actionCommand(args.shift() ?? '', args);
  if (command === 'cases') return showCases(args.join(' ') || undefined);
  if (command === 'case') return caseCommand(args.shift() ?? '', args);
  if (command === 'sync') return sync(args.join(' ') || undefined);
  if (command === 'hemory') return hemoryCommand(args.shift() ?? '', args);
  if (command === 'drafts') return showDrafts(args);
  if (command === 'draft') return draftCommand(args.shift() ?? '', args);
  if (command === 'service') return serviceCommand(args.shift() ?? 'status', args);
  if (command === 'wecom') return print(await request('/api/wecom/status'));
  if (command === 'agent') {
    const customer = args.shift() ?? '';
    const prompt = args.join(' ').trim();
    if (!prompt) throw new Error('agent 命令需要客户和指令');
    return runCustomerAgent(customer, prompt);
  }
  if (command === 'api') return rawApi(args.shift() ?? '', args.shift() ?? '', args.join(' ') || undefined);
  throw new Error(`未知命令: ${command}；运行 npm run cli -- help 查看用法`);
}

main().catch((error) => {
  console.error(`错误: ${(error as Error).message}`);
  process.exitCode = 1;
});
