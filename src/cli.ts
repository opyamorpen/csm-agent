#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { ConfirmDraft } from './tools/confirm.js';
import { installService, readServiceLogs, restartService, serviceStatus, uninstallService } from './service.js';
import { listBackups, restoreBackup } from './backup.js';
import { dataDir } from './store.js';
import { appRoot, isManagedInstall, readInstallLayout } from './managed-install.js';
import { readBuildInfo } from './version.js';
import { runUpdate } from './update.js';
import { runUninstall } from './uninstall.js';

const baseUrl = (process.env.CSM_BASE_URL ?? `http://127.0.0.1:${process.env.CSM_PORT ?? 3210}`).replace(/\/$/, '');
const rawArgs = process.argv.slice(2);
const jsonOutput = rawArgs.includes('--json');
const args = rawArgs.filter((arg) => arg !== '--json');

// ── CLI 登录凭证：按 baseUrl 键控存于数据目录（0600），所有请求自动附带 Bearer。 ──
interface CliAuthEntry { token: string; username: string; savedAt: string }
type CliAuthStore = Record<string, CliAuthEntry>;

function cliAuthPath(): string {
  return join(dataDir(), 'cli-auth.json');
}

function loadCliAuth(): CliAuthStore {
  try {
    const parsed = JSON.parse(readFileSync(cliAuthPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as CliAuthStore : {};
  } catch {
    return {};
  }
}

function saveCliAuthEntry(entry: CliAuthEntry | undefined): void {
  const store = loadCliAuth();
  if (entry) store[baseUrl] = entry;
  else delete store[baseUrl];
  writeFileSync(cliAuthPath(), JSON.stringify(store, null, 2), 'utf8');
  try { chmodSync(cliAuthPath(), 0o600); } catch { /* 平台不支持时忽略 */ }
}

function currentCliAuth(): CliAuthEntry | undefined {
  return loadCliAuth()[baseUrl];
}

/** 统一的请求头：已登录则附带 Authorization（调用方显式传入的同名头优先）。 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const auth = currentCliAuth();
  return { ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}), ...(extra ?? {}) };
}

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
  { command: 'login', workflow: 'auth', access: 'write', api: ['POST /api/auth/login'], notes: '多人共用部署的密码登录（logout 退出并吊销凭证、whoami 查看当前身份）；凭证按服务地址存于 ~/.csm-agent/cli-auth.json（0600），此后所有命令自动附带 Bearer。服务端 API 已全部要求登录；首启会创建 admin（CSM_ADMIN_PASSWORD 或随机生成打印一次）' },
  { command: 'users', workflow: 'user-admin', access: 'write', api: ['GET /api/users', 'POST /api/users', 'PATCH /api/users/:id', 'POST /api/users/:id/reset-password'], notes: '管理员管理账号：list 列出、create 建号（缺省生成初始密码仅显示一次）、reset-password 重置（收回该用户在线会话）、set-role/bind-wecom（绑定企微 userid 供扫码登录）/enable/disable；最后一名管理员不可降级或禁用' },
  { command: 'profile', workflow: 'auth', access: 'write', api: ['GET /api/auth/me', 'PUT /api/auth/me/avatar', 'DELETE /api/auth/me/avatar', 'GET /api/auth/me/avatar'], notes: '个人中心：查看账号与头像状态；avatar 上传（≤2MB，网页端自动居中裁方压到 256px）/--remove 移除' },
  { command: 'token', workflow: 'auth', access: 'write', api: ['POST /api/auth/tokens', 'GET /api/auth/tokens', 'DELETE /api/auth/tokens/:id'], notes: '个人访问令牌（PAT，无过期可吊销）: create 生成（明文仅显示一次）、list 查看、revoke 吊销；适合脚本/CI 以 Bearer 调用 API' },
  { command: 'doctor', workflow: 'diagnostics', access: 'read', api: ['/api/customers', '/api/config/llm', '/api/config/search', '/api/version'] },
  { command: 'config', workflow: 'runtime-config', access: 'write', api: ['/api/config/llm', 'PUT /api/config/llm', '/api/config/mcp'], notes: 'llm 为管理员维护的全局模型配置；mcp 查看本人「我的连接」（每人各自的 CRM/ONES/Hemory 凭证，会话与外部写走本人凭证，保存走网页设置页）' },
  { command: 'customers', workflow: 'customer-portfolio', access: 'read', api: ['/api/customers'], sorts: ['default', 'renewal_date', 'renewal_amount'] },
  { command: 'customers aliases', workflow: 'customer-portfolio', access: 'write', api: ['PUT /api/customers/:id/aliases', 'GET /api/customers/:id/overview'],
    notes: '维护客户别名（品牌名/口语简称，本地叠加层）：agent 与 CLI 的客户名解析支持全称/简称/别名精确匹配 + 唯一子串兜底；--set 整组替换（逗号分隔）、--add/--remove 可重复；跨客户撞名拒绝' },
  { command: 'customer', workflow: 'customer-overview', access: 'read', api: ['/api/customers/:id/overview'] },
  { command: 'webintel', workflow: 'web-intelligence-refresh', access: 'write', api: ['/api/customers/:id/web-intel', 'GET /api/customers/:id/web-intel/rounds', '/api/web-intel/rotation'],
    notes: '单客户强制检索（忽略 14 天门）；--history 查轮次报告（run 即报告：逐条明细带新增标记，同一条旧闻跨轮不重复落库只在报告留痕）；--rotation 手动排空自动轮换队列（夜间窗口每日 20:00–次日 08:00 上海错峰、每小时 1 个客户、约两周全员轮换、最久未查优先，失败次日优先重试）' },
  { command: 'opportunities', workflow: 'opportunity-analysis', access: 'read-write', api: ['GET /api/customers/:id/overview', 'POST /api/customers/:id/opportunities/refresh'],
    notes: '增购机会假设由 LLM 从会议录音片段+公开动态证据分析产出（数量不固定、按可信度排序、展示前 5 条，逐条附来源）；--refresh 强制重新分析（忽略指纹/24h 门），失败保留旧假设' },
  { command: 'timeline', workflow: 'customer-timeline', access: 'read', api: ['/api/customers/:id/timeline'] },
  { command: 'workhours', workflow: 'customer-workhours', access: 'read', api: ['/api/customers/:id/workhours'] },
  { command: 'action', workflow: 'action-items', access: 'read-write', api: ['/api/action-items', '/api/action-items/:id', '/api/action-items/:id/complete', '/api/action-items/bulk-complete'] },
  { command: 'alerts', workflow: 'risk-watchlist', access: 'read-write', api: ['/api/alerts', '/api/alerts?status=resolved', '/api/alerts?status=all', 'POST /api/alerts/:id/resolve'],
    notes: '风险预警名单：近 30 天 CRM 跟进与 ONES 工作项/工时活动同时停滞、或公开动态检索到负面信息的客户自动进入；resolve 消除风险必须填写原因/动作（写审计），条件自动解除由系统标记' },
  { command: 'case', workflow: 'case-drafts', access: 'approved-write', api: ['/api/case-drafts', '/api/case-drafts/:id', '/api/case-drafts/:id/regenerate', '/api/case-drafts/:id/publish-preview', '/api/case-drafts/:id/publish', '/api/case-drafts/:id/export', '/api/draft-jobs'],
    editableFields: ['title', 'company_info', 'business_scope', 'competitive_strategy', 'project_background', 'business_status', 'demands', 'solution_sections', 'value_items', 'lessons', 'summary', 'system_usage', 'milestones'],
    readOnlyFields: ['customer_id', 'customer_name', 'claim_evidence', 'context_snapshot', 'web_search', 'unknowns', 'coverage', 'figures'],
    notes: 'generate/regenerate --wait 实时打印生成进度（阶段/检索角度/模型输出字数）；业务解决方案图 1、系统集成图和价值全景图由模型提取结构化内容，服务端按确定性分层版式渲染；现状流程图、目标流程图、服务里程碑图采用模型内容加服务端统一视觉外壳与蓝色主题（历史草稿原样保留）；价值全景图固定从左到右为痛点及挑战/方案/价值三栏，中间方案区占最大空间，痛点与价值各 3~5 条并按序对应；show 输出素材覆盖率（价值/痛点信号被正文引用比例；ONES 记录明细不注入案例生成，交付事实只经服务端统计聚合参与）；export 导出 Word 文档（v8 四章深结构，含目录/客户信息表/配图）' },
  { command: 'weekly-report', workflow: 'weekly-reports', access: 'approved-write', api: ['/api/customers/:id/weekly-reports', '/api/weekly-reports/:id', '/api/weekly-reports/:id/regenerate', '/api/weekly-reports/:id/publish-preview', '/api/weekly-reports/:id/publish', '/api/draft-jobs'], notes: 'generate/regenerate --wait 实时打印生成进度（阶段/模型输出字数）' },
  { command: 'wiki', workflow: 'ones-wiki-browse', access: 'read', api: ['/api/ones-wiki/spaces', '/api/ones-wiki/pages'] },
  { command: 'sync', workflow: 'source-sync', access: 'write', api: ['/api/sync', '/api/customers/:id/refresh', '/api/sync-runs/:id'] },
  { command: 'backup', workflow: 'data-backup', access: 'read-write', api: ['POST /api/backup/run', 'GET /api/backups', 'GET /api/sync-runs/:id'],
    notes: '每日 04:00（上海）自动全量备份：SQLite VACUUM INTO 在线快照 + 会话 + 附件 + 配置（含密钥）打成单个 tar.gz 归档，保留最近 3 份、更旧自动删除；run 立即触发同一管线；list 列归档（本地可读，服务在线附带最近 run 与下次调度时刻）；restore 为本地离线命令（校验→停服务→现有数据移入 .restore-rollback-* 回滚目录→应用→重启，--db-only 只恢复数据库；~/.mcp-auth OAuth token 不在备份内，恢复后需重新授权）' },
  { command: 'hemory', workflow: 'hemory-attribution', access: 'read-write', api: ['/api/hemory/sync', '/api/hemory/resegment', '/api/hemory/resegment?recordingId=', '/api/hemory/segmentation-jobs', '/api/hemory/fragments', '/api/hemory/fragments?customer_id=', '/api/hemory/fragments/attribution', '/api/hemory/fragments/ignore', '/api/hemory/fragments/regenerate', '/api/hemory/fragments/inherit'], notes: 'assign/regenerate --wait 实时打印生成进度（阶段/模型输出字数/重试提示）；repair 修复重切孪生的归属继承（重切后已处理内容不再重回收件箱）' },
  { command: 'drafts', workflow: 'hemory-drafts', access: 'read', api: ['/api/draft-batches', '/api/draft-batches?include=written', '/api/draft-jobs', '/api/draft-jobs?status=failed&kind=hemory', '/api/draft-jobs?status=active&kind=hemory'], notes: 'draft jobs --active 列出进行中任务（含进度与中断标注）' },
  { command: 'draft', workflow: 'hemory-drafts', access: 'approved-write', api: ['/api/draft-batches', '/api/draft-items/:id', '/api/draft-items/:id (PATCH edits 结构化编辑)', '/api/draft-batches/:id/preview', '/api/draft-batches/:id/confirm', '/api/draft-batches/:id/regenerate', '/api/draft-batches/:id/dismiss', '/api/draft-items/:id/retry', '/api/draft-items/:id/dismiss'] },
  { command: 'service', workflow: 'macos-service', access: 'local', api: [] },
  { command: 'version', workflow: 'diagnostics', access: 'read', api: ['/api/version'], notes: '--json 输出安装指纹（version/buildId/gitSha/branch/HEAD/node 等）；两台机器各跑一次比对 gitSha 是否一致，即「一键安装/升级后与开发机一模一样」的验收锚点' },
  { command: 'update', workflow: 'self-update', access: 'local', api: [], notes: '失败自动回滚到更新前构建（gitSha 可比对的完整还原）；成功后轮询 /api/version 确认服务已换新（serviceVerified）' },
  { command: 'uninstall', workflow: 'self-update', access: 'local', api: [] },
  { command: 'ones', workflow: 'ones-desk-fields', access: 'read', api: ['/api/ones-desk-fields', '/api/ones-desk-fields?verify=1'] },
  { command: 'agent', workflow: 'customer-agent', access: 'approved-write', api: ['/api/sessions', '/api/sessions/:id/events', '/api/sessions/:id/messages', '/api/sessions/:id/attachments/:attId', '/api/sessions/:id/confirm', '/api/sessions/:id/stop', '/api/config/search'], tools: ['get_customer_detail', 'get_customer_profile', 'get_customer_events', 'get_ones_desk_required_fields', 'web_search', 'record_web_intelligence'], notes: '贴截图/聊天记录说「帮我提 bug/需求/工单」：agent 从贴入内容分析生成 ONES 建议/工单/运维工单待确认草稿（先取 get_ones_desk_required_fields 字段契约，证据不足走兜底值+unknowns），会话内 [y] 批准/[e] 编辑后批准按参数哈希回写 ONES' },
  { command: 'sessions', workflow: 'agent-sessions', access: 'read-write', api: ['/api/sessions', '/api/sessions?include=archived', '/api/sessions/:id', '/api/sessions/:id/export', '/api/sessions/:id/stop'] },
  { command: 'api', workflow: 'api-fallback', access: 'read-write', api: ['/api/*'] },
] as const;

async function request<T = any>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: authHeaders((options?.headers as Record<string, string>) ?? undefined),
    });
  } catch (error) {
    throw new Error(`无法连接 ${baseUrl}；请先运行 npm run dev。${(error as Error).message}`);
  }
  if (response.status === 401) throw new Error(`未登录或凭证已失效——请先运行 csm-agent login（目标 ${baseUrl}）`);
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
  // 别名是服务端叠加层、不在列表载荷里：精确/子串都未命中时按搜索词召回，再逐个核对 overview 的 aliases。
  if (input.length >= 2) {
    const byAlias: CustomerSummary[] = [];
    for (const item of await customers(input)) {
      const overview = await request<any>(`/api/customers/${encodeURIComponent(item.id)}/overview`);
      if (Array.isArray(overview?.aliases) && overview.aliases.includes(input)) byAlias.push(item);
    }
    if (byAlias.length === 1) return byAlias[0];
    if (byAlias.length > 1) throw new Error(`客户不唯一（别名「${input}」）: ${byAlias.map((item) => `${item.name}(${item.id})`).join(', ')}`);
  }
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
  csm-agent login [用户名]
    （多人部署的密码登录：交互输入密码，凭证按服务地址存于 ~/.csm-agent/cli-auth.json，
     此后所有命令自动附带；服务端首启创建 admin，密码取 CSM_ADMIN_PASSWORD 或随机生成打印一次）
  csm-agent logout
    （退出并吊销当前凭证）
  csm-agent whoami [--json]
    （查看当前服务地址与登录身份）
  csm-agent profile [--json]
    （个人中心 CLI 侧：查看账号与头像状态）
  csm-agent profile avatar <图片路径> | --remove
    （上传头像（PNG/JPEG/WebP，≤2MB，网页端自动裁方压缩）或移除；与网页个人中心同一 API）
  csm-agent users list|create|reset-password|set-role|enable|disable ...（需管理员）
    （create <用户名> [--display-name=X] [--role=admin|member] [--password=X]，缺省生成初始密码仅显示一次；
     reset-password <用户名> [--password=X]；set-role <用户名> admin|member；bind-wecom <用户名> <企微 userid>；
     enable/disable <用户名>）
  csm-agent token create|list|revoke
    （个人访问令牌（PAT，脚本/CI 用）: create [--name=X] 明文仅显示一次；revoke <令牌ID>）
  csm-agent config mcp [--json]
    （「我的连接」：查看本人 CRM/ONES/Hemory 凭证与连接状态；添加/保存走网页设置页）
  csm-agent config llm [--json]
  csm-agent config llm set --provider=<id> --model=<id> [--base-url=<url>] [--api-key=<key>] [--protocol=openai|anthropic] [--vision=on|off]
    （查看/切换大模型；provider=custom 需 --base-url，--protocol 选端点协议：
     openai=OpenAI 兼容（追加 /chat/completions，缺省），anthropic=Anthropic 兼容
     （追加 /v1/messages，如智谱 GLM Coding Plan 的 https://open.bigmodel.cn/api/anthropic）。
     保存时自动发一次真实请求验证连通，失败则不落盘；API Key 只写本地配置文件；
     --vision 声明自定义端点的图片输入能力（内置服务商按模型目录自动判定，无需设置）。
     示例：config llm set --provider=custom --model=glm-5.3-flash \\
              --base-url=https://open.bigmodel.cn/api/coding/paas/v4 --api-key=<key> --vision=on）
  csm-agent customers [搜索词] [--sort default|renewal_date|renewal_amount] [--json]
  csm-agent customers aliases <客户ID或名称> [--set 别名1,别名2] [--add 别名] [--remove 别名] [--json]
    （维护客户别名（品牌名/口语简称，同步不覆盖的本地叠加层）：agent 解析客户支持全称/简称/别名的
     精确匹配与唯一子串匹配，与全称无子串关系的叫法必须维护别名才能解析；无 flag 列出当前别名；
     撞其他客户的名称/简称/别名会被拒绝，避免制造歧义）
  csm-agent customer <客户ID或名称> [--json]
  csm-agent webintel <客户ID或名称> [--json]
    （强制检索该客户最近三个月公开动态（8 个角度：融资/中标/产品/高管/组织/舆情/招聘/政策），
     落库后重算续约风险与增购机会；未搜到不构成任何信号，风险维度按 unknown 处理）
  csm-agent webintel <客户ID或名称> --history [--json]
    （轮次报告：最近 10 轮逐条明细（★新增标记 + 来源链接）；同一条旧闻跨轮不重复落库、只在报告留痕）
  csm-agent webintel --rotation [--json]
    （手动排空自动轮换队列：14 天门内跳过、当天已尝试不重复；日常自动轮换为每日 20:00–次日 08:00（上海错峰）
     每小时检索 1 个客户、约两周轮完全部客户（最久未查优先，失败次日优先重试）；首次全量排空可能耗时 1 小时以上）
  csm-agent opportunities <客户ID或名称> [--refresh] [--json]
    （列出增购机会假设：LLM 从会议录音片段+公开动态证据分析，按可信度取前 5 条、
     逐条附信息来源（会议录音/公开动态，可带链接）；--refresh 强制重新分析，失败保留旧假设）
  csm-agent timeline <客户ID或名称> [sourceType] [--json]
  csm-agent workhours <客户ID或名称> [--json]
  csm-agent actions [客户ID或名称] [--json]
  csm-agent action complete <待办ID...> [--outcome <实际结果>]
    （批量完成：仅未完成状态生效，已完成跳过；单项失败不影响其他项；
     --outcome 支持空格或 = 传值，可选记录实际结果，不填不记录）
  csm-agent action update <待办ID> <JSON>
  csm-agent alerts [--status active|resolved|all] [--json]
    （风险预警名单：近 30 天无 CRM 跟进记录且无 ONES 工作项新增/更新与新增工时（两侧同时停滞），
     或公开动态检索到该客户负面信息（收入下降/罚款/投诉等）即进入；--status 默认 active，all 含已消除）
  csm-agent alerts resolve <预警ID> --note <原因/动作>
    （消除风险必须写明原因或动作，写入审计；消除后情况无新变化不重报）
  csm-agent cases [客户ID或名称] [--json]
  csm-agent case generate <客户ID或名称> [--force] [--wait]
    （生成时自动联网检索客户公开信息：公司概况/项目管理/需求管理/知识管理/行业动态/招投标/中标采购；
     业务解决方案图 1 采用结构化内容提取与服务端分层蓝图渲染；系统集成图和价值全景图采用结构化内容提取与服务端确定性分层渲染；现状流程图、目标流程图、服务里程碑图采用统一视觉外壳与蓝色主题，历史草稿原样保留；价值全景图固定从左到右为痛点及挑战/方案/价值三栏，中间方案区占最大空间，痛点与价值各 3~5 条并按序对应；--wait 轮询任务到终态并实时打印生成进度）
  csm-agent case show <草稿ID> [--json]
    （默认输出可直接对外的案例 Markdown（与复制/Wiki 发布同源），有配图时列出图注一行；--json 输出含 claim_evidence/figures/context_snapshot/unknowns 的完整审核对象）
  csm-agent case regenerate <草稿ID> [--wait]
  csm-agent case update <草稿ID> <版本> <JSON>
    （只更新 title 与 fields 中的公开正文：v8 为公司简介三小节/项目背景/业务现状/业务诉求/方案小节/价值与复盘/项目总结及派生表 system_usage、milestones；
     客户绑定、逐条证据、上下文、联网快照和 unknowns 由服务端保留）
  csm-agent case export <草稿ID> [--out <文件路径>]
    （导出 Word 文档：四章深结构版式（目录/客户信息表/服务里程碑/配图），默认保存到当前目录；
     与复制/Wiki 发布同一内容口径）
  csm-agent case preview <草稿ID> [ONES父页面ID]
  csm-agent case publish <草稿ID> <版本> <ONES父页面ID> <批准哈希>
  csm-agent weekly-report list <客户ID或名称> [--json]
  csm-agent weekly-report show <周报ID> [--json]
    （默认输出客户版周报 Markdown（与复制/Wiki 发布同源）；--json 输出含 source/stats 的完整对象）
  csm-agent weekly-report generate <客户ID或名称> [YYYY-MM-DD] [--force] [--wait]
    （日期为周内任意一天，自动对齐周一；基于该客户本周全部信息生成客户版四章节周报；
     --force 强制重建已存在的周报；--wait 轮询任务到终态并实时打印生成进度）
  csm-agent weekly-report update <周报ID> <版本> <JSON>
    （JSON 为四章节 content 对象：summary/accomplishments/next_week_plan/risks）
  csm-agent weekly-report preview <周报ID> [ONES父页面ID]
    （客户版发布正文 + 内部信息警告 + 批准哈希）
  csm-agent weekly-report publish <周报ID> <版本> <ONES父页面ID> <批准哈希>
  csm-agent wiki spaces [--json]
  csm-agent wiki pages --space <页面组ID> [--parent <页面ID>] [--json]
    （ONES Wiki 只读浏览：页面组列表与页面树，发布位置可用 csm-agent wiki pages 查 ID）
  csm-agent sync [客户ID或名称]
  csm-agent hemory sync [YYYY-MM-DD]
  csm-agent hemory resegment --all | --recording <录音ID>
  csm-agent hemory jobs [--json]
    （分段任务只读视图：排查录音卡在最大重试时看 attempts/status/error）
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
     当天旧草稿作废；--wait 轮询生成任务到终态。已写入草稿消费过的片段不再被
     同类型重复提案——全部消费时任务以备注收尾，不产出新草稿）
  csm-agent hemory repair [--apply]
    （存量孪生一次性修复：把重切前旧片段的人工归属/忽略按时间覆盖继承到当前待处理
     孪生片段，并回填转写基准让已处理完的录音跳过后续重切；默认 dry-run 只报告）
  csm-agent drafts [客户ID或名称] [--archived|--all] [--json]
    （默认只列待处理批次；--archived 只看纯已忽略/已作废批次，
     与 Web 草稿箱双 tab 一致；--all 含已写入的全量诊断视图；
     重新生成进行中的批次带「生成中」标记，期间不建议确认旧草稿）
  csm-agent draft review <批次ID>
  csm-agent draft edit <草稿ID> [--set 键=值 ...]
    （结构化编辑草稿：--set 可用中文标签（--set 优先级=P1 --set 描述=...）或字段键，
     选项字段可填中文选项名；无 --set 进入逐字段交互；编辑后需重新 preview/confirm；
     Web 草稿箱「编辑」弹窗同一契约。原始 JSON 高级编辑仍走 draft review 的 [e]）
  csm-agent draft retry <草稿ID>
  csm-agent draft ignore <草稿ID>
    （忽略单条草稿：软删除为已忽略，同批其他草稿不受影响；已写入项拒绝）
  csm-agent draft regenerate <批次ID>
  csm-agent draft dismiss <批次ID>
    （忽略批次：未写入草稿软删除为已忽略，已写入项不受影响）
  csm-agent draft jobs [任务ID...] [--active]
    （无参列出最近失败的生成任务：客户/日期/片段数/错误；
     带任务 ID 时查询单个任务状态与片段明细；
     --active 列出进行中的生成任务：状态/尝试/进度，中断任务有标注）
  csm-agent service install [端口]
  csm-agent service status|restart|uninstall|logs
  csm-agent update
    （自更新：仅限 install.sh 安装的受管目录；git fetch → reset --hard
     origin/main → npm ci → 重建 → 重建桌面 App → 重启常驻服务）
  csm-agent uninstall [--purge] [--yes]
    （卸载：移除 CLI shim、桌面 App 入口、常驻服务与受管目录；
     默认保留 ~/.csm-agent 用户数据，--purge 连同配置/会话/数据库一并删除）
  csm-agent backup list [--json]
    （列出备份归档：时间/大小/触发方式/包含内容；服务运行时附带最近备份 run 与下次调度时刻。
     自动备份每日 04:00（上海时区）全量数据目录——SQLite 在线快照 + 会话 + 附件 + 配置（含密钥）
     打成单个 tar.gz 归档，磁盘保留最近 3 份、更旧自动删除）
  csm-agent backup run
    （立即触发一次备份（与自动备份同一管线），完成后输出归档路径）
  csm-agent backup restore <归档路径|id|latest> [--db-only] [--yes]
    （离线恢复：先校验归档完整性，再停止 launchd 服务、把现有数据移入 .restore-rollback-* 目录
     （回滚 = 移回）后应用归档并重启服务；--db-only 只恢复数据库（会话/附件/配置保持现状）；
     ~/.mcp-auth OAuth token 不在备份内，恢复后需重新授权）
  csm-agent ones fields [--verify] [--json]
    （ONES Desk 建议/工单/运维工单必填字段契约：选项 UUID 表、兜底值、
     实例部署类型规则（CRM 使用版本=公有云版→公有云，其余→私有云）；
     --verify 经 get_issue_fields 实时核对选项 UUID 漂移）
  csm-agent agent <客户ID或名称> <指令> [--attach <文件路径> ...]
    （会话不绑定客户——客户全称自动注入指令文本；agent 本地工具按 customer_name 唯一解析取数，
     可按需抓取客户详情页各板块 get_customer_detail、本地已同步事件 get_customer_events、
     联网检索 web_search（未配 key 自动走免费匿名通道，可配 Tavily key）、
     落库 record_web_intelligence；
     --attach 附带本地文件（文本类/Office（docx/xlsx/pptx）/PDF 内容注入上下文，可重复；
     图片要求视觉模型，自定义端点先 config llm set ... --vision=on 声明能力）；
     贴截图/聊天记录说「帮我提 bug/需求」时，agent 从贴入内容分析生成 ONES
     建议/工单/运维工单待确认草稿，会话内 [y] 批准 / [e] 编辑后批准即回写 ONES）
  csm-agent sessions [list] [--all] [--json]
  csm-agent sessions show <会话ID> [--json]
    （导出会话全文：标题、客户标签（仅存量绑定会话）、时间范围与完整对话，与网页「分享」同源）
  csm-agent sessions archive|unarchive <会话ID>
    （归档后会话从列表隐藏；--all 或网页「已归档」区可查看并恢复）
  csm-agent sessions stop <会话ID>
    （停止该会话当前进行中的对话：中断模型调用与后续工具执行，
     挂起中的确认草稿按拒绝处理；agent 命令运行中按 Ctrl+C 同效）
  csm-agent api <GET|POST|PATCH|PUT|DELETE> </api/path> [JSON]
  csm-agent capabilities [--json]
  csm-agent version [--json]
    （--json 输出安装指纹 version/buildId/gitSha/branch/HEAD/node 等；
      两台机器各跑一次比对 gitSha 一致，即验证一键安装/升级还原出同一份代码构建）

仓库内可用 npm run cli -- <命令> 获得相同行为。默认连接 ${baseUrl}，可用 CSM_BASE_URL 覆盖。
所有 Agent 写入仍要求草稿自含客户身份并经过人工批准（会话本身不绑定客户）。`);
}

function version(): void {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  if (!rawArgs.includes('--json')) {
    console.log(packageJson.version ?? 'unknown');
    return;
  }
  // 安装指纹：两台机器各跑 `csm-agent version --json` 比对（gitSha 一致 = 同一份代码构建）。
  const root = appRoot();
  const local = readBuildInfo();
  const managed = isManagedInstall(root);
  // 受管安装的端口以 layout 记录为准（非默认 --port 安装不能只看环境变量默认值）
  const port = managed ? (readInstallLayout(root)?.port ?? Number(process.env.CSM_PORT ?? 3210)) : Number(process.env.CSM_PORT ?? 3210);
  const gitQuery = (...pieces: string[]): string | null => {
    try { return execFileSync('git', pieces, { cwd: root, encoding: 'utf8' }).trim() || null; } catch { return null; }
  };
  print({
    version: packageJson.version ?? 'unknown',
    buildId: local?.buildId ?? null,
    gitSha: local?.gitSha ?? null,
    dirty: local?.dirty ?? null,
    builtAt: local?.builtAt ?? null,
    managed,
    branch: gitQuery('rev-parse', '--abbrev-ref', 'HEAD'),
    head: gitQuery('rev-parse', 'HEAD'),
    origin: gitQuery('remote', 'get-url', 'origin'),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    port,
  });
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
  if (input[0] === 'aliases') return customerAliases(input.slice(1));
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
  console.log(`CSM: ${overview.customer.csmName ?? 'unknown'}  风险: ${overview.risk?.level ?? 'unknown'} / ${overview.risk?.score ?? 'unknown'}  覆盖率: ${overview.risk?.coverage ?? 0}%  规则: ${overview.risk?.ruleVersion ?? 'unknown'}`);
  console.log(`续约: ${overview.customer.renewalDate ?? 'unknown'}  合同价值: ${overview.customer.contractValue ?? 'unknown'}  最后互动: ${overview.lastInteractionAt ?? overview.customer.lastContactAt ?? 'unknown'}`);
  const rates = overview.completionRates ?? {};
  const rateLine = (key: string, label: string) => {
    const rate = rates[key];
    if (!rate || !rate.total) return `${label}: 暂无记录`;
    return rate.stale ? `${label}: 待刷新（缺状态类型）` : `${label}: ${rate.pct}%（已完成 ${rate.done}/${rate.total}）`;
  };
  console.log(`${rateLine('suggestion_feedback', '需求完成率')}  ${rateLine('support_ticket', '工单解决率')}  ${rateLine('operations_ticket', '运维解决率')}`);
  const dimensions = overview.risk?.dimensions ?? {};
  if (Object.keys(dimensions).length) {
    console.log('风险维度:');
    console.table(Object.entries(dimensions).map(([key, item]: [string, any]) => ({
      维度: key,
      得分: item.known ? `${item.score}/${item.weight}` : 'unknown',
      说明: item.reason,
    })));
  }
  console.log(`ONES 分类: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
  // 增购机会：与概览页同口径（前 5 条，一句话简述 + 来源行）；其余计数保持一行。
  const opportunities = (overview.opportunities ?? []).slice(0, 5);
  if (opportunities.length) {
    console.log('增购机会（按可信度前 5）:');
    opportunities.forEach((item: any, index: number) => {
      console.log(`  ${index + 1}. ${item.title}（置信度 ${Math.round((item.confidence || 0) * 100)}%）`);
      console.log(`     来源：${(item.sources ?? []).map(opportunitySourceLabel).join(' · ') || 'unknown'}`);
    });
  } else {
    console.log('增购机会: 暂无识别到增购信号');
  }
  console.log(`待办: ${(overview.actions ?? []).length}  案例草稿: ${(overview.caseDrafts ?? []).length}`);
  console.log('身份映射:');
  console.table((overview.identities ?? []).map((item: any) => ({ system: item.system, externalId: item.external_id, label: item.label, status: item.status })));
  const aliases: string[] = Array.isArray(overview.aliases) ? overview.aliases : [];
  console.log(`别名: ${aliases.length ? aliases.join('、') : '（未维护）'}`);
}

/** 客户别名维护：无 flag 列出；--set 整组替换（逗号分隔）；--add/--remove 可重复、支持 = 传值。 */
async function customerAliases(input: string[]): Promise<void> {
  const values = [...input];
  const takeFlag = (flag: '--set' | '--add' | '--remove'): string[] => {
    const hits: string[] = [];
    for (let i = 0; i < values.length;) {
      const value = values[i]!;
      if (value === flag) {
        const raw = values[i + 1];
        if (!raw || raw.startsWith('--')) throw new Error(`${flag} 需要一个值（${flag} 别名 或 ${flag}=别名）`);
        hits.push(raw);
        values.splice(i, 2);
        continue;
      }
      if (value.startsWith(`${flag}=`)) {
        hits.push(value.slice(flag.length + 1));
        values.splice(i, 1);
        continue;
      }
      i++;
    }
    return hits;
  };
  const set = takeFlag('--set');
  const add = takeFlag('--add');
  const remove = takeFlag('--remove');
  if (set.length && (add.length || remove.length)) throw new Error('--set（整组替换）不能与 --add/--remove 同时使用');
  if (set.length > 1) throw new Error('--set 只能出现一次，多个别名用逗号分隔');
  const splitAliases = (raw: string) => raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  const target = values.join(' ').trim();
  if (!target) throw new Error('用法：csm-agent customers aliases <客户ID或名称> [--set 别名1,别名2] [--add 别名] [--remove 别名]');
  const customer = await resolveCustomer(target);
  const overview = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/overview`);
  let aliases: string[] = Array.isArray(overview?.aliases) ? overview.aliases.map(String) : [];
  if (set.length) {
    aliases = splitAliases(set[0]!);
  } else {
    for (const raw of add) aliases.push(...splitAliases(raw));
    if (remove.length) {
      const drop = new Set(remove.flatMap(splitAliases));
      aliases = aliases.filter((alias) => !drop.has(alias));
    }
  }
  if (set.length || add.length || remove.length) {
    const body = await request<{ aliases: string[] }>(`/api/customers/${encodeURIComponent(customer.id)}/aliases`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aliases }),
    });
    aliases = body.aliases ?? aliases;
    console.log(`已更新 ${customer.name} 的别名`);
  }
  if (jsonOutput) return print({ customer: { id: customer.id, name: customer.name }, aliases });
  console.log(`${customer.name} (${customer.id})`);
  console.log(aliases.length
    ? `别名: ${aliases.join('、')}`
    : '别名: （未维护；--add 添加。与全称无子串关系的品牌名/口语简称须维护别名才能被 agent 解析）');
}

/** 公开动态检索：单客户强制刷新（忽略 14 天门）；--history 查轮次报告；--rotation 手动排空自动轮换队列。 */
async function webintel(input: string, options: { rotation?: boolean; history?: boolean } = {}): Promise<void> {
  if (options.rotation) {
    const run = await request<any>('/api/web-intel/rotation', { method: 'POST' });
    // 首次全量排空最坏 149 客户 × ~33s ≈ 80+ 分钟；等终态上限放宽到 90 分钟。
    const completed = await waitSync(run.id, 5400);
    if (jsonOutput) return print(completed);
    const summary = completed.sourceStatus?.web_intelligence ?? {};
    const statusLabel: Record<string, string> = { succeeded: '轮换完成', partial: '部分失败', failed: '失败' };
    console.log(`公开动态轮换排空：${statusLabel[completed.status] ?? completed.status}${completed.error ? ` · ${completed.error}` : ''}`);
    console.log(`尝试 ${summary.attempted ?? 0} 个客户，落库 ${summary.saved ?? 0} 条，失败 ${summary.failed ?? 0} 个`);
    for (const item of summary.customers ?? []) {
      console.log(`  - ${item.customer}：${item.status === 'succeeded' ? '检索完成' : item.status}${item.saved ? `（落库 ${item.saved} 条）` : ''}`);
    }
    if (!summary.attempted) console.log('  （当前没有待轮换客户：全部在 14 天新鲜度窗口内，或今天已尝试过）');
    if (completed.status === 'failed') process.exitCode = 2;
    return;
  }
  const customer = await resolveCustomer(input);
  if (options.history) {
    const { rounds } = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/web-intel/rounds?limit=10`);
    if (jsonOutput) return print({ customer: { id: customer.id, name: customer.name }, rounds });
    console.log(`公开动态轮次报告（${customer.name}，最近 ${rounds.length} 轮，最新在前）`);
    if (!rounds.length) {
      console.log('  暂无轮次记录：该客户从未检索过（自动轮换每日 20:00–次日 08:00 推进，或 webintel <客户> 立查）');
      return;
    }
    for (const round of rounds) {
      const summary = round.sourceStatus?.web_intelligence ?? {};
      const at = String(round.startedAt ?? '').slice(0, 16).replace('T', ' ');
      if (round.status === 'failed') {
        console.log(`  ■ ${at} · 失败：${round.error ?? summary.error ?? '未知原因'}`);
        continue;
      }
      console.log(`  ■ ${at} · 检索 ${summary.searched ?? '?'} 个角度 · 新增 ${summary.count ?? 0} / 命中 ${summary.total ?? 0} 条`);
      for (const finding of summary.findings ?? []) {
        console.log(`    ${finding.is_new ? '★新增' : '　　'} [${finding.category}] ${finding.label}（${finding.occurred_at}）${finding.source_url}`);
      }
      if (!summary.findings?.length) console.log('    （本轮无落库动态——未搜到不构成任何信号）');
    }
    return;
  }
  const result = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/web-intel`, { method: 'POST' });
  if (jsonOutput) return print(result);
  const statusLabel: Record<string, string> = { succeeded: '检索完成', skipped: '跳过', failed: '失败' };
  console.log(`公开动态检索（${customer.name}）：${statusLabel[result.status] ?? result.status}${result.reason ? ` · ${result.reason}` : ''}`);
  console.log(`检索角度 ${result.searched} 个，新增落库 ${result.saved} 条（本轮命中 ${result.total ?? result.saved} 条，旧闻不重复落库）`);
  for (const finding of result.findings ?? []) {
    console.log(`  - [${finding.category}] ${finding.label}（${finding.occurred_at}）${finding.source_url}`);
  }
  if (!result.saved) console.log('  （未找到可落库的最近三个月公开动态；未搜到不构成任何正面或负面信号）');
  const risk = result.risk;
  if (risk) {
    console.log(`刷新后风险: ${risk.level} / ${risk.score == null ? '分数未知' : `${risk.score} 分`}（覆盖 ${risk.coverage}% · ${risk.ruleVersion}）`);
    const web = risk.dimensions?.web;
    if (web) console.log(`公开动态维度: ${web.known ? `${web.score}/${web.weight}` : 'unknown'} · ${web.reason}`);
  }
}

/** 来源行格式化：与概览页同口径（会议录音/公开动态 + 日期，公开动态带链接）。 */
function opportunitySourceLabel(source: any): string {
  const day = String(source.occurredAt ?? '').slice(0, 10);
  const name = source.sourceSystem === 'hemory' ? `会议录音（${day}）`
    : source.sourceSystem === 'web' ? `公开动态（${day}）${source.sourceUrl ? ` ${source.sourceUrl}` : ''}`
    : (source.label ?? source.sourceSystem ?? 'unknown');
  return name;
}

/** 增购机会：列出按可信度排序的前 5 条假设（一句话简述 + 来源行）；--refresh 强制重新分析。 */
async function opportunitiesCommand(input: string, options: { refresh?: boolean } = {}): Promise<void> {
  const customer = await resolveCustomer(input);
  if (options.refresh) {
    const result = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/opportunities/refresh`, { method: 'POST' });
    if (jsonOutput) return print(result);
    const statusLabel: Record<string, string> = { succeeded: '分析完成', skipped: '跳过' };
    console.log(`增购机会重新分析（${customer.name}）：${statusLabel[result.status] ?? result.status}${result.reason ? ` · ${result.reason}` : ''}`);
  }
  const overview = await request<any>(`/api/customers/${encodeURIComponent(customer.id)}/overview`);
  const items = (overview.opportunities ?? []).slice(0, 5);
  if (jsonOutput) return print({ customer: { id: customer.id, name: customer.name }, total: (overview.opportunities ?? []).length, opportunities: overview.opportunities });
  console.log(`增购机会（${customer.name}，按可信度前 ${items.length} 条）`);
  if (!items.length) {
    console.log('  暂无识别到增购信号');
    return;
  }
  items.forEach((item: any, index: number) => {
    console.log(`  ${index + 1}. ${item.title}（置信度 ${Math.round((item.confidence || 0) * 100)}%）`);
    const sources = item.sources ?? [];
    console.log(`     来源：${sources.map(opportunitySourceLabel).join(' · ') || 'unknown'}${(item.sourceCount ?? 0) > sources.length ? ` · 等 ${item.sourceCount} 条来源` : ''}`);
  });
  const hidden = (overview.opportunities ?? []).length - items.length;
  if (hidden > 0) console.log(`  （另有 ${hidden} 条较低可信度假设未展示）`);
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
  // 状态两态中文化展示；--json 保持 API 原值。
  console.table(body.actions.map((action) => ({ id: action.id, customerId: action.customerId,
    status: action.status === 'completed' ? '已完成' : '未完成',
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

const ALERT_TRIGGER_LABELS: Record<string, string> = {
  engagement_inactivity: 'CRM 与 ONES 互动停滞',
  negative_public_signal: '公开负面动态',
};

/** 风险预警名单：--status active|resolved|all（默认 active），表格含触发原因/消除信息。 */
async function showAlerts(status: 'active' | 'resolved' | 'all'): Promise<void> {
  const body = await request<{ alerts: any[]; counts: { active: number; resolved: number } }>(`/api/alerts?status=${status}`);
  if (jsonOutput) return print(body);
  console.table(body.alerts.map((alert) => ({
    id: alert.id,
    客户: alert.customerName ?? alert.customerId,
    触发: ALERT_TRIGGER_LABELS[alert.triggerKey] ?? alert.triggerKey,
    发现: String(alert.createdAt).slice(0, 10),
    ...(alert.status === 'resolved'
      ? { 消除: String(alert.resolvedAt ?? '').slice(0, 10), 消除人: alert.resolvedBy ?? '', 消除原因: alert.resolutionNote }
      : { 原因: (alert.reasons ?? []).join('；') }),
  })));
  console.log(`预警名单：待处理 ${body.counts.active} · 已消除 ${body.counts.resolved}`);
}

async function alertsCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'resolve') {
    const id = values.find((value) => !value.startsWith('--'));
    if (!id) throw new Error('alerts resolve 缺少预警 ID（先 csm-agent alerts 查看名单）');
    const note = inlineOptionOf(values, '--note');
    if (!note) throw new Error('消除风险必须填写原因/动作：--note "..."');
    const alert = await request<any>(`/api/alerts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
    });
    if (jsonOutput) return print(alert);
    console.log(`已消除预警：${alert.customerId} · ${ALERT_TRIGGER_LABELS[alert.triggerKey] ?? alert.triggerKey}`);
    console.log(`原因/动作：${alert.resolutionNote}`);
    return;
  }
  if (subcommand === 'list' || subcommand === '') {
    const statusFlag = inlineOptionOf(values, '--status');
    const status = statusFlag === 'resolved' || statusFlag === 'all' ? statusFlag : 'active';
    return showAlerts(status);
  }
  throw new Error('alerts 子命令只允许 list/resolve');
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
    if (items.length) console.table(items.map((item) => ({ 待办ID: item.id, 标题: item.title ?? '', 结果: item.result, 说明: item.error ?? item.reason ?? '' })));
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.result as string] = (counts[item.result as string] ?? 0) + 1;
    console.log(`${label}：共 ${items.length} 项` + (items.length ? `（${Object.entries(counts).map(([key, value]) => `${value} ${key}`).join('，')}）` : ''));
  }

  async function actionCommand(subcommand: string, values: string[]): Promise<void> {
    if (subcommand === 'list') return showActions(values.join(' ') || undefined);
    if (subcommand === 'complete') {
      const positional = values.filter((value) => !value.startsWith('--'));
      if (!positional.length) throw new Error('action complete 缺少待办 ID');
      const outcome = inlineOptionOf(values, '--outcome');
      const body: Record<string, unknown> = { ids: positional };
      if (outcome !== undefined) body.outcome = outcome;
      const result = await request('/api/action-items/bulk-complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return printActionBulkResult('批量完成', result);
    }
    const actionId = values.shift() ?? '';
    if (!actionId) throw new Error(`action ${subcommand || '(空)'} 缺少待办 ID`);
    if (subcommand === 'update') {
      const body = parseObject(values.join(' '), 'action update');
      return print(await request(`/api/action-items/${encodeURIComponent(actionId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
    }
    throw new Error('action 子命令只允许 list/update/complete');
  }

function printCaseDraft(draft: any, markdown = '', coverage?: any): void {
  console.log(`${draft.title} · ${draft.status === 'published' ? `已发布(${draft.publishedPageId ?? ''})` : `草稿 v${draft.version}`} · ${draft.generator ?? 'unknown'}`);
  // 正文 = 服务端 renderCaseMarkdown 权威渲染的客户版 Markdown（与 Web 复制、Wiki 发布同源）；
  // claim_evidence/context_snapshot/unknowns 等内部字段不进默认输出，--json 保留完整结构化数据供审核与审计。
  if (coverage) {
    // v6：ONES 明细剔除后覆盖度只衡量价值/痛点信号与权威公开资料（存量草稿仍带 delivered 字段时兼容展示）。
    const { valueSignals, painSignals, enriched, delivered, fallbackCited } = coverage;
    const deliveredPart = delivered ? ` · 交付记录 ${delivered.cited}/${delivered.total}` : '';
    const fallbackPart = fallbackCited ? ` · 兜底引用片段 ${fallbackCited}` : '';
    console.log(`素材覆盖率：价值信号 ${valueSignals.cited}/${valueSignals.total} · 痛点信号 ${painSignals.cited}/${painSignals.total}${deliveredPart}${fallbackPart}${enriched ? ' · 已自动补充完善' : ''}`);
  }
  // v7 配图：Markdown 以图注占位（图形本体在工作台详情渲染），CLI 列出图注供审核。
  const figures = Array.isArray(draft?.fields?.figures) ? draft.fields.figures : [];
  if (figures.length) console.log(`配图 ${figures.length} 张：${figures.map((figure: any) => figure.caption || figure.kind).join('；')}`);
  if (markdown) console.log(`\n${markdown}`);
  console.log(`\n（完整内部证据：csm-agent case show ${draft.id} --json）`);
}

async function caseCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'list') return showCases(values.join(' ') || undefined);
  if (subcommand === 'generate') {
    const positional = values.filter((value) => !value.startsWith('--'));
    const customer = await resolveCustomer(positional[0] ?? '');
    const result = await request<any>('/api/case-drafts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customer.id, force: values.includes('--force') }),
    });
    if (!jsonOutput) {
      if (result.reused) console.log(`已存在同数据指纹的案例草稿（${result.draftId}），幂等复用。`);
      else console.log(`案例生成任务已提交（任务 ${result.jobId}）。`);
    }
    if (values.includes('--wait') && result.jobId) {
      const jobs = await waitDraftJobs([result.jobId]);
      printDraftJobSummary(jobs);
      if (jobs.every((job) => job.status === 'succeeded')) {
        const body = await request<any>(`/api/case-drafts?customer_id=${encodeURIComponent(customer.id)}`);
        const draft = (body.drafts ?? []).find((item: any) => item.fingerprint === result.fingerprint)
          ?? (body.drafts ?? [])[0];
        if (draft) {
          const detail = await request<any>(`/api/case-drafts/${encodeURIComponent(draft.id)}`);
          printCaseDraft(detail.draft, detail.markdown ?? '', detail.draft?.fields?.coverage);
        }
      }
      return;
    }
    return print(result);
  }
  if (subcommand === 'regenerate') {
    const draftId = values.shift() ?? '';
    if (!draftId) throw new Error('case regenerate 缺少草稿 ID');
    const result = await request<any>(`/api/case-drafts/${encodeURIComponent(draftId)}/regenerate`, { method: 'POST' });
    if (!jsonOutput) console.log(`案例重新生成任务已提交（任务 ${result.jobId}）。`);
    if (values.includes('--wait') && result.jobId) {
      const jobs = await waitDraftJobs([result.jobId]);
      printDraftJobSummary(jobs);
    }
    return print(result);
  }
  const draftId = values.shift() ?? '';
  if (!draftId) throw new Error(`case ${subcommand || '(空)'} 缺少草稿 ID`);
  if (subcommand === 'show') {
    const body = await request<any>(`/api/case-drafts/${encodeURIComponent(draftId)}`);
    if (jsonOutput) return print(body);
    printCaseDraft(body.draft, body.markdown ?? '', body.draft?.fields?.coverage);
    for (const warning of body.warnings ?? []) console.log(`⚠ ${warning}`);
    return;
  }
  if (subcommand === 'update') {
    const version = Number(values.shift());
    if (!Number.isInteger(version) || version < 1) throw new Error('case update 版本必须是正整数');
    const body = parseObject(values.join(' '), 'case update');
    return print(await request(`/api/case-drafts/${encodeURIComponent(draftId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, version }),
    }));
  }
  if (subcommand === 'export') {
    // Word 导出：GET 二进制流写盘（--out 支持空格或 = 传值；缺省存当前目录，文件名取服务端下发的附件名）。
    const out = inlineOptionOf(values, '--out');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/case-drafts/${encodeURIComponent(draftId)}/export`);
    } catch (error) {
      throw new Error(`无法连接 ${baseUrl}；请先运行 npm run dev。${(error as Error).message}`);
    }
    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const disposition = response.headers.get('content-disposition') ?? '';
    const suggested = decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? '客户成功案例.docx');
    const target = out !== undefined && out.trim() ? out.trim() : join(process.cwd(), suggested);
    writeFileSync(target, buffer);
    if (!jsonOutput) console.log(`已导出 Word 文档：${target}（${(buffer.length / 1024).toFixed(1)} KB）`);
    return print({ id: draftId, file: target, bytes: buffer.length });
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
  throw new Error('case 子命令只允许 list/generate/show/regenerate/update/export/preview/publish');
}

function printWeeklyReport(report: any, markdown = '', customerName = ''): void {
  console.log(`${customerName ? `${customerName} · ` : ''}${report.weekStart} ~ ${report.weekEnd} · ${report.status === 'published' ? `已发布(${report.publishedPageId ?? ''})` : `草稿 v${report.version}`} · ${report.generator ?? 'unknown'}`);
  // 正文 = 服务端 renderWeeklyMarkdown 权威渲染的客户版 Markdown（与 Web 复制、Wiki 发布同源）；
  // 内部证据与统计不进默认输出，--json 保留完整结构化数据供审核与审计。
  if (markdown) console.log(`\n${markdown}`);
  else {
    const content = report.content ?? {};
    console.log(`\n## 一、本周工作概览\n${content.summary ?? '(空)'}`);
  }
  console.log(`\n（完整内部证据与统计：csm-agent weekly-report show ${report.id} --json）`);
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
        if (report) {
          const detail = await request<any>(`/api/weekly-reports/${encodeURIComponent(report.id)}`);
          printWeeklyReport(detail.report, detail.markdown, customer.name);
        }
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
    return printWeeklyReport(body.report, body.markdown ?? '');
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
    const body = await request<any>(`/api/weekly-reports/${encodeURIComponent(reportId)}/publish-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPageID: values.join(' ') }),
    });
    if (jsonOutput) return print(body);
    // 人类可读预览：客户版发布正文 + 内部信息警告 + 批准哈希（不执行发布）。
    if ((body.warnings ?? []).length) {
      console.log('⚠️ 内部信息提示（请先修正再发布）：');
      for (const warning of body.warnings) console.log(`  - ${warning}`);
      console.log('');
    }
    console.log(`发布页面标题：${body.args?.title ?? ''}\n`);
    console.log(String(body.args?.content ?? ''));
    console.log(`\n批准哈希：${body.approvalHash ?? ''}`);
    return;
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

/** 摘出可重复选项：同时支持 `--flag 值` 与 `--flag=值` 两种形态，返回其余参数与全部取值。 */
function extractRepeatableFlag(values: string[], name: string): { kept: string[]; found: string[] } {
  const kept: string[] = [];
  const found: string[] = [];
  const prefix = `--${name}=`;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === `--${name}`) {
      const next = values[i + 1];
      if (next !== undefined) { found.push(next); i++; }
    } else if (v.startsWith(prefix)) {
      found.push(v.slice(prefix.length));
    } else {
      kept.push(v);
    }
  }
  return { kept, found };
}

/** 按扩展名猜 MIME：CLI 没有浏览器的 file.type，服务端按 MIME 优先分类，猜错会走错通道。 */
const CLI_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.log': 'text/plain', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.xml': 'application/xml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/plain',
  '.py': 'text/plain', '.sh': 'text/plain', '.sql': 'text/plain', '.toml': 'text/plain', '.ini': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
};

function mimeFromName(name: string): string {
  return CLI_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

async function configCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'mcp' && !values.length) {
    // 「我的连接」：每人各自的 CRM/ONES/Hemory 凭证（网页设置页同一 API；保存仍走网页）。
    const body = await request<any>('/api/config/mcp');
    if (jsonOutput) return print(body);
    if (!body.servers?.length) return console.log('（尚未配置；请在网页「设置 → 我的连接」添加 CRM/ONES/Hemory）');
    for (const server of body.servers) {
      console.log(`${server.name}  [${server.transport}]${server.url ? ' ' + server.url : ''}${server.command ? ' ' + server.command + ' ' + (server.args ?? []).join(' ') : ''}`);
    }
    const failures: Array<[string, string]> = body.failures ?? [];
    if (failures.length) console.log(`未连接: ${failures.map(([name, err]) => `${name}(${err})`).join('; ')}`);
    return;
  }
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
    const visionRaw = flagOf(rest, 'vision');
    const protocolRaw = flagOf(rest, 'protocol');
    if (!provider || !model) throw new Error('config llm set 需要 --provider=<id> --model=<id>，可选 --base-url=<url> --api-key=<key> --protocol=openai|anthropic --vision=on|off');
    if (protocolRaw !== undefined && !['openai', 'anthropic'].includes(protocolRaw)) {
      throw new Error('--protocol 只接受 openai/anthropic（自定义端点协议：openai=…/chat/completions，anthropic=…/v1/messages）');
    }
    const payload: Record<string, string | boolean> = { provider, model };
    if (baseUrl !== undefined) payload.baseUrl = baseUrl;
    if (apiKey !== undefined) payload.apiKey = apiKey;
    if (protocolRaw !== undefined) payload.protocol = protocolRaw;
    if (visionRaw !== undefined) {
      const vision = ['on', 'true', '1', 'yes'].includes(visionRaw.toLowerCase()) ? true
        : ['off', 'false', '0', 'no'].includes(visionRaw.toLowerCase()) ? false : null;
      if (vision === null) throw new Error('--vision 只接受 on/off（视觉=图片输入；仅自定义端点需要显式声明，内置服务商按模型目录自动判定）');
      payload.vision = vision;
    }
    const result = await request<any>('/api/config/llm', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return print(result);
  }
  throw new Error('config 子命令只允许 llm / llm set / mcp');
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

/** 轮询草稿生成任务到终态（每 2 秒，默认上限 10 分钟，覆盖 3 次模型重试 + 指数退避的最坏路径）；轮询期间实时打印进度变化。返回最终任务列表。失败任务不创建批次，只能通过任务状态感知。 */
async function waitDraftJobs(jobIds: string[], maxAttempts = 300): Promise<any[]> {
  const pending = new Set(jobIds);
  const finished: any[] = [];
  const lastPrinted = new Map<string, string>();
  for (let attempt = 0; attempt < maxAttempts && pending.size; attempt++) {
    const ids = [...pending].join(',');
    const { jobs } = await request<any>(`/api/draft-jobs?ids=${encodeURIComponent(ids)}`);
    const byId = new Map<string, any>((jobs ?? []).map((job: any) => [job.id, job]));
    for (const id of [...pending]) {
      const job = byId.get(id);
      if (!job || job.status === 'succeeded' || job.status === 'failed' || job.stalled) {
        pending.delete(id);
        finished.push(job ?? { id, status: 'unknown' });
      } else if (job) {
        // 进度文案变化才打印：阶段边界/模型输出增长/重试提示逐条落到终端，超时不再黑箱。
        // 案例进度列是滚动多行日志（阶段行 + 末尾流式 tick），单行实时状态取最后一行。
        const line = String(job.progress ?? '').split('\n').filter(Boolean).pop() || (job.status === 'running' ? '正在处理' : '排队中');
        if (lastPrinted.get(id) !== line) {
          lastPrinted.set(id, line);
          process.stdout.write(`\r生成中：${line}${' '.repeat(8)}`);
          if (line.length > 100) process.stdout.write('\n');
        }
      }
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  process.stdout.write('\n');
  if (pending.size) throw new Error(`等待草稿生成超时（${pending.size} 个任务仍在后台运行，可稍后运行 csm-agent drafts 查看）`);
  return finished;
}

function printDraftJobSummary(jobs: any[]): void {
  const failed = jobs.filter((job) => job.status === 'failed');
  const stalled = jobs.filter((job) => job.stalled);
  for (const job of failed) console.log(`草稿生成任务 ${job.id} 失败：${job.error ?? '未知原因'}`);
  for (const job of stalled) console.log(`生成任务 ${job.id} 疑似因服务重启中断且未恢复，请重新生成重试`);
  for (const job of jobs.filter((job) => job.status !== 'failed' && !job.stalled && job.note)) console.log(`草稿生成任务 ${job.id}：${job.note}`);
  if (!failed.length && !stalled.length) console.log(`草稿生成完成（${jobs.length} 个任务）。运行 csm-agent drafts 查看新草稿。`);
  if (failed.length || stalled.length) process.exitCode = 2;
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
    // 整轮含分段模型调用与退避重试（最坏 ~21 分钟），等待上限放宽到 30 分钟等终态。
    return print(await waitSync(run.id, 1800));
  }
  if (subcommand === 'resegment') {
    // --recording <id>：定向重切单条录音（分段失败逃生门）；--all：全量重切库内全部录音。
    const inlineOption = (flag: string): string | undefined => {
      const index = values.findIndex((value) => value === flag || value.startsWith(`${flag}=`));
      if (index < 0) return undefined;
      const inline = values[index].startsWith(`${flag}=`);
      const raw = inline ? values[index].slice(flag.length + 1) : values[index + 1];
      return raw && !raw.startsWith('--') ? raw : undefined;
    };
    const recording = inlineOption('--recording');
    if (recording && values.includes('--all')) throw new Error('--recording 与 --all 不能同时使用');
    if (!recording && !values.includes('--all')) throw new Error('hemory resegment 需要 --all（全量重切）或 --recording <录音ID>（定向重切）');
    const run = await request<any>('/api/hemory/resegment', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recording ? { recordingId: recording } : { scope: 'all' }) });
    // 逐录音两阶段模型调用耗时较长，等待上限放宽到 60 分钟。
    const completed = await waitSync(run.id, 3600);
    const summary = completed.sourceStatus?.hemory ?? {};
    if (!jsonOutput) {
      if (recording) {
        console.log(`定向重切录音 ${recording}：${completed.status === 'succeeded' ? '成功' : '失败'}，片段 ${summary.count ?? '?'}。`);
      } else {
        console.log(`录音总数 ${summary.recordings ?? '?'}，成功 ${summary.recordings != null ? Number(summary.recordings) - Number(summary.failedRecordings ?? 0) : '?'}，`
          + `失败 ${summary.failedRecordings ?? 0}，新片段 ${summary.count ?? '?'}，丢弃段 ${summary.discardedSegments ?? '?'}。`);
      }
      if (summary.backupPath) console.log(`备份：${summary.backupPath}`);
      if (!recording) console.log('超过 7 个上海自然日的录音，其待归属片段需用 hemory inbox --days=N 或日期过滤查看。');
    }
    print(completed);
    if (completed.status !== 'succeeded') process.exitCode = 2;
    return;
  }
  if (subcommand === 'jobs') {
    // 分段任务只读视图：排查「录音卡在最大重试」时看 attempts/status/error；skipped=已处理完且转写未增长被闸门跳过。
    const body = await request<any>('/api/hemory/segmentation-jobs');
    if (jsonOutput) return print(body.jobs);
    const statusLabel: Record<string, string> = { pending: '待处理', running: '进行中', succeeded: '成功', failed: '失败', skipped: '已跳过' };
    console.table((body.jobs ?? []).map((job: any) => ({ id: job.id.slice(0, 8), recordingEvent: job.recordingEventId.slice(0, 8),
      status: statusLabel[job.status] ?? job.status, attempts: job.attempts, segments: job.segmentCount,
      generator: job.generator ?? '', error: String(job.error ?? '').slice(0, 60), updatedAt: job.updatedAt })));
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
      consumed: (item.consumedBy ?? []).join(',') || '',
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
  if (subcommand === 'repair') {
    // 存量孪生一次性修复：默认 dry-run 报告将继承的归属清单；--apply 执行继承并回填转写基准。
    const apply = values.includes('--apply');
    const result = await request<any>('/api/hemory/fragments/inherit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apply }) });
    if (jsonOutput) return print(result);
    console.log(apply ? `已修复 ${result.recordings} 个录音，继承归属 ${result.inherited} 条，回填转写基准 ${result.metaBackfilled} 个。`
      : `dry-run：${result.recordings} 个录音待修复（--apply 执行）。`);
    for (const item of result.details ?? []) {
      console.log(`\n录音 ${item.recordingId}（${item.title}）${item.metaBackfilled ? ' ＋回填转写基准' : ''}`);
      for (const entry of item.inherited ?? []) {
        const customer = entry.customerId ? ` → 客户 ${entry.customerId}` : '';
        console.log(`  ${entry.eventId} 继承 ${entry.status}${customer}（前驱 ${entry.predecessorId}，覆盖率 ${(Number(entry.overlapRatio) * 100).toFixed(0)}%）`);
      }
    }
    return;
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
  throw new Error('hemory 子命令只允许 sync/resegment/jobs/inbox/assign/clear/ignore/regenerate/repair');
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
  // 显示契约与 Web 草稿箱双 tab 一致：默认只列待处理批次（剔除纯已忽略/已作废），
  // --archived 只看纯已忽略/已作废批次；--all 恢复含已写入的全量视图（诊断/对账用）。
  const includeAll = rawArgs.includes('--all');
  const archivedOnly = rawArgs.includes('--archived');
  if (includeAll && archivedOnly) throw new Error('--archived 与 --all 不能同时使用');
  const customerInput = rawArgs.filter((arg) => arg !== '--all' && arg !== '--archived').join(' ').trim();
  const customer = customerInput ? await resolveCustomer(customerInput) : null;
  const query = `${customer ? `customer_id=${encodeURIComponent(customer.id)}` : ''}${customer && includeAll ? '&' : ''}${includeAll ? 'include=written' : ''}`;
  const body = await request<any>(`/api/draft-batches${query ? `?${query}` : ''}`);
  // 分组口径与 Web 端一致：actionableItemCount（服务端装饰）缺失时按条目状态本地回退。
  const actionableOf = (batch: any) => batch.actionableItemCount ?? (batch.items ?? []).filter((item: any) => !['written', 'dismissed', 'stale'].includes(item.status)).length;
  const batches = (body.batches ?? []).filter((batch: any) => includeAll || (archivedOnly ? actionableOf(batch) === 0 : actionableOf(batch) > 0));
  if (jsonOutput) return print(batches);
  const rows = batches.flatMap((batch: any) => (batch.items ?? []).map((item: any) => ({ batch: batch.id, id: item.id,
    customerId: item.customerId, type: item.type, status: item.status, regenerating: batch.regenerating ? '生成中' : '',
    version: item.version, target: item.targetObject || '', title: item.title })));
  if (!rows.length) {
    if (includeAll) console.log('没有任何草稿批次');
    else if (archivedOnly) console.log('没有已忽略/已作废批次（csm-agent drafts 查看待处理，drafts --all 查看全部）');
    else console.log('没有待处理草稿（csm-agent drafts --archived 查看已忽略/已作废，--all 查看全部）');
  }
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

/**
 * 草稿结构化编辑（与 Web 编辑弹窗同一契约/合并 API）：
 * --set 可用字段键（title/desc/hours/...）或中文标签（优先级/所属模块...），选项字段值可填
 * 中文标签或选项 UUID；无 --set 时进入交互模式逐字段提示（回车保留原值）。
 */
async function editDraftItem(id: string, setArgs: string[]): Promise<void> {
  if (!id) throw new Error('draft edit 缺少草稿 ID');
  const detail = await request<any>(`/api/draft-items/${encodeURIComponent(id)}`);
  const contract = detail.editContract;
  if (!contract) throw new Error('该草稿不支持表单编辑（或已写入/已忽略）；高级编辑可用 draft review 的 [e] 原始 JSON 路径');
  const byKey = new Map<string, any>((contract.fields ?? []).map((field: any) => [field.key, field]));
  const byLabel = new Map<string, any>((contract.fields ?? []).map((field: any) => [field.label, field]));
  const edits: Record<string, string> = {};
  const applySet = (name: string, rawValue: string) => {
    const field = byKey.get(name) ?? byLabel.get(name);
    if (!field) throw new Error(`未知字段「${name}」；可用字段: ${(contract.fields ?? []).map((item: any) => `${item.label}(${item.key})`).join('、')}`);
    const value = rawValue.trim();
    if (!value) throw new Error(`「${field.label}」不能为空`);
    if (field.type === 'select') {
      const match = (field.options ?? []).find((option: any) => option.label === value || option.value === value);
      if (!match) throw new Error(`「${field.label}」没有「${value}」这个选项；可选: ${(field.options ?? []).map((option: any) => option.label).join('、')}`);
      edits[field.key] = match.value;
    } else edits[field.key] = value;
  };
  for (const set of setArgs) {
    const eq = set.indexOf('=');
    if (eq <= 0) throw new Error(`--set 需要 键=值 形式（收到「${set}」）；字段名可用中文标签，如 --set 优先级=P1`);
    applySet(set.slice(0, eq), set.slice(eq + 1));
  }
  if (!setArgs.length) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`草稿 ${id} ｜ ${draftTypeLabel(detail.type)} ｜ ${detail.title}`);
      for (const field of contract.fields ?? []) {
        if (field.type === 'select') {
          const options = (field.options ?? []).map((option: any) => option.label).join('、');
          const answer = (await rl.question(`  ${field.label}（当前 ${field.options?.find((option: any) => option.value === field.value)?.label ?? field.value}；可选 ${options}）: `)).trim();
          if (answer) applySet(field.label, answer);
        } else {
          const answer = (await rl.question(`  ${field.label}（当前 ${String(field.value ?? '') || '（空）'}）: `)).trim();
          if (answer) applySet(field.label, answer);
        }
      }
    } finally { rl.close(); }
    if (!Object.keys(edits).length) { console.log('未修改任何字段'); return; }
  }
  const updated = await request<any>(`/api/draft-items/${encodeURIComponent(id)}`, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: detail.version, edits }) });
  if (jsonOutput) return print(updated);
  console.log('草稿已更新（编辑后须重新预览确认才会写入）：');
  printDraftItems([updated]);
}

async function draftCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'review') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('draft review 缺少批次 ID');
    return reviewDraftBatch(id);
  }
  if (subcommand === 'edit') {
    const id = values.shift() ?? '';
    const setArgs: string[] = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] === '--set') { const next = values[i + 1]; if (!next) throw new Error('--set 需要 键=值 参数'); setArgs.push(next); i++; }
      else if (values[i].startsWith('--set=')) setArgs.push(values[i].slice('--set='.length));
      else throw new Error(`无法识别的参数「${values[i]}」；用法: draft edit <草稿ID> [--set 优先级=P1 ...]`);
    }
    return editDraftItem(id, setArgs);
  }
  if (subcommand === 'retry') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('draft retry 缺少草稿 ID');
    return print(await request(`/api/draft-items/${encodeURIComponent(id)}/retry`, { method: 'POST' }));
  }
  if (subcommand === 'ignore') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('draft ignore 缺少草稿 ID');
    return print(await request(`/api/draft-items/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }));
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
    // 无参 = 列出最近失败的生成任务（失败明细可发现入口）；--active = 全局在途任务（进度/中断可见）；
    // 带 ID = 查询指定任务状态与片段明细。
    const active = values.includes('--active');
    const ids = values.filter((value) => value && value !== '--active');
    const { jobs } = ids.length
      ? await request<any>(`/api/draft-jobs?ids=${encodeURIComponent(ids.join(','))}`)
      : active
        ? await request<any>('/api/draft-jobs?status=active&kind=hemory')
        : await request<any>('/api/draft-jobs?status=failed&kind=hemory');
    if (jsonOutput) return print(jobs);
    if (!jobs.length) { console.log(ids.length ? '任务不存在（可能已清理或 ID 有误）' : active ? '没有进行中的生成任务' : '没有失败的生成任务'); return; }
    const { customers } = await request<any>('/api/customers');
    const nameOf = (customerId: string) => customers?.find((item: any) => item.id === customerId)?.name ?? customerId;
    for (const job of jobs) {
      console.log(`任务 ${job.id}`);
      console.log(`  客户：${nameOf(job.customerId)}${job.dateKey ? ` · ${job.dateKey}` : ''} · 状态 ${job.status} · 尝试 ${job.attempts} 次`);
      if (job.stalled) console.log('  中断：任务疑似因服务重启中断且未恢复，请重新生成重试');
      if (job.progress) console.log(String(job.progress).split('\n').map((line, index) => (index === 0 ? `  进度：${line}` : `        ${line}`)).join('\n'));
      if (job.error) console.log(`  错误：${job.error}`);
      if (job.note) console.log(`  备注：${job.note}`);
      if (job.fragments?.length) {
        console.log(`  涉及片段（${job.fragments.length} 个）：`);
        for (const fragment of job.fragments) console.log(`    ${fragment.id} · ${fragment.topic}${fragment.summary ? `：${String(fragment.summary).slice(0, 60)}` : ''}`);
      }
    }
    if (!ids.length) console.log(active ? '等待终态：csm-agent hemory assign <客户> <片段ID...> --wait（轮询期间实时打印进度）' : '重试：csm-agent hemory regenerate <片段ID...>（按天重建）');
    return;
  }
  throw new Error('draft 子命令只允许 review/edit/retry/ignore/regenerate/dismiss/jobs');
}

