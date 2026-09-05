# 复制工作流

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/G5ATKbnj
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 工作项 / 工作项状态与工作流 / 复制工作流
Evidence: documentation, not runtime verification

## 复制工作流

## 功能入口

「配置中心」-「工作项类型」- 「工作项工作流」- 复制工作流

[image: _yy9z4oLP; see source page]

「项目设置」-「工作项类型」- 「工作项工作流」- 复制工作流

[image: _icRVqdCL; see source page]

## 目标位置

支持将“源工作项类型”的工作流，应用到到其他工作项类型中，包括：

- 当前项目或其他项目的工作项类型，若这些项目已存在工作项数据，则需要更新这些工作项的工作流

- 配置中心中的工作项类型

[image: _eD8YT6j5; see source page]

## 工作项类型范围

支持跨工作项类型之间相互复制工作流，「发布」工作项类型除外

复制工作流到「项目-工作项类型」

[image: image.png; see source page]

复制工作流到「配置中心-工作项类型」

[image: _l82sR0_v; see source page]

## 其他产品规则说明

| 目标位置 | 所需权限 | 其他特殊说明 |
| --- | --- | --- |
| 项目-工作项类型 | 允许将“源工作项类型”复制到其他项目的工作项类型中，需要操作者拥有：<br><br>“目标工作项类型”所属项目的「查看项目」和「管理项目」权限 | 工作流的「步骤属性」仅保留目标位置工作项类型已有的工作项属性<br><br>比如将「工作项类型 A」工作流复制到「工作项类型 B」<br><br>A 的“工作流-步骤属性”中配置了“属性a”，B 的属性视图中不包含“属性a”<br><br>复制成功后，B 的“工作流-步骤属性”中不会包含“属性a” |
| 配置中心-工作项类型 | 允许将“源工作项类型”复制到配置中心的其他工作项类型中，需要操作者拥有：<br><br>配置中心的「管理工作项配置」权限 |  |
