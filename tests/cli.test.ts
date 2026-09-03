import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
}

test('package exposes the canonical global CLI and verification gate', () => {
  assert.equal(packageJson.bin?.['csm-agent'], 'dist/cli.js');
  assert.match(packageJson.scripts?.verify ?? '', /cli:smoke/);
  assert.equal(readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8').split('\n')[0], '#!/usr/bin/env node');
});

test('CLI exposes machine-readable core capability coverage without a running server', () => {
  const result = runCli('capabilities', '--json');
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout) as Array<{ command: string; workflow: string; api: string[] }>;
  const commands = new Set(capabilities.map((item) => item.command));
  for (const command of ['serve', 'doctor', 'config', 'customers', 'customer', 'webintel', 'opportunities', 'timeline', 'workhours', 'action', 'case', 'sync', 'hemory', 'draft', 'service', 'agent', 'sessions', 'api']) {
    assert.ok(commands.has(command), `missing CLI capability: ${command}`);
  }
  // 公开动态检索能力：CLI 命令与强制刷新端点同源。
  assert.ok(capabilities.some((item) => item.workflow === 'web-intelligence-refresh' && item.api.includes('/api/customers/:id/web-intel')));
  // 增购机会 v2：LLM 假设分析能力（读 overview + 强制重新分析端点）与展示口径说明。
  const opportunityCapability = capabilities.find((item) => item.workflow === 'opportunity-analysis');
  assert.ok(opportunityCapability && opportunityCapability.api.includes('POST /api/customers/:id/opportunities/refresh'));
  assert.match(opportunityCapability.notes ?? '', /前 5 条/);
  // 企业微信待办同步能力已整体移除：命令、工作流与 API 都不得再出现。
  assert.ok(!commands.has('wecom'), 'wecom CLI command should be removed');
  assert.ok(!capabilities.some((item) => item.workflow === 'wecom-todo' || item.api.some((api) => api.includes('/api/wecom/'))),
    'wecom-todo workflow and /api/wecom/* endpoints should be removed');
  assert.ok(capabilities.some((item) => item.workflow === 'action-items' && item.api.includes('/api/action-items/:id/complete')));
  // 行动「接受」流程已整体移除（草稿确认即视为接受）：bulk-accept API 不得再出现。
  assert.ok(!capabilities.some((item) => item.api.includes('/api/action-items/bulk-accept')),
    'bulk-accept API should be removed from capabilities');
  assert.ok(capabilities.some((item) => item.workflow === 'action-items' && item.api.includes('/api/action-items/bulk-complete')));
  assert.ok(capabilities.some((item) => item.workflow === 'case-drafts' && item.api.includes('/api/case-drafts/:id/publish')));
  assert.ok(capabilities.some((item) => item.workflow === 'case-drafts' && item.api.includes('/api/case-drafts/:id/regenerate')));
  assert.ok(capabilities.some((item) => item.workflow === 'case-drafts' && item.api.includes('/api/case-drafts/:id/export')));
  const caseCapability = capabilities.find((item) => item.workflow === 'case-drafts');
  assert.deepEqual(caseCapability.editableFields, ['title', 'company_info', 'business_scope', 'competitive_strategy', 'project_background', 'business_status', 'demands', 'solution_sections', 'value_items', 'lessons', 'summary', 'system_usage', 'milestones']);
  assert.ok(caseCapability.readOnlyFields.includes('claim_evidence') && caseCapability.readOnlyFields.includes('context_snapshot') && caseCapability.readOnlyFields.includes('figures'));
  // 生成进度可见契约：case/weekly-report 能力含 draft-jobs 轮询端点与 --wait 进度说明。
  assert.ok(caseCapability.api.includes('/api/draft-jobs'));
  assert.match(caseCapability.notes ?? '', /实时打印生成进度/);
  const weeklyCapability = capabilities.find((item) => item.workflow === 'weekly-reports');
  assert.ok(weeklyCapability.api.includes('/api/draft-jobs'));
  assert.match(weeklyCapability.notes ?? '', /实时打印生成进度/);
  assert.ok(capabilities.some((item) => item.workflow === 'customer-agent' && item.api.includes('/api/sessions/:id/confirm')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-attribution' && item.api.includes('/api/hemory/fragments/attribution')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-attribution' && item.api.includes('/api/hemory/fragments/ignore')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-attribution' && item.api.includes('/api/hemory/resegment')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-batches/:id/confirm')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-batches/:id/regenerate')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-items/:id/dismiss')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-jobs')));
  // 草稿生成进度可见契约：drafts 能力含全局在途查询端点与 --active 说明；hemory 能力含 --wait 进度说明。
  // （hemory-drafts 工作流有 drafts/draft 两条能力，find 会先命中无 notes 的 draft 条目——按 api 精确定位。）
  const draftsReadCapability = capabilities.find((item) => item.api.includes('/api/draft-jobs?status=active&kind=hemory'));
  assert.ok(draftsReadCapability, 'drafts 能力应含全局在途查询端点');
  assert.match(draftsReadCapability.notes ?? '', /draft jobs --active/);
  const heretryCapability = capabilities.find((item) => item.workflow === 'hemory-attribution');
  assert.match(heretryCapability.notes ?? '', /实时打印生成进度/);
  assert.ok(capabilities.some((item) => item.workflow === 'runtime-config' && item.api.includes('PUT /api/config/llm')));
  assert.ok(capabilities.some((item) => item.workflow === 'agent-sessions' && item.api.includes('/api/sessions?include=archived')));
  assert.ok(capabilities.some((item) => item.workflow === 'agent-sessions' && item.api.includes('/api/sessions/:id/export')));
  assert.ok(capabilities.some((item) => item.workflow === 'agent-sessions' && item.api.includes('/api/sessions/:id/stop')));
  assert.ok(capabilities.some((item) => item.workflow === 'weekly-reports' && item.api.includes('/api/customers/:id/weekly-reports')));
  assert.ok(capabilities.some((item) => item.workflow === 'weekly-reports' && item.api.includes('/api/weekly-reports/:id/publish-preview')));
  assert.ok(capabilities.some((item) => item.workflow === 'weekly-reports' && item.api.includes('/api/weekly-reports/:id/publish')));
  assert.ok(capabilities.some((item) => item.workflow === 'ones-wiki-browse' && item.api.includes('/api/ones-wiki/spaces')));
  assert.ok(capabilities.some((item) => item.workflow === 'ones-wiki-browse' && item.api.includes('/api/ones-wiki/pages')));
  // 旧进程检测：doctor 挂 /api/version 比对服务端与本地构建。
  assert.ok(capabilities.some((item) => item.workflow === 'diagnostics' && item.api.includes('/api/version')));
  // 风险预警名单：读列表（三种 status）+ 消除端点，消除必须填写原因/动作。
  const alertCapability = capabilities.find((item) => item.workflow === 'risk-watchlist');
  assert.ok(alertCapability, 'risk-watchlist capability missing');
  assert.ok(alertCapability.api.includes('POST /api/alerts/:id/resolve'));
  assert.ok(alertCapability.api.includes('/api/alerts?status=resolved'));
  assert.match(alertCapability.notes ?? '', /必须填写原因\/动作/);
});