// ── backup：全量数据备份/恢复（run/list 走服务 API；restore 本地离线，服务必须不在运行） ──

async function backupCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'run') {
    const start = await request<any>('/api/backup/run', { method: 'POST' });
    const completed = await waitSync(start.id, 300);
    const archive = completed.sourceStatus?.backup?.archive;
    if (archive) console.log(`备份归档: ${archive}`);
    print(completed);
    if (completed.status === 'failed') process.exitCode = 2;
    return;
  }
  if (subcommand === 'list') {
    // 本地读归档目录（服务不在线也能列）；服务可达时附最近 run 与下次调度时刻（service status 同款降级）。
    const result: Record<string, unknown> = { backups: listBackups(dataDir()) };
    try {
      const service = await request<any>('/api/backups');
      result.lastRun = service.lastRun ?? null;
      result.nextScheduledAt = service.nextScheduledAt ?? null;
    } catch {
      result.service = '不可达（仅本地归档；服务运行时此处附带最近备份 run 与下次调度时刻）';
    }
    return print(result);
  }
  if (subcommand === 'restore') {
    const target = values.find((v) => !v.startsWith('--'));
    if (!target) throw new Error('用法: csm-agent backup restore <归档路径|id|latest> [--db-only] [--yes]');
    const dbOnly = values.includes('--db-only');
    const probeAlive = async (): Promise<boolean> => {
      try {
        await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
        return true;
      } catch {
        return false;
      }
    };
    // 恢复前预检：先把「服务在跑」的事实亮给用户（restoreBackup 停服务后会再探活兜底）。
    if (await probeAlive()) console.log('检测到服务正在运行，恢复过程中将停止并重启 launchd 托管的服务。');
    if (!values.includes('--yes')) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`将用 ${target} 覆盖现有数据（现有数据移入回滚目录${dbOnly ? '，--db-only 只恢复数据库' : ''}）。输入 y 继续: `)).trim().toLowerCase();
        if (answer !== 'y') throw new Error('已取消恢复');
      } finally {
        rl.close();
      }
    }
    const result = await restoreBackup(target, dataDir(), { dbOnly, probeAlive, onStep: (message) => console.log(message) });
    if (result.serviceRestarted) {
      process.stdout.write('等待服务重启');
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const version = await request<any>('/api/version');
          console.log(`\n服务已恢复运行（buildId ${version.buildId}）`);
          break;
        } catch {
          process.stdout.write('.');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } else {
      console.log('服务未由 launchd 托管：数据已恢复，如需启动请运行 csm-agent service install 或 npm run dev。');
    }
    return print(result);
  }
  throw new Error('backup 子命令只允许 run/list/restore');
}

