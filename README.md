# CSM Agent 客户成功工作台

以 CRM 售后客户为唯一主体的内部 CSM 工作台。系统通过 MCP 读取 CRM、ONES 和 Hemory，将跨系统事实归一到客户，形成客户组合、统一时间线、续约风险、增购假设、案例草稿和行动闭环。

## 一期能力

- 客户组合：首页优先展示续约 120 天内客户和合同价值前 20%客户。
- 客户全景：CRM 基础资料、ONES 建议与反馈/工单/运维工单/客户工时/私有云实例、Hemory 会议转写、风险、机会、案例和行动。
- 风险判断：确定性规则负责分数和等级；缺失数据保持 `unknown`，不转换为风险分。
- 增购机会：只在非高风险客户中展示至少两个独立证据支持的假设。
- 客户案例：固定模板成稿，CSM 编辑并确认后写入 ONES Wiki。
- 行动批量处理：「本周行动」页支持勾选（全选 + 已选计数，点卡片本体即可选中）后批量完成，批量操作条 sticky 冻结在滚动区顶部；批量完成弹一次共用「实际结果」输入（留空记「CSM 在工作台确认完成」）。逐项处理互不影响——仅待处理/进行中可被完成，其余跳过，单项失败不回滚其他项，结果按 项数 汇总提示。CLI 同款：`csm-agent action complete <行动ID...> [--outcome]`。「接受」流程已移除：草稿确认即视为接受，不接受的草稿直接忽略。
- Agent：保留多轮对话和 MCP 工具调用，任何写入都绑定到批准的目标工具和完整参数哈希。会话每轮自动拾取最新的工具清单与模型配置（服务重启或 MCP 重连后旧会话不再停留在过期清单上）；「询问 Agent」按钮为客户绑定会话。Agent 另有本地工具：`get_customer_profile` / `get_customer_events` 直接读工作台已同步数据（本地优先，超过 36 小时未同步提示刷新或用 MCP 兜底），`web_search` 联网检索客户公开动态（Tavily），`record_web_intelligence` 把检索结果落库为 `web_signal` 证据。会话支持「分享」（一键复制全文：标题、客户绑定、时间范围与完整对话；Web「分享」按钮与 `csm-agent sessions show <会话ID>` 同源）和「归档」（从会话列表隐藏，网页「已归档」折叠区或 `csm-agent sessions unarchive` 可恢复；归档会话禁止继续发消息）。侧边栏 Agent 导航项显示待办角标 = Hemory 待归属数 + 草稿箱待处理数。
- 客户标签页：建议、工单、运维、工时、私有云实例、跟进记录、会议沟通、客户案例、行动事项和统一时间线分组查看；建议/工单/运维三个 ONES 工作项列表只展示语义化 ID（`display_id`）、标题、状态、创建时间，标题可点击进入工作项详情，并默认按创建时间倒序。工时页同时展示总工时和登记明细（登记人、工时日期、登记小时、工时描述），明细默认按工时日期倒序。
- 会议回写：在客户标签页选择目标，Agent 基于已归属 Hemory 证据生成草稿；CSM 可编辑业务字段和实际参数，确认后才写入。
- Hemory 收件箱：每天中国时间 13:00/20:00 通过 MCP 拉取当天完整逐句转写，按录音持久化后由当前 Agent 大模型整理为话题、摘要和连续证据片段；片段不按客户名称自动归属（转写中提及客户名通常是在引用其他客户案例，不代表在与该客户沟通），全部片段由 CSM 在 Agent 页面批量标记。
- 片段质量门槛：寒暄、环境音、零散的一两句话，以及少于 3 条有效发言或信息量不足的分段只保留在原始转写中，不进入待归属；模型不得合并不相关短句来绕过门槛。
- 自动草稿箱：客户归属后，AI 只生成证据支持的 Agent 待办、沟通记录、需求或工单草稿；勾选后一次批准、逐项执行，失败项单独重试。归属（或重新生成）触发的后台生成任务对用户可见：Web 草稿箱顶部显示「正在生成草稿」spinner 横幅并在完成后自动刷新（任务状态经 `GET /api/draft-jobs` 轮询），CLI 侧 `csm-agent hemory assign --wait` 等待终态、`csm-agent draft jobs` 随时查询。**模型调用带指数退避自动重试（5s/15s/45s，中继端点连接坏窗口为瞬时故障）；重试耗尽才标记 failed 并透出真实原因，不做规则兜底**——失败任务不创建批次、不产出草稿，Web 草稿箱顶部有持久失败卡片（客户+日期+真实错误+涉及片段明细，可按片段一键重新生成），CLI 侧 `csm-agent draft jobs` 无参列出全部失败任务及片段明细；同日重新生成成功后旧失败任务自动标记 superseded 不再堆积。每个客户每个上海自然日一个批次，沟通记录草稿有且仅有一条（按【话题】分节合并当天全部沟通，正文超长时压缩最长节而非丢弃末尾节），并连带一条工时草稿（时长按录音片段时间计算，真实沟通跨度不足 3 分钟时按最小 0.1 小时计、描述为一句话总结）；当天已在 CRM 发布过沟通（含手动录入的跟进）后，新草稿只合并发布之后的新沟通，全天发布完毕则不再生成沟通记录与工时草稿（其他类型不受影响）。已写入草稿的消费台账：各类型已写入草稿引用过的片段不再被同类型重复消费（已写入工单的片段不再重新提案工单，工时已写入但跟进失败时只重出跟进不再重复计工时），强制再生成遇到当天证据全部消费时任务以「未生成新草稿」备注收尾、不作废旧草稿；片段的消费状态在收件箱（Web 徽标「已写入·工单」等）与 CLI `hemory inbox` 的 consumed 列可见。同日补充归属会按全天内容重建当天批次（未写入草稿作废，已写入记录不动）。草稿箱（Web 与 `csm-agent drafts`）默认不显示已写入草稿；`csm-agent drafts --all` 或 `GET /api/draft-batches?include=written` 可查看全量；纯已作废/已忽略批次在 Web 草稿箱独立于待处理批次，放在「已忽略/已作废」二级 tab 分列展示（CLI 对应 `csm-agent drafts --archived`）；批次级整批忽略走 CLI `csm-agent draft dismiss`（Web 不再提供批次级按钮）。草稿卡片支持单卡「确认/忽略」直接操作（`csm-agent draft ignore` 同款逐条忽略），勾选多份草稿后底部浮动操作条钉在可视区底部（默认批量确认，点「批量忽略…」切换一次才进入忽略模式，勾选清零自动复位）。