test('CLI provides standard global help and version commands', () => {
  const help = runCli('help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /csm-agent serve/);
  assert.match(help.stdout, /csm-agent customers .*--sort default\|renewal_date\|renewal_amount/);
  assert.match(help.stdout, /csm-agent capabilities/);
  // 增购机会命令：--refresh 强制重新分析与来源标注说明。
  assert.match(help.stdout, /csm-agent opportunities <客户ID或名称> \[--refresh\] \[--json\]/);
  assert.match(help.stdout, /逐条附信息来源/);
  assert.doesNotMatch(help.stdout, /action accept/);
  assert.match(help.stdout, /csm-agent action complete <待办ID\.\.\.> \[--outcome <实际结果>\]/);
  // 两态模型：批量完成仅未完成生效，已完成跳过。
  assert.match(help.stdout, /仅未完成状态生效，已完成跳过/);
  assert.doesNotMatch(help.stdout, /待处理\/进行中/);
  assert.match(help.stdout, /csm-agent case generate <客户ID或名称> \[--force\] \[--wait\]/);
  assert.match(help.stdout, /--wait 轮询任务到终态并实时打印生成进度/);
  assert.match(help.stdout, /csm-agent case show <草稿ID> \[--json\]/);
  assert.match(help.stdout, /csm-agent case regenerate <草稿ID> \[--wait\]/);
  assert.match(help.stdout, /公司概况\/项目管理\/需求管理\/知识管理\/行业动态\/招投标\/中标采购/);
  assert.match(help.stdout, /默认输出可直接对外的案例 Markdown（与复制\/Wiki 发布同源）/);
  // v7：case show 帮助须声明配图图注输出与 --json 的 figures 审核对象。
  assert.match(help.stdout, /有配图时列出图注一行/);
  assert.match(help.stdout, /claim_evidence\/figures\/context_snapshot\/unknowns/);
  assert.doesNotMatch(help.stdout, /evidence_map\/unknowns/);
  assert.match(help.stdout, /只更新 title 与 fields 中的公开正文/);
  assert.match(help.stdout, /csm-agent case export <草稿ID> \[--out <文件路径>\]/);
  assert.match(help.stdout, /导出 Word 文档/);
  assert.match(help.stdout, /csm-agent case publish/);
  assert.match(help.stdout, /csm-agent weekly-report generate <客户ID或名称> \[YYYY-MM-DD\] \[--force\] \[--wait\]/);
  assert.match(help.stdout, /默认输出客户版周报 Markdown（与复制\/Wiki 发布同源）/);
  assert.match(help.stdout, /csm-agent weekly-report publish <周报ID> <版本> <ONES父页面ID> <批准哈希>/);
  assert.match(help.stdout, /csm-agent wiki spaces \[--json\]/);
  assert.match(help.stdout, /csm-agent wiki pages --space <页面组ID>/);
  assert.match(help.stdout, /csm-agent hemory assign/);
  assert.match(help.stdout, /csm-agent hemory ignore/);
  assert.match(help.stdout, /csm-agent hemory resegment --all/);
  assert.match(help.stdout, /csm-agent hemory inbox \[YYYY-MM-DD\] \[--days N\] \[--from HH:MM\] \[--to HH:MM\]/);
  assert.match(help.stdout, /csm-agent draft review/);
  assert.match(help.stdout, /csm-agent draft ignore <草稿ID>/);
  assert.match(help.stdout, /csm-agent draft regenerate/);
  assert.match(help.stdout, /csm-agent service install/);
  assert.match(help.stdout, /csm-agent sessions \[list\] \[--all\] \[--json\]/);
  assert.match(help.stdout, /csm-agent sessions show <会话ID>/);
  assert.match(help.stdout, /csm-agent sessions archive\|unarchive <会话ID>/);
  assert.match(help.stdout, /csm-agent sessions stop <会话ID>/);
  assert.match(help.stdout, /挂起中的确认草稿按拒绝处理/);
  // 风险预警名单：列表三种状态 + 消除必须写明原因/动作。
  assert.match(help.stdout, /csm-agent alerts \[--status active\|resolved\|all\]/);
  assert.match(help.stdout, /csm-agent alerts resolve <预警ID> --note <原因\/动作>/);
  assert.match(help.stdout, /消除风险必须写明原因或动作/);

  const version = runCli('--version');
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('alerts resolve requires a note and supports space/equal flag forms', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const command = source.match(/async function alertsCommand[\s\S]*?\n  }\n/)?.[0];
  assert.ok(command, 'alertsCommand source was not found');
  // --note 走 inlineOptionOf（同时支持 `--note 值` 与 `--note=值`），缺失即报错拦截。
  assert.match(command, /inlineOptionOf\(values, '--note'\)/);
  assert.match(command, /消除风险必须填写原因\/动作/);
  assert.match(command, /\/api\/alerts\/\$\{encodeURIComponent\(id\)\}\/resolve/);
});

test('draft regenerate waits for the new batch and points to the review step', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const handler = source.match(/async function regenerateDraftBatch[\s\S]*?\n}\n\nasync function draftCommand/)?.[0];

  assert.ok(handler, 'regenerateDraftBatch source was not found');
  assert.match(handler, /waitForRegeneratedBatch/);
  assert.match(handler, /draft review/);
  assert.match(handler, /已作废/);
});