async function serviceCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'install') {
    const port = Number(values.shift() ?? process.env.CSM_PORT ?? 3210);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 的整数');
    return print(installService(port));
  }
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
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, { headers: authHeaders() });
  if (!response.ok || !response.body) throw new Error(`SSE 连接失败: HTTP ${response.status}${response.status === 401 ? '（请先 csm-agent login）' : ''}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // 流式输出防重：text_delta 已实时打印的内容，跳过其后整段 text 事件。
  const streamedTexts = new Set<string>();
  let thinkingOpen = false;
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
      if (event.type === 'text_delta') {
        if (thinkingOpen) { console.log(); thinkingOpen = false; }
        const delta = event.delta ?? '';
        process.stdout.write(delta);
        streamedTexts.add((streamedTexts.size ? '\n' : '') + delta);
      } else if (event.type === 'thinking_delta') {
        if (!thinkingOpen) { process.stdout.write('\n〔思考〕'); thinkingOpen = true; }
        process.stdout.write(event.delta ?? '');
      } else if (event.type === 'text') {
        if (thinkingOpen) { console.log(); thinkingOpen = false; }
        const streamed = [...streamedTexts].join('');
        const remaining = event.text && streamed.includes(event.text) ? '' : event.text;
        if (remaining) console.log(`\n[Agent] ${remaining}`);
        streamedTexts.clear();
      } else if (event.type === 'tool_call') {
        console.log(`\n[工具调用] ${event.name} ${JSON.stringify(event.arguments)}`);
      } else if (event.type === 'tool_result' && event.name !== 'confirm_write') {
        console.log(`[工具结果] ${event.name}: ${String(event.result ?? '').slice(0, 800)}`);
      } else if (event.type === 'confirm') {
        await confirmDraft(sessionId, event.draft);
      } else if (event.type === 'turn_end') {
        if (event.usage && typeof event.usage.total === 'number') {
          console.log(`\n[Token] 本轮输入 ${event.usage.input} · 输出 ${event.usage.output} · 共 ${event.usage.total}`);
        }
        if (event.stopped === true) console.log('[已停止] 本轮对话已手动停止');
        await reader.cancel();
        return;
      }
    }
  }
}

async function runCustomerAgent(customerInput: string, prompt: string, attachPaths: string[] = []): Promise<void> {
  const customer = await resolveCustomer(customerInput);
  // 附件与网页「+」按钮同一 API/校验/落盘：CLI 只负责读文件 + base64 + 猜 MIME。
  const attachments = attachPaths.map((path) => {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      throw new Error(`附件读取失败: ${path}`);
    }
    const name = path.split('/').pop() ?? path;
    return { name, mimeType: mimeFromName(name), data: raw.toString('base64') };
  });
  if (attachments.length) console.log(`附件 ${attachments.length} 个：${attachments.map((a) => a.name).join('、')}`);
  // 会话与客户解耦：POST 不带 customerId；客户全称注入指令文本，本地工具按 customer_name 唯一解析取数。
  const session = await request<any>('/api/sessions', { method: 'POST' });
  console.log(`Agent 会话 ${session.id}（客户：${customer.name}——会话不绑定客户，客户名已随指令发给 agent）`);
  const message = `（客户：${customer.name}）${prompt ? `\n${prompt}` : ''}`;
  let interrupted = false;
  // Ctrl+C 先通知服务端真正停止本轮（挂起中的确认草稿按拒绝处理），再退出。
  const onSigint = () => {
    interrupted = true;
    console.log('\n正在停止对话…');
    request(`/api/sessions/${session.id}/stop`, { method: 'POST' }).catch(() => {});
  };
  process.on('SIGINT', onSigint);
  try {
    const stream = streamAgent(session.id);
    await request(`/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attachments.length ? { message, attachments } : { message }),
    });
    await stream;
    if (interrupted) process.exitCode = 130;
  } finally {
    process.off('SIGINT', onSigint);
  }
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

