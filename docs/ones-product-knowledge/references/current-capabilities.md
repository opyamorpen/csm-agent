# ONES 私有部署 v7.26.0 能力与限制

来源：2026-09-05 采集的 [官方手册完整索引](official/index.md)。所有下列陈述均为文档证据；实际部署、许可证、配置与客户使用情况需要另证。

## 项目与研发对象

| 能力 | 有来源的描述 | 前提与限制 | 正文 |
| --- | --- | --- | --- |
| 产品架构 | Project、Wiki 为核心；Project 覆盖测试、资源、项目集、效能、自动化、DevOps | 模块分类不等同于购买授权 | [产品概览](official/pages/MUgoysYk.md) |
| 项目 | 项目模板、组件、角色成员、项目状态、归档删除、绑定页面组 | 删除/归档影响需看对应对象规则 | [项目设置](official/pages/J3W4ackd.md) |
| 工作项 | 自定义类型、属性、布局、关联关系、层级、状态工作流、通知提醒 | 类型/字段/工作流配置及操作权限分别核对 | [工作项](official/pages/4YQE1RKg.md) |
| 表单联动 | 属性默认值、必填、显示条件、可选项范围；全局/本地布局 | 新建布局与详情布局可以不同 | [详情页](official/pages/UcUGNQQd.md)、[新建页](official/pages/X4u3oHtZ.md) |
| 关联与层级 | 关联工作项属性表达关系，层级结构表达多层拆解 | 层级属性不可直接作为排序条件；更新子层级有单独权限 | [关联](official/pages/4bCHfeLw.md)、[层级](official/pages/WAPN8Y7z.md) |
| 需求管理 | 产品需求、史诗、路线图、基线管理 | 需求基线与甘特图基线不是同一配置入口 | [需求](official/pages/MQ4rfNAZ.md)、[需求基线](official/pages/NSWLo2im.md) |
| 关系追溯图 | 关系网络与关联路径查看 | 与表格形式的跟踪矩阵分开描述 | [关系追溯图](official/pages/AfdH1Sgi.md) |
| 跟踪矩阵 | 源层级与多级追溯，末级可展示代码分支/MR/提交；缺口、覆盖率、Excel | 仅把权限内可确认的断链算缺口；覆盖率按保存配置计算，末级不展示向下覆盖率 | [矩阵](official/pages/426L6coE.md)、[v7.26.0 更新](official/pages/WCUbpvx1.md) |

## 敏捷、瀑布与计划

| 能力 | 文档描述 | 限制/辨析 | 正文 |
| --- | --- | --- | --- |
| 迭代 | 规划、阶段、燃尽图、迭代概览 | 燃尽统计取决于所选口径和计划/实际时间，不能混算 | [迭代](official/pages/Cz2GdS1D.md)、[燃尽](official/pages/6cBFCynz.md) |
| 看板 | 自定义栏、状态映射、泳道、WIP 上限与饱和信号 | 超出 WIP 后仍可流转进入该栏；不是硬性阻断 | [看板](official/pages/8tzzWLwN.md) |
| 甘特图 | 基于工作项的 WBS、层级/属性映射、排期、里程碑、交付物、基线偏差、导入导出 | 区分新版甘特图与旧项目计划组件；依赖类型、自动排期按对应版本正文核对 | [甘特图](official/pages/4TXEmFmy.md)、[设置](official/pages/MX9NDoVt.md) |
| 交付物 | 交付物清单、提交/重新提交、查看情况、批量归档、权限 | 交付物被上传不代表业务验收通过 | [交付物](official/pages/CFMNDjth.md) |
| 项目集 | 项目集管理、关联项目、跨项目甘特图及共享 | 不凭“Plan”名称承诺资源优化算法或所有项目组合治理能力 | [项目集](official/pages/LXb8hxxZ.md) |

## 工作项审批

[完整正文](official/pages/3fxNu225.md)、[审批交接](official/pages/JHR5zbC6.md)。工作项审批和 Wiki 页面审批是不同对象的功能。

