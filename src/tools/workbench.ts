import { Type } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';

export const CUSTOMER_PROFILE_TOOL_NAME = 'get_customer_profile';
export const CUSTOMER_EVENTS_TOOL_NAME = 'get_customer_events';

const STALE_MS = 36 * 3_600_000;

/** Local tool: read the customer's synced workbench profile (local-first). */
export const customerProfileTool: Tool = {
  name: CUSTOMER_PROFILE_TOOL_NAME,
  description:
    '读取指定客户在工作台已同步的档案聚合（customer_name/customer_id 指定客户，全称或简称唯一精确匹配）：客户基本信息（名称/行业/健康度/续约日期/合同价值/CSM）、' +
    '最近一次互动时间、风险评分、增购机会假设、各数据源（crm/ones/hemory）事件数量与最近同步时间、' +
    '最近公开网络动态（web_signal 证据）。结果只反映本地已同步数据，请结合各源 last_synced_at 评估新鲜度；' +
    '超过 36 小时未同步视为过期（stale），此时可提示用户刷新或改用 MCP 工具实时查询。',
  parameters: Type.Object({
    customer_name: Type.Optional(Type.String({ description: '客户全称或简称（与工作台客户唯一精确匹配）' })),
    customer_id: Type.Optional(Type.String({ description: 'CRM CSM售后客户 _id（已知权威 ID 时优先用它）' })),
  }),
};

/** Local tool: read the customer's synced event timeline (local-first). */
export const customerEventsTool: Tool = {
  name: CUSTOMER_EVENTS_TOOL_NAME,
  description:
    '读取指定客户在工作台已同步的事件时间线（customer_name/customer_id 指定客户，全称或简称唯一精确匹配；按发生时间倒序）：CRM 跟进记录、ONES 建议/工单/运维工单/工时/私有云实例、' +
    'Hemory 会议片段（含转写摘要）等。可用 sourceType 过滤类型，limit 控制条数（默认 50，最大 200）。' +
    '结果只反映本地已同步数据；缺失的时间段不代表没有事件。',
  parameters: Type.Object({
    customer_name: Type.Optional(Type.String({ description: '客户全称或简称（与工作台客户唯一精确匹配）' })),
    customer_id: Type.Optional(Type.String({ description: 'CRM CSM售后客户 _id（已知权威 ID 时优先用它）' })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: '返回条数，默认 50' })),
    sourceType: Type.Optional(Type.String({ description: '按事件类型过滤，如 crm_followup / support_ticket / suggestion_feedback / operations_ticket / customer_manhour / private_cloud_instance / ai_topic_segment' })),
  }),
};

function isStale(syncedAt: string | null | undefined): boolean {
  if (!syncedAt) return true;
  const at = Date.parse(syncedAt);
  return Number.isNaN(at) || Date.now() - at > STALE_MS;
}

export interface WorkbenchToolDeps {
  /** 按调用参数解析客户（全称/简称唯一精确匹配，或按权威 CRM _id 直取）；未唯一命中返回 null。 */
  resolveCustomer(name?: string, id?: string): { id: string; name: string } | null;
  overview(customerId: string): Record<string, unknown> | null;
  timeline(customerId: string, limit: number): Array<Record<string, unknown>>;
}

function requireCustomer(
  deps: WorkbenchToolDeps,
  toolName: string,
  args: Record<string, unknown>,
): { id: string; name: string } {
  const customer = deps.resolveCustomer(
    typeof args.customer_name === 'string' ? args.customer_name.trim() : undefined,
    typeof args.customer_id === 'string' ? args.customer_id.trim() : undefined,
  );
  if (!customer) {
    throw new Error(
      `${toolName}: 未提供或未能唯一解析客户——请带 customer_name（客户全称/简称，唯一精确匹配；身份未锁定时先完成 csm-identity-resolution）。`,
    );
  }
  return customer;
}

export function makeWorkbenchToolHandlers(deps: WorkbenchToolDeps): {
  profile: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
  events: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
} {
  return {
    profile: async (args) => {
      const customer = requireCustomer(deps, CUSTOMER_PROFILE_TOOL_NAME, args);
      const overview = deps.overview(customer.id);
      if (!overview) {
        return { text: `工作台未找到客户 ${customer.name}（${customer.id}）的档案，请先刷新同步。`, isError: true };
      }
      const payload = overview as {
        customer?: { syncedAt?: string | null };
        sourceCounts?: Array<{ source_system: string; count: number; last_synced_at: string | null }>;
      };
      const stale = isStale(payload.customer?.syncedAt);
      const lines = [
        `客户工作台档案（${customer.name}）：`,
        JSON.stringify(overview, null, 2),
        '',
        stale
          ? `注意：该客户数据已超过 36 小时未同步（synced_at=${payload.customer?.syncedAt ?? 'unknown'}），可能有滞后；可建议用户刷新，或用 MCP 工具实时查询最新数据。`
          : `数据新鲜度：synced_at=${payload.customer?.syncedAt ?? 'unknown'}，在 36 小时内。`,
      ];
      return { text: lines.join('\n') };
    },
    events: async (args) => {
      const customer = requireCustomer(deps, CUSTOMER_EVENTS_TOOL_NAME, args);
      const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50) || 50));
      const sourceType = typeof args.sourceType === 'string' && args.sourceType.trim() ? args.sourceType.trim() : null;
      const all = deps.timeline(customer.id, sourceType ? 200 : limit);
      const events = sourceType ? all.filter((e) => e.sourceType === sourceType).slice(0, limit) : all;
      if (!events.length) {
        return { text: `没有已同步的${sourceType ? `“${sourceType}”` : ''}事件。注意这只说明本地没有，不代表源系统没有；如需最新数据可用 MCP 工具实时查询。` };
      }
      const body = events.map((e) => JSON.stringify(e)).join('\n');
      return { text: `客户「${customer.name}」已同步事件（共 ${events.length} 条，按发生时间倒序）：\n${body}` };
    },
  };
}
