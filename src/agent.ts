import type { AssistantMessage, Context, Model, Models, Tool, ToolCall } from '@earendil-works/pi-ai';
import { CONFIRM_TOOL_NAME, type ConfirmDraft } from './tools/confirm.js';
import type { CustomerContext } from './tools/customer.js';

/** Structural gateway so the loop can be unit-tested with a fake. */
export interface McpGateway {
  resolve(publicName: string): { server: string; rawName: string } | undefined;
  isWrite(server: string, rawName: string): boolean;
  call(publicName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
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
  /** Ask the human to approve/reject a draft. Resolve true = approve. */
  requestConfirm: (draft: ConfirmDraft) => Promise<boolean>;
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

  let approvedWrite = false;
  let lastText = '';

  for (let i = 0; i < maxIterations; i++) {
    const msg: AssistantMessage = await models.complete(model, context);
    context.messages.push(msg);

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
        const ok = await hooks.requestConfirm(draft);
        approvedWrite = ok;
        resultText = ok
          ? 'APPROVED — 本次写操作已获批准，可以调用对应写工具。'
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
          resultText = `未知工具: ${call.name}`;
          isError = true;
        } else if (mcp.isWrite(target.server, target.rawName) && !approvedWrite) {
          resultText = `拒绝执行: ${call.name} 是写操作。必须先调用 ${CONFIRM_TOOL_NAME} 并获得 APPROVED。`;
          isError = true;
        } else {
          try {
            const r = await mcp.call(call.name, (call.arguments ?? {}) as Record<string, unknown>);
            resultText = r.text;
            isError = r.isError;
            approvedWrite = false; // 一次性批准，用完即失效
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
