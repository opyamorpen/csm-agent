import type { AssistantMessage, Context, Model, Models, Tool, ToolCall } from '@earendil-works/pi-ai';
import { CONFIRM_TOOL_NAME, type ConfirmDraft } from './tools/confirm.js';
import type { CustomerContext } from './tools/customer.js';
import { argumentsHash } from './approval.js';

/** Structural gateway so the loop can be unit-tested with a fake. */
export interface McpGateway {
  resolve(publicName: string): { server: string; rawName: string } | undefined;
  isWrite(server: string, rawName: string): boolean;
  call(publicName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Names of currently connected MCP servers (for unknown-tool diagnostics). */
  serverNames?(): string[];
}

/** Token usage of one turn, accumulated across all LLM calls in the loop. */
export interface TurnUsage {
  input: number;
  output: number;
  total: number;
}

export interface AgentEvent {
  type: 'text' | 'text_delta' | 'thinking' | 'thinking_delta' | 'tool_call' | 'confirm' | 'tool_result' | 'customer_context' | 'done';
  text?: string;
  /** Incremental fragment carried by text_delta / thinking_delta events. */
  delta?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  draft?: ConfirmDraft;
  result?: string;
  context?: CustomerContext;
  /** Token usage carried by the final `done` event of a turn. */
  usage?: TurnUsage;
}

/** Thrown when a running turn is aborted through its AbortSignal. */
export class AgentAbortedError extends Error {
  constructor() {
    super('对话已停止');
    this.name = 'AgentAbortedError';
  }
}

export interface AgentHooks {
  onEvent: (e: AgentEvent) => void;
  /** Resolve true for the original draft, an edited draft, or false to reject. */
  requestConfirm: (draft: ConfirmDraft) => Promise<boolean | ConfirmDraft>;
}

/** A non-interactive local tool handler (e.g. resolve_customer). */
export type LocalToolHandler = (
  args: Record<string, unknown>,
  emit: (e: AgentEvent) => void,
) => Promise<{ text: string; isError?: boolean }>;

export function extractText(content: readonly { type: string }[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function extractThinking(content: readonly { type: string }[]): string {
  return content
    .filter((b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking' && typeof (b as { thinking?: unknown }).thinking === 'string')
    .map((b) => b.thinking)
    .join('\n')
    .trim();
}

export interface LoopParams {
  models: Models;
  model: Model<any>;
  mcp: McpGateway;
  context: Context;
  hooks: AgentHooks;
  localTools?: Record<string, LocalToolHandler>;
  maxIterations?: number;
  /** Aborting stops the loop between/inside iterations (LLM calls are aborted in-flight). */
  signal?: AbortSignal;
}

/**
 * Stream one assistant message, forwarding text/thinking deltas to hooks as
 * they arrive. Returns the final AssistantMessage; provider failures arrive
 * as stopReason 'error'/'aborted' on the message instead of a thrown error.
 */
async function completeStreaming(
  models: Models,
  model: Model<any>,
  context: Context,
  hooks: AgentHooks,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const stream = models.stream(model, context, signal ? { signal } : undefined);
  for await (const ev of stream) {
    if (ev.type === 'text_delta' && ev.delta) hooks.onEvent({ type: 'text_delta', delta: ev.delta });
    else if (ev.type === 'thinking_delta' && ev.delta) hooks.onEvent({ type: 'thinking_delta', delta: ev.delta });
  }
  return stream.result();
}

/**
 * Run one tool-calling loop over an existing context (mutates it in place).
 * Returns the final assistant text.
 */
export async function runLoop(params: LoopParams): Promise<string> {
  const { models, model, mcp, context, hooks, localTools = {}, maxIterations = 20, signal } = params;

  let approvedWrite: { tool: string; argsHash: string } | null = null;
  let lastText = '';
  const usage: TurnUsage = { input: 0, output: 0, total: 0 };

  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) throw new AgentAbortedError();

    const msg: AssistantMessage = await completeStreaming(models, model, context, hooks, signal);
    // 半截的中止消息不入 context：悬挂的 toolCall 没有配对 toolResult，会破坏下一轮请求。
    if (msg.stopReason === 'aborted') throw new AgentAbortedError();
    context.messages.push(msg);
    if (msg.stopReason === 'error') {
      throw new Error((msg as AssistantMessage & { errorMessage?: string }).errorMessage || '模型调用失败');
    }
    usage.input += msg.usage?.input ?? 0;
    usage.output += msg.usage?.output ?? 0;
    usage.total += msg.usage?.totalTokens ?? 0;

    const thinking = extractThinking(msg.content);
    if (thinking) hooks.onEvent({ type: 'thinking', text: thinking });

    const text = extractText(msg.content);
    if (text) {
      lastText = text;
      hooks.onEvent({ type: 'text', text });
    }

    const calls = msg.content.filter((b): b is ToolCall => b.type === 'toolCall');
    if (calls.length === 0) {
      hooks.onEvent({ type: 'done', text: lastText, usage });
      return lastText || '(未得到最终答复)';
    }

    for (const call of calls) {
      hooks.onEvent({ type: 'tool_call', name: call.name, arguments: call.arguments });

      let resultText: string;
      let isError = false;

      if (signal?.aborted) {
        // 停止后跳过真实执行；toolCall 必须配对 toolResult，否则下一轮请求会被 API 拒绝。
        resultText = '（对话已停止，本调用未执行）';
        isError = true;
      } else if (call.name === CONFIRM_TOOL_NAME) {
        const draft = call.arguments as unknown as ConfirmDraft;
        hooks.onEvent({ type: 'confirm', draft });
        const decision = await hooks.requestConfirm(draft);
        const approvedDraft = decision === true ? draft : decision && typeof decision === 'object' ? decision : null;
        approvedWrite = approvedDraft
          ? { tool: approvedDraft.target_tool, argsHash: argumentsHash(approvedDraft.target_arguments ?? {}) }
          : null;
        resultText = approvedDraft
          ? `APPROVED — 仅允许调用 ${approvedDraft.target_tool}，参数为 ${JSON.stringify(approvedDraft.target_arguments ?? {})}`
          : 'REJECTED — 已拒绝，不要写入；请询问用户需要修改什么。';
      } else if (localTools[call.name]) {
        try {
          const r = await localTools[call.name]((call.arguments ?? {}) as Record<string, unknown>, hooks.onEvent);
          resultText = r.text;
          isError = !!r.isError;
        } catch (err) {
          resultText = `本地工具 ${call.name} 执行失败: ${(err as Error).message}`;
          isError = true;
        }
      } else {
        const target = mcp.resolve(call.name);
        if (!target) {
          const connected = mcp.serverNames?.() ?? [];
          const serverHint = connected.length
            ? `当前已连接的 MCP 服务器: ${connected.join('、')}。`
            : '当前没有任何已连接的 MCP 服务器。';
          resultText = `未知工具: ${call.name}。${serverHint}请从系统提示「可用 MCP 工具」清单中选择真实存在的工具名，不要臆造工具名。`;
          isError = true;
        } else if (mcp.isWrite(target.server, target.rawName)) {
          const actualArgs = (call.arguments ?? {}) as Record<string, unknown>;
          if (!approvedWrite) {
            resultText = `拒绝执行: ${call.name} 是写操作。必须先调用 ${CONFIRM_TOOL_NAME} 并获得 APPROVED。`;
            isError = true;
          } else if (approvedWrite.tool !== call.name || approvedWrite.argsHash !== argumentsHash(actualArgs)) {
            resultText = `拒绝执行: 实际工具或参数与已批准草稿不一致，请重新提交 ${CONFIRM_TOOL_NAME}。`;
            approvedWrite = null;
            isError = true;
          } else {
            try {
              const r = await mcp.call(call.name, actualArgs);
              resultText = r.text;
              isError = r.isError;
            } catch (err) {
              resultText = `MCP 调用失败: ${(err as Error).message}`;
              isError = true;
            } finally {
              approvedWrite = null;
            }
          }
        } else {
          try {
            const r = await mcp.call(call.name, (call.arguments ?? {}) as Record<string, unknown>);
            resultText = r.text;
            isError = r.isError;
          } catch (err) {
            resultText = `MCP 调用失败: ${(err as Error).message}`;
            isError = true;
          }
        }
      }

      hooks.onEvent({ type: 'tool_result', name: call.name, result: resultText });
      context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: resultText }],
        isError,
        timestamp: Date.now(),
      });
    }