test('weekly-report CLI defaults to the customer-facing markdown and keeps evidence behind --json', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const printer = source.match(/function printWeeklyReport[\s\S]*?\n}\n\nasync function weeklyReportCommand/)?.[0];

  // 显示契约：默认输出 = 服务端权威渲染的客户版 Markdown；内部证据只留在 --json。
  assert.ok(printer, 'printWeeklyReport source was not found');
  assert.match(printer, /markdown/);
  assert.doesNotMatch(printer, /统计: 沟通/);
  assert.doesNotMatch(printer, /口径说明/);
  assert.match(printer, /--json/);
  // show 子命令走详情接口取 markdown。
  const showHandler = source.match(/if \(subcommand === 'show'\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(showHandler, 'weekly-report show handler was not found');
  assert.match(showHandler, /body\.markdown/);
});

test('hemory CLI covers ignore restore and incremental sync semantics', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const handler = source.match(/async function hemoryCommand[\s\S]*?\n}\n\n\/\/ 草稿确认视图/)?.[0];
  assert.ok(handler, 'hemoryCommand source was not found');
  assert.match(handler, /hemory\/fragments\/ignore/);
  assert.match(handler, /\/api\/hemory\/sync/);
  assert.match(handler, /--days=/);
  assert.match(handler, /sync\/resegment\/jobs\/inbox\/assign\/clear\/ignore\/regenerate/);
});

