# CSM Agent 客户成功工作台

案例内容 v19：新生成案例以 5000-8000 字行业解决方案母稿为目标，素材不足时收缩。第一章保留七角度联网检索，优先官网、监管/政府和招采资料；正文加强决策背景、组织约束、运营模式、角色治理、方案机制与采用变化，`lessons` 在新稿显示为「可复制实践」，旧稿维持原标题。每个 `solution_sections` 可选择 0-2 个 `practice_ids`，全篇不重复；通用实践及文档依据保存在只读 `practice_library`，按冻结文本嵌入正文，不进入客户 `claim_evidence`、配图素材、配图锚点或集成清单。三张工程化图的结构、渲染器与校验规则不变。`content_review` 提供七维内容线索、篇幅与实践数量，属非阻断诊断，不代表语义正确性认证；两个以上有素材线索但未展开的维度可触发现有一次增量补写，不增加模型阶段。本轮不扩展公开发布流程。

编辑示例：`csm-agent case update <草稿ID> <版本> '{"fields":{"solution_sections":[{"title":"统一需求入口","text":"有来源支持的客户方案正文","practice_ids":["intake-governance"]}]}}'`。该命令替换整个方案小节数组；保留其他小节时须一并提交。`case show <草稿ID> --json` 可查看实践 ID 目录、冻结版本和内容诊断，`case show` 与复制/Word 使用相同实践正文。

以 CRM 售后客户为唯一主体的内部 CSM 工作台。系统通过 MCP 读取 CRM、ONES 和 Hemory，将跨系统事实归一到客户，形成客户组合、统一时间线、续约风险、增购假设、案例草稿和待办闭环。

## 一期能力

