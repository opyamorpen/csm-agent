# 项目组件

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/QGaTBdvb
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 项目 / 项目设置 / 项目组件
Evidence: documentation, not runtime verification

## 项目组件

## 1.什么是“组件”？

ONES Project 通过“项目”来管理团队各项事务， “组件”是项目内具有独立工作逻辑的功能模块， 可以有效拓宽“项目-任务类型”结构的单一场景，为管理各类事务提供更灵活的支撑，匹配更丰富的业务场景，满足不同规模团队的协作和管理需求。

此外，组件能力也使得 ONES Project 更高效的与其它子产品联动， 实现研发管理全流程与全场景的打通。

## 2.组件类型

系统内有三种组件类型：通用组件、系统组件、自定义工作项类型组件；组件数量众多，功能丰富，配置灵活，各功能特性将在后续章节中展开详细介绍。

### 2.1 系统组件

#### 2.1.1 预置的工作项类型组件

“工作项” 是 ONES 系统定义各类项目事务的基本工作单位，是对于具备相同数据结构（常见的如状态、属性、工作流）的业务类型的抽象定义，有着相似的业务场景，都是围绕“完成这件事情”来流转。

“工作项类型组件” 基于这类事务的处理逻辑，做了一些产品能力的封装，增强可复用性的同时，也支持基于不同工作项类型的个性化的配置。

典型的工作项类型组件包括：

- 用户故事 ：详细的用户故事列表，可以对用户故事进行排序、筛选、规划

- 需求：详细的需求列表，包含需求规划、拆分、关联工作项等针对性功能

- 任务：详细的任务列表，包含关联工作项等针对性功能

- 缺陷：详细的缺陷列表，包含关联需求、关联测试计划等针对性功能

另外，还有一类特殊的工作项类型组件，针对其业务特性，在组件能力上做了特殊处理：

- 工单：详细的工单列表，包含工单收集，指派工单处理人，自定义工单状态流转

- 发布：包含发布列表，可以进行发布的计划与管理

[工作项类型组件详细说明](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/6n74F7aj)

#### 2.1.2 产品和需求管理组件

- [路线图](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/U1VTxT4s)：将目标以及实现目标的工作的完成时间表传达给利益相关者的工具。

- [基线管理](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/8R74ewwn)：对项目进行中的关键节点进行阶段性固化，形成可追溯、可回溯的项目基准。

- [模块](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/KK9iHAvB)：用于归类管理项目内的工作项。

#### 2.1.3 敏捷研发核心组件

- [迭代](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/KNvfgfvA)：包含迭代列表、迭代周期、迭代燃尽图、相关工作项列表等内容。

- [规划](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/TJn9Qwu8)：用于管理团队的待办事项列表，规划史诗、发布与迭代计划。

- [看板](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/VsmsPYGC)：通过看板可视化工作流的形式，管理和跟踪工作项的进展。

#### 2.1.4 瀑布项目规划核心组件

- [甘特图](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/BEr2Dj2Z)：在甘特图组件中，可以完成从 WBS 工作拆解、项目规划到进度管控的全流程管理。通过「表格+甘特图」的形式直观展示项目进展，实现瀑布式项目管理的高效协作与管理。

旧版组件：

- [项目计划](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/EZrwptPo)：传统项目规划和进度管理甘特，同时支持与关联迭代、混合使用

- [里程碑](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/XArvBFjG)：包含里程碑列表，支持增删改查里程碑、对比里程碑计划的历史版本

- [交付物](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/V3bbBWXs)：包含项目交付物列表及来源

- [执行](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/KN7BPMoK)：包含从项目计划拆解得到的所有计划

#### 2.1.5 其它基础功能组件

- [通用组件](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/26Dg5odJ)：支持一级导航与自定义链接

- [项目概览](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/4LujmpAn)：自定义卡片，展示当前项目的基本信息以及迭代和工作项的完成情况

- [筛选器](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/49KiyZfn)：根据项目所需汇总工作项信息，提供公共视图、私人视图的能力

- [成员](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/MtPEy1yb)：展示当前项目中的所有成员及其角色构成，可进行项目成员管理

- [报表](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/PrMtJ7MX)：提供了当前项目的多维度数据统计能力以及可视化展现

- [目录](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/N2ZpJVtS)：通过关联 Wiki 页面组的方式，实时同步页面信息

- [文件](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/6qgFy3sm)：汇总展示项目下所有工作项包含的文件

- [流水线](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/4sQPY9md)：展示当前项目关联的流水线信息

### 2.2 自定义工作项类型组件

用户创建了一个新的工作项类型时，系统会自动生成自定义工作项类型组件。自定义工作项类型的组件能力与系统预置的工作项类型组件，如需求、缺陷、任务等一致。

## 3.组件添加和移除

在项目内顶部导航入口选择「项目设置」-「项目组件」，即可为一个项目搭配所需的组件，目标是将自定义导航中的组件调整至团队所需。

你可以通过拖放的方式添加和移除组件。将左侧组件库中的组件拖至自定义导航下，完成添加；从自定义导航拖至组件库，即完成移除。此外：

- 一个项目内，可重复添加多个相同组件

- 组件显示名称支持自定义修改

每个组件基于业务类型和功能设计上的差异，有相应的个性化配置，具体的操作在各组件功能特性中详细有详细说明。
