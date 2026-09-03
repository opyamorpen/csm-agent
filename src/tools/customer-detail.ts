import { Type } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';

export const CUSTOMER_DETAIL_TOOL_NAME = 'get_customer_detail';

/** 客户详情页 13 个 tab 的 key，与 `all`（整表拉取，仅用户明确要求时使用）。 */
export const CUSTOMER_DETAIL_SECTIONS = [
  'overview',
  'suggestion_feedback',
  'support_ticket',
  'operations_ticket',
  'customer_manhour',
  'private_cloud_instance',
  'followup',
  'web_intel',
  'hemory_fragments',
  'cases',
  'weekly_report',
  'actions',
  'timeline',
] as const;

export type CustomerDetailSection = (typeof CUSTOMER_DETAIL_SECTIONS)[number];

const SECTION_LABELS: Record<CustomerDetailSection, string> = {
  overview: '概览（客户档案/风险/机会/完成率/数据新鲜度）',
  suggestion_feedback: '建议',
  support_ticket: '工单',
  operations_ticket: '运维工单',
  customer_manhour: '工时（汇总 + 逐条登记明细）',
  private_cloud_instance: '私有云实例',
  followup: 'CRM 跟进记录',
  web_intel: '公开动态（轮次报告：最近 3 轮逐条明细，新增条目带 is_new 标记）',
  hemory_fragments: 'Hemory 已确认会议片段（含转写摘要）',
  cases: '客户案例（候选 + 草稿摘要）',
  weekly_report: '实施周报（列表 + 最新一期正文）',
  actions: '待办事项',
  timeline: '统一时间线（全部事件混合）',
};

/** events 类的 sourceType（复用 source_events 统一表）。 */
const EVENT_SECTIONS: Partial<Record<CustomerDetailSection, string>> = {
  suggestion_feedback: 'suggestion_feedback',
  support_ticket: 'support_ticket',
  operations_ticket: 'operations_ticket',
  private_cloud_instance: 'private_cloud_instance',
  followup: 'crm_followup',
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** 单节输出字符上限：防 197 项模块表级别的长 payload 一次灌爆上下文。 */
const SECTION_CHAR_CAP = 30000;

/** Local tool: fetch customer detail-tab data on demand (local-first, minimal sections). */
export const customerDetailTool: Tool = {
  name: CUSTOMER_DETAIL_TOOL_NAME,
  description:
    '按需读取指定客户的客户详情页数据（本地已同步数据，结果含同步时间）。customer_name/customer_id 指定客户（全称或简称，唯一精确匹配）。' +
    'sections 选择需要的板块，与客户详情页 tab 一一对应：' +
    'overview 概览（档案/风险/机会/完成率）、suggestion_feedback 建议、support_ticket 工单、operations_ticket 运维工单、' +
    'customer_manhour 工时明细、private_cloud_instance 私有云实例、followup 跟进记录、web_intel 公开动态轮次报告、' +
    'hemory_fragments Hemory 片段、cases 客户案例、weekly_report 实施周报、actions 待办事项、timeline 统一时间线。' +
    '默认最小选择：每轮只取与本轮问题直接相关的板块，节省 token；仅当用户明确要求「全部/完整信息」时才传 ["all"]。' +
    'limit 仅作用于事件类板块（建议/工单/运维/私有云/跟进/时间线），默认 50，最大 200。',
  parameters: Type.Object({
    customer_name: Type.Optional(Type.String({ description: '客户全称或简称（与工作台客户唯一精确匹配）' })),
    customer_id: Type.Optional(Type.String({ description: 'CRM CSM售后客户 _id（已知权威 ID 时优先用它）' })),
    sections: Type.Array(Type.String(), {
      description: '需要的板块 key 列表；["all"] 表示全部 13 个板块（仅用户明确要求全部信息时使用）',
      minItems: 1,
    }),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIMIT, description: '事件类板块条数，默认 50' })),
  }),
};

/** 解析 sections 参数：白名单过滤 + 去重 + all 展开；空结果返回 null 交给调用方报错。 */
export function resolveSections(raw: unknown): CustomerDetailSection[] | null {
  if (!Array.isArray(raw)) return null;
  const wanted = raw.map((s) => String(s).trim()).filter(Boolean);
  if (wanted.includes('all')) return [...CUSTOMER_DETAIL_SECTIONS];
  const valid = new Set<string>(CUSTOMER_DETAIL_SECTIONS);
  const picked = [...new Set(wanted.filter((s) => valid.has(s)))] as CustomerDetailSection[];
  return picked.length ? picked : null;
}

function cap(text: string): string {
  if (text.length <= SECTION_CHAR_CAP) return text;
  return `${text.slice(0, SECTION_CHAR_CAP)}\n……（本板块内容过长已截断至 ${SECTION_CHAR_CAP} 字符；可缩小范围或追问具体条目）`;
}

