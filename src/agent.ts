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

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'confirm' | 'tool_result' | 'customer_context' | 'done';
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  draft?: ConfirmDraft;
  result?: string;
  context?: CustomerContext;
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

export interface LoopParams {
  models: Models;
  model: Model<any>;
  mcp: McpGateway;
  context: Context;
  hooks: AgentHooks;
  localTools?: Record<string, LocalToolHandler>;
  maxIterations?: number;
}

/**
 * Run one tool-calling loop over an existing context (mutates it in place).
 * Returns the final assistant text.
 */
export async function runLoop(params: LoopParams): Promise<string> {
  const { models, model, mcp, context, hooks, localTools = {}, maxIterations = 20 } = params;

  let approvedWrite: { tool: string; argsHash: string } | null = null;
  let lastText = '';

  for (let i = 0; i < maxIterations; i++) {
    const msg: AssistantMessage = await models.complete(model, context);
    context.messages.push(msg);
    if (msg.stopReason === 'error') {
      throw new Error((msg as AssistantMessage & { errorMessage?: string }).errorMessage || '模型调用失败');
    }

    const text = extractText(msg.content);
    if (text) {
      lastText = text;
      hooks.onEvent({ type: 'text', text });
    }

    const calls = msg.content.filter((b): b is ToolCall => b.type === 'toolCall');
    if (calls.length === 0) {
      hooks.onEvent({ type: 'done', text: lastText });
      return lastText || '(未得到最终答复)';
    }

    for (const call of calls) {
      hooks.onEvent({ type: 'tool_call', name: call.name, arguments: call.arguments });

      let resultText: string;
      let isError = false;

      if (call.name === CONFIRM_TOOL_NAME) {
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
  }

  hooks.onEvent({ type: 'done', text: lastText });
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
  async send(userInput: string, hooks: AgentHooks): Promise<string> {
    if (this.cfg.live) {
      this.context.systemPrompt = this.cfg.live.getSystemPrompt();
      this.context.tools = this.cfg.live.getTools();
      this.cfg.model = this.cfg.live.getModel();
    }
    this.context.messages.push({ role: 'user', content: userInput, timestamp: Date.now() });
    return runLoop({ ...this.cfg, context: this.context, hooks });
  }

  /** Restore conversation history (used when resuming a persisted session). */
  restore(messages: Context['messages']): void {
    this.context.messages = messages;
  }
}

export interface RunParams extends SessionConfig {
  userInput: string;
  hooks: AgentHooks;
}

/** One-shot convenience wrapper (used by the CLI and tests). */
export async function runAgent(params: RunParams): Promise<string> {
  const { userInput, hooks, ...cfg } = params;
  const session = new AgentSession(cfg);
  return session.send(userInput, hooks);
}
