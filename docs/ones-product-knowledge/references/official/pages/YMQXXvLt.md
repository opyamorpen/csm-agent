# Jira数据迁移

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/YMQXXvLt
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 数据迁移 / Jira数据迁移
Evidence: documentation, not runtime verification

## Jira数据迁移

## 1 功能介绍

### 1.1 迁移至 ONES 私有部署

- 在部署 Jira 的服务器中安装 Jira 迁移工具高级版

- 从 Jira 系统中备份数据包

- 使用 Jira 迁移工具高级版迁移至 ONES

## 2 Jira 数据迁移清单

下列表格为 Jira 数据迁移清单的总体迁移效果。

如需获取具体迁移效果，可下载以下附件查看：

[file-list: _0p1qet29; see source page]

[image: 7ceJ6HaKud-ZAC7gg5IKjzDf-5ZisHrxhhqkThCeYFg.png; see source page]

Jira 数据迁移清单图示

迁移后权限将以 Jira 的配置为准。

| 类型 | Jira 数据或配置 | ONES 数据或配置 | 同步情况 | 备注 |
| --- | --- | --- | --- | --- |
| 用户管理 | 用户（Users） | 用户 | 支持迁移 | 用户名、邮箱、所属用户组、所属项目角色 |
| 用户管理 | 用户组（Groups） | 用户组 | 支持迁移 | 用户组名称、包含哪些用户 |
| Jira 设置-系统、插件 | 项目角色（Project Role） | - | 支持迁移 | 用户组名称 |
| Jira 设置-系统、插件 | 全局权限（Globe Permission） | 团队权限 | 兼容迁移迁移 | 详见数据迁移清单 |
| Jira 设置-系统、插件 | 用户邮箱可见性（User email visibility） | - | 不支持自助迁移 |  |
| Jira 设置-系统、插件 | 用户界面（User Interface） | - | 不支持自助迁移 |  |
| Jira 设置-系统、插件 | 筛选器（Filters） | - | 不支持自助迁移 |  |
| Jira 设置-系统、插件 | 仪表盘（Dashboards） | - | 不支持自助迁移 |  |
| Jira 设置-系统、插件 | 插件（Add-ons） | - | 不支持自助迁移 |  |
| Jira 项目数据及配置 | 项目名称（Project Name） | 项目名称 | 支持迁移 |  |
| Jira 项目数据及配置 | 项目负责人（Project Lead） | 项目负责人 | 支持迁移 |  |
| Jira 项目数据及配置 | 项目类型（Project Type） | 项目属性-单选菜单 | 支持迁移 |  |
| Jira 项目数据及配置 | 项目分类（Project Category） | 项目属性-单选菜单 | 兼容迁移 |  |
| Jira 项目数据及配置 | 项目角色（Project Roles） | 项目-成员 | 兼容迁移 | ONES 项目角色不支持分配用户组，因此 Jira 项目组包含的用户组将被展开成用户。即 ONES 项目-成员取 JIRA 项目角色中包含的用户和用户组包含的成员 |
| Jira 项目数据及配置 | 项目成员（Project Users） | 项目-成员 | 支持迁移 |  |
| Jira 项目数据及配置 | 迭代（Sprint） | 迭代 | 支持迁移 |  |
| Jira 项目数据及配置 | 版本（Release） | 发布 | 支持迁移 | 迁移为 ONES-发布工作项类型 |
| Jira 项目数据及配置 | 模块（Component） | 工作项属性-所属模块 | 支持迁移 |  |
| Jira 项目数据及配置 | 项目筛选器（Filters） | - | 不支持自助迁移 |  |
| Jira 项目数据及配置 | 报表（Reports） | - | 不支持自助迁移 |  |
| Jira 项目数据及配置 | 问题类型配置（Issue Type Scheme） | 项目-工作项类型配置 | 支持迁移 | ONES 侧没有方案概念，Jira 侧全局的工作项类型将迁移至 ONES，同时应用到不同项目中 |
| Jira 项目数据及配置 | 字段配置（Field Configuration） | 项目-工作项属性 | 兼容迁移 | 迁移效果同字段（Field）；此外不支持自助迁移同步字段属性、默认值和是否必填 |
| Jira 项目数据及配置 | 页面配置（Issue Type Screen Scheme） | 配置中心-视图配置 | 兼容迁移 |  |
| Jira 项目数据及配置 | 工作流配置（Workflow Scheme） | 工作流 | 兼容迁移 | 支持迁移工作流状态和步骤，暂不支持迁移触发器、条件验证、验证器和后续动作 |
| Jira 项目数据及配置 | 问题安全等级（Issue Security Scheme） |  | 不支持自助迁移 |  |
| Jira 项目数据及配置 | 权限配置（Permission Schemes） | 项目-权限配置 | 兼容迁移 | 详见数据迁移清单 |
| Jira 项目数据及配置 | 通知配置（Notification Schemes） | 项目-工作项通知 | 兼容迁移 | 详见数据迁移清单 |
| JIRA 问题配置 | 问题类型（Issue Type） | 配置中心-工作项类型 | 兼容迁移 | Jira 全局配置里的 Issue Type 会被处理成包含属性、工作流、权限、通知的 ONES 工作项类型；jira迁移工具支持映射ONES已有工作项类型 |
| JIRA 问题配置 | 字段（Field） | 配置中心-工作项属性 | 兼容迁移 | 详见数据迁移清单 |
| JIRA 问题配置 | 状态（Statuses） | 配置中心-状态 | 支持迁移 |  |
| JIRA 问题配置 | 优先级（Priorities） | 配置中心-优先级 | 支持迁移 |  |
| JIRA 问题配置 | 问题链接（Issue linking） | 配置中心-关联关系 | 支持迁移 |  |
| JIRA 问题配置 | 处理结果（Resolution） | 配置中心-多选菜单属性 | 兼容迁移 |  |
| JIRA 问题配置 | 时间跟踪配置（Time Trackin） | 配置中心-工作日设置 | 不支持自助迁移 |  |
| JIRA 问题数据 | 问题属性 | 工作项属性 | 兼容迁移 | 详见数据迁移清单 |
| JIRA 问题数据 | ID | 工作项 ID | 支持迁移 |  |
| JIRA 问题数据 | 所属项目（Project） | 所属项目 | 支持迁移 |  |
| JIRA 问题数据 | 问题类型（Issue Type） | 工作项类型 | 支持迁移 |  |
| JIRA 问题数据 | 概要（Summary） | 标题 | 支持迁移 |  |
| JIRA 问题数据 | 状态（Status） | 状态 | 支持迁移 |  |
| JIRA 问题数据 | 优先级（Priority） | 优先级 | 支持迁移 |  |
| JIRA 问题数据 | 迭代（Sprint） | 所属迭代 | 支持迁移 |  |
| JIRA 问题数据 | 描述（Description） | 描述 | 支持迁移 |  |
| JIRA 问题数据 | 修复的版本（Fix Version/s） | 工作项属性-关联工作项属性（自定义） | 支持迁移 |  |
| JIRA 问题数据 | 影响版本（Affects Version/s） | 工作项属性-关联工作项属性（自定义） | 支持迁移 |  |
| JIRA 问题数据 | 等级（Rank） | 工作项属性-单行文本 | 支持迁移 |  |
| JIRA 问题数据 | 标签（Labels） | 标签 | 支持迁移 |  |
| JIRA 问题数据 | 模块（Component） | 所属模块 | 支持迁移 |  |
| JIRA 问题数据 | 解决结果（Resolution） | 工作项属性-单选菜单 | 支持迁移 |  |
| JIRA 问题数据 | 创建者（Creator） | 创建者 | 支持迁移 |  |
| JIRA 问题数据 | 经办人（Assignee） | 负责人 | 支持迁移 |  |
| JIRA 问题数据 | 报告人（Reporter） | 工作项属性-单选成员 | 兼容迁移 |  |
| JIRA 问题数据 | 表决（Votes） | 工作项属性-数字 | 兼容迁移 |  |
| JIRA 问题数据 | 关注者（Watchers） | 关注者 | 支持迁移 |  |
| JIRA 问题数据 | 创建时间（Date Created） | 创建时间 | 支持迁移 |  |
| JIRA 问题数据 | 更新时间（Date Updated） | 更新时间 | 支持迁移 |  |
| JIRA 问题数据 | 到期日期（Due Date） | 截止日期 | 支持迁移 |  |
| JIRA 问题数据 | 附件（Attachments） | 工作项附件 | 支持迁移 |  |
| JIRA 问题数据 | 链接的问题（Issue Links） | 关联工作项 | 支持迁移 |  |
| JIRA 问题数据 | 子任务（Sub-Tasks） | 子任务 | 支持迁移 |  |
| JIRA 问题数据 | 动态-历史记录（History） | 动态-文件、关联、变更记录 | 兼容迁移 | 详见数据迁移清单 |
| JIRA 问题数据 | 动态-备注（Comments） | 动态-工作项评论 | 兼容迁移 | 详见数据迁移清单 |
| JIRA 问题数据 | 工时（Estimated、Logged） | 工时 | 兼容迁移 | 详见数据迁移清单 |
