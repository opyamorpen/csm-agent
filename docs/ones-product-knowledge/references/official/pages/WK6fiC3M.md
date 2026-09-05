# 报表

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/WK6fiC3M
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 工时管理 / 资源管理 / 报表
Evidence: documentation, not runtime verification

## 报表

ONES为你提供了 登记工时报表，你可以使用这些数据量化了解你的团队的工时投入明细与总览。另外，你可以将这些数据导出，以备后用，为项目优先级、资源分配和总体战略制定提供量化数据支持。

## 报表可查看工时数据范围

受“查看项目权限”与“成员权限配置”影响

- 查看项目权限：仅可查看拥有“查看项目”权限的项目下的工时数据

- 成员权限配置：支持配置成员可查看的工时数据范围

[image: _BZHF2ULz; see source page]

-

## 报表配置

基础配置

- 时间范围：仅支持查看一年内的工时数据

- 成员范围：支持按用户组、部门、成员筛选

- 时间维度：支持“按天查看”、“按周查看”、“按月查看”

- 排序：当前仅支持按“合计工时”条件排序

- 筛选：筛选条件支持部分工时属性、工作项属性等

[image: image.png; see source page]



数据结构

- 支持按不同层级对工时数据进行分层展示，可支持设置工作项与工时的“所属项目、工作项、成员”等菜单类属性（见下图）

- 最多可配置 5个层级，允许不设置任何层级

[image: _6offEdi4; see source page]

[image: image.png; see source page]



表头属性配置

可配置属性包含“登记工时属性”、“工作项属性”等

[image: image.png; see source page]



数据同步机制 & 性能问题

报表数据每半小时同步一次，可点击刷新重新同步数据

报表一次最多只能查看 30W 条工时数据，若超出数量，则会有相关报错提示，需要重新调整报表配置，缩小查看数据的范围

[image: image.png; see source page]