async function stopSession(id: string): Promise<void> {
  if (!id) throw new Error('sessions stop 缺少会话 ID');
  const result = await request(`/api/sessions/${id}/stop`, { method: 'POST' });
  print(result);
  console.log('已请求停止该会话当前进行中的对话（挂起中的确认草稿按拒绝处理）。');
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
  if (subcommand === 'stop') return stopSession(values.shift() ?? '');
  throw new Error('sessions 子命令只允许 list/show/archive/unarchive/stop');
}

async function doctor(): Promise<void> {
  const [list, llm, search] = await Promise.all([customers(), request('/api/config/llm'), request('/api/config/search')]);
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
    sampleTimelineEvents: overview?.timeline?.length ?? 0, llm, webSearch: search });
}

// ── 登录与账号（多人共用：密码登录；PAT 供 CI 复用，admin 管理用户） ──

/** 静默密码输入：TTY 下 terminal 模式 + 吞掉输出的可写流 = 不回显；管道/CI（非 TTY）直接读一行。 */
async function promptPassword(): Promise<string> {
  const isTty = process.stdin.isTTY === true;
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: isTty });
  try {
    if (isTty) process.stdout.write('密码: ');
    return await rl.question('');
  } finally {
    rl.close();
  }
}

async function loginCommand(usernameArg?: string): Promise<void> {
  const username = (usernameArg ?? '').trim() || await (async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    try { return (await rl.question('用户名: ')).trim(); } finally { rl.close(); }
  })();
  if (!username) throw new Error('用户名不能为空');
  const password = await promptPassword();
  if (!password) throw new Error('密码不能为空');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, tokenName: `cli@${hostname()}` }),
    });
  } catch (error) {
    throw new Error(`无法连接 ${baseUrl}: ${(error as Error).message}`);
  }
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `登录失败 (HTTP ${response.status})`);
  if (!body.token) throw new Error('服务端未返回令牌（请升级服务端到支持多用户的版本）');
  saveCliAuthEntry({ token: body.token, username: body.user?.username ?? username, savedAt: new Date().toISOString() });
  console.log(`已登录 ${baseUrl}，身份: ${body.user?.displayName || body.user?.username || username}${body.user?.role === 'admin' ? '（管理员）' : ''}`);
}