test('hemory inbox filters by customer and status; regenerate rebuilds per customer-day', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const handler = source.match(/async function hemoryCommand[\s\S]*?\n}\n\n\/\/ 草稿确认视图/)?.[0];
  assert.ok(handler, 'hemoryCommand source was not found');
  // inbox：--customer 经 resolveCustomer 解析为 customer_id 过滤；--status 白名单校验；表格含客户名列。
  assert.match(handler, /--customer=.*resolveCustomer\(customerOption\)/s);
  assert.match(handler, /--status 只允许 pending\/all\/confirmed\/ignored/);
  assert.match(handler, /customer_id=\$\{encodeURIComponent\(customer\.id\)\}/);
  assert.match(handler, /customers\?\.find\(\(c: any\) => c\.id === item\.customerId\)\?\.name/);
  // regenerate：片段级强制重生成端点，--wait 复用草稿任务轮询。
  assert.match(handler, /\/api\/hemory\/fragments\/regenerate/);
  assert.match(handler, /按天强制重生成：选中片段决定要重建的「客户\+上海日」，各天全量已确认片段参与/);
  assert.match(handler, /hemory regenerate 缺少片段 ID/);
});

test('hemory inbox supports Shanghai time-of-day range filters with since/until', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const handler = source.match(/async function hemoryCommand[\s\S]*?\n}\n\n\/\/ 草稿确认视图/)?.[0];
  assert.ok(handler, 'hemoryCommand source was not found');
  // --from/--to 解析 HH:MM、必须与日期同用，并按上海时区组装 since/until 闭区间（与 Web 同一契约）。
  assert.match(handler, /--from=\\d\{2\}:\\d\{2\}/);
  assert.match(handler, /--to=\\d\{2\}:\\d\{2\}/);
  assert.match(handler, /--from\/--to 时间段过滤需要同时指定日期/);
  assert.match(handler, /`\$\{date\}T\$\{from\.slice\(7\)\}:00\+08:00`/);
  assert.match(handler, /`\$\{date\}T\$\{to\.slice\(5\)\}:59\+08:00`/);
  assert.match(handler, /&since=\$\{encodeURIComponent\(since\)\}/);
  assert.match(handler, /&until=\$\{encodeURIComponent\(until\)\}/);
});

test('hemory resegment waits for the async run and reports v2 resegment statistics', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const handler = source.match(/async function hemoryCommand[\s\S]*?\n}\n\n\/\/ 草稿确认视图/)?.[0];
  assert.ok(handler, 'hemoryCommand source was not found');
  assert.match(handler, /\/api\/hemory\/resegment/);
  assert.match(handler, /scope: 'all'/);
  assert.match(handler, /waitSync\(run\.id, 3600\)/);
  assert.match(handler, /discardedSegments/);
  assert.match(handler, /--days=N/);
});

