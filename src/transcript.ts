import type { ConfirmDraft } from './tools/confirm.js';

/** Display event shape persisted with each session (superset of AgentEvent). */
export interface TranscriptEvent {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  draft?: ConfirmDraft;
  result?: string;
  /** 用户消息携带的附件元信息（不落 base64）。 */
  attachments?: Array<{ name?: string }>;
}

export interface TranscriptSession {
  title: string;
  createdAt: number;
  updatedAt: number;
  events: Array<{ seq: number; event: TranscriptEvent }>;
  customer?: { customer_name?: string; crm_customer_id?: string } | null;
}

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

/** Render one display event as a transcript line; null means skip (not user-visible). */
function eventLine(event: TranscriptEvent): string | null {
  switch (event.type) {
    case 'user': {
      const attachmentNames = Array.isArray(event.attachments)
        ? event.attachments.map((a) => (a?.name ?? '').trim()).filter(Boolean)
        : [];
      const suffix = attachmentNames.length ? `（附件：${attachmentNames.map((n) => `📎 ${n}`).join('、')}）` : '';
      return `用户：${event.text ?? ''}${suffix}`;
    }
    case 'text':
      return `助手：${event.text ?? ''}`;
    case 'confirm': {
      const draft = event.draft;
      if (!draft) return null;
      return `[待确认草稿] ${draft.title} ｜ 目标: ${draft.target_system} ｜ 工具: ${draft.target_tool}`;
    }
    default:
      // 工具轨迹（tool_call/tool_result）与 turn_start/turn_end/customer_context/done 等不进分享文本。
      return null;
  }
}

/** Build the plain-text transcript used by session sharing (标题 + 客户绑定 + 时间范围 + 对话). */
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
