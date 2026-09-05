# 代码集成

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/CCkd8s9i
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / DevOps工具链 / 代码集成
Evidence: documentation, not runtime verification

## 代码集成

## 1.应用能力

目前「代码集成」应用，支持集成 GitHub、GitLab、私有 GitLab、SVN、私有 Bitbucket 等类型的代码仓。仓库集成到ONES后，支持以下功能点：

- 支持关联代码提交信息到工作项详情

- 迭代概览中支持展示代码提交次数、提交趋势、影响行数的统计图标

- 迭代下有「代码」组件，支持查看迭代中的代码提交汇总

- 支持新建并关联合并请求到工作项详情

- 支持新建并关联代码分支到工作项详情

- 支持代码开发事件自动触发工作项状态流转

## 2.权限管理

在团队权限配置中，可以配置「代码集成」应用的管理员。「代码集成」应用的管理员拥有代码集成配置的全局设置能力，以进行代码仓库的关联、移除操作。

[image: image - 2024-05-06T145712.520.png; see source page]
