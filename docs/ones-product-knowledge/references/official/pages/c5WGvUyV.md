# 插入工作项列表

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/c5WGvUyV
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Wiki / 协同页面编辑与管理 / 插入工作项列表
Evidence: documentation, not runtime verification

## 插入工作项列表

### 功能介绍

Wiki 协同页面支持在文档中插入 Project 项目中的工作项列表，方便团队成员在文档中展示相关的工作项，以便更好地进行工作汇报或工作规划。

### 操作流程

点击「+」或输入「/」后在工具栏中选择「工作项列表」，支持以快照列表方式或自动更新列表方式插入。

[image: _mWI6HWhU; see source page]

#### 插入快照列表

在插入方式中选择「快照列表」，查看页面时，工作项数据不会自动更新，工作项列表的插入者能够在编辑页面时，手动更新列表中的工作项属性数据。查看页面时，不会根据查看者的工作项查看权限过滤数据。该方式适用于工作汇报场景。

##### 1.1 选择要插入的工作项内容

1. 在「插入方式」中选择「快照列表」

2. 配置筛选条件后，在工作项列表中选择要插入的工作项；最多可选择筛选结果中的前 200 条数据

3. 点击「确定」按钮，将勾选的工作项插入到 Wiki 页面中

[image: jAfh9f66T8dv-AgM0J6SxrmaW-eLnI2wX_FvblgA99U.png; see source page]

如果系统中已有配置好的工作项视图，点击「视图筛选条件」，选择视图位置、组件和视图，点击「应用筛选条件」，即可快速获得视图中的工作项，根据需求选择工作项插入即可

[image: nYfWlMTRUasMwWUAz6EZgyLjXL4u-vqbFNtRn-7XcCg.png; see source page]

如果需要在列表中展示特定的表头，点击列表右上角的设置图标，可设置工作项列表的表头。搜索即可添加其他系统属性和自定义属性。

[image: yVxmwWnY3S-ulFRjjocdE3XittxdCOyZP7uY80FQXHo.png; see source page]

##### 1.2 更新工作项快照列表中的属性数据

插入到页面后，工作项列表顶部会展示工作项个数、最近更新时间，点击「刷新数据」按钮，即可更新列表中所选工作项的属性。

[image: QjQSNfSsIbeANIKyd0euKG_MkWt0VrvovlCxl9L1GN8.png; see source page]

#### 插入自动更新列表

在插入方式中选择「自动更新列表」，查看页面时，工作项数据会自动更新，且会根据查看者的工作项查看权限过滤数据。该方式适用于某个项目或迭代下的工作项数据同步场景。

##### 2.1 选择要插入的工作项内容

1. 在「插入方式」中选择「自动更新列表」

2. 根据插入工作项的需求配置筛选条件。选择「自动更新列表」方式时，会插入全部筛选结果

3. 点击「确定」，插入到页面中

[image: 8m8VKlY8Wc-FLHUtqc1ZIxU-SjXK1ymYSisNyIBKntw.png; see source page]

插入后，阅读者查看页面时，列表数据会自动加载最新数据。

[image: c7c0YFo-TD8PAY5iLJx3wzCGS__9f5mtqiccKBIPd7A.png; see source page]

### 查看工作项列表

插入后的工作项列表将通过卡片的形式展示。点击列表中的工作项可在新标签页中跳转到工作项详情。

- 页面编辑状态下，鼠标悬停在工作项列表上方，点击「编辑」按钮，可对工作项列表进行二次编辑，便于修改筛选条件和工作项范围。

- 鼠标点击工作项列表卡片之后出现调整框，可长按底部边框蓝点拖拽调整卡片高度。

[image: ptFdS4ZH4ypwieSwfXjwcNCc9Kq9WUhSuowPGyD2Dqo.png; see source page]

## 修改工作项列表标题

已插入的工作项列表，点击标题，即可在输入框中修改工作项列表标题，以便更清晰地描述当前列表展示的内容。

[image: uUdGW7-fl6wc6bxViBH0hSi7hpz4UFGKK-dT7krKIZk.png; see source page]

### 数据导出

- 导出页面为 PDF 和 Word 时，以「快照列表」 方式插入的工作项列表内容支持以表格形式导出到文件中；以「自动更新列表」方式插入的列表，会以超链接的方式导出，点击可跳转至筛选器，查看所选条件下的全部工作项。

-

### 特殊场景

- 当工作项视图被删除，在 Wiki 页面中会保留工作项列表卡片，但是会提示「暂无工作项」。