async function logoutCommand(): Promise<void> {
  const auth = currentCliAuth();
  if (!auth) {
    console.log(`${baseUrl} 未保存登录凭证`);
    return;
  }
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    // 服务端不可达/令牌已失效也照样清理本地凭证。
    if (!/未登录|无法连接/.test((error as Error).message)) throw error;
  }
  saveCliAuthEntry(undefined);
  console.log(`已退出 ${baseUrl}（身份 ${auth.username}）`);
}

async function whoamiCommand(): Promise<void> {
  const auth = currentCliAuth();
  if (!auth) {
    console.log(`未登录（目标 ${baseUrl}；运行 csm-agent login）`);
    return;
  }
  const me = await request<any>('/api/auth/me');
  if (jsonOutput) print({ baseUrl, savedUsername: auth.username, ...me.user });
  else console.log(`${baseUrl}: ${me.user.displayName || me.user.username}（${me.user.username}，${me.user.role === 'admin' ? '管理员' : '成员'}）`);
}

async function usersCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'list') {
    const body = await request<{ users: any[] }>('/api/users');
    if (jsonOutput) return print(body.users);
    if (!body.users.length) return console.log('（暂无用户）');
    for (const user of body.users) {
      console.log(`${String(user.id).padStart(3)}  ${user.username.padEnd(16)} ${String(user.displayName).padEnd(12)} ${user.role === 'admin' ? '管理员' : '成员'}${user.status === 'disabled' ? '（已禁用）' : ''}`);
    }
    return;
  }
  if (subcommand === 'create') {
    const username = values.shift() ?? '';
    if (!username) throw new Error('用法: users create <用户名> [--display-name=显示名] [--role=member|admin] [--password=密码]');
    const body = await request<any>('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        displayName: flagOf(values, 'display-name'),
        role: flagOf(values, 'role') === 'admin' ? 'admin' : 'member',
        ...(flagOf(values, 'password') ? { password: flagOf(values, 'password') } : {}),
      }),
    });
    if (jsonOutput) return print(body);
    console.log(`已创建用户 ${body.user.username}（${body.user.role === 'admin' ? '管理员' : '成员'}）`);
    if (body.initialPassword) console.log(`初始密码（仅此一次显示）: ${body.initialPassword}`);
    return;
  }
  // 其余子命令都按用户名定位目标：list 一次拿全量再本地匹配。
  const username = values.shift() ?? '';
  if (!username) throw new Error('缺少用户名参数');
  const { users } = await request<{ users: any[] }>('/api/users');
  const target = users.find((user) => user.username === username);
  if (!target) throw new Error(`用户 ${username} 不存在`);
  if (subcommand === 'reset-password') {
    const supplied = flagOf(values, 'password');
    const body = await request<any>(`/api/users/${target.id}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(supplied ? { password: supplied } : {}),
    });
    if (jsonOutput) return print({ ok: true, ...(body.password ? { password: body.password } : {}) });
    console.log(`已重置 ${username} 的密码（其在线会话已收回）`);
    if (body.password) console.log(`新密码（仅此一次显示）: ${body.password}`);
    return;
  }
  if (subcommand === 'set-role') {
    const role = values.shift() ?? '';
    if (role !== 'admin' && role !== 'member') throw new Error('角色只允许 admin / member');
    await request(`/api/users/${target.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
    console.log(`${username} 已设为${role === 'admin' ? '管理员' : '成员'}`);
    return;
  }
  if (subcommand === 'bind-wecom') {
    const wecomUserid = values.shift() ?? '';
    if (!username || !wecomUserid) throw new Error('用法: users bind-wecom <用户名> <企微 userid>（企微管理后台通讯录成员账号）');
    await request(`/api/users/${target.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wecomUserid }) });
    console.log(`已绑定 ${username} ↔ 企微 userid ${wecomUserid}（扫码登录即入该账号）`);
    return;
  }
  if (subcommand === 'enable' || subcommand === 'disable') {
    await request(`/api/users/${target.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: subcommand === 'enable' ? 'active' : 'disabled' }) });
    console.log(`${username} 已${subcommand === 'enable' ? '启用' : '禁用（其在线会话已收回）'}`);
    return;
  }
  throw new Error(`未知 users 子命令: ${subcommand}（可用: list/create/reset-password/set-role/bind-wecom/enable/disable）`);
}