    if (signal?.aborted) throw new AgentAbortedError();
  }

  hooks.onEvent({ type: 'done', text: lastText, usage });
  return lastText || '（达到最大迭代次数，仍未得到最终答复）';
}

export interface SessionConfig {
  models: Models;
  model: Model<any>;
  mcp: McpGateway;
  tools: Tool[];
  systemPrompt: string;
  localTools?: Record<string, LocalToolHandler>;
  maxIterations?: number;
  /**
   * Live runtime access: when present, each send() refreshes the context's
   * systemPrompt/tools/model before running, so sessions created before an
   * MCP reconnect or model switch pick up the latest runtime state.
   */
  live?: {
    getSystemPrompt(): string;
    getTools(): Tool[];
    getModel(): Model<any>;
  };
}

/** A multi-turn agent session that keeps conversation history in its context. */
export class AgentSession {
  readonly context: Context;

  constructor(private readonly cfg: SessionConfig) {
    this.context = {
      systemPrompt: cfg.systemPrompt,
      messages: [],
      tools: cfg.tools,
    };
  }

  /** Append a user message and run the loop. Returns the final assistant text. */
  async send(userInput: string, hooks: AgentHooks, signal?: AbortSignal): Promise<string> {
    if (this.cfg.live) {
      this.context.systemPrompt = this.cfg.live.getSystemPrompt();
      this.context.tools = this.cfg.live.getTools();
      this.cfg.model = this.cfg.live.getModel();
    }
    this.context.messages.push({ role: 'user', content: userInput, timestamp: Date.now() });
    return runLoop({ ...this.cfg, context: this.context, hooks, signal });
  }

  /** Restore conversation history (used when resuming a persisted session). */
  restore(messages: Context['messages']): void {
    this.context.messages = messages;
  }
}

export interface RunParams extends SessionConfig {
  userInput: string;
  hooks: AgentHooks;
  /** Aborting stops the loop (see LoopParams.signal). */
  signal?: AbortSignal;
}

/** One-shot convenience wrapper (used by the CLI and tests). */
export async function runAgent(params: RunParams): Promise<string> {
  const { userInput, hooks, signal, ...cfg } = params;
  const session = new AgentSession(cfg);
  return session.send(userInput, hooks, signal);
}
