import { createRuntime } from './bootstrap.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  // 后台任务（分段/草稿/周报生成等）的未处理 rejection 只记日志，绝不打崩常驻服务进程
  // （曾因分段 3 次超时 rethrow 未接 catch 导致整个服务退出）。
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });

  const runtime = await createRuntime();
  const port = Number(process.env.CSM_PORT ?? 3210);
  const host = process.env.CSM_HOST ?? '127.0.0.1';

  // Start the HTTP server first so the UI is available immediately; MCP servers
  // connect in the background per user (startServer 挂接系统用户、会话按属主懒连，
  // slow OAuth flows must not block startup).
  await startServer(runtime, port);
  console.log(`CSM Agent 已启动: http://${host}:${port}`);

  // MCP 断连自愈：启动连接只跑一次，失败的服务（如瞬时网络抖动 fetch failed）此前会断到下次重启——
  // 每 60s 对每个缓存用户只重试仍处 failures 的服务（每次重读该用户配置），
  // 全部恢复后静默空转；与配置重存的 reconnect 互不冲突。
  const mcpRetryTimer = setInterval(() => {
    void runtime.users.retryFailed().catch((err) => {
      console.error('[mcp] 断连自愈重试失败:', err);
    });
  }, 60_000);
  mcpRetryTimer.unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