async function tokenCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'create') {
    const body = await request<any>('/api/auth/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: flagOf(values, 'name') ?? `cli@${hostname()}` }),
    });
    if (jsonOutput) return print(body);
    console.log(`已创建个人访问令牌「${body.tokenRecord.name}」（仅此一次显示）:`);
    console.log(body.token);
    console.log('用法: 保存到环境变量后以 Authorization: Bearer <token> 访问 API。');
    return;
  }
  if (subcommand === 'list') {
    const body = await request<{ tokens: any[] }>('/api/auth/tokens');
    if (jsonOutput) return print(body.tokens);
    if (!body.tokens.length) return console.log('（暂无令牌）');
    for (const token of body.tokens) console.log(`${token.id}  ${token.name.padEnd(24)} 创建 ${token.createdAt}  最近使用 ${token.lastUsedAt}`);
    return;
  }
  if (subcommand === 'revoke') {
    const id = values.shift() ?? '';
    if (!id) throw new Error('用法: token revoke <令牌ID>（token list 查看）');
    const body = await request<{ ok: boolean }>(`/api/auth/tokens/${id}`, { method: 'DELETE' });
    console.log(body.ok ? '已吊销' : '令牌不存在或已吊销');
    return;
  }
  throw new Error(`未知 token 子命令: ${subcommand}（可用: create/list/revoke）`);
}

