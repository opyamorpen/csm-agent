#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { ConfirmDraft } from './tools/confirm.js';
import { installService, readServiceLogs, restartService, serviceStatus, uninstallService } from './service.js';
import { readBuildInfo } from './version.js';
import { runUpdate } from './update.js';
import { runUninstall } from './uninstall.js';

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
  { command: 'doctor', workflow: 'diagnostics', access: 'read', api: ['/api/customers', '/api/config/llm', '/api/config/search', '/api/wecom/status', '/api/version'] },
  { command: 'config', workflow: 'runtime-config', access: 'write', api: ['/api/config/llm', 'PUT /api/config/llm'] },
  { command: 'customers', workflow: 'customer-portfolio', access: 'read', api: ['/api/customers'], sorts: ['default', 'renewal_date', 'renewal_amount'] },
  { command: 'customer', workflow: 'customer-overview', access: 'read', api: ['/api/customers/:id/overview'] },
  { command: 'timeline', workflow: 'customer-timeline', access: 'read', api: ['/api/customers/:id/timeline'] },
  { command: 'workhours', workflow: 'customer-workhours', access: 'read', api: ['/api/customers/:id/workhours'] },
  { command: 'action', workflow: 'action-items', access: 'read-write', api: ['/api/action-items', '/api/action-items/:id', '/api/action-items/:id/complete', '/api/action-items/:id/wecom-todo-intents', '/api/action-items/bulk-accept', '/api/action-items/bulk-complete'] },
  { command: 'case', workflow: 'case-drafts', access: 'approved-write', api: ['/api/case-drafts', '/api/case-drafts/:id', '/api/case-drafts/:id/publish-preview', '/api/case-drafts/:id/publish'] },
  { command: 'weekly-report', workflow: 'weekly-reports', access: 'approved-write', api: ['/api/customers/:id/weekly-reports', '/api/weekly-reports/:id', '/api/weekly-reports/:id/regenerate', '/api/weekly-reports/:id/publish-preview', '/api/weekly-reports/:id/publish', '/api/draft-jobs'] },
  { command: 'wiki', workflow: 'ones-wiki-browse', access: 'read', api: ['/api/ones-wiki/spaces', '/api/ones-wiki/pages'] },
  { command: 'sync', workflow: 'source-sync', access: 'write', api: ['/api/sync', '/api/customers/:id/refresh', '/api/sync-runs/:id'] },
  { command: 'hemory', workflow: 'hemory-attribution', access: 'read-write', api: ['/api/hemory/sync', '/api/hemory/resegment', '/api/hemory/fragments', '/api/hemory/fragments?customer_id=', '/api/hemory/fragments/attribution', '/api/hemory/fragments/ignore', '/api/hemory/fragments/regenerate'] },
  { command: 'drafts', workflow: 'hemory-drafts', access: 'read', api: ['/api/draft-batches', '/api/draft-batches?include=written', '/api/draft-jobs', '/api/draft-jobs?status=failed&kind=hemory'] },
  { command: 'draft', workflow: 'hemory-drafts', access: 'approved-write', api: ['/api/draft-batches', '/api/draft-items/:id', '/api/draft-batches/:id/preview', '/api/draft-batches/:id/confirm', '/api/draft-batches/:id/regenerate', '/api/draft-batches/:id/dismiss', '/api/draft-items/:id/retry'] },
  { command: 'service', workflow: 'macos-service', access: 'local', api: [] },
  { command: 'update', workflow: 'self-update', access: 'local', api: [] },
  { command: 'uninstall', workflow: 'self-update', access: 'local', api: [] },
  { command: 'ones', workflow: 'ones-desk-fields', access: 'read', api: ['/api/ones-desk-fields', '/api/ones-desk-fields?verify=1'] },
  { command: 'wecom', workflow: 'wecom-todo', access: 'read', api: ['/api/wecom/status'] },
  { command: 'agent', workflow: 'customer-agent', access: 'approved-write', api: ['/api/sessions', '/api/sessions/:id/events', '/api/sessions/:id/messages', '/api/sessions/:id/confirm', '/api/config/search'], tools: ['get_customer_profile', 'get_customer_events', 'get_ones_desk_required_fields', 'web_search', 'record_web_intelligence'] },
  { command: 'sessions', workflow: 'agent-sessions', access: 'read-write', api: ['/api/sessions', '/api/sessions?include=archived', '/api/sessions/:id', '/api/sessions/:id/export'] },
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
    （健康自检，含旧进程探测：服务端构建 vs 本地 dist 构建，stale 会提示重启）
  csm-agent config llm [--json]
  csm-agent config llm set --provider=<id> --model=<id> [--base-url=<url>] [--api-key=<key>]
    （查看/切换大模型；provider=custom 需 --base-url（OpenAI 兼容端点），
     保存时自动发一次真实请求验证连通，失败则不落盘；API Key 只写本地配置文件）
  csm-agent customers [搜索词] [--sort default|renewal_date|renewal_amount] [--json]
  csm-agent customer <客户ID或名称> [--json]
  csm-agent timeline <客户ID或名称> [sourceType] [--json]
  csm-agent workhours <客户ID或名称> [--json]
  csm-agent actions [客户ID或名称] [--json]
  csm-agent action accept <行动ID...>
    （批量接受：仅待处理状态生效，其余跳过；逐项处理互不影响）
  csm-agent action complete <行动ID...> [--outcome <实际结果>]
    （批量完成：仅已接受/进行中状态生效，其余跳过；单项失败不影响其他项；
     --outcome 支持空格或 = 传值，缺省记「CSM 在工作台确认完成」）
  csm-agent action update <行动ID> <JSON>
  csm-agent action wecom <行动ID>
  csm-agent cases [客户ID或名称] [--json]
  csm-agent case generate <客户ID或名称>
  csm-agent case update <草稿ID> <版本> <JSON>
  csm-agent case preview <草稿ID> [ONES父页面ID]
  csm-agent case publish <草稿ID> <版本> <ONES父页面ID> <批准哈希>
  csm-agent weekly-report list <客户ID或名称> [--json]
  csm-agent weekly-report show <周报ID> [--json]
    （四章节内容 + 确定性统计一览；--json 输出完整对象）
  csm-agent weekly-report generate <客户ID或名称> [YYYY-MM-DD] [--force] [--wait]
    （日期为周内任意一天，自动对齐周一；基于该客户本周全部信息生成四章节周报；
     --force 强制重建已存在的周报；--wait 轮询生成任务到终态）
  csm-agent weekly-report update <周报ID> <版本> <JSON>
    （JSON 为四章节 content 对象：summary/accomplishments/next_week_plan/risks）
  csm-agent weekly-report preview <周报ID> [ONES父页面ID]
  csm-agent weekly-report publish <周报ID> <版本> <ONES父页面ID> <批准哈希>
  csm-agent wiki spaces [--json]
  csm-agent wiki pages --space <页面组ID> [--parent <页面ID>] [--json]
    （ONES Wiki 只读浏览：页面组列表与页面树，发布位置可用 csm-agent wiki pages 查 ID）
  csm-agent sync [客户ID或名称]
  csm-agent hemory sync [YYYY-MM-DD]
  csm-agent hemory resegment --all
  csm-agent hemory inbox [YYYY-MM-DD] [--days N] [--from HH:MM] [--to HH:MM]
                        [--customer 客户ID或名称] [--status pending|all|confirmed|ignored] [--json]
    （--from/--to 按上海时区收窄到当天时间段，需与日期同用；--customer 按客户过滤，
     --status 默认 pending，confirmed 查看某客户已归属片段）
  csm-agent hemory assign <客户ID或名称> <片段ID...> [--wait]
    （--wait 轮询触发的草稿生成任务直到完成/失败，默认立即返回任务句柄）
  csm-agent hemory clear <片段ID...>
  csm-agent hemory ignore <片段ID...>
  csm-agent hemory regenerate <片段ID...> [--wait]
    （按天强制重生成：片段决定要重建的「客户+上海日」，各天全部已确认片段参与，
     当天旧草稿作废；--wait 轮询生成任务到终态）
  csm-agent drafts [客户ID或名称] [--all] [--json]
  csm-agent draft review <批次ID>
  csm-agent draft retry <草稿ID>
  csm-agent draft regenerate <批次ID>
  csm-agent draft dismiss <批次ID>
    （忽略批次：未写入草稿软删除为已忽略，已写入项不受影响）
  csm-agent draft jobs [任务ID...]
    （无参列出最近失败的生成任务：客户/日期/片段数/错误；
     带任务 ID 时查询单个任务状态与片段明细）
  csm-agent service install [端口]
  csm-agent service status|restart|uninstall|logs
  csm-agent update
    （自更新：仅限 install.sh 安装的受管目录；git fetch → reset --hard
     origin/main → npm ci → 重建 → 重建桌面 App → 重启常驻服务）
  csm-agent uninstall [--purge] [--yes]
    （卸载：移除 CLI shim、桌面 App 入口、常驻服务与受管目录；
     默认保留 ~/.csm-agent 用户数据，--purge 连同配置/会话/数据库一并删除）
  csm-agent ones fields [--verify] [--json]
    （ONES Desk 建议/工单/运维工单必填字段契约：选项 UUID 表、兜底值、
     实例部署类型规则（CRM 使用版本=公有云版→公有云，其余→私有云）；
     --verify 经 get_issue_fields 实时核对选项 UUID 漂移）
  csm-agent wecom
  csm-agent agent <客户ID或名称> <指令>
    （客户绑定会话；agent 可读本地已同步数据 get_customer_profile/events、
     联网检索 web_search（未配 key 自动走免费匿名通道，可配 Tavily key）、
     落库 record_web_intelligence）
  csm-agent sessions [list] [--all] [--json]
  csm-agent sessions show <会话ID> [--json]
    （导出会话全文：标题、客户绑定、时间范围与完整对话，与网页「分享」同源）
  csm-agent sessions archive|unarchive <会话ID>
    （归档后会话从列表隐藏；--all 或网页「已归档」区可查看并恢复）
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

  /** inlineOption：从 values 中取 `--flag 值` 或 `--flag=值`（值不能以 -- 开头）。 */
  function inlineOptionOf(values: string[], flag: string): string | undefined {
    const index = values.findIndex((value) => value === flag || value.startsWith(`${flag}=`));
    if (index === -1) return undefined;
    const inline = values[index].startsWith(`${flag}=`);
    const raw = inline ? values[index].slice(flag.length + 1) : values[index + 1];
    return raw && !raw.startsWith('--') ? raw : undefined;
  }

  /** 批量操作统一输出：--json 全量；否则逐项表格 + 汇总行（成功/跳过/失败）。 */
  function printActionBulkResult(label: string, body: unknown): void {
    const items = (body as { items?: Array<Record<string, unknown>> }).items ?? [];
    if (jsonOutput) return print(body);
    if (items.length) console.table(items.map((item) => ({ 行动ID: item.id, 标题: item.title ?? '', 结果: item.result, 说明: item.error ?? item.reason ?? '' })));
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.result as string] = (counts[item.result as string] ?? 0) + 1;
    console.log(`${label}：共 ${items.length} 项` + (items.length ? `（${Object.entries(counts).map(([key, value]) => `${value} ${key}`).join('，')}）` : ''));
  }

  async function actionCommand(subcommand: string, values: string[]): Promise<void> {
    if (subcommand === 'list') return showActions(values.join(' ') || undefined);
    if (subcommand === 'accept' || subcommand === 'complete') {
      const positional = values.filter((value) => !value.startsWith('--'));
      if (!positional.length) throw new Error(`action ${subcommand} 缺少行动 ID`);
      const endpoint = subcommand === 'accept' ? '/api/action-items/bulk-accept' : '/api/action-items/bulk-complete';
      const outcome = subcommand === 'accept' ? undefined : inlineOptionOf(values, '--outcome');
      const body: Record<string, unknown> = { ids: positional };
      if (outcome !== undefined) body.outcome = outcome;
      const result = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return printActionBulkResult(subcommand === 'accept' ? '批量接受' : '批量完成', result);
    }
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
    throw new Error('action 子命令只允许 list/update/accept/complete/wecom');
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

function printWeeklyReport(report: any, customerName = ''): void {
  const stats = report.stats ?? {};
  console.log(`${customerName ? `${customerName} · ` : ''}${report.weekStart} ~ ${report.weekEnd} · ${report.status === 'published' ? `已发布(${report.publishedPageId ?? ''})` : `草稿 v${report.version}`} · ${report.generator ?? 'unknown'}`);
  console.log(`统计: 沟通 ${stats.communications ?? 0} 场 · 新增建议 ${stats.newSuggestions ?? 0}(解决 ${stats.resolvedSuggestions ?? 'unknown'}) · 新增工单 ${stats.newTickets ?? 0}(解决 ${stats.resolvedTickets ?? 'unknown'}) · 新增运维 ${stats.newOperations ?? 0}(解决 ${stats.resolvedOperations ?? 'unknown'}) · 工时 ${stats.workhours == null ? 'unknown' : `${Number(stats.workhours).toFixed(1)}h`}`);
  const content = report.content ?? {};
  console.log(`\n一、本周执行摘要\n${content.summary ?? '(空)'}`);
  console.log(`\n二、本周完成情况`);
  for (const item of content.accomplishments ?? []) console.log(`  [${item.category}]${item.date ? ` ${item.date}` : ''} ${item.text}${item.source ? `（${item.source}）` : ''}`);
  console.log(`\n三、下周工作计划`);
  for (const [index, item] of (content.next_week_plan ?? []).entries()) console.log(`  ${index + 1}. ${item.text}${item.source ? `（${item.source}）` : ''}`);
  console.log(`\n四、问题风险与阻塞`);
  for (const item of content.risks ?? []) console.log(`  - ${item.text}${item.source ? `（${item.source}）` : ''}`);
  if ((report.stats?.notes ?? []).length) console.log(`\n口径说明: ${(report.stats.notes).join('；')}`);
}

async function weeklyReportCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'list') {
    const customer = await resolveCustomer(values.join(' '));
    const body = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`);
    if (jsonOutput) return print(body.reports);
    if (!(body.reports ?? []).length) return console.log('该客户尚未生成任何周报');
    console.table((body.reports ?? []).map((report: any) => ({ id: report.id, week: `${report.weekStart} ~ ${report.weekEnd}`,
      status: report.status, version: report.version, generator: report.generator ?? 'unknown' })));
    return;
  }
  if (subcommand === 'generate') {
    const positional = values.filter((value) => !value.startsWith('--'));
    const customer = await resolveCustomer(positional[0] ?? '');
    const weekStart = positional[1] ?? '';
    const result = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekStart: weekStart || undefined, force: values.includes('--force') }),
    });
    if (!jsonOutput) console.log(`周报任务已提交（周 ${result.weekStart}，任务 ${result.jobId ?? '幂等复用已有周报'}）。`);
    if (values.includes('--wait') && result.jobId) {
      const jobs = await waitDraftJobs([result.jobId]);
      printDraftJobSummary(jobs);
      if (jobs.every((job) => job.status === 'succeeded')) {
        const body = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`);
        const report = (body.reports ?? []).find((item: any) => item.weekStart === result.weekStart);
        if (report) printWeeklyReport(report, customer.name);
      }
      return;
    }
    return print(result);
  }
  const reportId = values.shift() ?? '';
  if (!reportId) throw new Error(`weekly-report ${subcommand || '(空)'} 缺少周报 ID`);
  if (subcommand === 'show') {
    const body = await request<any>(`/api/weekly-reports/${encodeURIComponent(reportId)}`);
    if (jsonOutput) return print(body.report);
    return printWeeklyReport(body.report);
  }
  if (subcommand === 'update') {
    const version = Number(values.shift());
    if (!Number.isInteger(version) || version < 1) throw new Error('weekly-report update 版本必须是正整数');
    const body = parseObject(values.join(' '), 'weekly-report update');
    if (typeof body.summary !== 'string') throw new Error('weekly-report update JSON 必须包含 summary 字段');
    return print(await request(`/api/weekly-reports/${encodeURIComponent(reportId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, content: body }),
    }));
  }
  if (subcommand === 'regenerate') {
    const result = await request<any>(`/api/weekly-reports/${encodeURIComponent(reportId)}/regenerate`, { method: 'POST' });
    if (!jsonOutput) console.log(`周报任务已提交（周 ${result.weekStart}，任务 ${result.jobId ?? '无'}）。`);
    return print(result);
  }
  if (subcommand === 'preview') {
    return print(await request(`/api/weekly-reports/${encodeURIComponent(reportId)}/publish-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPageID: values.join(' ') }),
    }));
  }
  if (subcommand === 'publish') {
    const version = Number(values.shift());
    const parentPageID = values.shift() ?? '';
    const approvalHash = values.shift() ?? '';
    if (!Number.isInteger(version) || version < 1) throw new Error('weekly-report publish 版本必须是正整数');
    if (!approvalHash) throw new Error('weekly-report publish 缺少 publish-preview 返回的批准哈希');
    return print(await request(`/api/weekly-reports/${encodeURIComponent(reportId)}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, parentPageID, approvalHash }),
    }));
  }
  throw new Error('weekly-report 子命令只允许 list/show/generate/update/regenerate/preview/publish');
}

async function wikiCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'spaces') {
    const body = await request<any>('/api/ones-wiki/spaces');
    if (jsonOutput) return print(body.spaces);
    console.table((body.spaces ?? []).map((space: any) => ({ id: space.id, name: space.name })));
    return;
  }
  if (subcommand === 'pages') {
    // 与 hemory inbox 的 --customer 同一惯例：支持 `--space 值` 与 `--space=值` 两种写法。
    const inlineOption = (flag: string): string | undefined => {
      const index = values.findIndex((value) => value === flag || value.startsWith(`${flag}=`));
      if (index < 0) return undefined;
      const inline = values[index].startsWith(`${flag}=`);
      const raw = inline ? values[index].slice(flag.length + 1) : values[index + 1];
      return raw && !raw.startsWith('--') ? raw : undefined;
    };
    const space = inlineOption('--space');
    const parent = inlineOption('--parent');
    if (!space) throw new Error('wiki pages 需要 --space=<页面组ID>（可用 csm-agent wiki spaces 查询）');
    const body = await request<any>(`/api/ones-wiki/pages?space_id=${encodeURIComponent(space)}`);
    let pages = body.pages ?? [];
    if (parent) pages = pages.filter((page: any) => page.parentID === parent);
    if (jsonOutput) return print(pages);
    if (!pages.length) return console.log(parent ? '该父页面下没有子页面' : '该页面组没有可见页面');
    console.table(pages.map((page: any) => ({ id: page.id, title: page.title, parentID: page.parentID || '(根)', archived: page.isArchived ? '是' : '' })));
    return;
  }
  throw new Error('wiki 子命令只允许 spaces/pages');
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

// ── config llm：查看/切换大模型（与网页设置页同一 API；custom 保存时同样做连通验证） ──

function flagOf(values: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = values.find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function configCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'llm' && !values.length) {
    const cfg = await request<any>('/api/config/llm');
    return print(cfg);
  }
  if (subcommand === 'llm' && values[0] === 'set') {
    const rest = values.slice(1);
    const provider = flagOf(rest, 'provider');
    const model = flagOf(rest, 'model');
    const baseUrl = flagOf(rest, 'base-url');
    const apiKey = flagOf(rest, 'api-key');
    if (!provider || !model) throw new Error('config llm set 需要 --provider=<id> --model=<id>，可选 --base-url=<url> --api-key=<key>');
    const payload: Record<string, string> = { provider, model };
    if (baseUrl !== undefined) payload.baseUrl = baseUrl;
    if (apiKey !== undefined) payload.apiKey = apiKey;
    const result = await request<any>('/api/config/llm', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return print(result);
  }
  throw new Error('config 子命令只允许 llm / llm set');
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

/** 轮询草稿生成任务到终态（每 2 秒，默认上限 180 秒）；返回最终任务列表。失败任务不创建批次，只能通过任务状态感知。 */
async function waitDraftJobs(jobIds: string[], maxAttempts = 90): Promise<any[]> {
  const pending = new Set(jobIds);
  const finished: any[] = [];
  for (let attempt = 0; attempt < maxAttempts && pending.size; attempt++) {
    const ids = [...pending].join(',');
    const { jobs } = await request<any>(`/api/draft-jobs?ids=${encodeURIComponent(ids)}`);
    const byId = new Map<string, any>((jobs ?? []).map((job: any) => [job.id, job]));
    for (const id of [...pending]) {
      const job = byId.get(id);
      if (!job || job.status === 'succeeded' || job.status === 'failed') {
        pending.delete(id);
        finished.push(job ?? { id, status: 'unknown' });
      }
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (pending.size) throw new Error(`等待草稿生成超时（${pending.size} 个任务仍在后台运行，可稍后运行 csm-agent drafts 查看）`);
  return finished;
}

function printDraftJobSummary(jobs: any[]): void {
  const failed = jobs.filter((job) => job.status === 'failed');
  for (const job of failed) console.log(`草稿生成任务 ${job.id} 失败：${job.error ?? '未知原因'}`);
  if (!failed.length) console.log(`草稿生成完成（${jobs.length} 个任务）。运行 csm-agent drafts 查看新草稿。`);
  if (failed.length) process.exitCode = 2;
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
      console.log('超过 7 个上海自然日的录音，其待归属片段需用 heremory inbox --days=N 或日期过滤查看。');
    }
    print(completed);
    if (completed.status !== 'succeeded') process.exitCode = 2;
    return;
  }
  if (subcommand === 'inbox') {
    const days = values.find((value) => /^--days=\d+$/.test(value));
    const from = values.find((value) => /^--from=\d{2}:\d{2}$/.test(value));
    const to = values.find((value) => /^--to=\d{2}:\d{2}$/.test(value));
    const badTime = values.find((value) => /^--(from|to)=/.test(value) && !/^--(from|to)=\d{2}:\d{2}$/.test(value));
    if (badTime) throw new Error(`时间参数格式应为 HH:MM，例如 --from=14:00（收到: ${badTime}）`);
    // --status/--customer 与 --sort 同一惯例：支持 `--customer 值` 与 `--customer=值` 两种写法。
    const inlineOption = (flag: string): string | undefined => {
      const index = values.findIndex((value) => value === flag || value.startsWith(`${flag}=`));
      if (index < 0) return undefined;
      const inline = values[index].startsWith(`${flag}=`);
      const raw = inline ? values[index].slice(flag.length + 1) : values[index + 1];
      return raw && !raw.startsWith('--') ? raw : undefined;
    };
    const status = inlineOption('--status');
    if (status && !['pending', 'all', 'confirmed', 'ignored'].includes(status)) throw new Error(`--status 只允许 pending/all/confirmed/ignored（收到: ${status}）`);
    const customerOption = inlineOption('--customer');
    const date = values.find((value) => !value.startsWith('--') && /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? '';
    if ((from || to) && !date) throw new Error('--from/--to 时间段过滤需要同时指定日期，例如 csm-agent hemory inbox 2026-08-27 --from=14:00 --to=15:30');
    const customer = customerOption ? await resolveCustomer(customerOption) : null;
    // 闭区间：只填一边时另一边取全天边界；与 Web 界面一致按上海时区组装 since/until。
    const since = from ? `${date}T${from.slice(7)}:00+08:00` : undefined;
    const until = to ? `${date}T${to.slice(5)}:59+08:00` : undefined;
    const query = `/api/hemory/fragments?status=${status ?? 'pending'}&limit=500${customer ? `&customer_id=${encodeURIComponent(customer.id)}` : ''}${date ? `&date=${encodeURIComponent(date)}` : ''}${days ? `&days=${days.slice(7)}` : ''}`
      + `${since ? `&since=${encodeURIComponent(since)}` : ''}${until ? `&until=${encodeURIComponent(until)}` : ''}`;
    const body = await request<any>(query);
    if (jsonOutput) return print(body.fragments);
    const customers = customer ? null : (await request<any>('/api/customers')).customers ?? [];
    console.table((body.fragments ?? []).map((item: any) => ({ id: item.id, start: item.payload?.startAt ?? item.occurredAt,
      end: item.payload?.endAt ?? item.occurredAt, recording: item.payload?.recordingId, topic: item.payload?.topic ?? item.title,
      part: item.payload?.topicGroupId ? `${item.payload?.topicPartIndex}/${item.payload?.topicPartCount}` : '',
      summary: String(item.payload?.summary ?? '').slice(0, 80), speakers: (item.payload?.speakers ?? []).join(','), status: item.attributionStatus,
      customer: customer ? customer.name : customers?.find((c: any) => c.id === item.customerId)?.name ?? '' })));
    return;
  }
  if (subcommand === 'regenerate') {
    const wait = values.includes('--wait');
    const eventIds = values.filter((value) => !value.startsWith('--'));
    if (!eventIds.length) throw new Error('hemory regenerate 缺少片段 ID');
    // 按天强制重生成：选中片段决定要重建的「客户+上海日」，各天全量已确认片段参与；旧批次作废、已写入 CRM 的不受影响。
    const result = await request<any>('/api/hemory/fragments/regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventIds }) });
    if (!jsonOutput) {
      for (const day of result.days ?? []) console.log(`重建 ${day.dateKey}（客户 ${day.customerId}）的当日合并草稿。`);
      if (!(result.jobs ?? []).length) console.log('没有需要重建的生成日（选中片段所在天没有已确认活跃片段）。');
    }
    if (wait) {
      const jobIds = (result.jobs ?? []).map((job: any) => job.jobId).filter(Boolean);
      if (jsonOutput) print(result);
      if (jobIds.length) printDraftJobSummary(await waitDraftJobs(jobIds));
      else if (!jsonOutput) console.log('没有新触发的草稿生成任务。');
      return;
    }
    return print(result);
  }
  if (subcommand === 'assign' || subcommand === 'clear' || subcommand === 'ignore') {
    const wait = values.includes('--wait');
    // 第一个非选项参数是客户 ID/名称（assign），其余非选项参数是片段 ID；--wait/--json 不参与。
    const positional = values.filter((value) => !value.startsWith('--'));
    const customer = subcommand === 'assign' ? await resolveCustomer(positional[0] ?? '') : null;
    const eventIds = subcommand === 'assign' ? positional.slice(1) : positional;
    if (!eventIds.length) throw new Error(`hemory ${subcommand} 缺少片段 ID`);
    const all = await request<any>('/api/hemory/fragments?status=all&limit=500');
    const expectedHashes = Object.fromEntries((all.fragments ?? []).filter((item: any) => eventIds.includes(item.id)).map((item: any) => [item.id, item.payloadHash]));
    if (subcommand === 'ignore') {
      return print(await request('/api/hemory/fragments/ignore', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventIds, expectedHashes }) }));
    }
    const result = await request<any>('/api/hemory/fragments/attribution', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventIds, customerId: customer?.id ?? null, expectedHashes }) });
    // --wait：轮询生成任务到终态（jobId 为空的幂等复用任务无新生成，直接跳过）。
    if (wait) {
      const jobIds = (result.jobs ?? []).map((job: any) => job.jobId).filter(Boolean);
      if (jsonOutput) print(result);
      if (jobIds.length) printDraftJobSummary(await waitDraftJobs(jobIds));
      else if (!jsonOutput) console.log('没有新触发的草稿生成任务（同指纹批次已存在）。');
      return;
    }
    return print(result);
  }
  throw new Error('hemory 子命令只允许 sync/resegment/inbox/assign/clear/ignore/regenerate');
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
  const jobIds: string[] = (jobs ?? []).map((job: any) => job.jobId).filter(Boolean);
  if (jsonOutput) return print({ jobs, supersededBatchId: original.id, customerId: original.customerId });
  console.log(`已提交 ${jobs.length} 个重新生成任务（旧批次 ${original.id} 的未写入草稿已作废），等待新批次生成…`);
  // 先等任务终态：失败任务不创建批次，只轮询批次列表会永远等不到结果。
  let finalJobs: any[] = [];
  try { finalJobs = await waitDraftJobs(jobIds); }
  catch (error) { console.log((error as Error).message); }
  const failed = finalJobs.filter((job) => job.status === 'failed');
  for (const job of failed) console.log(`草稿生成任务 ${job.id} 失败：${job.error ?? '未知原因'}`);
  if (failed.length) process.exitCode = 2;
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
  if (subcommand === 'dismiss') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('draft dismiss 缺少批次 ID');
    return print(await request(`/api/draft-batches/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }));
  }
  if (subcommand === 'jobs') {
    // 无参 = 列出最近失败的生成任务（失败明细可发现入口）；带 ID = 查询指定任务状态与片段明细。
    const ids = values.filter(Boolean);
    const { jobs } = ids.length
      ? await request<any>(`/api/draft-jobs?ids=${encodeURIComponent(ids.join(','))}`)
      : await request<any>('/api/draft-jobs?status=failed&kind=hemory');
    if (jsonOutput) return print(jobs);
    if (!jobs.length) { console.log(ids.length ? '任务不存在（可能已清理或 ID 有误）' : '没有失败的生成任务'); return; }
    const { customers } = await request<any>('/api/customers');
    const nameOf = (customerId: string) => customers?.find((item: any) => item.id === customerId)?.name ?? customerId;
    for (const job of jobs) {
      console.log(`任务 ${job.id}`);
      console.log(`  客户：${nameOf(job.customerId)}${job.dateKey ? ` · ${job.dateKey}` : ''} · 状态 ${job.status} · 尝试 ${job.attempts} 次`);
      if (job.error) console.log(`  错误：${job.error}`);
      if (job.fragments?.length) {
        console.log(`  涉及片段（${job.fragments.length} 个）：`);
        for (const fragment of job.fragments) console.log(`    ${fragment.id} · ${fragment.topic}${fragment.summary ? `：${String(fragment.summary).slice(0, 60)}` : ''}`);
      }
    }
    if (!ids.length) console.log('重试：csm-agent hemory regenerate <片段ID...>（按天重建）');
    return;
  }
  throw new Error('draft 子命令只允许 review/retry/regenerate/dismiss/jobs');
}

