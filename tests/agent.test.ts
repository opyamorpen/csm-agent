import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxThinking,
  Type,
} from '@earendil-works/pi-ai';
import { runAgent, AgentSession, AgentAbortedError, type McpGateway } from '../src/agent.js';
import { confirmWriteTool, type ConfirmDraft } from '../src/tools/confirm.js';

const WRITE_TOOL_NAME = 'mcp__crm__create_followup';

function makeGateway(): { gw: McpGateway; writeCalls: number } {
  const state = { writeCalls: 0 };
  const gw: McpGateway = {
    resolve(name) {
      if (name === WRITE_TOOL_NAME) return { server: 'crm', rawName: 'create_followup' };
      return undefined;
    },
    isWrite(_server, rawName) {
      return rawName.startsWith('create');
    },
    async call(name) {
      if (name === WRITE_TOOL_NAME) state.writeCalls++;
      return { text: 'written-ok', isError: false };
    },
  };
  return { gw, writeCalls: () => state.writeCalls };
}

const draft: ConfirmDraft = {
  target_system: 'crm',
  target_object: 'CRM 跟进记录',
  record_type: 'followup',
  title: '跟进记录草稿',
  summary: '测试草稿',
  fields: { customer_name: '测试客户' },
  target_tool: WRITE_TOOL_NAME,
  target_arguments: {},
};

function buildContext() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const tools = [confirmWriteTool, { name: WRITE_TOOL_NAME, description: 'write', parameters: Type.Object({}) }];
  return { faux, models, model, tools };
}

test('runAgent: reject blocks the write tool', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw, writeCalls } = makeGateway();

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('confirm_write', draft)]),
    fauxAssistantMessage([fauxToolCall(WRITE_TOOL_NAME, {})]),
    fauxAssistantMessage('完成'),
  ]);

  let confirmed = false;
  const result = await runAgent({
    models, model, mcp: gw, tools,
    systemPrompt: 'test',
    userInput: '整理跟进记录',
    hooks: {
      onEvent() {},
      requestConfirm: async () => { confirmed = true; return false; },
    },
  });

  assert.equal(confirmed, true);
  assert.equal(writeCalls(), 0, '被拒绝后不得调用写工具');
  assert.equal(result, '完成');
});

test('runAgent: approve lets the write tool through (one-shot)', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw, writeCalls } = makeGateway();

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('confirm_write', draft)]),
    fauxAssistantMessage([fauxToolCall(WRITE_TOOL_NAME, {})]),
    fauxAssistantMessage('已写入'),
  ]);

  const result = await runAgent({
    models, model, mcp: gw, tools,
    systemPrompt: 'test',
    userInput: '整理跟进记录',
    hooks: {
      onEvent() {},
      requestConfirm: async () => true,
    },
  });

  assert.equal(writeCalls(), 1, '批准后应调用一次写工具');
  assert.equal(result, '已写入');
});

test('runAgent: identical confirm_write re-proposal after rejection is blocked without a second card', async () => {
  // 真实事故：批准失败→用户拒绝→模型重跑查询后提交参数完全相同的草稿，对话里出现两张同题卡。
  const { faux, models, model, tools } = buildContext();
  const { gw, writeCalls } = makeGateway();

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('confirm_write', draft)]),
    fauxAssistantMessage([fauxToolCall('confirm_write', draft)]),
    fauxAssistantMessage('已询问用户需要修改什么'),
  ]);

  let confirmRequests = 0;
  const results: string[] = [];
  await runAgent({
    models, model, mcp: gw, tools,
    systemPrompt: 'test',
    userInput: '整理跟进记录',
    hooks: {
      onEvent(e) { if (e.type === 'tool_result') results.push(String(e.result ?? '')); },
      requestConfirm: async () => { confirmRequests++; return false; },
    },
  });

  assert.equal(confirmRequests, 1, '原样重提不得再挂确认卡');
  assert.equal(writeCalls(), 0);
  assert.ok(results.some((r) => r.includes('不得原样重新提交')), '重提要被门禁拦截并说明出路');
  assert.equal(results.filter((r) => r.includes('REJECTED')).length, 1, '只有第一次拒绝产生 REJECTED 工具结果');
});

