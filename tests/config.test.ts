import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandEnv, loadLlmConfig, loadMcpServers, saveLlmConfig, saveMcpServers, userConfigDir } from '../src/config.js';
import { toPublicName, isWriteToolName, mcpResultToText, DEFAULT_WRITE_PATTERNS } from '../src/mcp/index.js';

test('expandEnv: replaces placeholders from process.env', () => {
  process.env.CSM_TEST_TOKEN = 'secret-123';
  assert.equal(expandEnv('Bearer ${CSM_TEST_TOKEN}'), 'Bearer secret-123');
  assert.equal(expandEnv('${MISSING_VAR_THAT_DOES_NOT_EXIST}'), '');
  delete process.env.CSM_TEST_TOKEN;
});

test('expandEnv: recurses into objects and arrays', () => {
  process.env.CSM_A = 'x';
  const out = expandEnv({ headers: { Authorization: 'Bearer ${CSM_A}' }, args: ['${CSM_A}', 'y'] }) as any;
  assert.equal(out.headers.Authorization, 'Bearer x');
  assert.deepEqual(out.args, ['x', 'y']);
  delete process.env.CSM_A;
});

test('global CLI config is persisted under the writable data directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-agent-config-'));
  const previousDataDir = process.env.CSM_DATA_DIR;
  const previousConfigDir = process.env.CSM_CONFIG_DIR;
  try {
    process.env.CSM_DATA_DIR = dir;
    delete process.env.CSM_CONFIG_DIR;
    assert.equal(userConfigDir(), join(dir, 'config'));

    saveMcpServers([{ name: 'test', transport: 'stdio', command: 'test-command' }]);
    assert.deepEqual(loadMcpServers(), [{ name: 'test', transport: 'stdio', command: 'test-command' }]);

    saveLlmConfig({ provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' });
    const llm = loadLlmConfig();
    assert.equal(llm.provider, 'openai');
    assert.equal(llm.model, 'gpt-4o-mini');
  } finally {
    if (previousDataDir === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = previousDataDir;
    if (previousConfigDir === undefined) delete process.env.CSM_CONFIG_DIR;
    else process.env.CSM_CONFIG_DIR = previousConfigDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toPublicName: namespaced and sanitized', () => {
  assert.equal(toPublicName('crm', 'search customer'), 'mcp__crm__search_customer');
  assert.equal(toPublicName('recording', 'get.transcript'), 'mcp__recording__get_transcript');
});

test('isWriteToolName: pattern match, case-insensitive', () => {
  assert.equal(isWriteToolName('create_followup', DEFAULT_WRITE_PATTERNS), true);
  assert.equal(isWriteToolName('UpdateTicket', DEFAULT_WRITE_PATTERNS), true);
  assert.equal(isWriteToolName('search_customer', DEFAULT_WRITE_PATTERNS), false);
  assert.equal(isWriteToolName('get_transcript', []), false);
});

test('mcpResultToText: joins text blocks and keeps diagnostics', () => {
  assert.equal(mcpResultToText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(mcpResultToText({ content: [] }), '(empty result)');
  assert.match(mcpResultToText({ content: [], structuredContent: { ok: 1 } }), /"ok":1/);
  assert.equal(mcpResultToText({ content: [{ type: 'text', text: '{"ok":1}' }], structuredContent: { ok: 1 } }), '{"ok":1}');
});
