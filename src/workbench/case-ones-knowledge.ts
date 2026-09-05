import { createHash } from 'node:crypto';

/** Compact runtime knowledge; full versioned sources live in docs/ones-product-knowledge. */
export const ONES_KNOWLEDGE_VERSION = 'private-v7.26.0-20260905';
export const ONES_KNOWLEDGE_SOURCES = [
  'https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/AzTb9z8u',
  'https://developer.ones.cn/zh-CN/',
  'https://open.ones.cn/zh-CN/',
] as const;

export const ONES_CAPABILITY_MAP = [
  '【ONES 产品能力图谱（私有部署 v7.26.0 文档，2026-09-05 核对）】',
  '版本边界：该文档基线不代表客户已升级；SaaS、其他版本、许可证与配置差异需核对。文档未覆盖的能力保留 unknown，不等同于不支持。',
  '产品域：',
  '- ONES Project：自定义工作项类型/属性/布局/关联/层级/工作流，需求与史诗、路线图、基线、迭代与看板、甘特图/里程碑/交付物、关系追溯图。测试、工时资源、项目集、效能、DevOps 和流程自动化属于其手册能力域；历史名称 TestCase/Performance/Plan 不代表所有许可证均包含。',
  '- 需求跟踪矩阵（v7.26.0 版本说明新增）：多级追溯，末级可含代码分支/MR/提交，权限范围内的缺口筛选、覆盖率卡片和 Excel 导出；权限不足不能算已确认缺口，覆盖率按已保存配置计算。',
  '- 工作项审批：内容确认/内容变更、属性冻结、批量与交接、审批中心；同一工作项仅一个在途审批。审批通过与执行节点成功分开，步骤表单可能先于审批写入。',
  '- 测试管理（TestCase）：用例库、编写组织用例、计划执行、关联需求/缺陷、测试报告与权限。',
  '- 工时资源与项目集：预估/登记工时、成员排期、负载与投入跟踪、工时周期冻结；项目集层级和跨项目甘特图。',
  '- 效能管理（Performance）：仪表盘、卡片、预制模板、SQL 与权限。完整 DORA、MTTR、ROI 等是否现成可用需核对模板、数据源和口径。',
  '- 流程自动化：事件、条件、动作、动态内容、联动对象、分支和运行历史；具体支持动作依枚举。看板 WIP 超限是饱和告警，仍可流转。工作项公式、ONESQL、效能 SQL、Wiki 表格公式不可混用。',
  '- ONES Wiki：页面组/页面树、协同编辑、模板历史、数据表格、评论批注、共享加密、页面审批/变更审批/交接、公开发布、导入导出、水印与统计；公开发布、归档及移动端编辑有对象和操作限制。',
  '- ONES Desk：自定义提单表单、工单门户/H5/微信小程序、登录或免登录收集、分派流转与客户沟通。免登录追踪能力受限；不能据此宣称完整 ITSM/SLA 引擎。',
  '- ONES Account：组织/团队、成员/部门/用户组、权限、目录同步、登录验证、通知、MFA/密码/会话策略/日志/水印；目录、登录、通知按连接器分别配置。',
  '- ONES AI 智能助手：上下文对话、工作项创建管理、知识问答与文档生成、数据查询、通知摘要、网络搜索、模型/用量/权限配置及 MCP 服务；实际可用工具受版本、模型、配置、网络和权限约束。',
  '开放与集成：',
  '- 原生代码仓文档：GitHub、公有/私有 GitLab、SVN、私有 Bitbucket；提交、分支、MR 与工作项关联，各类型支持范围不同。',
  '- 原生流水线集成当前文档仅支持 Jenkins，查看运行状态/步骤/日志并关联项目与迭代；其他 CI/CD、部署审批需另行评估，不能写成已具备的标准连接。',
  '- 账号连接器：企业微信、飞书、钉钉、LDAP/AD、CAS、SAML、有度与 API 同步；不能假定每种都支持目录/登录/通知全部功能。',
  '- OpenAPI/OAuth、事件、插件和 MCP 可用于扩展；scope 与业务权限同时满足。Plugin 1.0（plugin.yaml/.opk）和 App 2.0（opkx.json/.opkx 或外部托管）协议、SDK 不可混用；审批扩展仅为相应 Web 接入点。',
  '- 迁移：Jira 评估/映射/迁移，Confluence 工具或空间导入，CSV/XLSX/XLS 工作项创建更新；Service Management、插件、附件、权限与空值处理需核对，导入成功不等于完整恢复。',
  '【图谱边界】图谱本身不构成交付证据。以上仅是产品文档证据，不构成客户交付/配置/集成/收益证据。所有客户事实以素材为准；缺失保持 unknown。建议区分原生、配置、扩展开发和待核验，不承诺固定实施周期、合规认证或量化收益。AI 只生成待 CSM 确认的草稿。',
].join('\n');

/** Deterministic figure vocabulary; customer adoption still needs separate evidence. */
export const ONES_PLATFORM_CAPABILITIES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: '权限管理', detail: '权限点与角色配置' },
  { title: '流程自定义', detail: '工作流与状态流转' },
  { title: '字段自定义', detail: '自定义字段与表单' },
  { title: '流程自动化', detail: '事件条件与动作' },
  { title: '审批中心', detail: '工作项与页面审批' },
  { title: '单点登录', detail: '账号集成与验证' },
  { title: '开放 API', detail: 'OpenAPI 与 OAuth' },
  { title: '报表仪表盘', detail: '多维报表与仪表盘' },
];

/** Standard connection names for the existing empty-evidence figure fallback. */
export const ONES_STANDARD_INTEGRATIONS: readonly string[] = ['企业微信', '钉钉', '飞书', 'LDAP/AD'];

// Knowledge changes must invalidate both generated drafts and resumable model checkpoints.
export const ONES_KNOWLEDGE_DIGEST = createHash('sha256').update(JSON.stringify({
  version: ONES_KNOWLEDGE_VERSION,
  sources: ONES_KNOWLEDGE_SOURCES,
  map: ONES_CAPABILITY_MAP,
  platform: ONES_PLATFORM_CAPABILITIES,
  integrations: ONES_STANDARD_INTEGRATIONS,
})).digest('hex');
