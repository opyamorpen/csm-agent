# Jira 迁移工具：评估迁移效果模式

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/BsRSbSJR
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 数据迁移 / Jira数据迁移 / 迁移至 ONES 私有部署 / Jira 迁移工具：评估迁移效果模式
Evidence: documentation, not runtime verification

## Jira 迁移工具：评估迁移效果模式

## 1 评估迁移效果

对于每次迁移，我们建议你先通过工具的「评估迁移效果」模式，评估你的 Jira 备份包迁移至 ONES 环境后的效果。仅需要提供 Jira 备份包，即可生成评估报告。在评估迁移报告中：

- 展示 Jira 备份包整体迁移效果，如用户、用户组、项目等。

- 展示具体项目、问题类型、属性、用户等迁移效果

- 评估你的 Jira 系统中是否存在异常用户

[image: image - 2024-05-06T171235.213.png; see source page]

评估迁移效果图示

## 2 评估报告模式步骤

### 2.1 上传备份包

- 在评估迁移效果前，请确保你在 Jira 系统中已经备份 Jira 数据。[了解如何备份 Jira 系统](https://confluence.atlassian.com/adminjiraserver/backing-up-data-938847673.html)

- Jira 迁移工具高级版：

  - 工具内无配置路径页面：根据工具内指引可在 Jira 系统中找到 Jira 备份包的储存路径。校验路径后，可以选择需要评估的 Jira 备份包。

  - 工具内已配置路径页面：无需配置路径，直接可以选择需要评估的 Jira 备份包。如果你需要重新配置路径，需要重新部署工具。

### 2.2 下载评估报告

解析完备份包后，工具将会生成迁移报告，建议你下载迁移报告，查看报告内迁移效果后再进行 Jira 数据迁移。

## 3 怎么阅读评估报告

### 3.1 整体迁移评估效果

工具将帮你整体评估一下功能模块的迁移效果，需要注意的是：

- 权限点指 Jira 项目内、系统全局的权限点

- Jira 插件暂不支持迁移，如果你需要迁移 Jira 插件及其对应业务数据，请联系 ONES 售后服务团队（联系方式：400-188-1518）。

### 3.2 项目

项目评估效果中，将帮你具体评估你的 Jira 备份包内所有项目的迁移效果，Jira 迁移工具仅支持迁移 Jira software 项目，即项目类型为 “software”“business” 的 Jira 项目。因此其他项目类型，如 Jira service management 的项目将不支持自助迁移。

### 3.3 问题类型

- Jira 迁移工具仅支持迁移  Jira Software 下的问题类型，如：Story、Bug、Task 等。其他 Jira 产品中的问题类型，如 Service request 等问题类型将不支持自助迁移。

- 由于 Jira 备份包中无法识别 Jira 问题类型的所属产品，因此在评估报告中无法显示具体问题类型是否支持迁移。在「迁移 Jira 数据」模式中，将会自动过滤不支持迁移的 Jira问题类型。

### 3.4 属性

属性评估效果中，将帮你具体评估问题属性、项目属性的迁移效果。

### 3.5 用户

用户评估效果中，将帮你识别：

- 是否存在已迁移的用户

- 是否存在异常用户

  - 邮箱地址无效：邮箱地址不完整，邮箱地址为空，邮箱地址包含中文字符等。

  - 邮箱地址重复：邮箱地址在 Jira 侧重复。注意，邮箱地址不区分大小写，即 test@ones.com ; Test@[ones.com](https://ones.com/)将视为相同邮箱地址。

-  如果你的 Jira 系统中存在异常用户，建议您在 Jira 侧更新有效的、唯一的用户邮箱地址（如：validemail@[ones.cn](https://ones.cn/) ）或在 Jira 迁移工具的「迁移 Jira 数据」模式中修正用户信息。

### 3.6 其他数据

其他数据评估效果中，将包含权限、通知方案、系统设置等数据的迁移评估效果。此部分数据的迁移操作将默认处理，在「迁移 Jira 数据」模式中，用户不可以自定义此部分数据的迁移操作。
