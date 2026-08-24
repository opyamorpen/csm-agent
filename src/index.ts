import { createRuntime } from './bootstrap.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const port = Number(process.env.CSM_PORT ?? 3210);

  console.log(`MCP 工具: ${runtime.mcp.listTools().map((t) => t.publicName).join(', ') || '(未连接任何 MCP 工具)'}`);
  for (const [name, err] of runtime.mcp.failures) {
    console.warn(`[mcp] ${name} 未连接: ${err}`);
  }

  await startServer(runtime, port);
  console.log(`\nCSM Agent 已启动: http://127.0.0.1:${port}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
