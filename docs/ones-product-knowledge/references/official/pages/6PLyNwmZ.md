# 插入文本绘图

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/6PLyNwmZ
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Wiki / 协同页面编辑与管理 / 插入文本绘图
Evidence: documentation, not runtime verification

## 插入文本绘图

## 1.功能介绍

Wiki 协同页面支持插入文本绘图，可以快速将符合特定语法的文本渲染为图表、UML图或流程图

## 2.操作流程

点击顶部工具栏「插入」菜单、或输入 / ，在列表中选择「文本绘图」，选择需要插入的文本绘图类型，包括：mermaid、plantUML、flowChart

[image: image.png; see source page]

### 2.1 撰写文本绘图

插入后，在左侧输入对应文本绘图的语法，右侧展示渲染后的图表 如果语法有异常，无法正常渲染为图片，右侧会展示错误提示；修正语法后，即可正常展示图表。

[image: image.png; see source page]

如果在撰写文本绘图过程中出现渲染错误信息，可参考下列文档进行修正

Mermaid ：[https://mermaid.js.org/intro/](https://mermaid.js.org/intro/)

PlantUML：[https://plantuml.com/](https://plantuml.com/)

flowChart ：[https://flowchart.js.org/](https://flowchart.js.org/)



### 2.2 切换绘图模式

点击顶部的「展示代码与绘图」菜单，可切换「仅展示绘图」或「仅展示代码」 。无论编辑状态如何选择显示模式，阅读状态下都仅展示图片。

- 查看页面时，点击绘图，可放大查看；

- 右键点击绘图，可保存为图片或复制 Markdown。

[image: image.png; see source page]
