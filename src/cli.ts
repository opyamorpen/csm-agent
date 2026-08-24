import { createInterface } from 'node:readline/promises';
import { createRuntime } from './bootstrap.js';
import type { ConfirmDraft } from './tools/confirm.js';
import { runAgent, type AgentEvent } from './agent.js';

function askConfirm(draft: ConfirmDraft): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return (async () => {
    console.log('\n──── 待确认草稿 ────');
    console.log(`目标系统: ${draft.target_system}`);
    console.log(`目标对象: ${draft.target_object}`);
    console.log(`类型:     ${draft.record_type}`);
    console.log(`标题:     ${draft.title}`);
    console.log(`摘要:     ${draft.summary}`);
    console.log('字段:');
    console.log(JSON.stringify(draft.fields, null, 2));
    const answer = await rl.question('\n批准写入吗？(y/N) ');
    rl.close();
    return answer.trim().toLowerCase() === 'y';
  })();
}

async function main(): Promise<void> {
  const runtime = await createRuntime();
  console.log(`已连接 MCP 工具: ${runtime.mcp.listTools().map((t) => t.publicName).join(', ') || '(无)'}`);
  for (const [name, err] of runtime.mcp.failures) {
    console.warn(`[mcp] ${name} 未连接: ${err}`);
  }

  const userInput = process.argv.slice(2).join(' ').trim() || '帮我整理最近一个客户的跟进记录';
  console.log(`\n指令: ${userInput}\n`);

  const result = await runAgent({
    ...runtime,
    userInput,
    hooks: {
      onEvent(e: AgentEvent) {
        if (e.type === 'text' && e.text) console.log(`\n[助手] ${e.text}`);
        else if (e.type === 'tool_call') console.log(`  → 调用工具 ${e.name} ${JSON.stringify(e.arguments)}`);
        else if (e.type === 'tool_result' && e.name !== 'confirm_write') console.log(`  ← ${e.name}: ${e.result?.slice(0, 200)}`);
      },
      requestConfirm: askConfirm,
    },
  });

  console.log(`\n===== 最终结果 =====\n${result}`);
  await runtime.mcp.closeAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