export interface CustomerDetailToolDeps {
  /** 按调用参数解析客户（全称/简称唯一精确匹配，或按权威 CRM _id 直取）；未唯一命中返回 null。 */
  resolveCustomer(name?: string, id?: string): { id: string; name: string } | null;
  overview(customerId: string): Record<string, unknown> | null;
  timeline(customerId: string, limit: number): Array<Record<string, unknown>>;
  /** 工时明细（汇总 + 登记行）。 */
  workhours(customerId: string): Promise<Record<string, unknown>>;
  hemoryFragments(customerId: string, limit: number): Array<Record<string, unknown>>;
  /** 公开动态轮次报告（run 即报告），取最近 3 轮防 token 灌爆。 */
  webIntelRounds(customerId: string): Array<Record<string, unknown>>;
  /** 案例：候选 + 草稿列表（含 markdown 渲染由各草稿 detail 拼接成本在服务端做）。 */
  cases(customerId: string): Promise<Record<string, unknown>>;
  weeklyReports(customerId: string): Promise<Record<string, unknown>>;
  actions(customerId: string): Array<Record<string, unknown>>;
}

function block(label: string, body: string): string {
  return `## ${label}\n${cap(body)}`;
}

/**
 * 客户详情按板块拼装：每节一个 `## 中文名` 头，节内 JSON/文本。
 * 事件类板块走 sourceType 过滤，避免一次拉混合时间线再让模型自己筛。
 */
export async function makeCustomerDetailResult(
  deps: CustomerDetailToolDeps,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const customer = deps.resolveCustomer(
    typeof args.customer_name === 'string' ? args.customer_name.trim() : undefined,
    typeof args.customer_id === 'string' ? args.customer_id.trim() : undefined,
  );
  if (!customer) {
    return {
      text: `${CUSTOMER_DETAIL_TOOL_NAME}: 未提供或未能唯一解析客户——请带 customer_name（客户全称/简称，唯一精确匹配；身份未锁定时先完成 csm-identity-resolution）。`,
      isError: true,
    };
  }
  const sections = resolveSections(args.sections);
  if (!sections) {
    return {
      text: `${CUSTOMER_DETAIL_TOOL_NAME}: sections 无效。可选值：${[...CUSTOMER_DETAIL_SECTIONS, 'all'].join(' / ')}`,
      isError: true,
    };
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));

  const parts: string[] = [`客户「${customer.name}」详情板块（本地已同步数据，共 ${sections.length} 节）：`];
  for (const section of sections) {
    const label = SECTION_LABELS[section];
    if (section === 'overview') {
      // 概览剔除 timeline（归 timeline 板块）、caseDrafts/actions（归各自板块），避免重复拉取与 token 浪费。
      const data = deps.overview(customer.id);
      if (!data) {
        parts.push(block(label, '工作台未找到该客户档案，请先刷新同步。'));
        continue;
      }
      const { timeline: _timeline, caseDrafts: _caseDrafts, actions: _actions, ...slim } = data as Record<string, unknown>;
      parts.push(block(label, JSON.stringify(slim, null, 2)));
    } else if (section in EVENT_SECTIONS) {
      const sourceType = EVENT_SECTIONS[section]!;
      const events = deps.timeline(customer.id, MAX_LIMIT).filter((e) => e.sourceType === sourceType).slice(0, limit);
      parts.push(block(label, events.length ? events.map((e) => JSON.stringify(e)).join('\n') : `本地暂无已同步的「${label}」数据（不代表源系统没有，可提示用户刷新）。`));
    } else if (section === 'timeline') {
      const events = deps.timeline(customer.id, limit);
      parts.push(block(label, events.length ? events.map((e) => JSON.stringify(e)).join('\n') : '本地暂无已同步事件。'));
    } else if (section === 'customer_manhour') {
      parts.push(block(label, JSON.stringify(await deps.workhours(customer.id), null, 2)));
    } else if (section === 'hemory_fragments') {
      const fragments = deps.hemoryFragments(customer.id, limit);
      parts.push(block(label, fragments.length ? fragments.map((f) => JSON.stringify(f)).join('\n') : '本地暂无已确认 Hemory 片段。'));
    } else if (section === 'web_intel') {
      const rounds = deps.webIntelRounds(customer.id);
      parts.push(block(label, rounds.length ? JSON.stringify(rounds, null, 2) : '暂无公开动态轮次记录（不代表没有公开信息，可 web_search 实时检索）。'));
    } else if (section === 'cases') {
      parts.push(block(label, JSON.stringify(await deps.cases(customer.id), null, 2)));
    } else if (section === 'weekly_report') {
      parts.push(block(label, JSON.stringify(await deps.weeklyReports(customer.id), null, 2)));
    } else if (section === 'actions') {
      const actions = deps.actions(customer.id);
      parts.push(block(label, actions.length ? JSON.stringify(actions, null, 2) : '本地暂无待办事项。'));
    }
  }
  return { text: parts.join('\n\n') };
}