test('runAgent: changed-args re-proposal passes, identical re-proposal after a successful write is blocked', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw, writeCalls } = makeGateway();
  const revised: ConfirmDraft = { ...draft, title: '修改后的草稿', target_arguments: { note: 'v2' } };

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('confirm_write', draft)]),
    fauxAssistantMessage([fauxToolCall('confirm_write', revised)]),
    fauxAssistantMessage([fauxToolCall(WRITE_TOOL_NAME, { note: 'v2' })]),
    fauxAssistantMessage([fauxToolCall('confirm_write', revised)]),
    fauxAssistantMessage('完成'),
  ]);

  let decisions = 0;
  const results: string[] = [];
  await runAgent({
    models, model, mcp: gw, tools,
    systemPrompt: 'test',
    userInput: '整理跟进记录',
    hooks: {
      onEvent(e) { if (e.type === 'tool_result') results.push(String(e.result ?? '')); },
      requestConfirm: async () => { decisions++; return decisions === 2; },
    },
  });

  assert.equal(decisions, 2, '改参重提要放行出第二张卡');
  assert.equal(writeCalls(), 1, '只应写入一次');
  assert.ok(results.some((r) => r.includes('不要重复提交')), '写入成功后的同参重提要被拦截');
});

test('runAgent: approval is bound to exact tool arguments', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw, writeCalls } = makeGateway();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('confirm_write', { ...draft, target_arguments: { customer: 'A' } })]),
    fauxAssistantMessage([fauxToolCall(WRITE_TOOL_NAME, { customer: 'B' })]),
    fauxAssistantMessage('未写入'),
  ]);
  const result = await runAgent({
    models, model, mcp: gw, tools, systemPrompt: 'test', userInput: '写入',
    hooks: { onEvent() {}, requestConfirm: async () => true },
  });
  assert.equal(writeCalls(), 0);
  assert.equal(result, '未写入');
});

test('runAgent: CSM-edited arguments replace the original approval binding', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw, writeCalls } = makeGateway();
  const original = { ...draft, target_arguments: { customer: 'A' } };
  const edited = { ...original, title: 'CSM 修改后', target_arguments: { customer: 'B' } };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('confirm_write', original)]),
    fauxAssistantMessage([fauxToolCall(WRITE_TOOL_NAME, { customer: 'B' })]),
    fauxAssistantMessage('已按修改稿写入'),
  ]);
  const result = await runAgent({
    models, model, mcp: gw, tools, systemPrompt: 'test', userInput: '写入',
    hooks: { onEvent() {}, requestConfirm: async () => edited },
  });
  assert.equal(writeCalls(), 1);
  assert.equal(result, '已按修改稿写入');
});

test('runAgent: local tool (resolve_customer) emits customer_context and bypasses MCP', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw, writeCalls } = makeGateway();

  const contexts: Array<{ type: string; context?: any }> = [];
  const emitted: Array<{ type: string; context?: any }> = [];

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('resolve_customer', { customer_name: '云启科技', health: '绿' })]),
    fauxAssistantMessage('已解析'),
  ]);

  const localTools = {
    resolve_customer: async (args: Record<string, unknown>, emit: (e: any) => void) => {
      const ctx = { customer_name: String(args.customer_name), health: String(args.health) };
      emit({ type: 'customer_context', context: ctx });
      return { text: '已记录' };
    },
  };

  const result = await runAgent({
    models, model, mcp: gw, tools,
    systemPrompt: 'test',
    userInput: '解析客户',
    localTools,
    hooks: {
      onEvent(e) { if (e.type === 'customer_context') emitted.push(e); },
      requestConfirm: async () => false,
    },
  });

  assert.equal(writeCalls(), 0);
  assert.equal(emitted.length, 1);
  assert.equal((emitted[0] as any).context.customer_name, '云启科技');
  assert.equal(result, '已解析');
});

test('AgentSession: send() refreshes systemPrompt/tools/model from live runtime', async () => {
  // Simulate a session created BEFORE MCP connected (empty tool list, stale prompt).
  const { faux, models, model, tools } = buildContext();
  const { gw } = makeGateway();

  const runtime = {
    systemPrompt: '（尚未配置任何 MCP 服务器）',
    tools: [confirmWriteTool],
    model,
  };
  const session = new AgentSession({
    models,
    model,
    mcp: gw,
    tools: runtime.tools,
    systemPrompt: runtime.systemPrompt,
    live: {
      getSystemPrompt: () => runtime.systemPrompt,
      getTools: () => runtime.tools,
      getModel: () => runtime.model,
    },
    hooks: undefined as never,
  });

  faux.setResponses([fauxAssistantMessage('ok')]);

  // MCP connects / reload happens after the session was created.
  runtime.systemPrompt = '已连接 crm/ones/hemory';
  runtime.tools = tools;

  await session.send('你好', { onEvent() {}, requestConfirm: async () => false });

  assert.equal(session.context.systemPrompt, '已连接 crm/ones/hemory', 'send() 应取最新 systemPrompt');
  assert.ok(session.context.tools.some((t) => t.name === WRITE_TOOL_NAME), 'send() 应取最新工具清单');
});

