import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from '@earendil-works/pi-ai';
import { runAgent, AgentSession, type McpGateway } from '../src/agent.js';
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
