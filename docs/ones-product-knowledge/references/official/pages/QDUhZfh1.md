# 进度

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/QDUhZfh1
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 工作项 / 工作项属性类型 / 进度
Evidence: documentation, not runtime verification

## 进度

#### 一、功能入口

进度支持在「配置中心」-「项目管理配置」-「进度汇总」中配置汇总规则

进度汇总支持按工作项类型配置，并生效于所有项目

[image: SOc1KwxSr4pR18pFHX3EQIzqc6B3RA1-poX93Bbk1-Q.png; see source page]

#### 二、汇总配置生效说明

| 汇总配置 | 进度计算规则 |
| --- | --- |
| 选择「不汇总」 | 进度可手动填写，进度 = 手动填写的值 |
| 选择「汇总层级结构中的子层级工作项」 | 在选择层级结构下：<br><br>- 当前工作项有子层级工作项，则进度不可手动填写<br><br>- 进度 = SUM(子层级工作项周期时长*进度)/SUM(子层级工作项周期时长)<br><br>- 若子层级工作项未设置进度，则其进度视为 0%<br><br>- 若子层级工作项开始或完成日期为空，则其周期时长视为一天<br><br>- 当前工作项没有子层级工作项，则进度可手动填写<br><br>[image: _LbZQVGI6; see source page] |
