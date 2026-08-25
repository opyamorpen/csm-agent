import { Type } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';

export const CONFIRM_TOOL_NAME = 'confirm_write';

export interface ConfirmDraft {
  target_system: string;
  target_object: string;
  record_type: string;
  title: string;
  summary: string;
  fields: Record<string, unknown>;
  target_tool: string;
  target_arguments: Record<string, unknown>;
}

/** The only gate before any write to CRM or ONES. */
export const confirmWriteTool: Tool = {
  name: CONFIRM_TOOL_NAME,
  description:
    '在向 CRM 或 ONES 写入任何记录之前，把完整草稿展示给 CSM 请求批准。' +
    '必须先调用本工具并获得 APPROVED，之后才能调用写工具。' +
    'target_system 填 crm 或 ones；record_type 可填 suggestion / ticket / operations / workhour / followup / private_cloud_instance / profile / case；' +
    'target_tool 和 target_arguments 必须与批准后实际调用完全一致；' +
    'fields 填完整草稿字段（与 Templates 中的契约一致）。',
  parameters: Type.Object({
    target_system: Type.String({ description: '回写目标系统：crm 或 ones' }),
    target_object: Type.String({ description: '目标对象，例如 "CRM 跟进记录" 或 "ONES Wiki 客户档案页面"' }),
    record_type: Type.String({ description: '产出类型：suggestion / ticket / operations / workhour / followup / private_cloud_instance / profile / case' }),
    title: Type.String({ description: '草稿标题' }),
    summary: Type.String({ description: '一段人类可读的摘要，说明即将写入什么' }),
    fields: Type.Record(Type.String(), Type.Unknown()),
    target_tool: Type.String({ description: '批准后唯一允许调用的完整 MCP 工具名' }),
    target_arguments: Type.Record(Type.String(), Type.Unknown(), { description: '批准后传给目标工具的完整参数' }),
  }),
};