async function serviceCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'install') return print(installService(Number(values.shift() ?? process.env.CSM_PORT ?? 3210)));
  if (subcommand === 'status') {
    // 附运行中服务的构建版本：stale（磁盘构建已更新而进程未换新）一眼可见。
    const status = serviceStatus();
    try {
      const version = await request<any>('/api/version');
      return print({ ...status, version: { buildId: version.buildId, startedAt: version.startedAt,
        supervised: version.supervised === true, stale: version.stale === true } });
    } catch (error) { return print({ ...status, version: { error: '服务未运行或无 /api/version 端点' } }); }
  }
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

async function showSessions(rawArgs: string[]): Promise<void> {
  // --all 与网页已归档区显示契约一致：默认剔除已归档会话，--all 恢复全量（诊断/恢复用）。
  const includeAll = rawArgs.includes('--all');
  const body = await request<any>(`/api/sessions${includeAll ? '?include=archived' : ''}`);
  if (jsonOutput) return print(body.sessions);
  const rows = (body.sessions ?? []).map((s: any) => ({
    id: s.id, title: s.title, customer: s.customerName || s.customerId || '', updatedAt: new Date(s.updatedAt).toLocaleString('zh-CN', { hour12: false }),
    archived: s.archived === true ? '是' : '',
  }));
  if (!rows.length) console.log(includeAll ? '没有任何会话' : '没有活跃会话（csm-agent sessions --all 查看含已归档）');
  else console.table(rows);
}