- 支持状态流转触发的内容确认审批，以及冻结属性的内容变更审批；有审批规则、表单、审批属性范围与流程。
- 状态流转同时有步骤表单时，先写入步骤表单，再发起审批；这些字段的写入不随审批失败回滚。状态流转及后置动作等待审批通过。
- 审批中保留原工作项状态、冻结审批属性。同一工作项只能有一个在途审批，内容确认与变更审批不能同时在途。
- 变更审批值在通过后的执行节点才写入。审批通过和执行节点成功是两个状态，执行失败可以重试。
- 支持单条/批量、同意/拒绝、加签/转交、驳回/撤回以及审批通知，是否允许具体操作还取决于规则和角色。
- 不能把原生审批直接等同于插件完全接管审批引擎。开放平台审批扩展只开放对应接入点，详见开发技能。

## 测试、工时、资源、效能

| 能力 | 文档描述 | 限制/辨析 | 正文 |
| --- | --- | --- | --- |
| 测试管理 | 用例库、组织编写用例、计划执行、关联需求缺陷、报告与权限 | 需求跟踪组件暂不展示子工作项类型；指标与可见范围依具体报告 | [测试计划](official/pages/QK2vYT8u.md)、[测试报告](official/pages/GwhcKUu8.md) |
| 工时 | 预估/登记、配置与统计 | 工时值不是客户收益或个人绩效结论 | [工时](official/pages/MUcG9tKq.md)、[配置](official/pages/BR9VMk6v.md) |
| 资源 | 成员排期、投入分配、工时及进度跟踪、周期冻结 | 资源规划需要数据与规则，不自动证明最优分配或冲突已解决 | [规划](official/pages/HSn8XrfL.md)、[跟踪](official/pages/VYh2HV33.md) |
| 资源报表 | 按维度统计资源与工时 | 报表页写明仅查看一年内工时；旧工时报表/日志标注不再维护 | [报表](official/pages/WK6fiC3M.md)、[旧报表](official/pages/Xb2YtXMU.md) |
| 效能 | 仪表盘、卡片、模板、SQL 使用与权限 | 本次文档不能证明完整 DORA 四指标、MTTR、缺陷逃逸率、ROI 均开箱即用；这些指标需核验模板/数据源/口径 | [效能](official/pages/HRe1mjzr.md)、[卡片](official/pages/7gnwhM6p.md)、[SQL](official/pages/D85jGK8C.md) |

## 自动化、查询与公式

[自动化](official/pages/TsYumB8r.md) 包括触发事件、条件、动作、动态内容、联动对象、分支判断、规则管理和运行历史。是否支持某个触发器或动作，必须核对具体枚举，不能从“有自动化”推导任意操作可编排。

[ONESQL 筛选](official/pages/4qbAC4pf.md)、[公式计算属性](official/pages/SwhSKAjx.md)、[Wiki 数据表格公式](official/pages/CXijYKbS.md) 和效能 SQL 是不同语言/场景，不能互换函数或语法。

工作项公式支持数值/日期/时间/时间间隔、关联对象统计与 `onesCount`、`sum`、`mean`、`onesMax`、`onesMin`、`map`、`filter` 等。`map` 结果需供其他函数使用，不能直接参与计算，也不能嵌套 `map`。不要自动加入 Excel/JavaScript 的 `NOW()`、`TODAY()` 或假定定时重算；需要查对应函数表与目标行为。文档例子若出现拼写或算式不一致，以正式定义及实测为准。

## DevOps 与账号集成

| 能力 | 当前文档范围 | 不可扩大为 | 正文 |
| --- | --- | --- | --- |
| 代码仓 | GitHub、公有/私有 GitLab、SVN、私有 Bitbucket；提交、分支、MR 关联与代码事件状态流转 | Gitee 等所有代码仓原生支持；所有类型拥有同样功能 | [代码集成](official/pages/CCkd8s9i.md)、[SVN](official/pages/8Y5anQpy.md) |
| 流水线 | 原生应用当前仅支持 Jenkins，查看运行状态/步骤/日志，关联项目与迭代 | GitLab CI/GitHub Actions 原生接入、部署审批或从 ONES 任意触发构建 | [流水线](official/pages/53KtmpQr.md)、[配置](official/pages/DV6RWYMa.md) |
| 账号集成 | 企业微信、飞书、钉钉、LDAP/AD、CAS、SAML、有度、API 同步等章节 | 每个连接器都支持目录同步、登录和通知三种能力；Slack 原生扫码登录 | [集成总览](official/pages/DdV5mwEN.md)、[目录](official/pages/QTMwDKsp.md)、[登录](official/pages/YS9kSvv9.md)、[通知](official/pages/AfBVHTde.md) |

自定义集成可评估 OpenAPI、事件或插件，但需要对应开发、权限、网络与目标版本条件，不标为已经原生支持或已经交付。