test('draft review prints structured display fields with raw JSON behind --json', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const printer = source.match(/function printDraftItems[\s\S]*?\n}\n\nfunction draftTypeLabel/)?.[0];
  const handler = source.match(/async function reviewDraftBatch[\s\S]*?\n}\n\nasync function waitForRegeneratedBatch/)?.[0];
  const listing = source.match(/async function showDrafts[\s\S]*?\n}\n\nasync function editBatchItems/)?.[0];

  // CLI 与 Web 共用服务端 displayFields：逐行结构化输出，原始 JSON 仅在 --json 时输出。
  assert.ok(printer, 'printDraftItems source was not found');
  assert.match(printer, /item\.displayFields\?\.length/);
  assert.match(printer, /\$\{field\.label\}: \$\{field\.value\}/);
  assert.match(printer, /校验错误: \$\{item\.validationErrors\.join\('；'\)\}/);
  assert.ok(handler, 'reviewDraftBatch source was not found');
  assert.match(handler, /if \(jsonOutput\) print\(batch\)/);
  assert.match(handler, /printDraftItems\(batch\.items \?\? \[\]\)/);
  assert.match(handler, /printDraftItems\(\(confirmed as any\)\.items \?\? \[\]\)/);
  assert.ok(listing, 'showDrafts source was not found');
  assert.match(listing, /target: item\.targetObject \|\| ''/);
});

test('actions listing renders two-state Chinese status labels (CLI parity with web tabs)', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const listing = source.match(/async function showActions[\s\S]*?\n}\n\nasync function showCases/)?.[0];

  // 显示契约：CLI 表格状态列与 Web 双 tab 同口径（未完成/已完成中文化），--json 保持 API 原值。
  assert.ok(listing, 'showActions source was not found');
  assert.match(listing, /action\.status === 'completed' \? '已完成' : '未完成'/);
  assert.doesNotMatch(listing, /in_progress/);
});

test('drafts listing hides written items by default, --archived isolates fully dismissed batches, --all restores the full view', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const listing = source.match(/async function showDrafts[\s\S]*?\n}\n\nasync function editBatchItems/)?.[0];
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  // 显示契约：CLI 与 Web 草稿箱双 tab 一致——默认只列待处理批次（隐藏已写入与纯已忽略/已作废），
  // --archived 只看纯已忽略/已作废批次，--all 携带 include=written 查看全量。
  assert.ok(listing, 'showDrafts source was not found');
  assert.match(listing, /rawArgs\.includes\('--all'\)/);
  assert.match(listing, /rawArgs\.includes\('--archived'\)/);
  assert.match(listing, /--archived 与 --all 不能同时使用/);
  assert.match(listing, /include=written/);
  assert.match(listing, /actionableOf\(batch\) === 0/);
  assert.match(listing, /actionableOf\(batch\) > 0/);
  assert.match(listing, /没有待处理草稿/);
  assert.match(listing, /没有已忽略\/已作废批次/);
  assert.match(source, /csm-agent drafts \[客户ID或名称\] \[--archived\|--all\] \[--json\]/);
  const capabilities = JSON.parse(runCli('capabilities', '--json').stdout) as Array<{ command: string; api: string[] }>;
  assert.ok(capabilities.some((item) => item.command === 'drafts' && item.api.includes('/api/draft-batches?include=written')));
  // 服务端同一契约：默认剔除 written 项与全写入批次，include=written 恢复全量。
  assert.match(server, /include'\) === 'written'/);
  assert.match(server, /item\.status !== 'written'/);
});

test('drafts listing marks regenerating batches via the server-decorated flag', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const draftsModule = readFileSync(new URL('../src/workbench/drafts.ts', import.meta.url), 'utf8');
  const listing = source.match(/async function showDrafts[\s\S]*?\n}\n\nasync function editBatchItems/)?.[0];

  // 显示契约：重新生成进行中的批次在 drafts 表格带「生成中」列（服务端 regenerating 装饰直通）。
  assert.ok(listing, 'showDrafts source was not found');
  assert.match(listing, /regenerating: batch\.regenerating \? '生成中' : ''/);
  // 服务端权威标记：活跃日集合按请求算一次，批次装饰复用；判定逻辑在服务层三端共用。
  assert.match(server, /workbench\.drafts\.activeRegenerationDays\(\)/);
  assert.match(server, /decorateDraftBatch\(batch, activeDays\)/);
  assert.match(draftsModule, /activeRegenerationDays\(\)/);
  assert.match(draftsModule, /batchRegenerating\(batch/);
});

