# CSM Agent 客户成功工作台

以 CRM 售后客户为唯一主体的内部 CSM 工作台。系统通过 MCP 读取 CRM、ONES 和 Hemory，将跨系统事实归一到客户，形成客户组合、统一时间线、续约风险、增购假设、案例草稿和行动闭环。

## 一期能力

- 客户组合：首页优先展示续约 120 天内客户和合同价值前 20%客户。
- 客户全景：CRM 基础资料、ONES 建议与反馈/工单/运维工单/客户工时/私有云实例、Hemory 会议转写、风险、机会、案例和行动。
- 风险判断：确定性规则负责分数和等级；缺失数据保持 `unknown`，不转换为风险分。
- 增购机会：只在非高风险客户中展示至少两个独立证据支持的假设。
- 客户案例：固定模板成稿，CSM 编辑并确认后写入 ONES Wiki。
- 企业微信待办：CSM 确认行动后生成一次性 H5 意图，在企业微信原生面板完成平台确认并保存 `todoId`。
- Agent：保留多轮对话和 MCP 工具调用，任何写入都绑定到批准的目标工具和完整参数哈希。
- 客户标签页：建议、工单、运维、工时、私有云实例、跟进记录、会议沟通、客户案例、行动事项和统一时间线分组查看；建议/工单/运维三个 ONES 工作项列表只展示语义化 ID（`display_id`）、标题、状态、创建时间，标题可点击进入工作项详情，并默认按创建时间倒序。工时页同时展示总工时和登记明细（登记人、工时日期、登记小时、工时描述），明细默认按工时日期倒序。
- 会议回写：在客户标签页选择目标，Agent 基于已归属 Hemory 证据生成草稿；CSM 可编辑业务字段和实际参数，确认后才写入。
- Hemory 收件箱：每天中国时间 13:00/20:00 通过 MCP 拉取当天完整逐句转写，按录音持久化后由当前 Agent 大模型整理为话题、摘要和连续证据片段；唯一客户名称自动归属，其他片段由 CSM 在 Agent 页面批量标记。
- 片段质量门槛：寒暄、环境音、零散的一两句话，以及少于 3 条有效发言或信息量不足的分段只保留在原始转写中，不进入待归属；模型不得合并不相关短句来绕过门槛。
- 自动草稿箱：客户归属后，AI 只生成证据支持的 Agent 待办、工时、沟通记录、需求或工单草稿；勾选后一次批准、逐项执行，失败项单独重试。

## 运行

要求 Node.js `>=22.5`。SQLite 使用 Node 内置 `node:sqlite`，数据默认保存在 `~/.csm-agent/workbench.sqlite`；可通过 `CSM_DATA_DIR` 修改。

```bash
npm install
npm test
npm run dev
```