test('runAgent: unknown tool error lists connected servers and warns against inventing names', async () => {
  const { faux, models, model, tools } = buildContext();
  const gw: McpGateway = {
    resolve: () => undefined,
    isWrite: () => false,
    async call() { return { text: '', isError: false }; },
    serverNames: () => ['crm', 'ones', 'hemory'],
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('mcp__crm__search_customer', {})]),
    fauxAssistantMessage('已纠错'),
  ]);
  const results: string[] = [];
  await runAgent({
    models, model, mcp: gw, tools, systemPrompt: 'test', userInput: '查客户',
    hooks: { onEvent(e) { if (e.type === 'tool_result') results.push(e.result ?? ''); }, requestConfirm: async () => false },
  });
  assert.ok(results[0].includes('未知工具'), '应标明未知工具');
  assert.ok(results[0].includes('crm、ones、hemory'), '应列出已连接服务器');
  assert.ok(results[0].includes('不要臆造工具名'), '应提示不要臆造工具名');
});

// ── 停止 / 流式 / thinking / usage ──────────────────────────────────────────

test('runAgent: text_delta events arrive before the full text event', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw } = makeGateway();
  faux.setResponses([fauxAssistantMessage('流式回复内容')]);
  const order: string[] = [];
  await runAgent({
    models, model, mcp: gw, tools, systemPrompt: 'test', userInput: '你好',
    hooks: {
      onEvent(e) {
        if (e.type === 'text_delta' && e.delta) order.push('delta:' + e.delta);
        if (e.type === 'text' && e.text) order.push('text:' + e.text);
      },
      requestConfirm: async () => false,
    },
  });
  assert.ok(order.some((item) => item.startsWith('delta:')), '应收到 text_delta 流式事件');
  const firstText = order.findIndex((item) => item.startsWith('text:'));
  const lastDelta = order.map((item) => item.startsWith('delta:')).lastIndexOf(true);
  assert.ok(lastDelta >= 0 && lastDelta < firstText, '全部 delta 应先于整段 text 事件');
});

test('runAgent: thinking blocks are surfaced as thinking event and deltas stream', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw } = makeGateway();
  faux.setResponses([fauxAssistantMessage([fauxThinking('先分析一下'), { type: 'text', text: '答案' }])]);
  const thinkingEvents: string[] = [];
  const thinkingDeltas: string[] = [];
  await runAgent({
    models, model, mcp: gw, tools, systemPrompt: 'test', userInput: '想一下',
    hooks: {
      onEvent(e) {
        if (e.type === 'thinking' && e.text) thinkingEvents.push(e.text);
        if (e.type === 'thinking_delta' && e.delta) thinkingDeltas.push(e.delta);
      },
      requestConfirm: async () => false,
    },
  });
  assert.ok(thinkingDeltas.length > 0, 'thinking_delta 应流式到达');
  assert.equal(thinkingEvents.join(''), '先分析一下', '整段 thinking 事件应携带完整思考文本');
});

test('runAgent: done event carries accumulated token usage', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw } = makeGateway();
  faux.setResponses([fauxAssistantMessage('第一段'), fauxAssistantMessage('第二段')]);
  let usage: { input: number; output: number; total: number } | undefined;
  await runAgent({
    models, model, mcp: gw, tools, systemPrompt: 'test', userInput: '你好',
    hooks: {
      onEvent(e) { if (e.type === 'done') usage = e.usage; },
      requestConfirm: async () => false,
    },
  });
  assert.ok(usage, 'done 事件应携带 usage');
  assert.ok(usage!.input > 0, 'input tokens 应大于 0（faux 估算）');
  assert.ok(usage!.output > 0, 'output tokens 应大于 0');
  assert.ok(usage!.total >= usage!.input + usage!.output, 'total 应聚合所有调用');
});

test('runAgent: pre-aborted signal makes zero LLM calls and throws AgentAbortedError', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw } = makeGateway();
  faux.setResponses([fauxAssistantMessage('不应被调用')]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runAgent({
      models, model, mcp: gw, tools, systemPrompt: 'test', userInput: '你好',
      hooks: { onEvent() {}, requestConfirm: async () => false },
      signal: controller.signal,
    }),
    AgentAbortedError,
  );
  assert.equal(faux.state.callCount, 0, '预中止时不应发起任何 LLM 调用');
});

