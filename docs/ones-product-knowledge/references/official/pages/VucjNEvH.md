# Jira 迁移工具介绍

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/VucjNEvH
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 数据迁移 / Jira数据迁移 / 迁移至 ONES 私有部署 / Jira 迁移工具介绍
Evidence: documentation, not runtime verification

## Jira 迁移工具介绍

## 1 介绍

如果你正在使用 Jira，并想将数据转移到 ONES 环境中，Jira 迁移工具可以帮助你实现这一目标。

Jira 迁移工具支持迁移 Jira Software Server、Data Center 以及 Cloud 服务中的用户、项目、迭代、权限和问题等 Jira 数据，还支持以下自定义迁移操作：

- 用户

- 选择部分项目迁移

- 问题类型

- 问题属性和项目属性

## 2 Jira 迁移工具支持的范围

 Jira迁移工具支持以下范围

- 支持 Jira Software Server/Data Center、Jira Software Cloud 迁移至 ONES Server。

- 支持Jira 7.x 、8.x、9.x（Server）版本的数据迁移。

- 如果你的团队在 500 人以内， Jira 系统内 Issue 数量为 50 万以内，我们建议通过该工具进行迁移。如果你的 Jira 用量超出此范围，为了保障你的数据安全、提高迁移成功率，请联系 ONES 售后服务团队（联系方式：400-188-1518）。

 建议的浏览器及版本

- Edge >=88

- Firefox >=78

- Chrome >=87

- Safari >=14

## 3 Jira迁移工具能力介绍

### 3.1 迁移评估模式

通过提供你所需要评估的 Jira 数据包，即可生成 Jira 迁移评估报告，评估你的 Jira 数据迁移至 ONES 环境后的效果。

### 3.2 迁移 Jira 数据模式

正式迁移 Jira 数据，支持自定义用户、项目、问题等数据的迁移规则。

### 3.3 术语表

| 序号 | 术语 | 解释 |
| --- | --- | --- |
| 1 | 迁移效果 | 用来评估 Jira 数据迁移到 ONES 环境后的迁移效果 |
| 2 | 支持迁移 | 迁移效果的一种，指 Jira 数据或功能能够完全迁移至ONES环境中 |
| 3 | 兼容迁移 | 迁移效果的一种，指 Jira 数据或功能能够部分迁移至ONES环境中，可能是数据格式兼容，或是无法完全承接Jira侧的功能。 |
| 4 | 不支持自助迁移 | 迁移效果的一种，在 Jira 迁移工具中不支持用户自助迁移此 Jira 数据，如需迁移此类数据，请联系 ONES 售后服务团队（联系方式：400-188-1518）。 |
| 5 | 迁移操作 | 选择 Jira 数据如何迁移至 ONES 环境中。 |
| 6 | 创建 | 迁移操作的一种，指 Jira 数据以创建的形式迁移至 ONES 环境中。 |
| 7 | 映射 | 迁移操作的一种，指 Jira 数据映射为当前 ONES 环境中的已有数据。 |
| 8 | 更新 | 用户迁移操作的一种，指 Jira 异常用户中可以更新用户邮箱，更新为有效且唯一的邮箱地址。 |
| 9 | 合并 | 用户迁移操作的一种，指 Jira 重复邮箱用户中可以合并为唯一的用户迁移至ONES 环境中。 |
| 10 | 取消迁移 | 迁移操作的一种，指取消迁移该 Jira 数据及其对应的业务数据。 |
| 11 | 迁移状态 | 在解析 Jira 备份包中显示 ONES 团队是否有曾经迁移过 Jira 。 |