## 安装（macOS 一键安装）

普通使用者无需克隆仓库和安装 Node，一条命令完成 CLI + 桌面端 + 常驻服务安装：

```bash
curl -fsSL https://raw.githubusercontent.com/opyamorpen/csm-agent/main/scripts/install.sh | bash
```

安装器会：

1. 检查 git 与 Xcode Command Line Tools（`swiftc`，缺失时提示 `xcode-select --install`）；
2. 复用系统 Node（`>=22.5`），否则下载捆绑 Node 22 LTS 到 `~/.csm-agent/node`；
3. `git clone` 仓库到 `~/.csm-agent/app` 并构建；
4. 生成 `csm-agent` CLI shim（`~/.local/bin`，必要时写入 PATH）；
5. 现场构建桌面 App（Swift WKWebView 壳）并在 `/Applications` 建立入口；
6. 安装 launchd 常驻服务（`http://127.0.0.1:3210`，开机自启，`--no-service` 跳过）。

安装后：新开终端运行 `csm-agent version`；配置凭据后（App 设置中添加 MCP 服务器、`csm-agent config llm set` 配置大模型）即可使用。用户数据（配置、会话、SQLite、日志）都在 `~/.csm-agent` 下，与代码目录分离，更新和卸载不触碰。

隔离验收参数（不动真实数据）：`bash scripts/install.sh --dir <目录> --bin-dir <目录> --data-dir <目录> --apps-dir <目录> --port <端口> --no-service`。