test('sessions CLI hides archived sessions by default and --all restores the full view', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const listing = source.match(/async function showSessions[\s\S]*?\n}\n\nasync function showSessionTranscript/)?.[0];
  const handler = source.match(/async function sessionsCommand[\s\S]*?\n}\n\nasync function doctor/)?.[0];
  const setter = source.match(/async function setSessionArchived[\s\S]*?\n}\n\nasync function sessionsCommand/)?.[0];

  // 显示契约：与 Web 会话列表一致，默认剔除已归档；--all 携带 include=archived 查看全量并可恢复。
  assert.ok(listing, 'showSessions source was not found');
  assert.match(listing, /rawArgs\.includes\('--all'\)/);
  assert.match(listing, /include=archived/);
  assert.match(listing, /没有活跃会话/);
  assert.ok(handler, 'sessionsCommand source was not found');
  assert.match(handler, /sessions 子命令只允许 list\/show\/archive\/unarchive\/stop/);
  assert.match(handler, /subcommand === 'archive' \|\| subcommand === 'unarchive'/);
  assert.ok(setter, 'setSessionArchived source was not found');
  assert.match(setter, /JSON\.stringify\(\{ archived \}\)/);
  // 服务端同一契约：默认剔除归档，include=archived 恢复全量；归档会话禁止继续发消息。
  assert.match(server, /include'\) === 'archived'/);
  assert.match(server, /s\.archived !== true/);
  assert.match(server, /会话已归档，请先恢复/);
});

test('agent conversation can be stopped from CLI and server auto-rejects pending drafts', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const stopper = source.match(/async function stopSession[\s\S]*?\n}\n\nasync function sessionsCommand/)?.[0];
  const agentRun = source.match(/async function runCustomerAgent[\s\S]*?\n}\n\nasync function main/)?.[0];

  // CLI 契约：sessions stop 显式命令 + agent 运行中 Ctrl+C 等效停止。
  assert.ok(stopper, 'stopSession source was not found');
  assert.match(stopper, /\/api\/sessions\/\$\{id\}\/stop/);
  assert.match(agentRun ?? '', /process\.on\('SIGINT', onSigint\)/);
  assert.match(agentRun ?? '', /request\(`\/api\/sessions\/\$\{session\.id\}\/stop`/);

  // 服务端契约：stop 端点只在 busy 时可用；挂起中的确认草稿按拒绝处理（停止即不写）。
  assert.match(server, /sub === '\/stop'/);
  assert.match(server, /当前没有进行中的对话/);
  assert.match(server, /pending\.resolve\(false\)/);
  assert.match(server, /session\.abort\?\.abort\(\)/);
  // 停止通知以 assistant 文本事件落盘（分享导出可见），turn_end 恢复会话可用。
  assert.match(server, /（对话已手动停止）/);
});

test('customer portfolio display contract exposes the supported sort controls', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="customerSort"/);
  assert.match(html, /value="renewal_date"/);
  assert.match(html, /value="renewal_amount"/);
  assert.match(app, /sort=\$\{encodeURIComponent\(customerSort\.value\)\}/);
});

test('customer overview CLI reports the aggregated last interaction time', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const showCustomer = source.match(/async function showCustomer[\s\S]*?\n}\n\nasync function showTimeline/)?.[0];

  // 显示契约：与 Web 概览一致，最后互动优先取服务端聚合时间（全量业务事件最晚时间），回退 CRM 原始字段。
  assert.ok(showCustomer, 'showCustomer source was not found');
  assert.match(showCustomer, /最后互动: \$\{overview\.lastInteractionAt \?\? overview\.customer\.lastContactAt \?\? 'unknown'\}/);
});