// ── 个人中心（CLI 侧）：查看本人账号与头像；上传/移除头像（与网页个人中心同一 API）。 ──
async function profileCommand(subcommand: string, values: string[]): Promise<void> {
  if (subcommand === 'avatar') {
    if (rawArgs.includes('--remove')) {
      await request('/api/auth/me/avatar', { method: 'DELETE' });
      return console.log('已移除头像');
    }
    const file = values.shift() ?? '';
    if (!file) throw new Error('用法: profile avatar <图片路径>（PNG/JPEG/WebP，≤2MB）或 profile avatar --remove');
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      throw new Error(`读取文件失败: ${(error as Error).message}`);
    }
    const ext = extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : '';
    if (!mime) throw new Error('只支持 PNG / JPEG / WebP 图片');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('图片超过 2MB 上限（网页端会自动压缩，CLI 请自行压缩后上传）');
    await request('/api/auth/me/avatar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: bytes.toString('base64'), mimeType: mime }),
    });
    return console.log(`已上传头像（${mime}，${bytes.length} 字节）`);
  }
  const me = await request<any>('/api/auth/me');
  if (jsonOutput) return print(me);
  console.log(`${baseUrl}: ${me.user.displayName || me.user.username}（${me.user.username}，${me.user.role === 'admin' ? '管理员' : '成员'}）`);
  console.log(`头像: ${me.avatarConfigured ? '已设置' : '未设置（profile avatar <图片路径> 上传）'}`);
}

