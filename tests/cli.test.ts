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
  for (const command of ['serve', 'doctor', 'config', 'customers', 'customer', 'timeline', 'workhours', 'action', 'case', 'sync', 'hemory', 'draft', 'service', 'wecom', 'agent', 'sessions', 'api']) {
    assert.ok(commands.has(command), `missing CLI capability: ${command}`);
  }
  assert.ok(capabilities.some((item) => item.workflow === 'action-items' && item.api.includes('/api/action-items/:id/complete')));
  assert.ok(capabilities.some((item) => item.workflow === 'action-items' && item.api.includes('/api/action-items/bulk-accept')));
  assert.ok(capabilities.some((item) => item.workflow === 'action-items' && item.api.includes('/api/action-items/bulk-complete')));
  assert.ok(capabilities.some((item) => item.workflow === 'case-drafts' && item.api.includes('/api/case-drafts/:id/publish')));
  assert.ok(capabilities.some((item) => item.workflow === 'customer-agent' && item.api.includes('/api/sessions/:id/confirm')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-attribution' && item.api.includes('/api/hemory/fragments/attribution')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-attribution' && item.api.includes('/api/hemory/fragments/ignore')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-attribution' && item.api.includes('/api/hemory/resegment')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-batches/:id/confirm')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-batches/:id/regenerate')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-jobs')));
  assert.ok(capabilities.some((item) => item.workflow === 'runtime-config' && item.api.includes('PUT /api/config/llm')));
  assert.ok(capabilities.some((item) => item.workflow === 'agent-sessions' && item.api.includes('/api/sessions?include=archived')));
  assert.ok(capabilities.some((item) => item.workflow === 'agent-sessions' && item.api.includes('/api/sessions/:id/export')));
  assert.ok(capabilities.some((item) => item.workflow === 'weekly-reports' && item.api.includes('/api/customers/:id/weekly-reports')));
  assert.ok(capabilities.some((item) => item.workflow === 'weekly-reports' && item.api.includes('/api/weekly-reports/:id/publish-preview')));
  assert.ok(capabilities.some((item) => item.workflow === 'weekly-reports' && item.api.includes('/api/weekly-reports/:id/publish')));
  assert.ok(capabilities.some((item) => item.workflow === 'ones-wiki-browse' && item.api.includes('/api/ones-wiki/spaces')));
  assert.ok(capabilities.some((item) => item.workflow === 'ones-wiki-browse' && item.api.includes('/api/ones-wiki/pages')));
  // 旧进程检测：doctor 挂 /api/version 比对服务端与本地构建。
  assert.ok(capabilities.some((item) => item.workflow === 'diagnostics' && item.api.includes('/api/version')));
});

