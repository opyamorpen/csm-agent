import { createRuntime } from './bootstrap.js';
import { startServer } from './server.js';
import { loadMcpServers } from './config.js';

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const port = Number(process.env.CSM_PORT ?? 3210);

  // Start the HTTP server first so the UI is available immediately; connect
  // MCP servers in the background (slow OAuth flows must not block startup).
  await startServer(runtime, port);
  console.log(`CSM Agent 已启动: http://127.0.0.1:${port}`);

  void (async () => {
    try {
      await runtime.reloadMcp(loadMcpServers());
      console.log(`MCP 连接完成: ${runtime.mcp.listTools().length} 个工具`);
      for (const [name, err] of runtime.mcp.failures) {
        console.warn(`[mcp] ${name} 未连接: ${err}`);
      }
    } catch (err) {
      console.error('MCP 连接失败:', err);
    }
  })();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