### 更新与卸载

```bash
csm-agent update            # 拉取最新 main 并重建（重跑安装命令同样进入更新路径）
csm-agent uninstall         # 移除 CLI、桌面端、常驻服务与受管目录；保留 ~/.csm-agent 用户数据
csm-agent uninstall --purge # 连同用户数据一并删除（需确认，加 --yes 跳过确认）
```

## 运行

要求 Node.js `>=22.5`。SQLite 使用 Node 内置 `node:sqlite`，数据默认保存在 `~/.csm-agent/workbench.sqlite`；可通过 `CSM_DATA_DIR` 修改。

```bash
npm install
npm test
npm run dev
```

默认地址为 [http://127.0.0.1:3210](http://127.0.0.1:3210)。首次进入后在“设置”中配置 CRM、ONES、Hemory MCP；点击“同步数据”执行首次导入。服务每天 02:00 刷新 CRM/ONES，并在中国时间 13:00、20:00 拉取 Hemory 当天 `00:00` 至执行时刻的完整转写，再等待 Agent 大模型完成话题分段。客户详情支持单客户刷新。

### 构建版本与旧进程检测

`public/` 静态文件每次请求从磁盘实时读取（页面永远最新），而 API 路由在进程启动时加载进内存——**构建后若进程不重启，就会出现「新 UI + 旧 API」分裂**（新端点 404、新按钮失效）。防护体系：

- `npm run build` 先执行 `scripts/stamp-build.mjs`：git SHA + dirty 标记 + 构建时刻写入 `dist/build-info.json` 与 `public/build-info.js`（`window.__CSM_BUILD__`，gitignore），同一次构建的服务端与前端共享同一 buildId；`npm run dev` 为 `tsx watch`（源码改动自动重载）。
- 服务暴露 `GET /api/version`（buildId/startedAt/pid/supervised/stale）；前端每 30s 比对自己脚本的 buildId 与进程的 buildId，不一致或端点缺失（进程早于该机制）时页面顶部常亮红色横幅提示重启，恢复一致自动消隐。
- **自愈（推荐 launchd 托管）**：`csm-agent service install` 安装的 launchd 服务注入 `CSM_SUPERVISED=1` + KeepAlive——服务每 10s 自检 dist 变化，检测到新构建后自动退出（exit 0），launchd 拉起新构建，全程无人工介入；Mac App 自带子进程监管（terminationHandler 自动重启，短命退避 1s→60s 封顶）。
- 无监管的手动进程（如终端 `nohup node dist/index.js`）不自动退出（可用性优先），只在 `/api/version` 报告 stale 并触发前端横幅；`csm-agent doctor` 与 `csm-agent service status` 均会比对服务端与本地构建并提示重启。
- 端口被旧进程占用时启动不再裸崩：输出「端口已被占用，请 csm-agent service restart 或结束旧进程」后退出。

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
csm-agent action complete <行动ID...> --outcome "已与客户确认下一步" # 批量完成，--outcome 支持空格或=传值
csm-agent action update <行动ID> '{"status":"in_progress"}'
csm-agent cases [CRM客户ID]
csm-agent case generate <CRM客户ID>
csm-agent case update <草稿ID> <版本> '{"title":"案例标题","fields":{}}'
csm-agent case preview <草稿ID> <ONES父页面ID>
csm-agent case publish <草稿ID> <版本> <ONES父页面ID> <preview返回的批准哈希>
csm-agent weekly-report generate <CRM客户ID> [YYYY-MM-DD] [--force] [--wait] # 实施周报：日期对齐周一，基于该客户本周全部信息生成四章节
csm-agent weekly-report list/show <CRM客户ID|周报ID>
csm-agent weekly-report update <周报ID> <版本> '{"summary":"...","accomplishments":[],"next_week_plan":[],"risks":[]}'
csm-agent weekly-report preview <周报ID> <ONES父页面ID>
csm-agent weekly-report publish <周报ID> <版本> <ONES父页面ID> <preview返回的批准哈希>
csm-agent wiki spaces # ONES Wiki 页面组列表（发布位置层级选择器的数据源）
csm-agent wiki pages --space <页面组ID> [--parent <页面ID>] # 页面树，按 parentID 过滤
csm-agent sync [CRM客户ID]
csm-agent hemory sync [YYYY-MM-DD]
csm-agent hemory resegment --all
csm-agent hemory inbox [YYYY-MM-DD] [--days N] # 待归属片段；--from/--to 按上海时区收窄到当天时间段（需与日期同用）；consumed 列显示片段已被哪些类型的已写入草稿消费
csm-agent hemory inbox 2026-08-27 --from=14:00 --to=15:30
csm-agent hemory inbox --customer <客户ID或名称> --status confirmed # 按客户查看已归属片段（--status 默认 pending）
csm-agent hemory assign <客户ID或名称> <片段ID...> # 归属即触发后台草稿生成；--wait 轮询任务直到完成/失败
csm-agent hemory clear <片段ID...>
csm-agent hemory ignore <片段ID...>
csm-agent hemory regenerate <片段ID...> [--wait] # 按天强制重生成草稿：片段决定重建的「客户+上海日」，各天全部已确认片段参与，旧批次作废；已写入草稿消费过的片段不再被同类型重复提案
csm-agent drafts [客户ID或名称] [--archived|--all] # 默认只列待处理批次；--archived 只看纯已忽略/已作废批次；--all 含已写入的全量视图；重新生成进行中的批次带「生成中」标记（Web 端同状态角标+禁用操作）
csm-agent draft review <批次ID>
csm-agent draft edit <草稿ID> [--set 键=值 ...] # 结构化编辑草稿（--set 可用中文标签如 优先级=P1，选项字段可填中文选项名；无 --set 进入逐字段交互）；与 Web「编辑」弹窗同一契约
csm-agent draft retry <草稿ID>
csm-agent draft ignore <草稿ID> # 忽略单条草稿：软删除为已忽略，同批其他草稿不受影响；已写入项拒绝
csm-agent draft regenerate <批次ID>
csm-agent draft dismiss <批次ID> # 忽略批次：未写入草稿软删除为已忽略，已写入项不受影响
csm-agent draft jobs [任务ID...] # 无参列出最近失败的生成任务（客户/日期/片段明细/错误）；带 ID 查询任务状态
csm-agent service install 3210
csm-agent service status # 含运行中服务的构建版本（buildId/stale/supervised）
csm-agent service restart
csm-agent service logs
csm-agent ones fields [--verify] # ONES Desk 必填字段契约：选项 UUID 表、兜底值、实例部署类型规则
csm-agent agent <CRM客户ID> "基于会议生成工单草稿"
csm-agent agent <CRM客户ID> "结合已同步数据与最近三个月公开动态分析续约风险和增购机会"
csm-agent sessions [list] [--all] # 会话列表；--all 含已归档
csm-agent sessions show <会话ID> # 导出会话全文（标题 + 客户 + 时间 + 对话）
csm-agent sessions archive <会话ID> # 归档：从列表隐藏，可恢复
csm-agent sessions unarchive <会话ID>
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

五类工作项统一使用「客户信息」字段 `JrvswW8P`。客户主名称是 CRM「客户名称」引用字段（`field_n1qN0__c__r`，客户全称），「售后客户名称」（`field_83f4l__c`，常为简称）作为次级名称；同步按两个名称分别精确唯一解析该字段的 option ID，仍歧义或缺失的保持未归属，标题模糊匹配不作为自动归属依据。

Hemory 草稿确认视图按最小必填项结构化展示（服务端 `displayFields`，Web 与 CLI 共用）：ONES 需求/工单/运维工单草稿展示所属项目、工作项类型、标题、客户信息（含 ONES 选项名）、必填项（含 所属模块/所属产品 等，选项 UUID 反解为名称）、描述（Hemory 摘要）；`draft review` 默认逐行结构化输出，`--json` 保留原始 JSON。

草稿编辑是结构化表单（服务端 `editContract`，Web 草稿箱「编辑」弹窗、Agent 会话确认卡与 `csm-agent draft edit` 三端共用同一契约）：文本字段（标题/描述/跟进内容/工时与开始时间等）直接输入，选项字段（优先级/所属模块/建议类型/环境类型/所属产品/服务类目等）是中文下拉（CLI 侧填中文选项名或 UUID）；锁定项与系统自动填写项（客户绑定/所属项目/工作项类型/目标工作项/目标工具）只读展示，实例部署类型按 CRM 使用版本锁定不可改。编辑只提交「字段键→新值」，由服务端按类型契约合并回原参数 JSON（`PATCH /api/draft-items/:id` 的 `edits` 分支；会话确认走 `POST /api/sessions/:id/confirm` 的 `edits` 分支）——结构化部分不经手，不可能被改坏；选项值非法（未知选项名/非正数工时等）在合并时报错并给出合法选项。编辑后 version 递增、批准哈希清空，须重新预览确认。无契约类型（客户案例/客户档案）保留原始 JSON 编辑器；`draft review` 的 `[e]` 原始 JSON 编辑保留为诊断/高级路径。

ONES Desk 三类工作项（建议和反馈/工单/运维工单）的人工必填字段契约内置在 `src/workbench/drafts.ts`（`ONES_DESK_FIELD_SPECS`，2026-08-27 经 ONES 实测核验）：除标题/项目/类型/客户信息/描述外的全部规格字段（建议的所属模块、工单的所属产品、实例部署类型、优先级等）都会自动填入 fieldValues——证据不足时用兜底值（所属模块→功能扩展、所属产品→Core 基础平台能力、优先级→P2 等），草稿不出现必填项缺失。实例部署类型按 CRM「使用版本」（`field_Q2L6p__c`）确定性判定：公有云版→公有云，其余（含未同步）→私有云，模型提案不参与。交互式 Agent 会话用本地工具 `get_ones_desk_required_fields` 获取同一契约（`get_issue_fields` 的选项列表被截断且部分 UUID 无效，不能用于枚举选项），批准门校验规格字段齐备与部署类型一致。内置规则只读可见：`GET /api/ones-desk-fields` 与 `csm-agent ones fields [--verify]`（`--verify` 经 `get_issue_fields` 实时核对选项 UUID 漂移）。

## 本地配置

- `~/.csm-agent/config/mcp.user.yaml`：界面或全局 CLI 服务保存的 MCP 服务器配置。
- `~/.csm-agent/config/llm.user.yaml`：界面或全局 CLI 服务保存的模型配置。除内置服务商（DeepSeek/OpenAI/Anthropic/Moonshot/Groq）外，支持「自定义（OpenAI 兼容）」服务商：在「设置」页填 Base URL + 模型 + API Key 即可接入任意 OpenAI 兼容端点（如 `https://relay.ones.pro/v1` + `ucloud-deepseek-v4-pro`）。CLI 同口径：`csm-agent config llm` 查看、`csm-agent config llm set --provider=custom --model=<模型> --base-url=<端点> --api-key=<key>` 切换；保存前服务端会向端点发一次真实流式请求验证连通，失败不落盘。API Key 只写入本地配置文件（0600），查询接口只返回是否已配置。
- `~/.csm-agent/config/search.user.yaml`：联网搜索（Tavily）配置，也可在「设置」页填写或用环境变量 `TAVILY_API_KEY`。未配置 key 时 `web_search` 自动走免费匿名搜索层（Exa/Parallel/Tavily/Firecrawl/Keenable 五家轮换、限流自动切换下一家，匿名请求不带用户身份；`keylessFallback: false` 可停用）；配置 key 后优先走 Tavily 并支持严格时间窗过滤。`GET /api/config/search` 与 `csm-agent doctor` 只返回 key 是否已配置，不返回 key 本身。
- `~/.csm-agent/.env` 或当前目录 `.env`：凭据和部署变量；可用 `CSM_ENV_FILE` 显式指定。
- `CSM_CONFIG_DIR`：单独覆盖可写配置目录；`CSM_DATA_DIR` 同时决定默认数据目录和默认配置目录。

旧版项目内 `config/mcp.user.yaml` 和 `config/llm.user.yaml` 会继续读取；下一次保存时迁移到用户配置目录。用户配置与凭据不得提交到仓库。

模型查询接口不返回 API Key。MCP 设置页会在本地展示当前连接参数，因此当前定位为单用户本地工具；团队托管前需要增加登录、租户隔离和集中密钥管理。

## ONES 环境变量

ONES 当前租户已有默认值；迁移租户时覆盖：

```dotenv
ONES_CUSTOMER_FIELD_ID=JrvswW8P
ONES_WEB_BASE_URL=https://our.ones.pro
ONES_TEAM_ID=RDjYMhKq
```

## 关键接口

- `GET /api/customers?q=搜索词&sort=default|renewal_date|renewal_amount`、`GET /api/customers/:id/overview`、`GET /api/customers/:id/timeline`

客户组合和客户列表默认排除 CRM「售后客户阶段」等于「流失」的客户；流失客户仍保留在数据库中，可通过客户 ID 查看详情和历史记录。`renewal_date` 按合同到期时间升序，`renewal_amount` 按应续约金额降序，缺失值置底。
- `POST /api/sync`、`POST /api/customers/:id/refresh`、`GET /api/sync-runs/:id`
- `POST /api/hemory/sync`、`POST /api/hemory/resegment`、`GET /api/hemory/fragments`（支持 `since`/`until` ISO 时刻闭区间过滤，如 `since=2026-08-27T14:00:00+08:00`；`date` 仍为整天过滤，显式时间段同指定日期一样不受待归属 7 天窗口限制；`customer_id` 按客户过滤，配合 `status=confirmed` 查看某客户已归属片段）、`PUT /api/hemory/fragments/attribution`、`PUT /api/hemory/fragments/ignore`、`POST /api/hemory/fragments/regenerate`（按天强制重生成草稿，body `{eventIds}`，返回 `{jobs, days}` 与归属端点同形）
- `GET /api/draft-batches`、`PATCH /api/draft-items/:id`、`POST /api/draft-batches/:id/preview`
- `POST /api/draft-batches/:id/confirm`、`POST /api/draft-batches/:id/regenerate`、`POST /api/draft-items/:id/retry`、`GET /api/draft-jobs?ids=`（生成任务状态；归属/重生成响应返回 jobId，失败任务不创建批次只能在此查询）
- `GET /api/action-items`、`PATCH /api/action-items/:id`、`POST /api/action-items/:id/complete`
- `POST /api/action-items/bulk-complete`（body `{ids}`，可带 `outcome`；逐项处理互不影响，返回 `{items:[{id,title,result,reason?,error?}]}`）
- `POST /api/case-drafts`、`PATCH /api/case-drafts/:id`、`POST /api/case-drafts/:id/publish`
- `GET /api/sessions`（默认剔除已归档；`?include=archived` 返回全量）、`PATCH /api/sessions/:id`（重命名 / 归档切换）、`GET /api/sessions/:id/export`（会话全文文本）

## 数据与安全边界

- CRM `_id` 是客户主键；CRM「客户名称」（`field_n1qN0__c__r`）或「售后客户名称」（`field_83f4l__c`）必须与 ONES「客户信息」选项精确且唯一匹配；未归属内容不会进入客户判断。
- Hemory MCP 当前只提供词法和时间窗口转写搜索，不返回 Hemory 页面中的原生摘要、话题或 section ID；CSM Agent 保存原始转写后使用当前配置的大模型生成自己的话题片段，页面会明确展示话题、摘要和可展开原文证据。
- Hemory 同步是滚动 7 天增量：自动（13:00/20:00）与手动同步都扫描最近 7 个上海自然日，已入库片段按外部 ID 去重、已归属/已忽略状态在重同步后保持。待归属列表默认只显示最近 7 天（`days=0` 关闭，指定日期、时间段或全部状态不受限），超过 7 天的片段不删除，可按日期找回。
- 片段支持「忽略」：忽略后不再出现在待归属列表、重同步也不会重新进入，可通过 `csm-agent hemory inbox --status ignored`（或 `--status all`）查看并通过「恢复」（清除归属语义）回到待归属。网页筛选面板只按日期/时间段过滤，打开时预填今天 00:00–23:59 的真实默认值（点「筛选」即按该整天过滤，可自行修改）；状态切换走「已归属」按钮，客户维度走客户详情或 CLI `--customer`。
- 片段按「事件级切片 v3.2」生成（合并优先）：主切割边界是业务对象变化，次边界是同一对象内明显独立的新请求/新决策流；同一对象/同一诉求的连续讨论（含原因、方案、细节澄清、演示、结论与后续安排）保持一个大片段——30 分钟录音通常 1~4 个片段、2 小时会议通常 5~8 个片段，单段一般不超过 100 条发言。同一事件被打断后再次出现时保留多个片段并共享话题组（`topicGroupId`，收件箱显示「同话题 m/n」）。低于门槛（3 条有效发言且合计 40 字）的段独立丢弃，不与相邻话题合并。
- `csm-agent hemory resegment --all` 对库内全部录音按当前分段版本全量重切：先 `VACUUM INTO` 备份数据库，逐录音成功即切换新代际（失败的录音保持旧片段，重跑命令收敛），与增量同步互斥。重切后旧人工归属与忽略状态不继承（全部回到待归属），旧片段停用但保留审计；切换到重新归属完成之间，客户证据与风险「客户声音」维度可能临时降级。超过 7 个上海自然日的录音，其待归属片段需用 `--days=N` 或日期过滤查看。
- 同一录音晚间出现新增转写时，Agent 基于完整新内容重新分段；只有最新成功的一代片段进入待归属。旧片段和已写记录保留审计，旧片段关联的未写草稿会标记为失效，已写记录不改动；客户时间线与草稿再生只使用当前活跃代际的片段。
- 人工 Hemory 归属是唯一归属来源，后续当天全量重拉与同边界重切都不会冲掉 CSM 标记；重新归属会令未写出草稿失效，已写记录只保留审计提示，不自动反向修改 CRM/ONES。
- 沟通记录草稿的【话题】分节正文优先取生成模型对该片段的摘要（`sections`，每片段一条、忠于该片段自己的转写），缺失时回退分段器摘要、再回退转写原文；分节绝不重复同一段全天综述。工时草稿描述为当天一句话总结。
- ONES 工作项草稿宁缺毋滥，须同时满足语义判定与证据信号门控（门控检查证据片段的标题、分段摘要与转写）：**建议和反馈**仅当客户明确表达产品能力不满足（「标品还不支持」「希望支持/增加某功能」类诉求）；**工单**仅当客户明确指认缺陷（「这是个 bug」「不符合预期」类表述）；**运维工单**最谨慎，仅当明确提出运维操作请求（环境重装/数据迁移/配置/证书/服务器等基础设施操作）。方案讨论、workaround、客户内部流程、商务付费话题、泛泛不满一律不建工作项——相关内容保留在沟通记录与待办里。
- 转写由语音识别生成，产品名 ONES 常被误转为发音相近的词（万死、万斯、万四、vans 等）。草稿、实施周报与交互式 Agent 回写的生成提示词均内置近音词规则：凡上下文指代产品之处一律优先理解为并写作 ONES（引用客户原话时同样订正，ONES 工作项的所属产品/所属模块按对应产品线归类）；仅当上下文明确指向其他事物（如人名）时保留原词。片段收件箱与时间线中的分段摘要不做此订正（改分段摘要需升分段版本全量重切）。
- “需求”草稿写入 ONES Desk「建议和反馈」；工单写入 ONES Desk「工单」；二者都必须绑定客户字段 `JrvswW8P`。工时只写当前客户已绑定的售后客户工作项，写工具按 ONES 实例工时模式（`get_manhour_mode`）精确绑定为 `add_workhour_in_simple_mode` / `add_workhour_in_summary_mode`，参数带上海时区偏移的 `startTime`；沟通记录必须绑定 CRM `_id`；沟通记录的服务开始/结束时间取当天未发布沟通的首尾时刻。ONES/CRM 的业务失败（ONES `result:"FAIL"`、CRM `save_status` 未落库）都会把草稿置为 `failed` 并可单独重试。
- ONES 案例发布需要 `ONES_CASE_PARENT_PAGE_ID`，或由 CSM 在发布预览时提供父页面 ID。
- 实施周报（客户详情「实施周报」tab）：按周一~周日自然周（上海时区）基于该客户本周全部信息（Hemory 片段、建议/工单/运维工单、私有云实例、工时、CRM 跟进、行动事项、风险评级）生成四章节（本周执行摘要/本周完成情况/下周工作计划/问题风险与阻塞）；③④ 章以本周沟通片段中的约定/承诺与问题/风险信号为主要证据，逐条标注来源，无证据不杜撰。计数类统计由代码确定性计算：沟通次数按录音场数计（一场长会的多个话题片段只算一次）；工作项按「本周有更新」聚合去重（不限创建时间，上周创建本周解决/推进的也进周报），「新增」按创建时间在本周、「解决」按当前状态快照与更新时间近似判定（周报中标注）。生成失败任务显式报错并支持一键再次生成（不受指纹幂等短路）。发布到 ONES Wiki 走 `preview → 确认 → publish` 参数哈希审批门，父页面通过页面组→页面树层级选择器选取（案例发布同款选择器，手填页面 ID 保留为兜底）。
- ONES Wiki 只读浏览（`csm-agent wiki` / `GET /api/ones-wiki/*`）经 ONES MCP `search_for_spaces` / `get_list_of_space_pages` 实现，结果缓存 5 分钟。
- 当前 ONES MCP 没有 Desk 专用工具，Desk 数据通过 ONESQL 按项目、工作项类型和「客户信息」字段读取。
- Mac `.app` 仍是本地 WKWebView 壳。页面内所有确认/提示/输入对话框（草稿确认、重新生成、忽略归属、案例发布等）使用自绘 modal，不依赖原生 `confirm()/alert()/prompt()`（WKWebView 未实现 JS 对话框面板时它们会静默失败）。

## 验证

```bash
npm run verify
csm-agent capabilities --json
CSM_BASE_URL=http://127.0.0.1:3210 csm-agent doctor
csm-agent hemory inbox --json
csm-agent drafts --json
csm-agent service status
```

验收以指向当前构建的全局 `csm-agent` 为统一入口：先运行 `npm run verify`，再对运行中的服务执行与改动匹配的 CLI 命令。纯 UI 改动需要自动化检查覆盖展示合同；浏览器验收仅在用户明确要求时执行。真实交付边界还包括三套 MCP 同步与 ONES Wiki 实际发布；这些边界必须使用真实权限与凭据验证，不能由本地配置存在代替。

## Git 交付约定

远端仓库为 [opyamorpen/csm-agent](https://github.com/opyamorpen/csm-agent)，本地 Git 远端名为 `origin`。每轮本地修改完成后，必须先运行相关验证，再创建有明确说明的提交并推送到 `origin`；只有获得 `git push` 的直接证据，才能将该轮报告为已交付。提交或推送受阻时，必须保留工作区改动并明确报告阻塞原因，不得将未同步状态描述为远端已完成。