async function showSessionTranscript(sessionId: string): Promise<void> {
  const body = await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/export`);
  if (jsonOutput) return print(body);
  if (body.archived) console.log(`（已归档会话，可用 csm-agent sessions unarchive ${sessionId} 恢复）\n`);
  console.log(body.transcript ?? '（无内容）');
}

async function setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
  const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
  print(result);
}

/** csm-agent ones fields [--verify]：ONES Desk 必填字段契约（选项 UUID 表 + 兜底值 + 部署类型规则）。 */
async function showOnesDeskFields(verify: boolean): Promise<void> {
  const body = await request<any>(`/api/ones-desk-fields${verify ? '?verify=1' : ''}`);
  if (jsonOutput) return print(body);
  console.log(`ONES Desk（projectID=${body.projectID}）`);
  console.log(`实例部署类型规则: ${body.deployment_rule.rule}（来源: ${body.deployment_rule.source}）`);
  for (const [type, detail] of Object.entries<any>(body.types ?? {})) {
    console.log(`\n${detail.label}（issueTypeID=${body.issueTypeIDs?.[type] ?? 'unknown'}）`);
    console.table((detail.fields ?? []).map((field: any) => ({
      fieldID: field.fieldID,
      label: field.label,
      兜底值: field.defaultValue ?? '无',
      选项数: field.options ? Object.keys(field.options).length : (field.member ? '成员' : 0),
    })));
    for (const field of detail.fields ?? []) {
      if (field.options) {
        const entries = Object.entries<string>(field.options);
        console.log(`  ${field.label} 选项 (${entries.length}):`);
        for (const [label, uuid] of entries) console.log(`    ${label} = ${uuid}`);
      }
    }
    const verifyResult = body.verification?.[type];
    if (verify) {
      if (!verifyResult) console.log('  实时核对: 未执行');
      else if (verifyResult.ok) console.log('  实时核对: 通过（字段存在、必填、内置选项 UUID 有效）');
      else if (verifyResult.error) console.log(`  实时核对失败: ${verifyResult.error}`);
      else if (verifyResult.problems) console.log(`  实时核对发现问题:\n    ${verifyResult.problems.join('\n    ')}`);
    }
  }
  if (!verify) console.log('\n（加 --verify 经 get_issue_fields 实时核对选项 UUID 漂移）');
}

async function sessionsCommand(subcommand: string, values: string[], rawArgs: string[]): Promise<void> {
  if (subcommand === 'list') return showSessions(rawArgs);
  if (subcommand === 'show') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('sessions show 缺少会话 ID');
    return showSessionTranscript(id);
  }
  if (subcommand === 'archive' || subcommand === 'unarchive') {
    const id = values.shift() ?? '';
    if (!id) throw new Error(`sessions ${subcommand} 缺少会话 ID`);
    return setSessionArchived(id, subcommand === 'archive');
  }
  throw new Error('sessions 子命令只允许 list/show/archive/unarchive');
}

async function doctor(): Promise<void> {
  const [list, wecom, llm, search] = await Promise.all([customers(), request('/api/wecom/status'), request('/api/config/llm'), request('/api/config/search')]);
  const sample = list[0];
  const overview = sample ? await request<any>(`/api/customers/${encodeURIComponent(sample.id)}/overview`) : null;
  // 旧进程探测：服务端 buildId 与本地 dist 构建比对——分裂（新 UI + 旧 API）在 doctor 层可见。
  let build: Record<string, unknown> | string;
  try {
    const version = await request<any>('/api/version');
    const local = readBuildInfo();
    build = { serviceBuildId: version.buildId, localBuildId: local?.buildId ?? null,
      stale: version.stale === true || (local != null && version.buildId !== local?.buildId),
      supervised: version.supervised === true, startedAt: version.startedAt,
      hint: version.stale === true || (local != null && version.buildId !== local?.buildId)
        ? '服务进程仍在运行旧构建，请执行 csm-agent service restart（或结束旧进程）后重试'
        : 'ok' };
  } catch (error) {
    build = { error: (error as Error).message, hint: '服务进程无 /api/version 端点（版本过旧），请重启服务' };
  }
  print({ baseUrl, api: 'ok', build, customers: list.length, sampleCustomer: sample?.id ?? null,
    sampleTimelineEvents: overview?.timeline?.length ?? 0, llm, webSearch: search, wecom });
}

async function main(): Promise<void> {
  const command = args.shift() ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'version' || command === '--version' || command === '-v') return version();
  if (command === 'capabilities') return print(CLI_CAPABILITIES);
  if (command === 'serve') return serve(args.shift());
  if (command === 'doctor') return doctor();
  if (command === 'config') return configCommand(args.shift() ?? '', args);
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
  if (command === 'weekly-report') return weeklyReportCommand(args.shift() ?? '', args);
  if (command === 'wiki') return wikiCommand(args.shift() ?? '', args);
  if (command === 'sync') return sync(args.join(' ') || undefined);
  if (command === 'hemory') return hemoryCommand(args.shift() ?? '', args);
  if (command === 'drafts') return showDrafts(args);
  if (command === 'draft') return draftCommand(args.shift() ?? '', args);
  if (command === 'service') return serviceCommand(args.shift() ?? 'status', args);
  if (command === 'update') return runUpdate();
  if (command === 'uninstall') return runUninstall({ purge: rawArgs.includes('--purge'), yes: rawArgs.includes('--yes') });
  if (command === 'sessions') return sessionsCommand(args.shift() ?? 'list', args, rawArgs);
  if (command === 'ones') {
    const sub = args.shift() ?? '';
    if (sub === 'fields') return showOnesDeskFields(rawArgs.includes('--verify'));
    throw new Error('ones 子命令只允许 fields');
  }
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
