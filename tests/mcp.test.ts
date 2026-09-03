import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { McpHub } from '../src/mcp/index.js';
import type { McpServerConfig } from '../src/config.js';

const nodeRequire = createRequire(import.meta.url);
const sdkRoot = dirname(nodeRequire.resolve('@modelcontextprotocol/sdk/package.json'));
// 低层 Server + 纯 JSON Schema 工具：不依赖 zod，跨 SDK 版本稳定的 stdio 假 MCP 服务。
const fakeServerScript = `
const { Server } = require(${JSON.stringify(join(sdkRoot, 'server/index.js'))});
const { StdioServerTransport } = require(${JSON.stringify(join(sdkRoot, 'server/stdio.js'))});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(join(sdkRoot, 'types.js'))});
const server = new Server({ name: 'fake-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: 'echo:' + request.params.name }] }));
server.connect(new StdioServerTransport());
`;

function stdioConfig(command: string, args?: string[]): McpServerConfig {
  return { name: 'flaky', transport: 'stdio', command, args };
}

test('mcp: 启动连接失败停留 failures，retryFailed 配置恢复后自愈摘除并可调用', async () => {
  const hub = new McpHub();
  try {
    await hub.connect([stdioConfig('csm-agent-肯定不存在的命令-xyz')]);
    assert.equal(hub.failures.size, 1);
    assert.ok(hub.failures.has('flaky'));

    // 仍失败：不抛异常、返回空、失败标记保留（错误信息更新为最新一次）
    const stillFailed = await hub.retryFailed([stdioConfig('csm-agent-肯定不存在的命令-xyz')]);
    assert.deepEqual(stillFailed, []);
    assert.ok(hub.failures.has('flaky'));
    assert.equal(hub.serverNames().length, 0);

    // 配置恢复可用：重试成功、摘除失败标记、工具注册可解析可调用
    const recovered = await hub.retryFailed([stdioConfig(process.execPath, ['-e', fakeServerScript])]);
    assert.deepEqual(recovered, ['flaky']);
    assert.equal(hub.failures.size, 0);
    assert.deepEqual(hub.serverNames(), ['flaky']);
    assert.ok(hub.resolve('mcp__flaky__echo'), '重连成功后工具应可解析');
    const result = await hub.call('mcp__flaky__echo', {});
    assert.equal(result.isError, false);
    assert.equal(result.text, 'echo:echo');
  } finally {
    await hub.closeAll();
  }
});

test('mcp: retryFailed 不动健康服务——不在 failures 里的直接跳过', async () => {
  const hub = new McpHub();
  try {
    await hub.connect([stdioConfig(process.execPath, ['-e', fakeServerScript])]);
    assert.equal(hub.failures.size, 0);

    const recovered = await hub.retryFailed([stdioConfig(process.execPath, ['-e', fakeServerScript])]);
    assert.deepEqual(recovered, []);
    assert.equal(hub.failures.size, 0);
    assert.deepEqual(hub.serverNames(), ['flaky']);
  } finally {
    await hub.closeAll();
  }
});

test('mcp: 服务入口挂断连自愈定时器（启动失败的服务不再断到下次重启）', () => {
  // 2026-09-03 事故：Hemory 端点瞬时 fetch failed 后整个进程生命周期断连（MCP 只在启动连一次），
  // 同步静默瘫痪到下次服务重启。契约：index.ts 定时调用 retryFailed（每次重读配置）。
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /setInterval\(/);
  assert.match(source, /retryFailed\(loadMcpServers\(\)\)/);
});
