---
name: ones-product-knowledge
description: ONES product capabilities grounded in the private deployment v7.26.0 manual and official Platform 1.0/2.0 documentation, captured 2026-09-05. Use for product questions, customer solutions, feasibility and accurate ONES terminology. Distinguish versioned native capabilities, configuration, extensions and unverified customer delivery.
metadata:
  version: "7.26.0-20260905"
  tags: [ones, product-knowledge, v7.26.0, customer-success]
---

# ONES 产品能力知识库

当前文档基线：**私有部署 v7.26.0**，官方版本说明日期 2026-08-27，本次采集与核对日期 2026-09-05。这不是用户环境已经升级至 v7.26.0 的证明，也不能直接推导 SaaS、其他版本或所有许可证都具备相同能力。

## 使用入口

1. 先读 [当前能力与限制](references/current-capabilities.md)，确定原生功能、配置能力、开放扩展或未知。
2. 用 [完整手册索引](references/official/index.md) 定位正文。该索引覆盖指定空间全部 317 页，按原页面树保存可读内容、来源及校验值；不要默认加载整个语料库。
3. 精确到公式、权限、审批、数据迁移或产品操作时，阅读对应正文后再回答。接口、插件配置、SDK 方法应转到相应开发技能的官方协议，产品手册不能替代 API schema。
4. 对照 [本次纠正与证据边界](references/evidence-boundaries.md)，避免旧概览中的过度承诺。

## 产品模型

ONES Project 与 ONES Wiki 是核心产品。Project 手册下包括项目与工作项、测试、工时资源、项目集、效能、DevOps 和流程自动化；ONES Desk、AI 智能助手及账号安全有各自章节。TestCase、Performance、Plan、Account 可作为熟悉名称或历史产品名称，但不能据此编造当前采购包、实施阶段或授权范围。

原生能力摘要：自定义工作项与工作流、属性与布局、迭代看板、甘特图与基线、关系追溯图、需求跟踪矩阵、工作项审批与交接、测试闭环、工时资源、效能仪表盘、Wiki 协作与审批公开发布、Desk 工单、账号集成、AI/MCP。

v7.26.0 版本说明明确新增需求跟踪矩阵：多层级追溯、缺口筛选、覆盖率卡片、Excel 导出。权限不足的链路不能当作已确认缺口；覆盖率按已保存配置计算，不受缺口显示开关影响。

## 证据规则

- **文档**：官方手册描述了能力。带上版本、来源和必要前提。
- **已验证**：在明确环境、版本、身份与时间下实际完成了对应操作。有页面正文或 HTTP 200 不代表产品业务验证。
- **未知**：手册未覆盖、来源冲突、许可证/配置不明或缺少实测。未知不等于不支持，也不等于支持。
- 区分“原生具备”“配置后可用”“需插件/集成开发”“方案建议”。例如 Jenkins 原生流水线集成不能自动扩展为所有 CI/CD 工具原生集成。
- 产品能力不是客户已交付证据。客户案例与汇报中的“已部署、已打通、已提升”需要客户素材或运行证据；AI 仅形成待人工确认的草稿。
- 不从通用方法推导固定实施周期、量化收益、SLA、合规认证保证、报价、套餐或数据库兼容矩阵。使用当前合同、采购资料或目标版本运维文档另行核对。

## 开放平台边界

| 类型 | 正文来源 | 开发标识 |
| --- | --- | --- |
| Plugin 1.0 | https://developer.ones.cn/zh-CN/ | `config/plugin.yaml`、`@ones/cli`、`npx op`、`.opk` |
| App 2.0 | https://open.ones.cn/zh-CN/ | `@ones-open/cli`、`opkx.json`、`.opkx`，或外部托管 manifest |

两者都有扩展能力，但注册结构、身份和 SDK 不可混用。调用具体 API 仍需核对路径、scope、业务权限和目标版本；页面内部接口不等同于公开 API。

## 历史资料

[v7.22.0 正文快照](references/ones-private-v7.22.0-product-capability.md) 仅用于明确的旧版本问题；不要据此判定 v7.26.0 能力首次出现的版本。

[旧 V7.0 概览](references/legacy-v7.0-overview.md) 保留追溯用途，其中未逐条核实的 DORA、流水线工具、标准周期、采购分期和运维适配表不再作为当前答案依据。当前摘要与官方正文优先。
