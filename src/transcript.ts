import { CONFIRM_TOOL_NAME, type ConfirmDraft } from './tools/confirm.js';

/** Display event shape persisted with each session (superset of AgentEvent). */
export interface TranscriptEvent {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  draft?: ConfirmDraft;
  result?: string;
}

export interface TranscriptSession {
  title: string;
  createdAt: number;
  updatedAt: number;
  events: Array<{ seq: number; event: TranscriptEvent }>;
  customer?: { customer_name?: string; crm_customer_id?: string } | null;
}

const TOOL_CALL_ARGS_LIMIT = 200;
const TOOL_RESULT_LIMIT = 500;

function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Render one display event as a transcript line; null means skip (not user-visible). */
function eventLine(event: TranscriptEvent): string | null {
  switch (event.type) {
    case 'user':
      return `用户：${event.text ?? ''}`;
    case 'text':
      return `助手：${event.text ?? ''}`;
    case 'tool_call':
      return `[调用工具] ${event.name ?? 'unknown'} ${clip(JSON.stringify(event.arguments ?? {}), TOOL_CALL_ARGS_LIMIT)}`;
    case 'tool_result': {
      if (event.name === CONFIRM_TOOL_NAME) return null; // 与对话界面一致，不展示 confirm_write 内部结果。
      return `[工具结果] ${event.name ?? 'unknown'}: ${clip(event.result ?? '', TOOL_RESULT_LIMIT)}`;
    }
    case 'confirm': {
      const draft = event.draft;
      if (!draft) return null;
      return `[待确认草稿] ${draft.title} ｜ 目标: ${draft.target_system} ｜ 工具: ${draft.target_tool}`;
    }
    default:
      // turn_start/turn_end/customer_context/done 等界面不渲染的事件同样不进分享文本。
      return null;
  }
}

/** Build the plain-text transcript used by session sharing (对话 + 工具轨迹). */
export function formatSessionTranscript(session: TranscriptSession): string {
  const customer = session.customer;
  const customerLabel = customer?.customer_name
    ? `${customer.customer_name}${customer.crm_customer_id ? `（CRM ${customer.crm_customer_id}）` : ''}`
    : customer?.crm_customer_id
      ? `CRM ${customer.crm_customer_id}`
      : '未绑定客户';
  const lines: string[] = [
    `# ${session.title || '新对话'}`,
    `客户：${customerLabel}`,
    `会话时间：${formatTime(session.createdAt)} - ${formatTime(session.updatedAt)}（北京时间）`,
    '',
  ];
  for (const { event } of session.events) {
    const line = eventLine(event);
    if (line !== null) lines.push(line);
  }
  return lines.join('\n');
}