test('fragment consumption ledger is visible across CLI and API contracts', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  // inbox 表格补 consumed 列（片段被哪些类型的已写入草稿消费）。
  const inbox = cli.match(/async function hemoryCommand[\s\S]*?\n}\n\n\/\/ 草稿确认视图/)?.[0];
  assert.ok(inbox, 'hemoryCommand source was not found');
  assert.match(inbox, /consumed: \(item\.consumedBy \?\? \[\]\)\.join\(','\) \|\| ''/);
  // 生成任务备注：regenerate --wait / draft jobs 展示「未生成新草稿」结论，与失败错误、中断标注并列输出。
  assert.match(cli, /job\.status !== 'failed' && !job\.stalled && job\.note/);
  assert.match(cli, /备注：\$\{job\.note\}/);
  // 服务端同一契约：fragments 响应附 consumedBy（written 草稿 evidence_refs 反查 + 重切孪生扩展）。
  assert.match(server, /decorateHemoryFragments\(fragments\)/);
  assert.match(server, /expandedWrittenEvidenceByType\(customerId\)/);
  // usage 说明消费语义。
  assert.match(cli, /已写入草稿消费过的片段不再被[\s\S]*?同类型重复提案/);
});

test('CLI draft edit exposes the structured editing workflow in help and capabilities', () => {
  const help = runCli('help');
  assert.match(help.stdout, /csm-agent draft edit <草稿ID> \[--set 键=值 \.\.\.\]/);
  assert.match(help.stdout, /结构化编辑草稿/);

  const capabilities = runCli('capabilities', '--json');
  assert.equal(capabilities.status, 0, capabilities.stderr);
  const entries = JSON.parse(capabilities.stdout) as Array<{ command: string; workflow: string; api: string[] }>;
  const draft = entries.find((item) => item.command === 'draft')!;
  assert.ok(draft, 'draft capability missing');
  // 结构化编辑走 PATCH edits 分支（与 Web 编辑弹窗同一契约/合并 API）。
  assert.ok(draft.api.some((api) => api.includes('PATCH edits 结构化编辑')));
  assert.ok(draft.api.includes('/api/draft-items/:id'));

  // 子命令白名单报错文案包含 edit。
  const bad = runCli('draft', 'wrong-subcommand');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /review\/edit\/retry/);
});

test('agent CLI exposes attachments and the customer-detail tool; config llm set accepts vision', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const help = runCli('help');

  // --attach：可重复、与指令文本分离、读取本地文件 → base64 → 同一 messages API。
  assert.match(help.stdout, /csm-agent agent <客户ID或名称> <指令> \[--attach <文件路径> \.\.\.\]/);
  assert.match(help.stdout, /--vision=on\|off/);
  const agentDispatch = source.match(/if \(command === 'agent'\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(agentDispatch, 'agent dispatch was not found');
  assert.match(agentDispatch, /extractRepeatableFlag\(args, 'attach'\)/);
  assert.match(agentDispatch, /if \(!prompt && !attachPaths\.length\) throw new Error/);
  const runner = source.match(/async function runCustomerAgent[\s\S]*?\n}\n\nasync function main/)?.[0];
  assert.ok(runner, 'runCustomerAgent was not found');
  assert.match(runner, /raw\.toString\('base64'\)/);
  assert.match(runner, /attachments\.length \? \{ message: prompt, attachments \} : \{ message: prompt \}/);

  // --vision 白名单校验 + 仅随 payload 提交。
  assert.match(source, /--vision 只接受 on\/off/);
  assert.match(source, /payload\.vision = vision;/);

  // --protocol：自定义端点协议（openai 缺省 / anthropic 兼容），白名单校验 + 仅随 payload 提交。
  assert.match(help.stdout, /--protocol=openai\|anthropic/);
  assert.match(source, /--protocol 只接受 openai\/anthropic/);
  assert.match(source, /payload\.protocol = protocolRaw;/);

  // 能力清单：客户详情按需抓取工具 + 附件下载路由。
  const capabilities = JSON.parse(runCli('capabilities', '--json').stdout) as Array<{ command: string; workflow: string; api: string[]; tools?: string[] }>;
  const agent = capabilities.find((item) => item.workflow === 'customer-agent');
  assert.ok(agent?.tools?.includes('get_customer_detail'), 'agent capability must list get_customer_detail');
  assert.ok(agent?.api.includes('/api/sessions/:id/attachments/:attId'), 'agent capability must list the attachment route');
});
