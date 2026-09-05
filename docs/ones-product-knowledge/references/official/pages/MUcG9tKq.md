# 工时管理

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/MUcG9tKq
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 工时管理
Evidence: documentation, not runtime verification

## 工时管理

## 1.管理工时模式

工时模式主要用于设置团队的工时管理方式。ONES现在支持两种工时模式：简单模式、汇总模式。

- 简单模式下，团队可以针对工作项进行工时预估；

- 汇总模式下，团队则是对成员进行工时预估，工作项的预估工时通过成员的预估工时汇总得到。

### 1.1 预估工时计算逻辑

工时模式在汇总模式下，用户在预估工时的时候，可以选择日期是否需要包含非工作日，系统根据用户选择结果计算日期天数，并输出工时结果：

- “合计”模式下，每日预估工时=预估投入时长/日期天数，合计预估工时=预估投入时长。

- “每日”模式下，每日预估工时=预估投入时长，合计预估工时=预估投入时长*日期天数。

[image: _eyVfuxQ1; see source page]

注意事项：若用户选择预估日期不包含非工作日，则日期至少需要选择一个工作日。

[image: _fiv0SV_g; see source page]

如何切换工时模式可参考：

[工时设置](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/UDth3soY)

## 2.管理工作日和标准工作时长

### 2.1 工作日设置

工作日设置主要用于设置团队每周工作日和特殊工作日（或非工作日），工作日设置可参考：

[偏好设置-工作日设置](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/NLyt6xP3)

### 2.2 工时单位与时长

管理员可在「配置中心」-「工时设置」-「工时单位与时长」中，设置团队每日标准工作时长和工时默认单位，成员的工时数据将基于此进行计算。

## 3.管理工时权限

预估工时和剩余工时的新增、删除、修改权限由工作项的权限控制。在工作项权限中可以设置哪些成员可以管理所有预估工时或者登记工时，哪些成员可以管理自己的预估工时或者登记工时。工作项权限设置可参考：

[工作项权限设置](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/7yHU8hVP)

## 4.填写预估工时和剩余工时

项目成员可根据任务情况，在工作项中填写预估工时和剩余工时。根据已经填写的工时信息，可以查看工时进度和预估偏差。

## 5.在项目里查看工时报表

在项目中报表组件下，提供工时日历、工时总览两个类型的报表查看项目内的成员、迭代的工时统计情况。报表详细说明可参考：

[报表组件](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/PrMtJ7MX)
