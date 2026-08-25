import { Type } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';

export const CUSTOMER_CONTEXT_TOOL_NAME = 'resolve_customer';

export interface CustomerContext {
  customer_name?: string;
  crm_customer_id?: string;
  ones_project?: string;
  ones_customer_option_id?: string;
  customer_manhour_issue_id?: string;
  recording_subject_id?: string;
  industry?: string;
  scale?: string;
  stage?: string;
  health?: string;
  renewal_status?: string;
  key_contacts?: string;
  summary?: string;
}

const FIELDS: Array<keyof CustomerContext> = [
  'customer_name',
  'crm_customer_id',
  'ones_project',
  'ones_customer_option_id',
  'customer_manhour_issue_id',
  'recording_subject_id',
  'industry',
  'scale',
  'stage',
  'health',
  'renewal_status',
  'key_contacts',
  'summary',
];

/** Local tool: model submits structured customer identity/context for the UI card. */
export const resolveCustomerTool: Tool = {
  name: CUSTOMER_CONTEXT_TOOL_NAME,
  description:
    '把已解析的客户身份与上下文以结构化形式提交，用于在界面上展示客户上下文卡。' +
    '可在读取到新信息后再次调用以增量更新（只覆盖非空字段）。' +
    '字段：customer_name 客户名称、crm_customer_id、ones_project、ones_customer_option_id、customer_manhour_issue_id、recording_subject_id、' +
    'industry 行业、scale 规模、stage 当前阶段、health 健康度(红/黄/绿)、' +
    'renewal_status 续约状态、key_contacts 关键联系人、summary 最近跟进摘要。',
  parameters: Type.Object({
    customer_name: Type.Optional(Type.String()),
    crm_customer_id: Type.Optional(Type.String()),
    ones_project: Type.Optional(Type.String()),
    ones_customer_option_id: Type.Optional(Type.String()),
    customer_manhour_issue_id: Type.Optional(Type.String()),
    recording_subject_id: Type.Optional(Type.String()),
    industry: Type.Optional(Type.String()),
    scale: Type.Optional(Type.String()),
    stage: Type.Optional(Type.String()),
    health: Type.Optional(Type.String()),
    renewal_status: Type.Optional(Type.String()),
    key_contacts: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
  }),
};

/** Pick known fields from tool arguments, stringified and empty-dropped. */
export function extractCustomerContext(args: Record<string, unknown>): CustomerContext {
  const out: CustomerContext = {};
  for (const k of FIELDS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** Merge `next` over `prev`: non-empty fields win, others keep the old value. */
export function mergeCustomerContext(prev: CustomerContext | null, next: CustomerContext): CustomerContext {
  const out: CustomerContext = { ...(prev ?? {}) };
  for (const k of FIELDS) {
    const v = next[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}