- 客户组合：首页优先展示续约 120 天内客户和合同价值前 20%客户。
- 客户全景：CRM 基础资料、ONES 建议与反馈/工单/运维工单/客户工时/私有云实例、Hemory 会议转写、风险、机会、案例和待办。
- 风险判断：确定性规则负责分数和等级；缺失数据保持 `unknown`，不转换为风险分。
- 风险预警名单：满足任一触发条件即进入待处理预警——①近 30 天 CRM 跟进与 ONES 工作项/工时活动**同时停滞**（无 CRM 跟进记录 且 无 ONES 工作项新增/更新与新增工时；两侧都零历史不预警，单侧零历史不豁免；CRM 侧以跟进事件与档案「最后联系」字段取最大兜底——跟进同步只拉全局最近 200 条）；②公开动态检索到该客户负面信息（收入下降/罚款/投诉/负面评价等，回看 90 天与风险 web 维度同口径，只要有就预警）。预警与风险重算同源触发（每日同步/手动刷新/公开动态落库后）。CSM 可消除风险并必须填写原因/动作（写审计）；条件自动解除（任一渠道恢复活动、负面移出窗口）由系统标记；消除后情况无新变化不重报，新一轮双双沉默或新负面证据出现才重新预警。Web 左侧导航「风险预警」页（待处理/已消除双 tab）与客户详情预警横幅均可消除，CLI 同款：`csm-agent alerts` / `csm-agent alerts resolve <预警ID> --note "..."`。
- 公开动态轮次报告：每轮检索的完整结果存档在该轮同步记录里（run 即报告）——同一条旧闻跨轮命中按（客户, URL, 日期）自然键去重不重复落库，只在报告留痕并标注「新增」；客户详情「公开动态」tab（按轮分组：轮头「时间 · 检索 8 个角度 · 新增 N / 命中 M」，条目带分类/日期/来源链接/新增徽标）、`csm-agent webintel <客户> --history`、`GET /api/customers/:id/web-intel/rounds` 与 agent 本地工具 `get_customer_detail` 的 `web_intel` 板块四端同源。
- 增购机会：只在非高风险客户中展示至少两个独立证据支持的假设。
- 客户案例：按可直接公开传播的标准生成**四章深结构客户叙事（v8，对齐手写案例标准：客户及背景介绍（客户简介三小节 + 项目背景 + 系统使用情况表）→ 场景及解决方案（业务现状/业务诉求/业务解决方案小节化）→ 方案价值概述（服务里程碑/价值成效/经验复盘）→ 项目总结）**，各章有明确篇幅契约（方案章 2~6 小节 × 250~600 字、总篇幅 4000~8000 字量级），素材不足时宁少勿注水。生成采用**分章节流水线**：先一次「章节规划」调用产出六章节要点与证据骨架（plan），再逐章节单独撰写正文（每章一次小调用），最后由服务端对位组装——单次模型输出只有一章，彻底规避 maxTokens 截断（v4 单次大 JSON 输出在素材丰富的客户上稳定触发 `stopReason=length`）。**素材口径（v6，用户拍板）：ONES 系统内的工作项明细（建议与反馈/工单/运维工单、私有云实例、工时记录）不作为案例输入——不注入、不可被 claim_evidence 引用；ONES 数据只经服务端预计算的交付事实统计（delivery_stats：合作起点与时长、各类已完成交付量、工单解决时效、累计工时）以聚合形态参与**。案例素材 = Hemory 沟通片段 + CRM 跟进 + 客户档案 + 七角度公开检索（公司概况/项目管理/需求管理/知识管理/行业动态/招投标/中标采购）+ delivery_stats 聚合——模型可直接引用聚合数字作事实陈述，但禁止推导完成率或提升百分比，低完成量只写已完成部分；说话人、否定词、时态共同决定章节，转写匿名分轨（speaker_N）与「我/我们」视角按客户侧归类，未确认信息只进内部 `unknowns`，正文不出现占位词。每条主张以 `claim_evidence` 绑定来源原文（claim 由服务端按章节正文对位组装、摘录必须能定位到引用来源的连续原文——防编造是阻断项；说话人角色判定降级为非阻断告警，由 CSM 复核），生成上下文固化为 `context_snapshot`。**系统使用情况表与服务里程碑由服务端确定性派生**（CRM 档案/合作起点/已交付事件首单），LLM 不写（防虚构），CSM 可在工作台补充账号数、有效期、使用部门等缺失行（缺失项自动进 unknowns 提示）。输入侧按 token 预算治理：素材未超预算时完整原文注入；超出时逐级收缩注入规模，二级收缩后仍超则追加一次「素材摘要」模型调用压缩素材（保留 source_ref 对位），摘要后仍超才报「上下文预算超限」——降级与摘要轨迹持久化在草稿 `input_summary` 字段（`case show --json` 可见）。生成后计算素材覆盖度（价值/痛点信号、权威公开资料被正文实际引用的比例），主要素材池大量闲置时自动追加一次「补充完善」生成（补写失败保留第一稿），覆盖率与补写情况随草稿 `coverage` 字段持久化并在 `case show` 输出。每阶段模型调用对网络错误带指数退避重试（5s/15s/45s），内容错误带校验反馈修复并放宽首字节超时（大上下文常见 40~60s）。支持对话精修与各章正文编辑（含派生表/里程碑），服务端始终保留内部证据；编辑与精修写回走非阻断护栏（条目数失控、单条超长、内部信息残留时随响应返回提醒）。发布前公开检查会提示空章节、无来源数字、非客户反馈、敏感信息、交付统计披露口径、其他客户名称、过期上下文和授权复核等问题，均为非阻断警告。逐章生成时注入已定稿前序章节（跨章不重复、专有名词与口径一致）；规划阶段允许兜底引用关键词信号表之外的片段素材（`coverage.fallbackCited` 记录兜底规模，仅供审核不参与补写触发）；素材中有客户描述的流程（现状/目标）或值得呈现的合作里程碑时逐图生成配图；业务解决方案图 1、系统集成图和价值全景图由模型提取结构化内容，服务端按确定性模板渲染（分层蓝图、上下分层集成、痛点及挑战/方案/价值三分区）；其余配图仍由模型生成 SVG 并经服务端白名单消毒后落库（图级证据挂 source_refs），Markdown 端以图注占位、图形在工作台案例卡渲染，消毒或生成失败只丢弃该图、绝不阻断正文。**单版本保留（用户拍板）**：每次（重新）生成的新稿落库即删除同客户历史版本草稿行（含旧配图，关联发布尝试记录级联清理），工作台与 CLI 每客户只保留最新一版。**工作台案例卡内嵌只读「案例全文」**（客户详情 tab 默认展开、全局案例库折叠），章节顺序对齐服务端权威 Markdown 渲染，配图按章节位置嵌入（与导出 Word 同口径），无需进入编辑即可通读全文。**交付形态（v8）**：Markdown 三端同源（Web 复制 / ONES Wiki 发布 / CLI `case show`）之外新增 **Word 导出**——`GET /api/case-drafts/:id/export` / `csm-agent case export <草稿ID> [--out]` / 工作台「导出 Word」按钮，按四章版式生成 docx（目录域、客户信息表真表格、服务里程碑、SVG 栅格化配图），存量 v7 旧稿按五段结构照常可读、可编辑、可发布、可导出。**生成耗时与恢复（v18）**：保留原素材预算、篇幅、章节依赖、模型和配图契约。七角度检索并发上限 5；所有案例任务共享两个模型槽位，章节未结束时配图最多占一个，保留下一章的名额。网络错误仍按 5s/15s/45s 退避，内容错误立即携带具体校验反馈重试。补写只返回变更条目和对应证据，服务端保留未修改的正文及映射、合并后执行完整校验；正文锚点变化时更新关联配图，更新失败则整套保留首稿。任务持久化冻结素材和已经校验的阶段产物，只有完整请求、模型配置及规则版本匹配时才复用。`csm-agent case job <任务ID> [--json]` 查看每次调用的排队、首字、请求耗时、模型报告的 token/缓存用量和检查点；未记录值保持 unknown。`case resume <任务ID> [--wait]` 继续失败或中断的最新任务，素材/模型/规则变化或公开快照过期时拒绝；重新生成创建新任务，不借用旧任务检查点，同客户正在生成时重复点击复用在途任务。案例 `--wait` 最长 60 分钟。服务重启自动恢复尚未终结且兼容的任务（自动尝试上限 3），失败任务需显式 resume。时间诊断与自动化契约通过均不代表人工审稿结论；提速幅度以真实运行对照为准。
- 配图视觉统一：现状流程图、目标流程图和服务里程碑图采用模型内容 + 服务端统一视觉外壳与蓝色主题；业务解决方案图 1、系统集成图和价值全景图采用结构化内容 + 服务端确定性分层渲染。历史草稿配图原样保留，新生成图统一经过服务端消毒与边界校验。
- 待办处理：「待办」页展示全部待办（不限本周），分「未完成 / 已完成」两个 tab（计数写在 tab 文案里），均按客户分组展示（默认展开、点组标题可折叠）；未完成 tab 支持勾选（全选 + 已选计数，点卡片本体即可选中）后批量完成，批量操作条 sticky 冻结在滚动区顶部，已完成 tab 自动隐藏批量操作条；单项「完成」与批量完成均一键直达——不弹确认、不记录实际结果（CLI `--outcome` 可选记录实际结果，不填不记录）。逐项处理互不影响——仅未完成可被完成，已完成跳过，单项失败不回滚其他项，结果按 项数 汇总提示。待办状态只有两态：未完成（`new`）/ 已完成（`completed`）。CLI 同款：`csm-agent action complete <待办ID...> [--outcome]`。
- Agent：保留多轮对话和 MCP 工具调用，任何写入都绑定到批准的目标工具和完整参数哈希。会话每轮自动拾取最新的工具清单与模型配置（服务重启或 MCP 重连后旧会话不再停留在过期清单上）；**会话与客户完全解耦——会话不绑定客户，客户身份只存在于对话文本、本地工具的 customer_name 参数与回写草稿 fields**（悬浮球/「询问 Agent」点击均为新会话+预填，`resolve_customer` 是无状态身份解析：名称→CRM _id/ONES 选项/售后工时项/使用版本）。Agent 另有本地工具（读工作台客户的均须带 customer_name/customer_id 指定客户，全称/简称唯一精确匹配）：`get_customer_detail` 按板块（sections）读取客户详情页数据（概览/建议/工单/运维/工时/私有云实例/跟进记录/Hemory 片段/客户案例/实施周报/待办事项/统一时间线，每轮只取与问题直接相关的板块以节省 token，仅用户明确要求「全部信息」时才整表拉取），`get_customer_profile` / `get_customer_events` 是它的旧版粗粒度等价(本地优先，超过 36 小时未同步提示刷新或用 MCP 兜底），`web_search` 联网检索客户公开动态（Tavily），`record_web_intelligence` 把检索结果落库为 `web_signal` 证据（customer_name 必填，落库归属须确定）。对话支持本地附件：输入条左下「＋」按钮选择、拖拽文件或粘贴截图皆可；文本类文件（txt/md/csv/json/log/代码等）、Office 文档（docx/xlsx/pptx，提取正文文字；旧版 .doc/.xls/.ppt 请另存为新格式）与 PDF（提取正文文字）内容注入对话上下文，图片在模型支持视觉（图片输入）时作为 image 内容块发给模型——内置服务商按模型目录自动判定，自定义端点须在设置中勾选「支持图片输入（视觉模型）」（或 `csm-agent config llm set ... --vision=on`）；无视觉能力时图片附件被明确拒绝。贴入截图或一段聊天记录说「帮我提 bug / 提需求 / 提工单」时，agent 从贴入内容提取证据直接生成 ONES 建议/工单/运维工单待确认草稿（类型路由：缺陷指认→工单、新功能诉求→建议、运维诉求→运维工单；先取 `get_ones_desk_required_fields` 字段契约，证据不足的规格字段用兜底值并把不确定项写进 unknowns），在对话页确认卡上编辑并批准后按原参数一键回写 ONES；客户归属从贴入内容识别——会话不绑定客户，草稿自含身份：草稿携带客户名、批准时服务端按工作台唯一解析并确定性绑定 ONES 客户字段（识别不出或同名歧义才会追问）；信息足够时不连环追问，多个问题逐条依次确认，被拒绝的草稿不得原样重提。CLI 同口径：`csm-agent agent <客户> <指令> --attach <文件路径> [--attach ...]`。附件限制：一次最多 5 个、单文件 8MB、合计 15MB、文本/PDF 注入超 5 万字符截断标注；附件文件落盘在 `~/.csm-agent/attachments/<会话ID>/`，删除会话时一并清理。回复以 token 级流式逐字呈现（`text_delta` 瞬态事件只推在线客户端、不落盘不回放，中途刷新重连后回放整段）；推理模型的思考过程以折叠面板展示（流式时实时填充，完成后折叠为「已深度思考（N 字）」一行，可点开），每轮结束显示本轮 token 用量（输入/输出/本会话累计）。对话进行中可随时「停止」（发送按钮切换为红色停止态，点击即停 / `csm-agent sessions stop <会话ID>` / CLI agent 运行中 Ctrl+C）：中断模型调用与后续工具执行，挂起中的确认草稿按拒绝处理（停止即不写），停止留痕进入会话与分享导出；进行中的单个工具调用（含已批准的写调用）允许完成，批内剩余调用跳过。会话支持「分享」（一键复制全文：标题、客户绑定、时间范围与完整对话；Web「分享」按钮与 `csm-agent sessions show <会话ID>` 同源）和「归档」（从会话列表隐藏，网页「已归档」折叠区或 `csm-agent sessions unarchive` 可恢复；归档会话禁止继续发消息）。侧边栏 Agent 导航项显示待办角标 = Hemory 待归属数 + 草稿箱待处理数。
- 客户标签页：建议、工单、运维、工时、私有云实例、跟进记录、会议沟通、客户案例、待办事项和统一时间线分组查看；建议/工单/运维三个 ONES 工作项列表只展示语义化 ID（`display_id`）、标题、状态、创建时间，标题可点击进入工作项详情，并默认按创建时间倒序。工时页同时展示总工时和登记明细（登记人、工时日期、登记小时、工时描述），明细默认按工时日期倒序。
- 会议回写：在客户标签页选择目标，Agent 基于已归属 Hemory 证据生成草稿；CSM 可编辑业务字段和实际参数，确认后才写入。
- Hemory 收件箱：每天中国时间 13:00/20:00 通过 MCP 拉取当天完整逐句转写，按录音持久化后由当前 Agent 大模型整理为话题、摘要和连续证据片段；片段不按客户名称自动归属（转写中提及客户名通常是在引用其他客户案例，不代表在与该客户沟通），全部片段由 CSM 在 Agent 页面批量标记。
- 片段质量门槛：寒暄、环境音、零散的一两句话，以及少于 3 条有效发言或信息量不足的分段只保留在原始转写中，不进入待归属；模型不得合并不相关短句来绕过门槛。
- 自动草稿箱：客户归属后，AI 只生成证据支持的 Agent 待办、沟通记录、需求或工单草稿；勾选后一次批准、逐项执行，失败项单独重试。归属（或重新生成）触发的后台生成任务对用户可见：Web 草稿箱顶部「正在生成草稿」横幅实时显示每个任务的阶段与模型输出进度（「客户 · 日期：证据就绪/模型撰写中… 已输出 N 字/重试提示」，与实施周报/客户案例同一进度管线，任务状态与 progress 文案经 `GET /api/draft-jobs` 轮询，2s→5s 降频），完成后自动刷新；刷新页面/切换视图后横幅自动恢复（`GET /api/draft-jobs?status=active&kind=hemory` 恢复在途跟踪），超过 10 分钟安全阀才停止轮询且提示 15 秒后自动清除；服务重启遗留的孤儿 running 任务由服务端标注 stalled（永不终结，刷新不再收编进横幅），提示走草稿箱「重新生成」恢复。CLI 侧 `csm-agent hemory assign/regenerate --wait` 等待终态并实时打印进度变化，`csm-agent draft jobs` 随时查询、`--active` 列出进行中任务（含进度与中断标注）。**模型调用带指数退避自动重试（5s/15s/45s，中继端点连接坏窗口为瞬时故障）；重试耗尽才标记 failed 并透出真实原因，不做规则兜底**——失败任务不创建批次、不产出草稿，Web 草稿箱顶部有持久失败卡片（客户+日期+真实错误+涉及片段明细，可按片段一键重新生成），CLI 侧 `csm-agent draft jobs` 无参列出全部失败任务及片段明细；同日重新生成成功后旧失败任务自动标记 superseded 不再堆积。每个客户每个上海自然日一个批次，沟通记录草稿有且仅有一条（按【话题】分节合并当天全部沟通，正文超长时压缩最长节而非丢弃末尾节），并连带一条工时草稿（时长按录音片段时间计算，真实沟通跨度不足 3 分钟时按最小 0.1 小时计、描述为一句话总结）；当天已在 CRM 发布过沟通（含手动录入的跟进）后，新草稿只合并发布之后的新沟通，全天发布完毕则不再生成沟通记录与工时草稿（其他类型不受影响）。已写入草稿的消费台账：各类型已写入草稿引用过的片段不再被同类型重复消费（已写入工单的片段不再重新提案工单，工时已写入但跟进失败时只重出跟进不再重复计工时），强制再生成遇到当天证据全部消费时任务以「未生成新草稿」备注收尾、不作废旧草稿；片段的消费状态在收件箱（Web 徽标「已写入·工单」等）与 CLI `hemory inbox` 的 consumed 列可见。同日补充归属会按全天内容重建当天批次（未写入草稿作废，已写入记录不动）。草稿箱（Web 与 `csm-agent drafts`）默认不显示已写入草稿；`csm-agent drafts --all` 或 `GET /api/draft-batches?include=written` 可查看全量；纯已作废/已忽略批次在 Web 草稿箱独立于待处理批次，放在「已忽略/已作废」二级 tab 分列展示（CLI 对应 `csm-agent drafts --archived`）；批次级整批忽略走 CLI `csm-agent draft dismiss`（Web 不再提供批次级按钮）。草稿卡片支持单卡「确认/忽略」直接操作（`csm-agent draft ignore` 同款逐条忽略），勾选多份草稿后底部浮动操作条钉在可视区底部（默认批量确认，点「批量忽略…」切换一次才进入忽略模式，勾选清零自动复位）。

## 安装（macOS 一键安装）

普通使用者无需克隆仓库和安装 Node，一条命令完成 CLI + 桌面端 + 常驻服务安装。推荐「先下载后执行」（curl 失败会立刻显式报错）：

```bash
curl -fsSL --retry 3 https://raw.githubusercontent.com/opyamorpen/csm-agent/main/scripts/install.sh -o /tmp/csm-agent-install.sh && bash /tmp/csm-agent-install.sh
```

管道形式 `curl -fsSL .../install.sh | bash` 同样可用。

安装器会：

1. 检查 git 与 Xcode Command Line Tools（`swiftc`，缺失时提示 `xcode-select --install`）；
2. 复用系统 Node（`>=22.5`），否则下载捆绑 Node 22 LTS 到 `~/.csm-agent/node`（官方 SHASUMS256 校验，复用须与钉住版本完全一致）；
3. `git clone` 仓库到 `~/.csm-agent/app` 并构建（可用 `--repo`/`--branch` 指定安装源，默认 `main`；目录已存在但非受管安装时自动移到 `*.broken-<时间戳>` 后重新克隆，重跑必定自愈）；
4. 生成 `csm-agent` CLI shim（`~/.local/bin`，固化 `CSM_DATA_DIR`，必要时按登录 shell 写入 PATH）；
5. 现场构建桌面 App（Swift WKWebView 壳）并在 `/Applications` 建立入口（构建失败仅警告，不阻断 CLI/服务）；
6. 安装 launchd 常驻服务（`http://127.0.0.1:3210`，开机自启，`--no-service` 跳过）并**轮询 `/api/version` 校验服务已加载本次构建**（buildId 与磁盘一致且非 stale，超时打印服务日志并以失败退出，不再「睡了 2 秒就当成功」）。

安装收尾会打印安装指纹（commit/node/buildId/桌面 App/服务状态）。验证「与开发机一模一样」：两台机器各跑 `csm-agent version --json`，**gitSha 一致即同一份代码构建**（buildId 含构建时刻，两端必然不同，不作为比对项）。

安装后：新开终端运行 `csm-agent version`；配置凭据后（App 设置中添加 MCP 服务器、`csm-agent config llm set` 配置大模型）即可使用。用户数据（配置、会话、SQLite、日志）都在 `~/.csm-agent` 下，与代码目录分离，更新和卸载不触碰。

隔离验收参数（不动真实数据）：`bash scripts/install.sh --dir <目录> --bin-dir <目录> --data-dir <目录> --apps-dir <目录> --port <端口> --no-service`（要在真实 launchd 里隔离验收服务，加 `CSM_LAUNCH_AGENT_LABEL=<独立label>` 避免与本机常驻服务同 label 冲突）。

### 更新与卸载

```bash
csm-agent update            # 拉取最新 main 并重建（重跑安装命令同样进入更新路径）
csm-agent uninstall         # 移除 CLI、桌面端、常驻服务与受管目录；保留 ~/.csm-agent 用户数据
csm-agent uninstall --purge # 连同用户数据一并删除（需确认，加 --yes 跳过确认）
```

`csm-agent update` 的可靠性保证：

- **失败自动回滚**：依赖安装或构建失败时，自动 `git reset` 回更新前 commit、重装旧依赖并重建旧构建，报告 `rollback: restored`（运行中的服务本就跑旧内存代码，不受影响）；回滚也失败时报告 `rollback: failed` 并给出恢复指引。
- **升级后启动验证**：服务重启后轮询 `/api/version` 至多 120 秒，确认 buildId 已换新且非 stale（报告 `serviceVerified`），不再「重启了就算成功」。
- 服务重启沿用安装时记录的端口与 node 二进制（非默认 `--port` 安装不会被改回 3210，用别的 node 跑 update 不会静默换运行时）。

## 运行

要求 Node.js `>=22.5`。SQLite 使用 Node 内置 `node:sqlite`，数据默认保存在 `~/.csm-agent/workbench.sqlite`；可通过 `CSM_DATA_DIR` 修改。

```bash
npm install
npm test
npm run dev
```

默认地址为 [http://127.0.0.1:3210](http://127.0.0.1:3210)。首次进入后在“设置”中配置 CRM、ONES、Hemory MCP；点击“同步数据”执行首次导入。服务每天 02:00（上海时区）刷新 CRM/ONES，并在中国时间 13:00、20:00 拉取 Hemory 当天 `00:00` 至执行时刻的完整转写，再等待 Agent 大模型完成话题分段。客户公开动态自动轮换：每天中国时间 20:00–次日 08:00 夜间错峰时段每小时检索 1 个客户（8 角度联网搜索 + 1 次模型分类——错峰 token 更便宜，也不打满免费搜索限流），按「最久未查优先」约两周轮完全部非流失客户——14 天窗口内不重复搜、每天每客户至多尝试 1 次、失败的客户次日最先重试；Mac 合盖睡眠漏掉的槽位无需手动补：唤醒后过期的槽立即补跑一次，漏掉的客户自动排到「最久未查」队首由后续槽位捡回（想立即追进度用 `csm-agent webintel --rotation`）。同一条新闻跨轮命中按（客户, URL, 日期）自然键去重，不重复堆积证据。客户详情支持单客户刷新（公开动态强制立查，不受 14 天门限制）。

### 登录与多用户（密码登录）

所有 `/api/*`（除 `POST /api/auth/login` 与 `GET /api/version`）都要求登录凭证；页面首次打开会弹出登录页。

- **首启引导**：空库首次启动自动创建管理员 `admin`——密码取 `CSM_ADMIN_PASSWORD` 环境变量，未设置则随机生成并**打印到服务日志一次**（`csm-agent service logs` 查看）。存量单用户部署升级后，历史会话/记录全部归属 admin，除多一步登录外行为不变。
- **登录方式**：浏览器走用户名 + 密码（HttpOnly cookie 会话，7 天滑动过期）；CLI 走 `csm-agent login`（签发个人访问令牌 PAT，存 `~/.csm-agent/cli-auth.json`，0600，按服务地址键控）。企业微信扫码登录见下节。
- **每人各自的连接与数据可见性**：设置页「我的连接」维护本人 CRM/ONES/Hemory 凭证（服务器名称需为 `crm`/`ones`/`hemory`，模板即如此）；同步按用户执行——**你的凭证拉到的客户即你可见的客户**（`user_customer_access` 映射，CRM/ONES 双源授权；领导账号在 CRM/ONES 里的数据权限范围就是其区域范围）。Agent 会话/写入记录/待办为个人工作区按属主私有；草稿/案例/周报/预警等客户域数据按客户可见性过滤（不可见一律 404）；写审批限定会话属主可见的客户，外部写经操作者本人凭证执行（写身份=登录用户）。Hemory 收件箱按「本人录音 ∪ 可见客户」过滤。全量重切/孪生修复/同步运行详情为管理员维护操作。
- **企业微信扫码登录（配置即启用）**：`~/.csm-agent/config/wecom.user.yaml` 写齐 `corpid`/`agentid`/`secret`（自建应用）后登录页自动出现「企业微信扫码登录」；流程为 wwlogin 扫码页 → 回调 `GET /api/auth/wecom/callback` → code 换 userid → 匹配 `users.wecom_userid` 建会话。绑定：管理员执行 `csm-agent users bind-wecom <用户名> <企微 userid>`；state 一次性 5 分钟有效防重放。**前置条件**：企微管理后台配置应用的「登录可信域名」（部署域名确定后设置）；拿到真实凭证前本层以 mock 测试覆盖协议分支，端到端联调待真实环境验收。
- **个人中心（左下角头像，点击弹悬浮菜单）**：上传/移除头像（网页端自动居中裁方压到 256px，仅本人可见）；主题切换与光标动效开关在此设置；退出登录在头像菜单中。CLI 对应 `csm-agent profile` / `profile avatar`。
- **账号管理（管理员）**：`csm-agent users list / create <用户名> [--display-name=X] [--role=admin|member] [--password=X] / reset-password / set-role / enable / disable`；create/reset 缺省生成随机密码仅回显一次，重置密码会收回该用户全部在线会话；最后一名管理员不可降级或禁用。无自助注册。
- **权限口径（现阶段）**：`admin` 管理用户与全局配置（LLM/搜索密钥、MCP 配置、备份触发）；`member` 使用业务功能。Agent 会话与写入审批记录按属主私有（他人的会话 403）；审计（`audit_log`）记录真实登录用户名与 `user_id`，审批落 CRM/ONES 的执行记录带操作人。
- **安全要点**：密码 scrypt 加盐哈希（`node:crypto`，无外部依赖）；登录失败按 用户名+来源IP 连续 5 次锁 15 分钟；cookie 变更请求校验同源（CSRF 防御）；服务默认只监听 `127.0.0.1`（此前未绑 host 会监听全部网卡），多人局域网/公网部署用 `CSM_HOST` 打开（公网务必置于 HTTPS 反代之后）。
- **CLI/CI 令牌**：`csm-agent token create [--name=X]` 生成 PAT（明文仅显示一次、无过期、可 `token revoke` 吊销），供脚本以 `Authorization: Bearer <token>` 调用 API。

### 版本号（语义版本）

- **唯一权威源**是 `package.json` 的 `"version"`（裸值 `MAJOR.MINOR.PATCH`，npm 惯例）；所有面向人的展示统一加 `v` 前缀（如 `v0.2.0`），`--json` 等机器可读输出保持裸值。
- **构建时冻结**：`npm run build` 的构建戳把该版本一并写入 `dist/build-info.json` 与 `public/build-info.js`——运行中的进程汇报「自己那次构建」的版本，不受磁盘上后续更新的 `package.json` 影响（与 buildId 同一设计动机）。旧构建产物无此字段时各处展示 `unknown`。
- **消费方**：网页个人中心「系统版本」、`csm-agent version`（明文 `v` 前缀）、`/api/version`（`version` 字段）、`csm-agent doctor`（`serviceVersion`）与 `csm-agent service status`，全部同源。
- **升版规则**：patch（0.x.**N**）= 缺陷修复与小调整；minor（0.**N**.0）= 新功能/新工作流；major（**N**.0.0）= 不兼容变更或对外里程碑。升版随当轮交付 commit 手动完成。
- 语义版本与 buildId 分工：buildId（gitSha+构建时刻）管「构建一致性/新旧进程检测」，语义版本管「发布标识」；`csm-agent update` 仍按 git HEAD 判断是否更新。

### 构建版本与旧进程检测

`public/` 静态文件每次请求从磁盘实时读取（页面永远最新），而 API 路由在进程启动时加载进内存——**构建后若进程不重启，就会出现「新 UI + 旧 API」分裂**（新端点 404、新按钮失效）。防护体系：

- `npm run build` 在 tsc 成功后执行 `scripts/stamp-build.mjs`：git SHA + dirty 标记 + 构建时刻写入 `dist/build-info.json` 与 `public/build-info.js`（`window.__CSM_BUILD__`，gitignore），同一次构建的服务端与前端共享同一 buildId；**构建戳只在编译成功后落盘**——失败的构建不推进 buildId，受监管进程不会自退出换新到坏 dist 上；`npm run dev` 为 `tsx watch`（源码改动自动重载）。
- 服务暴露 `GET /api/version`（version/buildId/startedAt/pid/supervised/stale，其中 `version` 为构建冻结的语义版本，旧进程缺失时为 `null`）；前端每 30s 比对自己脚本的 buildId 与进程的 buildId，不一致或端点缺失（进程早于该机制）时页面顶部常亮红色横幅提示重启，恢复一致自动消隐。
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
csm-agent login # 多人部署：交互输密码登录，此后所有命令自动携带凭证（logout 退出）
csm-agent whoami # 查看当前服务地址与登录身份
csm-agent profile # 个人中心：账号与头像状态；profile avatar <图片> 上传 / --remove 移除
csm-agent customers 青岛高测
csm-agent customers --sort renewal_date
csm-agent customers --sort renewal_amount
csm-agent customers aliases <CRM客户ID或名称> # 查看客户别名
csm-agent customers aliases <CRM客户ID或名称> --add 青禾晶元 # 维护别名：agent 解析客户支持全称/简称/别名精确匹配 + 唯一子串兜底；与全称无子串关系的品牌名须维护别名才能解析（--set 整组替换 / --remove 删除）
csm-agent customers merge --from <重复行ID> --into <保留行ID> # 合并重复客户（管理员，修复同步/导入产生的同一客户双行或幽灵行）：from 行全部挂载数据改挂 into 行后删除，逐表迁移计数 + 审计；doctor 会报出可见同名重复
csm-agent customer <CRM客户ID> # 概览含续约风险五维度明细与全量完成率
csm-agent webintel <CRM客户ID> # 强制检索该客户最近三个月公开动态（8 角度），落库并重算风险/机会
csm-agent webintel <CRM客户ID> --history # 轮次报告：最近 10 轮逐条明细（★新增标记 + 来源链接），旧闻跨轮不重复落库只在报告留痕
csm-agent webintel --rotation # 手动排空自动轮换队列（14 天门内跳过、当天已尝试不重复；首次全量排空可能耗时 1 小时以上）
csm-agent opportunities <CRM客户ID> [--refresh] # 增购机会假设（LLM 从会议录音片段+公开动态分析，按可信度前 5 条、逐条附来源）；--refresh 强制重新分析
csm-agent timeline <CRM客户ID> support_ticket # 四列工作项，按创建时间倒序
csm-agent workhours <CRM客户ID> # 总工时和登记明细，按工时日期倒序
csm-agent actions [CRM客户ID]
csm-agent action complete <待办ID...> --outcome "已与客户确认下一步" # 批量完成，--outcome 可选记录实际结果（支持空格或=传值）
csm-agent action update <待办ID> '{"status":"completed"}'
csm-agent alerts [--status active|resolved|all] # 风险预警名单：近 30 天 CRM 跟进与 ONES 工作项/工时活动同时停滞、或公开动态检索到该客户负面信息（收入下降/罚款/投诉等）的客户自动进入；默认待处理
csm-agent alerts resolve <预警ID> --note "已上门回访，客户预算冻结属正常周期" # 消除风险必须写明原因/动作（写审计）；消除后情况无新变化不重报
csm-agent cases [CRM客户ID]
csm-agent case generate <CRM客户ID> [--force] [--wait] # 公开版四章深结构案例；联网检索公司概况/项目管理/需求管理/知识管理/行业动态/招投标/中标采购；--wait 实时打印生成进度（阶段/检索角度/模型输出字数）；服务端注入交付事实统计（合作时长/各类已完成交付量/工单解决时效/工时投入）并派生系统使用情况表与服务里程碑，素材覆盖度过低时自动追加一次补充完善；业务解决方案图 1、系统集成图和价值全景图由模型提取结构化内容，服务端按确定性分层版式渲染（价值全景图从左到右固定痛点及挑战/方案/价值三栏，中间方案区占最大空间，痛点与价值各 3~5 条并按序对应）；现状流程图、目标流程图和服务里程碑图采用模型内容加服务端统一视觉外壳与蓝色主题，历史草稿原样保留
csm-agent case show <草稿ID> # 默认输出可直接对外的 Markdown（与复制/Wiki 发布同源）与素材覆盖率一行摘要，有配图时列出图注；--json 查看 claim_evidence/figures/context_snapshot/coverage/unknowns
csm-agent case regenerate <草稿ID> [--wait] # 强制重建，成功后替换该客户的旧稿；在途重复提交复用同一任务
csm-agent case job <任务ID> [--json] # 每次模型调用的排队/首字/请求耗时、token、错误和检查点
csm-agent case resume <任务ID> [--wait] # 同素材/模型/规则继续失败或中断的最新任务，已校验步骤不重做
csm-agent case update <草稿ID> <版本> '{"title":"案例标题","fields":{}}' # 只更新公开正文（v8 各章字段 + system_usage/milestones）
csm-agent case export <草稿ID> [--out <文件路径>] # 导出 Word 文档（四章版式：目录/客户信息表/服务里程碑/配图），默认存当前目录
csm-agent case preview <草稿ID> <ONES父页面ID>
csm-agent case publish <草稿ID> <版本> <ONES父页面ID> <preview返回的批准哈希>
csm-agent weekly-report generate <CRM客户ID> [YYYY-MM-DD] [--force] [--wait] # 实施周报（客户版）：日期对齐周一，基于该客户本周全部信息生成四章节；--wait 实时打印生成进度
csm-agent weekly-report list/show <CRM客户ID|周报ID> # show 默认输出客户版 Markdown（与复制/Wiki 发布同源）；--json 查看含 source/stats 的完整内部证据
csm-agent weekly-report update <周报ID> <版本> '{"summary":"...","accomplishments":[],"next_week_plan":[],"risks":[]}'
csm-agent weekly-report preview <周报ID> <ONES父页面ID> # 客户版发布正文 + 内部信息警告 + 批准哈希
csm-agent weekly-report publish <周报ID> <版本> <ONES父页面ID> <preview返回的批准哈希>
csm-agent wiki spaces # ONES Wiki 页面组列表（发布位置层级选择器的数据源）
csm-agent wiki pages --space <页面组ID> [--parent <页面ID>] # 页面树，按 parentID 过滤
csm-agent sync [CRM客户ID]
csm-agent backup list # 备份归档列表（时间/大小/触发方式/包含内容）；服务在线附带最近备份 run 与下次调度时刻
csm-agent backup run # 立即全量备份（与每日 04:00 自动备份同一管线），完成后输出归档路径
csm-agent backup restore latest # 离线恢复：校验归档→停服务→现有数据移入 .restore-rollback-* 回滚目录→应用→重启服务；--db-only 只恢复数据库
csm-agent hemory sync [YYYY-MM-DD]
csm-agent hemory resegment --all | --recording <录音ID> # 全量重切 / 定向重切单条录音（分段失败逃生门）
csm-agent hemory jobs # 分段任务只读视图：attempts/status/error，排查录音卡最大重试
csm-agent hemory inbox [YYYY-MM-DD] [--days N] # 待归属片段；--from/--to 按上海时区收窄到当天时间段（需与日期同用）；consumed 列显示片段已被哪些类型的已写入草稿消费
csm-agent hemory inbox 2026-08-27 --from=14:00 --to=15:30
csm-agent hemory inbox --customer <客户ID或名称> --status confirmed # 按客户查看已归属片段（--status 默认 pending）
csm-agent hemory assign <客户ID或名称> <片段ID...> # 归属即触发后台草稿生成；--wait 轮询任务直到完成/失败
csm-agent hemory clear <片段ID...>
csm-agent hemory ignore <片段ID...>
csm-agent hemory regenerate <片段ID...> [--wait] # 按天强制重生成草稿：片段决定重建的「客户+上海日」，各天全部已确认片段参与，旧批次作废；已写入草稿消费过的片段不再被同类型重复提案
csm-agent hemory repair [--apply] # 存量孪生一次性修复：把重切前旧片段的人工归属/忽略按时间覆盖继承到当前待处理孪生片段，并回填转写基准让已处理完的录音跳过后续重切；默认 dry-run 只报告
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
csm-agent agent <CRM客户ID> "帮我提bug：导出报表时提示500，报错截图见附件" --attach ./报错截图.png
                                       # 贴图/聊天记录说「帮我提bug/需求」：agent 分析贴入内容生成
                                       # ONES 工作项待确认草稿，会话内 [y] 批准 / [e] 编辑后批准即回写
csm-agent agent <CRM客户ID> "结合已同步数据与最近三个月公开动态分析续约风险和增购机会"
csm-agent agent <CRM客户ID> "总结这份需求文档，并对比该客户现有建议" --attach ./需求说明.pdf
                                       # --attach 可重复；文本/PDF 注入上下文，图片要求视觉模型
                                       # （自定义端点先 config llm set ... --vision=on）
                                       # agent 运行中 Ctrl+C 会先停止服务端本轮对话再退出
csm-agent sessions [list] [--all] # 会话列表；--all 含已归档
csm-agent sessions show <会话ID> # 导出会话全文（标题 + 客户 + 时间 + 对话）
csm-agent sessions archive <会话ID> # 归档：从列表隐藏，可恢复
csm-agent sessions unarchive <会话ID>
csm-agent sessions stop <会话ID>  # 停止该会话进行中的对话（挂起中的确认草稿按拒绝处理）
csm-agent api GET /api/customers
```

案例编辑接口只接受标题和五段公开正文，`claim_evidence`、`context_snapshot`、`web_search`、`unknowns`、`coverage` 与客户绑定由服务端合并保留；编辑结果命中写回护栏（条目数失控/单条超长/内部信息残留/占位词）时响应附带非阻断 `warnings`。`case preview` 返回客户版正文、非阻断检查项与批准哈希；哈希同时绑定正文、目标页面、草稿版本和检查项摘要，任一变化都必须重新预览。`case publish` 以唯一请求哈希记录发布尝试，并发重复提交只会调用一次 ONES；ONES 未返回页面 ID 或调用中断时状态为 `unknown`，系统不会宣称已发布，须先到目标 Wiki 核对以避免重复页面。

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
- `~/.csm-agent/config/llm.user.yaml`：界面或全局 CLI 服务保存的模型配置。除内置服务商（DeepSeek/OpenAI/Anthropic/Moonshot/Groq）外，「设置」页支持两种自定义接入：「GLM Coding Plan（智谱）」预设一键带出官方 Coding Plan 端点与 `glm-5.3-flash`（本质是自定义 + OpenAI 兼容协议）；「自定义（OpenAI / Anthropic 兼容）」可接任意兼容端点——OpenAI 协议追加 `/chat/completions`（如 `https://relay.ones.pro/v1`），Anthropic 协议追加 `/v1/messages`（如智谱 Coding Plan 的 `https://open.bigmodel.cn/api/anthropic`，Claude Code 同款用法），在设置页选协议 + 填 Base URL + 模型 + API Key 即可。CLI 同口径：`csm-agent config llm` 查看、`csm-agent config llm set --provider=custom --model=<模型> --base-url=<端点> [--protocol=openai|anthropic] --api-key=<key>` 切换（如 GLM Coding Plan：`--base-url=https://open.bigmodel.cn/api/coding/paas/v4 --model=glm-5.3-flash --vision=on`）；保存前服务端会按所选协议向端点发一次真实流式请求验证连通，失败不落盘。API Key 只写入本地配置文件（0600），查询接口只返回是否已配置。视觉（图片输入）能力：内置服务商按模型目录自动判定；自定义端点无法探测，须在设置中勾选「支持图片输入（视觉模型）」或 `config llm set ... --vision=on` 声明——它是对话图片附件的放行前提，配置查询接口同时返回解析后的 `vision` 值。
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
- `POST /api/backup/run`（立即触发一次全量备份，返回 sync run 供轮询；备份已在进行中返回 409）、`GET /api/backups`（归档列表 + 最近备份 run + 下次调度时刻）
- `POST /api/customers/:id/opportunities/refresh`（强制重新分析增购机会：LLM 从会议录音片段+公开动态证据产出假设，数量不固定、按可信度排序；证据变化自动重析（24h 节流）+失败 1h 重试门在服务端，失败保留旧假设；`GET /api/customers/:id/overview` 的 opportunities 逐条附 sources 来源标注）
- `POST /api/hemory/sync`、`POST /api/hemory/resegment`、`GET /api/hemory/fragments`（支持 `since`/`until` ISO 时刻闭区间过滤，如 `since=2026-08-27T14:00:00+08:00`；`date` 仍为整天过滤，显式时间段同指定日期一样不受待归属 7 天窗口限制；`customer_id` 按客户过滤，配合 `status=confirmed` 查看某客户已归属片段）、`PUT /api/hemory/fragments/attribution`、`PUT /api/hemory/fragments/ignore`、`POST /api/hemory/fragments/regenerate`（按天强制重生成草稿，body `{eventIds}`，返回 `{jobs, days}` 与归属端点同形）、`POST /api/hemory/fragments/inherit`（存量孪生归属继承修复，body `{apply}`，默认 dry-run 返回逐录音修复计划）
- `GET /api/draft-batches`、`PATCH /api/draft-items/:id`、`POST /api/draft-batches/:id/preview`
- `POST /api/draft-batches/:id/confirm`、`POST /api/draft-batches/:id/regenerate`、`POST /api/draft-items/:id/retry`、`GET /api/draft-jobs?ids=`（生成任务状态；归属/重生成响应返回 jobId，失败任务不创建批次只能在此查询；任务行含 progress 进度文案，heretry/case/weekly 的孤儿 running（服务重启遗留、永不终结）带 stalled 标注——前端恢复轮询跳过、CLI `--wait` 按终态退出）、`GET /api/draft-jobs?status=failed&kind=hemory`（失败任务列表）、`GET /api/draft-jobs?status=active&kind=hemory`（全局在途任务，Web 刷新恢复横幅/CLI `draft jobs --active`；在途任务带 dateKey 装饰，孤儿 running 带 stalled 标注）
- `GET /api/action-items`、`PATCH /api/action-items/:id`、`POST /api/action-items/:id/complete`
- `GET /api/alerts?status=active|resolved|all`（风险预警名单，响应 `{alerts, counts}`，alert 含客户名称与触发原因明细；`GET /api/customers/:id/overview` 的 alerts 返回该客户待处理预警）、`POST /api/alerts/:id/resolve`（消除风险，body `{note}` 必填原因/动作、可带 `actor`；写审计；对非 active 预警返回 409）
- `POST /api/action-items/bulk-complete`（body `{ids}`，可带 `outcome`；逐项处理互不影响，返回 `{items:[{id,title,result,reason?,error?}]}`）
- `POST /api/case-drafts`、`PATCH /api/case-drafts/:id`、`POST /api/case-drafts/:id/publish`
- `GET /api/sessions`（默认剔除已归档；`?include=archived` 返回全量）、`PATCH /api/sessions/:id`（重命名 / 归档切换）、`GET /api/sessions/:id/export`（会话全文文本）

## 数据与安全边界

- CRM `_id` 是客户主键；CRM「客户名称」（`field_n1qN0__c__r`）或「售后客户名称」（`field_83f4l__c`）必须与 ONES「客户信息」选项精确且唯一匹配；未归属内容不会进入客户判断。
- Hemory MCP 当前只提供词法和时间窗口转写搜索，不返回 Hemory 页面中的原生摘要、话题或 section ID；CSM Agent 保存原始转写后使用当前配置的大模型生成自己的话题片段，页面会明确展示话题、摘要和可展开原文证据。
- Hemory 同步是滚动 7 天增量：自动（13:00/20:00）与手动同步都扫描最近 7 个上海自然日，已入库片段按外部 ID 去重、已归属/已忽略状态在重同步后保持。待归属列表默认只显示最近 7 天（`days=0` 关闭，指定日期、时间段或全部状态不受限），超过 7 天的片段不删除，可按日期找回。
- 片段支持「忽略」：忽略后不再出现在待归属列表、重同步也不会重新进入，可通过 `csm-agent hemory inbox --status ignored`（或 `--status all`）查看并通过「恢复」（清除归属语义）回到待归属。网页筛选面板只按日期/时间段过滤，打开时预填今天 00:00–23:59 的真实默认值（点「筛选」即按该整天过滤，可自行修改）；状态切换走「已归属」按钮，客户维度走客户详情或 CLI `--customer`。
- 片段按「事件级切片 v3.2」生成（合并优先）：主切割边界是业务对象变化，次边界是同一对象内明显独立的新请求/新决策流；同一对象/同一诉求的连续讨论（含原因、方案、细节澄清、演示、结论与后续安排）保持一个大片段——30 分钟录音通常 1~4 个片段、2 小时会议通常 5~8 个片段，单段一般不超过 100 条发言。同一事件被打断后再次出现时保留多个片段并共享话题组（`topicGroupId`，收件箱显示「同话题 m/n」）。低于门槛（3 条有效发言且合计 40 字）的段独立丢弃，不与相邻话题合并。
- `csm-agent hemory resegment --all` 对库内全部录音按当前分段版本全量重切：先 `VACUUM INTO` 备份数据库，逐录音成功即切换新代际（失败的录音保持旧片段，重跑命令收敛），与增量同步互斥。重切换代时，被取代片段的人工归属（确认含客户、忽略）按时间覆盖率自动继承到新片段（覆盖率不足视为真新内容保持待归属）；录音全部片段已处理完且转写相对上次成功分段未实质增长（新增 ≤2 行且结束时刻未后移超 60 秒）时跳过重切（分段 job 落 skipped 状态），转写实质增长则照常重切并继承。存量数据可用 `csm-agent hemory repair [--apply]` 一次性继承修复并回填转写基准（默认 dry-run 只报告）。旧片段停用但保留审计；切换到重新归属完成之间，客户证据与风险「客户声音」维度可能临时降级。超过 7 个上海自然日的录音，其待归属片段需用 `--days=N` 或日期过滤查看。
- 同一录音晚间出现新增转写时，Agent 基于完整新内容重新分段；只有最新成功的一代片段进入待归属（已处理时段的归属会被自动继承，不会重回收件箱）。旧片段和已写记录保留审计，旧片段关联的未写草稿会标记为失效，已写记录不改动；客户时间线与草稿再生只使用当前活跃代际的片段。已写入草稿的消费台账扩展到重切孪生：同录音时间高度重叠的活跃片段视为同类型已消费，不再被重复提案。
- 人工 Hemory 归属是唯一归属来源，后续当天全量重拉与同边界重切都不会冲掉 CSM 标记；重新归属会令未写出草稿失效，已写记录只保留审计提示，不自动反向修改 CRM/ONES。
- **数据备份**：服务每日 04:00（上海时区）自动全量备份，磁盘空间不足时跳过并记失败 run；服务重启错过槽位会在启动时补跑（当日已有成功备份则不重复）。备份内容为数据目录全量——SQLite 在线一致性快照（`VACUUM INTO`，WAL 安全）+ 会话（`sessions/`、`records.json`）+ 附件（`attachments/`）+ 配置（`config/*.user.yaml`、数据目录 `.env`，含密钥），打成单个 `backups/csm-backup-YYYYMMDD-HHMMSS.tar.gz` 归档（0600，含 manifest），磁盘保留最近 3 份、更旧自动删除（dataDir 根下重切前快照 `workbench-backup-*.sqlite` 纳入同一保留策略）。恢复走 `csm-agent backup restore`（离线命令）：先校验归档完整性（`PRAGMA quick_check`）与快照可读，再停止 launchd 服务（停后端口仍响应说明有手动 dev 进程持有数据，中止并不动数据）、把现有数据整体移入 `.restore-rollback-*` 回滚目录后应用归档并重启服务，恢复动作由服务启动时落 `backup_restore` 审计；`--db-only` 只恢复数据库。日志、`~/.mcp-auth` OAuth token、app 代码目录不在备份内（OAuth 恢复后需重新授权；代码由一键安装/升级体系还原）。保留 3 天意味着静默损坏超过 3 天将无法本地回滚，磁盘级灾难的兜底是 macOS Time Machine 等系统级备份。
- 沟通记录草稿的【话题】分节正文优先取生成模型对该片段的摘要（`sections`，每片段一条、忠于该片段自己的转写），缺失时回退分段器摘要、再回退转写原文；分节绝不重复同一段全天综述。工时草稿描述为当天一句话总结。
- ONES 工作项草稿宁缺毋滥，须同时满足语义判定与证据信号门控（门控检查证据片段的标题、分段摘要与转写）：**建议和反馈**仅当客户明确表达产品能力不满足（「标品还不支持」「希望支持/增加某功能」类诉求）；**工单**仅当客户明确指认缺陷（「这是个 bug」「不符合预期」类表述）；**运维工单**最谨慎，仅当明确提出运维操作请求（环境重装/数据迁移/配置/证书/服务器等基础设施操作）。方案讨论、workaround、客户内部流程、商务付费话题、泛泛不满一律不建工作项——相关内容保留在沟通记录与待办里。
- 转写由语音识别生成，产品名 ONES 常被误转为发音相近的词（万死、万斯、万四、vans 等）。草稿、实施周报与交互式 Agent 回写的生成提示词均内置近音词规则：凡上下文指代产品之处一律优先理解为并写作 ONES（引用客户原话时同样订正，ONES 工作项的所属产品/所属模块按对应产品线归类）；仅当上下文明确指向其他事物（如人名）时保留原词。片段收件箱与时间线中的分段摘要不做此订正（改分段摘要需升分段版本全量重切）。
- “需求”草稿写入 ONES Desk「建议和反馈」；工单写入 ONES Desk「工单」；二者都必须绑定客户字段 `JrvswW8P`。工时只写当前客户已绑定的售后客户工作项，写工具按 ONES 实例工时模式（`get_manhour_mode`）精确绑定为 `add_workhour_in_simple_mode` / `add_workhour_in_summary_mode`，参数带上海时区偏移的 `startTime`；沟通记录必须绑定 CRM `_id`；沟通记录的服务开始/结束时间取当天未发布沟通的首尾时刻。ONES/CRM 的业务失败（ONES `result:"FAIL"`、CRM `save_status` 未落库）都会把草稿置为 `failed` 并可单独重试。
- ONES 案例发布需要 `ONES_CASE_PARENT_PAGE_ID`，或由 CSM 在发布预览时提供父页面 ID。
- 实施周报（客户详情「实施周报」tab）是**客户版项目周报**：正文经 CSM 编辑确认后可直接复制或发布给外部客户。按周一~周日自然周（上海时区）基于该客户本周全部信息（Hemory 片段、建议/工单/运维工单、私有云实例、工时、CRM 跟进、行动事项、风险评级）生成四章节（本周工作概览/本周关键进展/下周工作计划/风险与待协调事项）：①② 章围绕项目成果、已确认结论与里程碑归并（同一事项多次沟通只留一条合并进展，不逐场复述会议流水）；③ 章为客户可确认的计划（含时间节点、责任方与预期结果）；④ 章以【风险】【阻塞】【待确认】前缀输出客观、可行动的风险条目——不隐藏真实风险，但正文禁止出现内部统计（沟通场次/工时/工单数）、风险评级评分、客户情绪判断与 Hemory/CRM 等内部证据。内部证据与正文分离：`source`（每条内部依据）与 `stats`（代码确定性统计：沟通按录音场数、工作项按「本周有更新」聚合去重、「解决」为快照近似口径）完整保留在数据库与 `--json`/编辑界面中供审核追溯，工作台展示时标记「内部统计（不随客户版内容复制或发布）」；客户版 Markdown 由服务端 `renderWeeklyMarkdown` 唯一渲染，Web 复制、Wiki 发布正文与 CLI 默认输出三端同源。发布前对正文做内部信息残留检测（历史周报正文可能残留旧版内部措辞），命中时在确认弹窗与 CLI preview 中给出非阻断警告。生成失败任务显式报错并支持一键再次生成（不受指纹幂等短路）。周报按周持久保存（每周一条、版本递增），周报卡片上方提供周下拉切换历史周（与顶部日期选择器双向同步，任意日期自动对齐周一）；「重新生成」期间旧版本卡片标记「重新生成中」并禁用全部操作，进度条持续可见，完成后自动刷新（生成期间切换到其他周不打扰）。服务重启遗留的孤儿 running 任务由服务端标注 stalled：重开页面不再收编（不锁「生成」按钮），失败卡引导「再次生成」。发布到 ONES Wiki 走 `preview → 确认 → publish` 参数哈希审批门（哈希锚定最终客户版发布参数，内容变化后旧批准哈希失效），父页面通过页面组→页面树层级选择器选取（案例发布同款选择器，手填页面 ID 保留为兜底）。
- ONES Wiki 只读浏览（`csm-agent wiki` / `GET /api/ones-wiki/*`）经 ONES MCP `search_for_spaces` / `get_list_of_space_pages` 实现，结果缓存 5 分钟。
- 当前 ONES MCP 没有 Desk 专用工具，Desk 数据通过 ONESQL 按项目、工作项类型和「客户信息」字段读取。
- Mac `.app` 仍是本地 WKWebView 壳。页面内所有确认/提示/输入对话框（草稿确认、重新生成、忽略归属、案例发布等）使用自绘 modal，不依赖原生 `confirm()/alert()/prompt()`（WKWebView 未实现 JS 对话框面板时它们会静默失败）。文件下载（案例导出 Word 等 `<a download>`）由壳的 WKDownloadDelegate 接管，经 NSSavePanel 让用户选择保存位置（未实现该委托链时 WKWebView 会把下载静默丢弃）；浏览器访问时 Chrome/Edge 走 File System Access `showSaveFilePicker` 选位置，其余环境落默认下载目录。

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
