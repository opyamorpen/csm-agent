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
  for (const command of ['serve', 'doctor', 'customers', 'customer', 'timeline', 'workhours', 'action', 'case', 'sync', 'hemory', 'draft', 'service', 'wecom', 'agent', 'api']) {
    assert.ok(commands.has(command), `missing CLI capability: ${command}`);
  }
  assert.ok(capabilities.some((item) => item.workflow === 'action-items' && item.api.includes('/api/action-items/:id/complete')));
  assert.ok(capabilities.some((item) => item.workflow === 'case-drafts' && item.api.includes('/api/case-drafts/:id/publish')));
  assert.ok(capabilities.some((item) => item.workflow === 'customer-agent' && item.api.includes('/api/sessions/:id/confirm')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-attribution' && item.api.includes('/api/hemory/fragments/attribution')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-batches/:id/confirm')));
  assert.ok(capabilities.some((item) => item.workflow === 'hemory-drafts' && item.api.includes('/api/draft-batches/:id/regenerate')));
});

test('CLI provides standard global help and version commands', () => {
  const help = runCli('help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /csm-agent serve/);
  assert.match(help.stdout, /csm-agent customers .*--sort default\|renewal_date\|renewal_amount/);
  assert.match(help.stdout, /csm-agent capabilities/);
  assert.match(help.stdout, /csm-agent action complete/);
  assert.match(help.stdout, /csm-agent case publish/);
  assert.match(help.stdout, /csm-agent hemory assign/);
  assert.match(help.stdout, /csm-agent draft review/);
  assert.match(help.stdout, /csm-agent draft regenerate/);
  assert.match(help.stdout, /csm-agent service install/);

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

test('customer portfolio display contract exposes the supported sort controls', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="customerSort"/);
  assert.match(html, /value="renewal_date"/);
  assert.match(html, /value="renewal_amount"/);
  assert.match(app, /sort=\$\{encodeURIComponent\(customerSort\.value\)\}/);
});