test('runAgent: aborted message is not pushed into context (no dangling toolCall)', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw } = makeGateway();
  const controller = new AbortController();
  // 用自定义 Models 包装：第一次调用正常回复，流式期间 abort 使 provider 返回 aborted 消息。
  const wrapped: typeof models = {
    ...models,
    stream: (m: any, ctx: any, options: any) => {
      const s = models.stream(m, ctx, options);
      const origResult = s.result.bind(s);
      void origResult().then((msg) => {
        if (msg.stopReason !== 'aborted' && controller.signal.aborted) {
          // 手工把已返回的消息改造成 aborted 语义，模拟 provider 中止行为。
          (msg as any).stopReason = 'aborted';
        }
      });
      return s as any;
    },
  } as any;
  faux.setResponses([fauxAssistantMessage('进行中的回复')]);
  controller.abort();
  await assert.rejects(
    runAgent({
      models: wrapped, model, mcp: gw, tools, systemPrompt: 'test', userInput: '你好',
      hooks: { onEvent() {}, requestConfirm: async () => false },
      signal: controller.signal,
    }),
    AgentAbortedError,
  );
});

test('runAgent: abort while confirm_write is pending rejects cleanly with paired toolResult', async () => {
  const { faux, models, model, tools } = buildContext();
  const { gw, writeCalls } = makeGateway();
  const controller = new AbortController();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('confirm_write', draft)]),
    fauxAssistantMessage([fauxToolCall(WRITE_TOOL_NAME, {})]),
  ]);
  // 挂起中的 confirm 由 abort 解除（服务端 stop 端点：resolve(false) 后 abort）。
  const requestConfirm = () => new Promise<boolean>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(false), { once: true });
    setTimeout(() => controller.abort(), 0);
  });
  await assert.rejects(
    runAgent({
      models, model, mcp: gw, tools, systemPrompt: 'test', userInput: '写入',
      hooks: { onEvent() {}, requestConfirm },
      signal: controller.signal,
    }),
    AgentAbortedError,
  );
  assert.equal(writeCalls(), 0, '挂起中被停止的草稿不得写入');
});

test('AgentSession.send: abort mid-batch skips the rest and keeps toolResult pairing', async () => {
  const { faux, models, model } = buildContext();
  const controller = new AbortController();
  let calls = 0;
  const gw: McpGateway = {
    resolve: () => ({ server: 'crm', rawName: 'read_tool' }),
    isWrite: () => false,
    async call() {
      calls++;
      if (calls === 1) controller.abort(); // 第一个工具执行中停止
      return { text: 'read-ok', isError: false };
    },
  };
  // 第一轮返回两个读工具调用；第一个执行完后 abort，第二个应被跳过并合成 toolResult。
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('read_tool', {}, { id: 'call-1' }),
      fauxToolCall('read_tool', {}, { id: 'call-2' }),
    ]),
    fauxAssistantMessage('unused'),
  ]);
  const session = new AgentSession({ models, model, mcp: gw, tools: [], systemPrompt: 'test' });
  await assert.rejects(
    session.send('读取', { onEvent() {}, requestConfirm: async () => false }, controller.signal),
    AgentAbortedError,
  );
  const msgs = session.context.messages;
  const toolCalls = msgs.filter((m) => m.role === 'assistant').flatMap((m: any) => m.content.filter((b: any) => b.type === 'toolCall'));
  const toolResults = msgs.filter((m) => m.role === 'toolResult');
  assert.equal(toolCalls.length, 2);
  assert.equal(toolResults.length, 2, '每个 toolCall 都必须配对 toolResult（跳过的合成结果）');
  assert.equal(calls, 1, '停止后批内剩余调用不应真实执行');
  assert.equal(toolResults[1].content[0]?.text, '（对话已停止，本调用未执行）',
    '被跳过的调用应合成停止说明 toolResult');
});

test('AgentSession: send() 接受文本+图片内容块并原样入上下文（附件消息持久化形态）', async () => {
  const { faux, models, model } = buildContext();
  const { gw } = makeGateway();
  faux.setResponses([fauxAssistantMessage('收到')]);
  const session = new AgentSession({ models, model, mcp: gw, tools: [], systemPrompt: 'test' });
  const blocks = [
    { type: 'text' as const, text: '看这张图' },
    { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' },
  ];
  const result = await session.send(blocks, { onEvent() {}, requestConfirm: async () => false });
  assert.equal(result, '收到');
  const first = session.context.messages[0] as { role: string; content: unknown };
  assert.equal(first.role, 'user');
  assert.deepEqual(first.content, blocks, '附件内容块须原样入 context（restore 落盘即为此形态）');
});
