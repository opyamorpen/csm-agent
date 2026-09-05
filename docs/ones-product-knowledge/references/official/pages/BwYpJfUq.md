# 在表格中设置条件格式

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/BwYpJfUq
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Wiki / 数据表格页面编辑与管理 / 在表格中设置条件格式
Evidence: documentation, not runtime verification

## 在表格中设置条件格式

## 功能场景

在表格中使用条件格式可以批量为某一范围内符合特定条件的单元格内容设置特定的格式样式，以达到快速筛选、突出显示等目的。



## 功能说明与产品规则

### 2.1 新增条件格式规则

点击总菜单中的格式-条件格式，界面上即会出现条件格式规则侧栏，可在规则侧栏中设置条件格式规则。

[image: YUY7mOVoUqvBr43VHx5xylwp_W5vFP6iBwW1Sqd7XLE.png; see source page]

[image: z9PfA8sSqnTiHHul7GdippALwd3B6iMYqyh6pBg2meQ.png; see source page]

在条件格式规则侧栏中，可以设置条件格式的应用范围，默认为当前选中的单元格范围，可以输入单元格范围进行修改，也可以点击应用范围输入框后面的选择按钮后直接在表格中选择单元格范围。

[image: V0TffX64N5q7AcfL_BXbT5lbExDxgCoy6k-3o1jdtCg.png; see source page]

在「符合以下条件时」区域内设置需要满足的条件，在「格式样式」中设置满足条件时单元格的样式，提交之后即可成功创建一个单元格规则。

### 2.2 管理条件格式规则

当创建了条件格式规则后，可以在条件格式规则侧栏中管理已经创建的规则。可以管理当前选定单元格上应用的条件规则，也可以管理当前工作表中应用的条件格式。条件格式规则名称表示当前规则的条件，而右侧预览的样式则表示满足条件时的样式。点击条件格式规则即可编辑规则，可以对规则进行拖拽排序。如果同个单元格中同时存在多个条件规则，则会根据规则列表中的顺序从上到下进行匹配应用，只会应用第一个匹配到的条件规则。鼠标悬浮在条件格式规则上，点击右侧的删除按钮可删除规则。

[image: TuLL8b7RizOwGHkvdFycIc77K4tKGEzcgUlOu4eQ4Lc.png; see source page]

[image: X663qARsjWCWqt-EUMKBCQ2AIhUqPVmqyWx8iWCD8Dc.png; see source page]

### 支持的条件内容

| 文本 | 为空 |
| --- | --- |
| 文本 | 不为空 |
| 文本 | 包含 |
| 文本 | 不包含 |
| 文本 | 开始于 |
| 文本 | 结束于 |
| 数值 | 介于 |
| 数值 | 不介于 |
| 数值 | 等于 |
| 数值 | 不等于 |
| 数值 | 大于 |
| 数值 | 小于 |
| 数值 | 大于或等于 |
| 数值 | 小于或等于 |
| 日期 | 昨天 |
| 日期 | 今天 |
| 日期 | 明天 |
| 日期 | 最近 7 天 |
| 日期 | 上周 |
| 日期 | 本周 |
| 日期 | 下周 |
| 日期 | 上个月 |
| 日期 | 本月 |
| 日期 | 下个月 |
