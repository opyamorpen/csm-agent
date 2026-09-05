# Jenkins集成配置

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/DV6RWYMa
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / DevOps工具链 / 流水线集成 / Jenkins集成配置
Evidence: documentation, not runtime verification

## Jenkins集成配置

## 1.启用流水线管理

Pipeline 初始页面增加使用示例。如果当前团队未关联过 Jenkins，可以在 ONES Pipeline 首页点击「开启关联 Jenkins」进入 Pipeline 配置中心关联 Jenkins，以开启流水线管理的旅程。

[image: EyqPW9xCuc8cdpYY1MdA7IoF4mNbxQd8NdjhXzC8KfA.png; see source page]

如果当前团队已关联过 Jenkins，可以进入 Pipeline 配置中心继续新建或编辑已关联 Jenkins。

## 2.关联 Jenkins

### 2.1 新建关联 Jenkins

1. 关联 Jenkins 前，请确保 ONES 系统和贵司 Jenkins 网络能互联互通。

2. Jenkins 版本最低支持2.176.4，最高支持2.433。

前往 Pipeline 配置中心的关联 Jenkins 页面，点击「新建关联 Jenkins」以关联当前团队所需持续集成工具。系统支持 Jenkins「流水线、文件夹、多分支、自由格式」类型的任务。关联 Jenkins 后，你可以在「ONES Pipeline」管理和追踪此类流水线。

[image: fy54ybHCBiPUmd0gc7opYeZWv4No8D4Z-zOaUS3qxB4.png; see source page]

[image: K2NmhU_fzjYzF6814QcvV7I9kB8r2GqgvomY_tYbHng.png; see source page]

已关联的 Jenkins 将按列表展示。当你进入关联 Jenkins 页面时，系统会自动检测 Jenkins 的访问状态。访问失败可能的原因：Jenkins 服务器挂掉、网络问题、Jenkins 的用户或密码/Token 已变更等。

[image: image - 2024-05-06T151743.729.png; see source page]

### 2.2 编辑关联 Jenkins

如果访问 Jenkins 的用户名或密码/Token 需要变更，你可以点击「编辑关联」按钮修改。编辑用户名或密码/Token 不会触发流水线的重新同步。

[image: yTjg2TV_CZU0jwkei1U9KTcciQEWuVotx4eiVEdo_z0.png; see source page]

### 2.3 移除关联 Jenkins

如果不想在当前团队展示某个 Jenkins 的流水线，你可以点击「移除关联」按钮。移除 Jenkins 后，你将获取不到当前 Jenkins 的数据，已同步的流水线数据也将清空。

[image: image - 2024-05-06T151833.657.png; see source page]

## 3.查看流水线

Pipeline 的流水线列表将显示不同来源的流水线，你可以根据“Jenkins URL”字段区分。

[image: FJZ2qhdvVkyBwab6GfIVvCsMDKDAaijyBxFeRluaiwU.png; see source page]

如果多分支流水线类型，系统通过父子结构展示多分支及其分支流水线。你可以通过点击“展开”查看多分支下的分支流水线。其中，分支流水线按“最近运行时间”降序排序，方便你查看最近在用的分支流水线。

[image: JJDkU75L2WqbiCN_3sCEkE6tjBUmPVHzMkLOpmGGVuE.png; see source page]

在 Pipeline 首页点击流水线名称，可以查看流水线的运行历史。在 Pipeline 首页点击最近运行的 ID、或者在运行历史页点击每行运行历史记录，可以查看流水线的运行详情。

[image: R8bJ_uIKWYZeKtcStLWyIRLVGfwX_tOHB8TnSh5Z_I4.png; see source page]

## 4.删除流水线

在流水线的更多页面里，可以删除流水线。删除流水线后，将同步删除持续集成服务器上的流水线。‌此外，如果你删除的是多分支流水线，其分支流水线也会被删除且不可恢复，请谨慎操作。

[image: image - 2024-05-06T151924.025.png; see source page]

## 5.流水线关联业务对象

### 5.1 项目关联流水线

项目支持「流水线」组件。你可以进入项目设置的项目组件页面中添加。

[image: DP47-QaSyBHPzIV3J4tzltkG8EafmKsuMIK_Elsu-xc.png; see source page]

具备项目管理员权限的用户，可以执行「关联已有流水线」的操作。此外，用户需要具备流水线的查看权限，才能看到或选到流水线。如果无相关流水线的权限，请联系流水线管理员添加。

[image: ajhrVZ6RehGeSmqVmzz5T3sEdsidjBokEWT9s0cf0Qo.png; see source page]

如果你关联的是多分支流水线，其分支流水线会被自动关联到项目中。项目关联流水线后，我们就可以在项目中跟进相关的流水线运行情况。

### 5.2 迭代关联流水线运行

迭代支持「流水线运行」功能，用于展示迭代关联的流水线运行数据，你可以在此功能中追踪和分析流水线运行情况。 通常的协作流程为：

1、项目管理员需提前为项目关联流水线（在「流水线」组件 > 关联已有流水线）;

2、迭代管理员需咨询技术人员配置“迭代关联流水线运行的规则” ；

- 系统支持通过脚本的方式批量将「当前项目的迭代」和「项目已关联流水线」的运行情况关联起来，请根据团队需要调整。

- 默认规则「string.len(branch) > 0 and string.find(sprint_name, branch, 1, true)」表示：如果流水线运行时的分支名称 包含迭代的数据，则建立关联关系。

3、迭代管理员根据配置的“迭代关联流水线运行的规则”，修改迭代名称。

- 你需要在迭代名称中加入流水线运行的“分支名称”或“代码仓名称”；

- 以使用默认规则为例，如果期望在迭代中关联和 F2003分支 相关的流水线运行，则可以把迭代名称改成“F2003-XXX”

[image: image - 2024-05-06T152007.599.png; see source page]

4、迭代成员进入「流水线运行」功能后，可以查看和迭代相关的流水线运行记录。

[image: 8V0xD1FjiS8HnSFJG1tvXoBxnHP4nT1JXgftWUTfkWs.png; see source page]