async function main(): Promise<void> {
  const command = args.shift() ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'version' || command === '--version' || command === '-v') return version();
  if (command === 'capabilities') return print(CLI_CAPABILITIES);
  if (command === 'serve') return serve(args.shift());
  if (command === 'doctor') return doctor();
  if (command === 'login') return loginCommand(args.shift());
  if (command === 'logout') return logoutCommand();
  if (command === 'whoami') return whoamiCommand();
  if (command === 'profile') return profileCommand(args.shift() ?? '', args);
  if (command === 'users') return usersCommand(args.shift() ?? 'list', args);
  if (command === 'token') return tokenCommand(args.shift() ?? '', args);
  if (command === 'config') return configCommand(args.shift() ?? '', args);
  if (command === 'customers') return showCustomers(args);
  if (command === 'customer') return showCustomer(args.join(' '));
  if (command === 'webintel') {
    const rotation = rawArgs.includes('--rotation');
    const history = rawArgs.includes('--history');
    const input = args.filter((item) => item !== '--rotation' && item !== '--history').join(' ').trim();
    if (rotation && history) throw new Error('--rotation 与 --history 不能同时使用');
    if (rotation && input) throw new Error('--rotation 不接受客户参数（单客户强制检索直接用 webintel <客户ID或名称>）');
    if (history && !input) throw new Error('--history 需要客户参数：webintel <客户ID或名称> --history');
    return webintel(input, { rotation, history });
  }
  if (command === 'opportunities') {
    const refresh = rawArgs.includes('--refresh');
    const input = args.filter((item) => item !== '--refresh' && !item.startsWith('--refresh=')).join(' ');
    return opportunitiesCommand(input, { refresh });
  }
  if (command === 'timeline') {
    const customer = args.shift() ?? '';
    return showTimeline(customer, args.shift());
  }
  if (command === 'workhours') return showWorkhours(args.join(' '));
  if (command === 'actions') return showActions(args.join(' ') || undefined);
  if (command === 'action') return actionCommand(args.shift() ?? '', args);
  if (command === 'alerts') {
    // 首参是 flag（如 alerts --status=resolved）时默认走 list，不吞子命令。
    const sub = args[0] && !args[0].startsWith('--') ? args.shift()! : 'list';
    return alertsCommand(sub, args);
  }
  if (command === 'cases') return showCases(args.join(' ') || undefined);
  if (command === 'case') return caseCommand(args.shift() ?? '', args);
  if (command === 'weekly-report') return weeklyReportCommand(args.shift() ?? '', args);
  if (command === 'wiki') return wikiCommand(args.shift() ?? '', args);
  if (command === 'sync') return sync(args.join(' ') || undefined);
  if (command === 'hemory') return hemoryCommand(args.shift() ?? '', args);
  if (command === 'drafts') return showDrafts(args);
  if (command === 'draft') return draftCommand(args.shift() ?? '', args);
  if (command === 'service') return serviceCommand(args.shift() ?? 'status', args);
  if (command === 'backup') return backupCommand(args.shift() ?? '', args);
  if (command === 'update') return runUpdate();
  if (command === 'uninstall') return runUninstall({ purge: rawArgs.includes('--purge'), yes: rawArgs.includes('--yes') });
  if (command === 'sessions') return sessionsCommand(args.shift() ?? 'list', args, rawArgs);
  if (command === 'ones') {
    const sub = args.shift() ?? '';
    if (sub === 'fields') return showOnesDeskFields(rawArgs.includes('--verify'));
    throw new Error('ones 子命令只允许 fields');
  }
  if (command === 'agent') {
    // --attach <路径>（可重复、--attach=路径 亦可）从指令文本中摘除，不拼进 message。
    const { kept, found: attachPaths } = extractRepeatableFlag(args, 'attach');
    const customer = kept.shift() ?? '';
    const prompt = kept.join(' ').trim();
    if (!prompt && !attachPaths.length) throw new Error('agent 命令需要客户和指令（或 --attach 附件）');
    return runCustomerAgent(customer, prompt, attachPaths);
  }
  if (command === 'api') return rawApi(args.shift() ?? '', args.shift() ?? '', args.join(' ') || undefined);
  throw new Error(`未知命令: ${command}；运行 npm run cli -- help 查看用法`);
}

main().catch((error) => {
  console.error(`错误: ${(error as Error).message}`);
  process.exitCode = 1;
});
