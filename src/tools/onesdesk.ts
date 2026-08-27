import { Type } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';
import {
  ONES_DESK_FIELD_SPECS,
  ONES_DESK_CLASSIFICATION_HINTS,
  ONES_DESK_DEPLOYMENT_FIELD_ID,
  ONES_DESK_ISSUE_TYPE_IDS,
  ONES_DESK_PROJECT_ID,
  resolveDeploymentType,
  type OnesDeskFieldSpec,
  type OnesDeskDraftType,
} from '../workbench/drafts.js';

export const ONES_DESK_FIELDS_TOOL_NAME = 'get_ones_desk_required_fields';

const DESK_TYPE_LABELS: Record<OnesDeskDraftType, string> = {
  suggestion: '建议和反馈',
  ticket: '工单',
  operations: '运维工单',
};

export interface OnesDeskToolDeps {
  /** 当前会话绑定客户的 CRM「使用版本」（公有云版 / 私有部署按年订阅版 / 私有部署一次性授权版）；未绑定时为 null。 */
  getUsageVersion(): string | null | undefined;
}

/** Local tool: the authoritative ONES Desk required-field contract (labels + option UUIDs + fallbacks). */
export const onesDeskFieldsTool: Tool = {
  name: ONES_DESK_FIELDS_TOOL_NAME,
  description:
    '获取 ONES Desk 工作项（建议和反馈/工单/运维工单）除标题/项目/类型/客户信息/描述之外的全部人工必填字段契约：' +
    '字段 fieldID、完整选项 label→UUID 表、证据不足时的兜底值，以及当前绑定客户按 CRM 使用版本解析出的实例部署类型。' +
    '新建 ONES 工作项前必须调用本工具：get_issue_fields 会对大选项集（所属模块/所属产品）截断且部分选项 UUID 无效，' +
    '不可用于枚举选项；本工具的选项表是唯一可靠来源。fieldValues 中每个规格字段都必须携带其中一个有效选项 UUID。',
  parameters: Type.Object({
    record_type: Type.Union([Type.Literal('suggestion'), Type.Literal('ticket'), Type.Literal('operations')], {
      description: '工作项类型：suggestion=建议和反馈、ticket=工单、operations=运维工单',
    }),
  }),
};

export function makeOnesDeskFieldsHandler(deps: OnesDeskToolDeps) {
  return async (args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
    const recordType = args.record_type as OnesDeskDraftType | undefined;
    if (!recordType || !(['suggestion', 'ticket', 'operations'] as const).includes(recordType)) {
      return { text: 'record_type 必须是 suggestion / ticket / operations 之一。', isError: true };
    }
    const usageVersion = deps.getUsageVersion();
    const deployment = resolveDeploymentType(usageVersion);
    const specs = ONES_DESK_FIELD_SPECS[recordType as OnesDeskDraftType];
    const fields = specs.map((spec: OnesDeskFieldSpec) => {
      const deploymentResolved = spec.uuid === ONES_DESK_DEPLOYMENT_FIELD_ID
        ? `当前客户解析值：${deployment}（依据 CRM 使用版本=${usageVersion ?? '未同步，按私有云兜底'}；公有云版→公有云，其余→私有云。此字段必须用该解析值，不得按沟通证据另选）`
        : '';
      return {
        fieldID: spec.uuid,
        label: spec.label,
        兜底值: spec.defaultValue ?? null,
        options: spec.options ?? null,
        ...(spec.member ? { 说明: '成员字段：可填用户 UUID 或兜底成员名' } : {}),
        ...(deploymentResolved ? { 说明: deploymentResolved } : {}),
      };
    });
    const hints = recordType === 'suggestion'
      ? ONES_DESK_CLASSIFICATION_HINTS.module.map((line) => `- ${line}`).join('\n')
      : recordType === 'ticket' ? ONES_DESK_CLASSIFICATION_HINTS.product.map((line) => `- ${line}`).join('\n') : '';
    const lines = [
      `ONES Desk「${DESK_TYPE_LABELS[recordType]}」必填字段契约（projectID=${ONES_DESK_PROJECT_ID}，issueTypeID=${ONES_DESK_ISSUE_TYPE_IDS[recordType]}）：`,
      JSON.stringify(fields, null, 2),
      '',
      '使用规则：',
      '- fieldValues 必须包含每个字段的 {fieldID, value}，value 用选项 UUID（不是 label）；证据不足时用兜底值对应的 UUID。',
      '- 实例部署类型按上面给出的当前客户解析值填写，不得按沟通证据另选。',
      hints ? `- 所属${recordType === 'suggestion' ? '模块' : '产品'}按分类指引选最接近的一项：\n${hints}` : '',
    ].filter(Boolean);
    return { text: lines.join('\n') };
  };
}
