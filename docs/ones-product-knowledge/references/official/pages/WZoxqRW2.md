# MCP 服务概述

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/WZoxqRW2
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES AI 智能助手 / MCP 服务与外部集成 / MCP 服务概述
Evidence: documentation, not runtime verification

## MCP 服务概述

### 什么是 MCP

MCP（Model Context Protocol）是一个开放的通信标准，用于连接 AI 应用与外部数据源和工具。ONES 基于 MCP 协议发布了 60+ 工具，覆盖项目管理、知识库、测试管理和账号信息等模块。任何支持 MCP 协议的客户端都可以通过标准化的方式接入 ONES 平台能力。

### 获取 MCP 服务器地址

在 ONES 中进入 个人中心 > 已授权 MCP 客户端，页面上会显示你所在团队的 MCP 服务器地址。点击地址旁的复制按钮即可获取。

如果你尚未授权过任何客户端，页面会显示空状态提示，并附带服务器地址和「了解更多」的跳转入口。

### 授权流程

MCP 客户端首次连接 ONES 时，会触发 OAuth 授权流程。该流程基于你的个人身份完成授权，确保客户端只能访问你本人有权限查看和操作的数据。

#### 第一步：发起授权

在 MCP 客户端中配置好 ONES 服务器地址后，客户端会自动打开浏览器跳转至 ONES 授权页面。页面顶部显示授权方向：从 ONES 授权到 MCP CLI Proxy。

#### 第二步：选择授权范围

授权页面中会列出所有可授权的权限范围，按操作类型分为 9 个类别：

- 读取项目管理数据（6 项）：访问项目、工作项、工作项类型、工作项属性、工作项评论、工时等数据

- 读取知识库管理数据（2 项）：访问知识空间和页面内容

- 读取账号管理数据（1 项）：访问当前用户信息

- 创建项目管理数据（4 项）：创建项目、创建工作项、发布工作项评论、创建工时

- 创建知识库管理数据（1 项）：创建知识库页面

- 更新项目管理数据（4 项）：更新项目和工作项信息

- 读取测试管理数据（2 项）：访问测试用例库和测试用例

- 创建测试管理数据（2 项）：在测试用例库中创建用例

- 更新测试管理数据（2 项）：更新测试用例信息

每个类别前有复选框，你可以根据实际需要勾选或取消。建议首次授权时保持全部勾选，以获得完整的工具能力。确认后点击页面底部的授权按钮完成授权。

授权范围决定了 MCP 客户端可以调用哪些工具。例如，如果取消勾选「创建项目管理数据」，客户端将无法使用创建工作项、记录工时等工具。

### 管理已授权客户端

授权完成后，你可以在 个人中心 > 已授权 MCP 客户端 页面查看和管理所有已授权的客户端。

#### 已授权列表

页面顶部显示 MCP 服务器地址（可复制），下方的列表展示所有已授权的客户端，每个条目包含以下信息：客户端名称、所属组织、授权时间、上次活跃时间，以及「查看」操作入口。

#### 查看授权详情

点击列表中的「查看」进入授权详情页，展示该客户端的完整信息：客户端名称、生效团队、当前授权范围列表、创建时间和上次活跃时间。页面底部提供取消授权按钮，页面右上角提供修改授权范围入口。

#### 修改授权范围

点击修改授权范围会弹出弹窗，展示与初次授权时相同的权限分组。展开某个分组后可以看到该分组下的具体权限项。例如展开「创建项目管理数据（4）」可以看到：

- create:project.project — 创建项目

- create:project.issue — 创建工作项

- create:project.issueComment — 发布工作项评论

- create:project.workhour — 创建工时

你可以按需开启或关闭单项权限，修改后点击保存生效。

如果你不再使用某个 MCP 客户端，建议及时取消授权以降低数据暴露风险。取消授权后，该客户端将立即失去对 ONES 数据的访问能力。

### 可用工具一览

ONES MCP 服务当前发布了 60+ 工具，覆盖项目管理、知识库、测试管理、账号与通知、技能管理等模块。以下为完整工具清单。

#### 项目管理 — 工作项