## Wiki 知识协作

| 能力 | 文档描述 | 重要限制 | 正文 |
| --- | --- | --- | --- |
| 页面组 | 创建/复制/分类、绑定项目、权限 | 页面组删除不能当作普通页面回收站删除 | [页面组](official/pages/EwYiUmUC.md) |
| 页面与编辑器 | 页面树、协同编辑、历史、模板、富文本/代码/表格/图表/多媒体/第三方资源 | 具体资源类型与编辑器/版本相关 | [编辑与管理](official/pages/KsRb27mV.md) |
| 数据表格 | 数据格式、条件格式、排序筛选验证、公式、图表、冻结、分组 | 不等于完整 Excel 功能兼容 | [数据表格](official/pages/85PnuBr9.md) |
| 协作与权限 | 评论批注、共享加密、收藏、标签、搜索与统计 | “加密”功能的访问控制不自动证明端到端加密 | [共享加密](official/pages/KvX6nrFr.md)、[统计](official/pages/Mc8rpAcG.md) |
| 页面审批 | 规则、表单、流程、批量与变更审批、交接 | 审批状态与可编辑性需结合具体操作判断 | [审批](official/pages/V2rxukTu.md)、[交接](official/pages/Cm48VbTw.md) |
| 公开发布 | 页面/页面组公开链接、密码、有效期、公开域名 | 加密页、办公协同文档等有约束；内嵌工作项/Wiki/成员等不能按内部权限假设公开可见 | [公开发布](official/pages/EDsLAS8M.md) |
| 导入导出 | Word、Markdown、Confluence 等导入；PDF/Word/Markdown 等导出及水印 | 超宽表格、特定内容块、归档页等需查限制 | [导入导出](official/pages/Pf4u6kiM.md)、[归档](official/pages/RFDd2U8k.md) |
| 移动编辑 | 可编辑已有页面并插入支持的内容 | 不支持新增/删除页、草稿查看编辑或批注操作 | [移动端](official/pages/78Ge4JkK.md) |

## Desk、AI 与安全

Desk 支持自定义提单表单、门户/H5/微信小程序、登录/免登录方式、分派流转和客户沟通。免登录提交后的跟踪能力不同；旧版小程序表单与当前能力分开阅读。文档不证明完整 ITSM/CMDB/SLA 引擎开箱即用。[配置](official/pages/BHtMALaP.md)、[收集](official/pages/7gUk6HHm.md)、[处理](official/pages/Wi6Znbof.md)。

ONES AI 智能助手有智能对话与上下文、工作项创建管理、知识问答/文档生成、数据查询分析、通知摘要、网络搜索、模型与功能配置、用量权限及 MCP 服务。工具、网络、模型、许可证和访问权限决定实际可用性。MCP 服务、AI 自己调用工具及第三方客户端接入是不同操作边界；写入和效果都需要实际证据。[AI 总入口](official/pages/WNzfHqQg.md)、[能力详解](official/pages/VqAdkc1b.md)、[MCP](official/pages/WZoxqRW2.md)、[用量权限](official/pages/CrBpaFJd.md)。

账号安全覆盖多团队组织、成员部门用户组、登录集成、密码/会话策略、MFA、信息安全、水印、操作日志与授权管理。第三方目录同步、即时创建成员和通知需要分别启用并按连接器验证。[管理员](official/pages/Ea2jiNu2.md)、[权限](official/pages/NBPcUwWP.md)、[安全](official/pages/9Yf39csU.md)。

## 迁移与环境

- Jira：评估模式、映射与迁移模式、部署工具、迁移前检查及异常处理。Jira Software 的 software/business 项目与 Service Management、插件数据支持范围不同。[评估](official/pages/BsRSbSJR.md)、[迁移流程](official/pages/DBKkjCuY.md)。
- Confluence：独立部署工具、空间与用户迁移、报告。大于 400 空间或 500 GB 是联系技术支持评估的条件，不是保证或绝对平台上限。[工具](official/pages/9yaGU4X9.md)。
- CSV：ID 用于区分创建/更新；属性空值处理、不可修改字段及父子关联有各自规则。不把 CSV 工作项导入推广成任意产品 Excel 双向同步。[CSV](official/pages/6A258nft.md)。
- 备份、数据库/国产化支持、容量与高可用架构需要目标版本运维文档。三个指定入口不足以重新认证旧运维兼容清单。