test('CLI provides standard global help and version commands', () => {
  const help = runCli('help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /csm-agent serve/);
  assert.match(help.stdout, /csm-agent customers .*--sort default\|renewal_date\|renewal_amount/);
  assert.match(help.stdout, /csm-agent capabilities/);
  assert.match(help.stdout, /csm-agent action accept <行动ID\.\.\.>/);
  assert.match(help.stdout, /csm-agent action complete <行动ID\.\.\.> \[--outcome <实际结果>\]/);
  assert.match(help.stdout, /csm-agent case publish/);
  assert.match(help.stdout, /csm-agent weekly-report generate <客户ID或名称> \[YYYY-MM-DD\] \[--force\] \[--wait\]/);
  assert.match(help.stdout, /csm-agent weekly-report publish <周报ID> <版本> <ONES父页面ID> <批准哈希>/);
  assert.match(help.stdout, /csm-agent wiki spaces \[--json\]/);
  assert.match(help.stdout, /csm-agent wiki pages --space <页面组ID>/);
  assert.match(help.stdout, /csm-agent hemory assign/);
  assert.match(help.stdout, /csm-agent hemory ignore/);
  assert.match(help.stdout, /csm-agent hemory resegment --all/);
  assert.match(help.stdout, /csm-agent hemory inbox \[YYYY-MM-DD\] \[--days N\] \[--from HH:MM\] \[--to HH:MM\]/);
  assert.match(help.stdout, /csm-agent draft review/);
  assert.match(help.stdout, /csm-agent draft regenerate/);
  assert.match(help.stdout, /csm-agent service install/);
  assert.match(help.stdout, /csm-agent sessions \[list\] \[--all\] \[--json\]/);
  assert.match(help.stdout, /csm-agent sessions show <会话ID>/);
  assert.match(help.stdout, /csm-agent sessions archive\|unarchive <会话ID>/);

  const version = runCli('--version');
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('draft regenerate waits for the new batch and points to the review step', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const handler = source.match(/async function regenerateDraftBatch[\s\S]*?\n}\n\nasync function draftCommand/)?.[0];

  assert.ok(handler, 'regenerateDraftBatch source was not found');
  assert.match(handler, /waitForRegeneratedBatch/);
  assert.match(handler, /draft review/);
  assert.match(handler, /已作废/);
});

test('hemory CLI covers ignore restore and incremental sync semantics', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const handler = source.match(/async function hemoryCommand[\s\S]*?\n}\n\n\/\/ 草稿确认视图/)?.[0];
  assert.ok(handler, 'hemoryCommand source was not found');
  assert.match(handler, /hemory\/fragments\/ignore/);
  assert.match(handler, /\/api\/hemory\/sync/);
  assert.match(handler, /--days=/);
  assert.match(handler, /sync\/resegment\/inbox\/assign\/clear\/ignore\/regenerate/);
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

test('drafts listing hides written items by default and --all restores the full view', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const listing = source.match(/async function showDrafts[\s\S]*?\n}\n\nasync function editBatchItems/)?.[0];
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  // 显示契约：CLI 与 Web 草稿箱一致，默认隐藏已写入草稿；--all 携带 include=written 查看全量。
  assert.ok(listing, 'showDrafts source was not found');
  assert.match(listing, /rawArgs\.includes\('--all'\)/);
  assert.match(listing, /include=written/);
  assert.match(listing, /没有待处理草稿/);
  assert.match(source, /csm-agent drafts \[客户ID或名称\] \[--all\] \[--json\]/);
  const capabilities = JSON.parse(runCli('capabilities', '--json').stdout) as Array<{ command: string; api: string[] }>;
  assert.ok(capabilities.some((item) => item.command === 'drafts' && item.api.includes('/api/draft-batches?include=written')));
  // 服务端同一契约：默认剔除 written 项与全写入批次，include=written 恢复全量。
  assert.match(server, /include'\) === 'written'/);
  assert.match(server, /item\.status !== 'written'/);
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
  assert.match(handler, /sessions 子命令只允许 list\/show\/archive\/unarchive/);
  assert.match(handler, /subcommand === 'archive' \|\| subcommand === 'unarchive'/);
  assert.ok(setter, 'setSessionArchived source was not found');
  assert.match(setter, /JSON\.stringify\(\{ archived \}\)/);
  // 服务端同一契约：默认剔除归档，include=archived 恢复全量；归档会话禁止继续发消息。
  assert.match(server, /include'\) === 'archived'/);
  assert.match(server, /s\.archived !== true/);
  assert.match(server, /会话已归档，请先恢复/);
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
  // 生成任务备注：regenerate --wait / draft jobs 展示「未生成新草稿」结论，与失败错误并列输出。
  assert.match(cli, /job\.status !== 'failed' && job\.note/);
  assert.match(cli, /备注：\$\{job\.note\}/);
  // 服务端同一契约：fragments 响应附 consumedBy（written 草稿 evidence_refs 反查）。
  assert.match(server, /decorateHemoryFragments\(fragments\)/);
  assert.match(server, /writtenEvidenceByType\(customerId\)/);
  // usage 说明消费语义。
  assert.match(cli, /已写入草稿消费过的片段不再被[\s\S]*?同类型重复提案/);
});
