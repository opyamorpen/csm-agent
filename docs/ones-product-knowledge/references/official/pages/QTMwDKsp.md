# 企业用户目录同步

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/QTMwDKsp
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 了解账号集成 / 企业用户目录同步
Evidence: documentation, not runtime verification

## 企业用户目录同步

## 1.概述

如果你的团队正在使用身份管理服务、企业级IM工具或者 OA 系统管理团队用户目录，你可以将用户目录同步到系统以便统一管理、降低成本。将用户目录同步到 ONES 可以有以下好处：

1. 快速将需要使用系统的团队成员加入到系统中，帮助团队成员更快的启用系统；

2. 统一管理团队的组织架构与用户信息，保持系统间用户信息一致；

3. 统一管理账号生命周期，降低管理员维护多个系统的成本；

基于用户目录同步下的账号生命周期管理：

[image: image (16).png; see source page]

## 2.同步数据

用户目录同步数据主要包含两种数据：用户信息、企业组织架构信息；

### 2.1 用户信息

用户信息通过「同步成员属性」建立映射关系，建立映射关系的属性将保持与同步数据源一致，且在系统内不可手动编辑。

[image: image (17).png; see source page]

目前可供建立映射关系的系统用户属性包括：

| 属性名 | 数据格式 | 长度限制 |
| --- | --- | --- |
| 用户名 | 字符串 | 64 |
| 公司名称 | 字符串 | 128 |
| 职位 | 字符串 | 16 |
| 工号 | 字符串 | 128 |

### 2.2 企业组织架构信息

系统将从企业用户目录服务获取组织架构部门信息，最后在系统团队组织架构中以树状结构展示。

[image: _nlx6RviQ; see source page]

## 3.系统支持的企业用户目录服务

系统支持以下服务作为「用户目录同步数据源」：

注意：系统仅支持从单个数据源同步用户目录

| 用户目录服务 |
| --- |
| [LDAP](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/7kgu26Pt) |
| [AD](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Ut5d8BM7) |
| [钉钉](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/TDCogFi4) |
| [企业微信](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Dp1AfNq7) |
| [飞书](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/5tQvsrBe) |
| [标准 API](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/DoMTfHzz) |

## 4.用户目录同步机制

系统支持以下3种机制同步用户目录：

1. 自动定时同步：指系统周期性的自动从「用户目录同步数据源」拉取最新的用户目录数据到系统；

2. 手动同步：指管理员可以通过系统界面上的「同步」按钮，手动触发拉取最新用户目录数据到系统；

3. 变更通知触发同步：指某些服务支持将用户目录变更推送到系统，系统收到通知后拉取更新的用户目录数据；

注：不同用户目录服务支持的同步机制有所不同，详情请参考各集成说明
