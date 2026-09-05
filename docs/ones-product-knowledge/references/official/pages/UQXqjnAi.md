# 甘特图设置

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/UQXqjnAi
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 项目集管理 / 甘特图 / 甘特图设置
Evidence: documentation, not runtime verification

## 甘特图设置

进入甘特图后，点击右侧「甘特图设置」，包含三个模块：基础信息、数据来源与数据同步

1. 基础信息 ：支持修改甘特图名称和可见范围；

2. 数据源设置 ：支持更改甘特图的数据来源，重置后会重新导入已选择的数据，不选择数据源时将会移除所有来自ONES Project的数据；

3. 同步设置 ：支持自动更新导入的 ONES Project 项目和迭代，或将在甘特图中更改的日期同步到 ONES Project 中，不导入 ONES Project 数据无法启用同步设置。

[image: image 39.png; see source page]

## 1.基础信息设定

选定具体的甘特图后，进入设置界面，填写对应的甘特图名称及可见范围；

支持修改甘特图名称和可见范围，修改后请点击“保存”按钮保存已修改的配置

### 2.数据源设置

在设定好基础信息后，在此处对甘特图的源数据进行两种选择；

- 无数据来源：甘特图的周期及进度需要手动调整；

- 来自项目：导入未完成的项目（包含迭代）并自动更新，支持在甘特图中更改开始/结束日期并同步到 ONES Project，勾选系统中存在的项目即可；

支持更改甘特图的数据来源，重置后会重新导入已选择的数据，不选择数据源时将会移除所有来自ONES Project的数据

## 3.同步设置

该设定将决定在甘特图日常使用中，甘特图周期与项目周期数据由那个工具决定，在系统中由两个开启/关闭按钮决定。

支持自动更新导入的 ONES Project 项目和迭代，或将在甘特图中更改的日期同步到 ONES Project 中，不导入 ONES Project 数据无法启用同步设置

- 自动更新导入的项目和迭代 ：开启后, 如果导入甘特图的项目或迭代在 ONES Project 被更改，将会在甘特图的对应数据中自动更新 ONES Project 的更改内容（甘特图中分组数据的开始/结束日期由组下的数据计算得到，无法同步 ONES Project 中的对应的计划周期字段）

- 同步到 ONES Project ：开启后, 如果导入的 ONES Project 项目或迭代的开始/结束日期在甘特图中被更改，可以将更改的开始/结束日期同步到 ONES Project 中对应的项目或迭代中