默认地址为 [http://127.0.0.1:3210](http://127.0.0.1:3210)。首次进入后在“设置”中配置 CRM、ONES、Hemory MCP；点击“同步数据”执行首次导入。服务每天 02:00 刷新 CRM/ONES，并在中国时间 13:00、20:00 拉取 Hemory 当天 `00:00` 至执行时刻的完整转写，再等待 Agent 大模型完成话题分段。客户详情支持单客户刷新。

## CLI 调试与运维

CLI 是项目基础能力，与页面共用同一 HTTP API、SQLite、客户绑定和批准机制。构建并注册全局命令：

```bash
npm run link:global
csm-agent version
csm-agent capabilities --json
```

之后可以完全通过 CLI 启动和调试，无需浏览器：

```bash
csm-agent serve 3210
csm-agent doctor
csm-agent customers 青岛高测
csm-agent customers --sort renewal_date
csm-agent customers --sort renewal_amount
csm-agent customer <CRM客户ID>
csm-agent timeline <CRM客户ID> support_ticket # 四列工作项，按创建时间倒序
csm-agent workhours <CRM客户ID> # 总工时和登记明细，按工时日期倒序
csm-agent actions [CRM客户ID]
csm-agent action update <行动ID> '{"status":"in_progress"}'
csm-agent action complete <行动ID> "已与客户确认下一步"
csm-agent action wecom <行动ID>
csm-agent cases [CRM客户ID]
csm-agent case generate <CRM客户ID>
csm-agent case update <草稿ID> <版本> '{"title":"案例标题","fields":{}}'
csm-agent case preview <草稿ID> <ONES父页面ID>
csm-agent case publish <草稿ID> <版本> <ONES父页面ID> <preview返回的批准哈希>
csm-agent sync [CRM客户ID]
csm-agent hemory sync [YYYY-MM-DD]
csm-agent hemory inbox [YYYY-MM-DD]
csm-agent hemory assign <客户ID或名称> <片段ID...>
csm-agent hemory clear <片段ID...>
csm-agent drafts [客户ID或名称]
csm-agent draft review <批次ID>
csm-agent draft retry <草稿ID>
csm-agent draft regenerate <批次ID>
csm-agent service install 3210
csm-agent service status
csm-agent service logs
csm-agent agent <CRM客户ID> "基于会议生成工单草稿"
csm-agent api GET /api/customers
```

仓库开发时可用 `npm run cli -- <命令>`，行为与全局命令相同。服务不在默认端口时设置 `CSM_BASE_URL=http://127.0.0.1:3212`。`api` 是所有 API 的通用诊断入口；核心工作流仍需提供独立、可读的 CLI 命令。后续 API 或工作流调整必须同步更新 CLI、`capabilities` 清单、帮助、测试和本说明；不改变 API/CLI 合同的纯展示调整需补充自动化展示检查。

CRM 客户集合以纷享销客「CSM售后客户」对象 `object_Umwnn__c` 为业务来源，售后客户记录 `_id` 是工作台唯一客户主键；组合默认读取该对象中售后客户阶段不等于「流失」的记录。客户名称用于解析 ONES 的「客户信息」选项，重名或非唯一匹配不会自动归属。

ONES 当前租户按以下字段契约同步：

| 项目 | 工作项类型 | 工作台分类 |
| --- | --- | --- |
| ONES Desk | 建议和反馈 | 建议与反馈 |
| ONES Desk | 工单 | 工单 |
| ONES Desk | 运维工单 | 运维工单 |
| 客户工时管理 | 售后客户 | 客户工时 |
| 私有云实例管理 | 私有云实例 | 私有云实例 |

五类工作项统一使用「客户信息」字段 `JrvswW8P`。同步先按 CRM 客户显示名精确唯一解析该字段的 option ID，失败后用 CRM 记录的关联主体名（`field_n1qN0__c__r`，如「华大九天」→「北京华大九天科技股份有限公司」）再做一次精确唯一解析；仍歧义或缺失的保持未归属。标题模糊匹配不作为自动归属依据。

Hemory 草稿确认视图按最小必填项结构化展示（服务端 `displayFields`，Web 与 CLI 共用）：ONES 需求/工单/运维工单草稿展示所属项目、工作项类型、标题、客户信息（含 ONES 选项名）、描述（Hemory 摘要），预检会通过 `get_issue_fields` 核对其余必填字段并给出明确校验错误；`draft review` 默认逐行结构化输出，`--json` 保留原始 JSON。

## 本地配置

- `~/.csm-agent/config/mcp.user.yaml`：界面或全局 CLI 服务保存的 MCP 服务器配置。
- `~/.csm-agent/config/llm.user.yaml`：界面或全局 CLI 服务保存的模型配置。
- `~/.csm-agent/.env` 或当前目录 `.env`：凭据和部署变量；可用 `CSM_ENV_FILE` 显式指定。
- `CSM_CONFIG_DIR`：单独覆盖可写配置目录；`CSM_DATA_DIR` 同时决定默认数据目录和默认配置目录。

旧版项目内 `config/mcp.user.yaml` 和 `config/llm.user.yaml` 会继续读取；下一次保存时迁移到用户配置目录。用户配置与凭据不得提交到仓库。

模型查询接口不返回 API Key。MCP 设置页会在本地展示当前连接参数，因此当前定位为单用户本地工具；团队托管前需要增加登录、租户隔离和集中密钥管理。

## 企业微信

Hemory 自动草稿中的待办只创建为 CSM Agent 本地行动事项，不自动创建企业微信待办。以下能力保留给已有的手动企业微信流程，不属于本期 Hemory 验收范围。

原生待办需要全员可见的企业微信自建应用、可信 HTTPS 域名和以下环境变量：

```dotenv
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=
WECOM_H5_BASE_URL=https://csm.example.com
# 可选；默认使用兼容版企业微信 JS-SDK
WECOM_JS_SDK_URL=https://res.wx.qq.com/open/js/jweixin-1.2.0.js

# ONES 当前租户已有默认值；迁移租户时覆盖
ONES_CUSTOMER_FIELD_ID=JrvswW8P
ONES_WEB_BASE_URL=https://our.ones.pro
ONES_TEAM_ID=RDjYMhKq
```

企业微信官方创建接口只调起原生创建面板，不能后台静默创建。CSM 不需要重复填写内容、参与人和截止时间，但必须在企业微信中完成最后一次平台确认。第三方应用和代开发应用不支持该能力。

## 关键接口

- `GET /api/customers?q=搜索词&sort=default|renewal_date|renewal_amount`、`GET /api/customers/:id/overview`、`GET /api/customers/:id/timeline`

客户组合和客户列表默认排除 CRM「售后客户阶段」等于「流失」的客户；流失客户仍保留在数据库中，可通过客户 ID 查看详情和历史记录。`renewal_date` 按合同到期时间升序，`renewal_amount` 按应续约金额降序，缺失值置底。
- `POST /api/sync`、`POST /api/customers/:id/refresh`、`GET /api/sync-runs/:id`
- `POST /api/hemory/sync`、`GET /api/hemory/fragments`、`PUT /api/hemory/fragments/attribution`
- `GET /api/draft-batches`、`PATCH /api/draft-items/:id`、`POST /api/draft-batches/:id/preview`
- `POST /api/draft-batches/:id/confirm`、`POST /api/draft-batches/:id/regenerate`、`POST /api/draft-items/:id/retry`
- `GET /api/action-items`、`PATCH /api/action-items/:id`、`POST /api/action-items/:id/complete`
- `POST /api/action-items/:id/wecom-todo-intents`、`POST /api/wecom/todo-created`
- `POST /api/case-drafts`、`PATCH /api/case-drafts/:id`、`POST /api/case-drafts/:id/publish`

## 数据与安全边界

- CRM `_id` 是客户主键；CRM 客户名称必须与 ONES「客户信息」选项精确且唯一匹配，Hemory 也只在唯一匹配时自动归属，歧义与未归属内容不会进入客户判断。
- Hemory MCP 当前只提供词法和时间窗口转写搜索，不返回 Hemory 页面中的原生摘要、话题或 section ID；CSM Agent 保存原始转写后使用当前配置的大模型生成自己的话题片段，页面会明确展示话题、摘要和可展开原文证据。
- 同一录音晚间出现新增转写时，Agent 基于完整新内容重新分段；只有最新成功的一代片段进入待归属。旧片段和已写记录保留审计，旧片段关联的未写草稿会标记为失效。
- 人工 Hemory 归属覆盖自动名称匹配，后续当天全量重拉不会冲掉 CSM 标记；重新归属会令未写出草稿失效，已写记录只保留审计提示，不自动反向修改 CRM/ONES。
- “需求”草稿写入 ONES Desk「建议和反馈」；工单写入 ONES Desk「工单」；二者都必须绑定客户字段 `JrvswW8P`。工时只写当前客户已绑定的售后客户工作项，沟通记录必须绑定 CRM `_id`。
- ONES 案例发布需要 `ONES_CASE_PARENT_PAGE_ID`，或由 CSM 在发布预览时提供父页面 ID。
- 企业微信状态轮询每 15 分钟执行一次，只读取和更新本应用创建的待办。
- 当前 ONES MCP 没有 Desk 专用工具，Desk 数据通过 ONESQL 按项目、工作项类型和「客户信息」字段读取。
- Mac `.app` 仍是本地 WKWebView 壳；企业微信 H5 必须部署到可被企业微信访问的 HTTPS 域名。

## 验证

```bash
npm run verify
csm-agent capabilities --json
CSM_BASE_URL=http://127.0.0.1:3210 csm-agent doctor
csm-agent hemory inbox --json
csm-agent drafts --json
csm-agent service status
```

验收以指向当前构建的全局 `csm-agent` 为统一入口：先运行 `npm run verify`，再对运行中的服务执行与改动匹配的 CLI 命令。纯 UI 改动需要自动化检查覆盖展示合同；浏览器验收仅在用户明确要求时执行。真实交付边界还包括三套 MCP 同步、ONES Wiki 实际发布、企业微信桌面端/移动端待办创建与状态回写；这些边界必须使用真实权限与凭据验证，不能由本地配置存在代替。

## Git 交付约定

远端仓库为 [opyamorpen/csm-agent](https://github.com/opyamorpen/csm-agent)，本地 Git 远端名为 `origin`。每轮本地修改完成后，必须先运行相关验证，再创建有明确说明的提交并推送到 `origin`；只有获得 `git push` 的直接证据，才能将该轮报告为已交付。提交或推送受阻时，必须保留工作区改动并明确报告阻塞原因，不得将未同步状态描述为远端已完成。
