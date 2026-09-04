---
name: csm-workbench-data
description: 从工作台本地数据库读取客户的已同步数据（档案、风险、机会、时间线）。在需要了解客户现状、回答客户分析类问题、生成草稿前，先执行本 skill（本地优先，MCP 兜底）。
---

# 工作台本地数据读取（本地优先）

目标：优先使用工作台已同步的本地数据，避免每次都实时调 MCP 重复拉取。

## 什么时候用本地工具

对话中已明确客户身份后（客户全称/简称/别名已知——本地工具按唯一匹配解析：精确或唯一子串），回答下列问题**先用本地工具**——会话不绑定客户，每次调用都要带 `customer_name`（或 `customer_id`）参数：

- 主入口是 `get_customer_detail`：按板块（sections）抓取客户详情页数据，与客户页 tab 一一对应——
  `overview` 概览（档案/风险/机会/完成率）、`suggestion_feedback` 建议、`support_ticket` 工单、`operations_ticket` 运维、
  `customer_manhour` 工时明细、`private_cloud_instance` 私有云实例、`followup` 跟进记录、`hemory_fragments` 会议片段、
  `cases` 客户案例、`weekly_report` 实施周报、`actions` 待办事项、`timeline` 统一时间线。
- **默认最小选择**：每轮只取与本轮问题直接相关的 sections（问工单就只取 `["support_ticket"]`），节省 token；
  仅当用户明确要求「全部信息 / 完整情况」时才传 `["all"]`。
- 客户现状概览（健康度、续约、合同、风险评分、增购机会）→ `["overview"]`
- 续约风险 / 增购机会分析 → 先 `["overview"]` 拿全景，再按需追加相关板块（如 `support_ticket`、`followup`、`hemory_fragments`）
- `get_customer_profile` / `get_customer_events` 仍可用（旧版粗粒度等价），新代码优先 `get_customer_detail`。

## 什么时候改用 MCP 实时查询

- 工具返回提示数据 stale（超过 36 小时未同步）：先告知用户数据可能滞后，建议用户在客户页点「刷新三套系统」；用户明确要最新数据时再用 MCP 工具实时查询。
- 需要本地没有的数据（例如某工单的最新评论、CRM 记录的最新字段值）。
- 会话尚未明确客户是哪一家时，先完成 csm-identity-resolution（resolve_customer 无状态解析出权威标识），再回到本地工具。

## 硬性规则

- 本地工具结果里每条数据都带同步时间（synced_at / last_synced_at）；引用数据时注明数据截至时间。
- 本地没有 ≠ 源系统没有。不得把"本地未搜到"当作业务事实（如"客户没有工单"）；如需确认请实时查 MCP。
- 事件时间线里 Hemory 片段只含已确认归属的；未归属片段不会出现在本地结果中。