| 工具名称 | 说明 |
| --- | --- |
| create_new_issue | 创建工作项 |
| update_issue | 更新工作项 |
| execute_issue_workflow | 执行工作项工作流 |
| find_similar_issues | 查找相似工作项 |
| get_issue_details | 获取工作项详情 |
| get_issue_activities | 获取工作项动态 |
| get_issue_code_info | 获取工作项代码关联信息 |
| get_issue_fields | 获取工作项字段 |
| get_issue_status | 获取工作项状态信息 |
| get_issue_executable_workflows | 获取工作项工作流 |
| get_issue_type_hierarchy_configs | 获取工作项层级配置 |
| get_list_of_issue_comments | 获取工作项评论 |
| post_issue_comment | 发表工作项评论 |
| update_issue_comment | 更新工作项评论 |
| search_for_issue_types | 查找工作项类型 |
| search_for_issue_field_options | 查找工作项选项字段信息 |
| query_issues_by_onesql | 进行 ONESql 查询 |
| get_onesql_grammar_help | 获取 ONESql 语法帮助 |

#### 项目管理 — 项目、迭代与组织

| 工具名称 | 说明 |
| --- | --- |
| create_new_project | 创建项目 |
| update_project_by_project_id | 更新项目信息 |
| get_project_details_by_project_id | 获取项目详情 |
| search_for_projects | 查找项目 |
| add_project_members | 添加项目成员 |
| create_sprint | 创建迭代 |
| get_sprint_details | 获取迭代详情 |
| search_for_sprints | 查找迭代 |
| update_sprint | 更新迭代 |
| search_for_epics | 查找史诗 |
| search_for_modules | 查找模块 |
| search_for_releases | 查找发布 |

#### 项目管理 — 工时

| 工具名称 | 说明 |
| --- | --- |
| add_workhour_in_simple_mode | 新增工时登记（简单模式） |
| add_workhour_in_summary_mode | 新增工时登记（汇总模式） |
| update_workhour_in_simple_mode | 更新已登记工时（简单模式） |
| update_workhour_in_summary_mode | 更新已登记工时（汇总模式） |
| get_manhour_list_in_simple_mode | 获取工时列表（简单模式） |
| get_manhour_list_in_summary_mode | 获取工时列表（汇总模式） |
| add_manhour_estimated_in_summary_mode | 新增预估工时 |
| update_manhour_estimated_in_summary_mode | 更新预估工时 |
| set_manhour_estimated_in_simple_mode | 设置预估工时 |
| set_manhour_remaining_in_simple_mode | 设置剩余工时 |

#### 知识库

| 工具名称 | 说明 |
| --- | --- |
| create_page | 创建页面 |
| get_page_details | 获取页面详情 |
| get_page_changes | 获取页面修改历史 |
| get_page_attachment_text | 获取页面附件对应的文本 |
| get_list_of_space_pages | 获取页面列表 |
| get_space_details | 获取页面组详情 |
| get_favorite_or_watch_pages | 获取收藏或关注的页面 |
| search_for_spaces | 搜索页面组 |
| search_pages_by_title | 按标题搜索页面 |
| search_for_references_in_wiki | 搜索相关页面与附件 |

#### 测试管理

| 工具名称 | 说明 |
| --- | --- |
| create_new_testcase_in_library | 创建测试用例 |
| get_testcase_details | 获取测试用例详情 |
| get_testcase_library_fields | 获取测试用例库字段 |
| update_testcase | 更新测试用例 |
| search_for_testcase_libraries | 查找测试用例库 |
| search_for_testcases_in_library | 查找测试用例 |
| create_module_in_testcase_library | 创建测试用例库模块 |
| search_for_modules_in_testcase_library | 查找测试用例库模块 |
| update_module_in_testcase_library | 更新测试用例库模块 |

#### 账号与通知

| 工具名称 | 说明 |
| --- | --- |
| search_for_users | 搜索成员 |
| get_user_notices | 获取用户通知 |

#### 技能管理

| 工具名称 | 说明 |
| --- | --- |
| create_skill | 创建技能 |
| read_skill | 读取技能 |
| update_skill | 更新技能 |
| delete_skill | 删除技能 |

#### 通用

| 工具名称 | 说明 |
| --- | --- |
| search_external_web | 搜索 Web 页面 |
