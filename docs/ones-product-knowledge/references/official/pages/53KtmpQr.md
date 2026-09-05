# 流水线集成

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/53KtmpQr
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / DevOps工具链 / 流水线集成
Evidence: documentation, not runtime verification

## 流水线集成

## 1.应用能力简介

目前「流水线集成」应用，支持集成Jenkins服务。Jenkins服务集成到ONES后，支持以下功能点：

- 一级导航【流水线管理】页面支持查看服务器下的Jenkins流水线信息，包括运行状态，运行步骤、日志等内容。目前支持同步到ONES的Jenkins任务类型如下：

  - 流水线

  - 多分支流水线

  - 文件夹

  - 自由风格

- 在项目中内置了「流水线」组件，支持将流水线与Project中的项目关联

- 迭代内置「流水线运行」组件，自动关联、同步和迭代名称匹配的分支流水线信息

目前「流水线集成」应用暂只支持关联 Jenkins 流水线，详细操作见以下 Jenkins 关联手册

[Jenkins 关联](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Uc9agrNW)

## 2.权限管理

在团队权限配置中，可以配置「流水线集成」应用的管理员。「流水线集成」应用的管理员可以管理、删除流水线管理页面下的流水线，同时可以更改「流水线集成配置」的全局设置。

[image: image - 2024-05-06T151700.472.png; see source page]

在每条流水线的「流水线设置」页面中，可以配置除「流水线集成」管理员之外的成员，查看和管理某一条流水线的权限。

[image: image - 2024-05-06T151702.175.png; see source page]
