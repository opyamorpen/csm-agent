# 文档导入与导出

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/Pf4u6kiM
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Wiki / 文档导入与导出
Evidence: documentation, not runtime verification

## 文档导入与导出

## 1.页面导入/导出

### 1.1 页面导入与导出

 ONES Wiki 提供页面导入/导出功能，方便您将本地文档或是 Confluence 页面导入到页面组中，或是将页面导出为本地文件便于使用。

- 导入：点击新建按钮旁边的图标，即可选择「导入 .doc/.docx 」或者「导入 Confluence 」

- 导出页面：点击页面右上角「更多」，在下拉菜单中可选择将页面导出为 PDF 或 Word

- 导出页面树：点击左侧页面树顶栏「设置」，可导出页面树为PDF，导出的页面树节点可自行选择

### 1.2 含超宽表格页面导出 PDF 时

当页面中包含超宽表格时，为了尽可能让表格中的内容能够展示在文件中，在导出 PDF 时，系统会对表格进行缩放处理，在将表格压缩到一定比例后，如果表格宽度依旧超出 PDF 文件内正文的宽度，表格会被截断。因此，含有超宽表格的页面，导出的 PDF 文件中的表格样式与原页面可能会有差异。

超宽表格：整体宽度超出 A4 纸正文宽度（约720px）的表格

## 2.Confluence 导入

Confluence 的任意空间（Space）均可保存为 XML 格式的 Zip 压缩包，ONES Wiki 提供了将压缩包导入为页面组/页面的功能，用户可以方便的进行知识库迁移。

##### 导入可分为两步：

1. 从 Confluence 导出 XML 的 Zip 压缩包；

2. 在 ONES Wiki 导入该 Zip 压缩包。

### 2.1 如何从 Confluence 里导出文件

Confluence v7.16.2操作界面： 进入 Confluence 首页后点击 Space (空间) 按钮即可选择目标空间，如：ONES.AI；

兼容 Confluence v7.16，如导入Confluence 其他版本，可能有部分数据未能正常导入；

进入具体的Spaces(空间)中，选择 Space Setting (空间设置) - Manage space（空间管理）- Export space (空间导出) - XML - Next - 选择 Full Export (导出全部)  或 Custom Export（导出部分），选择 Custom Export 之后你可以选择要导出的页面。按照以上步骤操作后，点击 Export (导出) 按钮，跳转后点击 here 即可下载 Zip 压缩包；

Full Export (导出全部) 会将空间的每个页面生成一个 XML 文件，包括你没有权限查看的页面，目前暂不支持导入日志、备注和附件。

[image: image - 2024-05-06T140309.924.png; see source page]

[image: image - 2024-05-06T140311.268.png; see source page]

[image: image - 2024-05-06T140312.971.png; see source page]

[image: image - 2024-05-06T140314.718.png; see source page]

### 2.2 将 zip 压缩包导入 ONES Wiki

支持导入为 ONES Wiki 的页面组或单页面，以下将详细的步骤进行说明。

##### 导入为页面组时：

在 Wiki 首页中，点击  按钮后，选择 导入 Confluence 为页面组 - 选取文件，选择 Confluence 导出的 zip 文件进行导入，导入过程会在云端处理，可通过进度管理预览每个压缩包的导入进度，支持取消导入、查看详情。

导入 Confluence 为页面组 的入口只呈现给 Wiki 管理员

[image: image - 2024-05-06T140350.568.png; see source page]

[image: image - 2024-05-06T140352.116.png; see source page]

上传完成后，点击 ，确认后系统将在云端处理进度，进度可通过管理器预览每个压缩包的导入进度，支持取消导入、查看详情。

[image: image - 2024-05-06T140353.860.png; see source page]

##### 导入为某页面组的页面时：

操作步骤与“导入为页面组”的步骤相同，此处不再赘述。

导入Confluence 入口仅对拥有新建页面权限的用户呈现。

### 2.3 导入说明

系统将在导入完成后为管理员发送导入成功的提醒

导入数据说明：

- 可导入空间信息、页面内容

- 不可导入系统配置、备注、评论、空间内用户、空间权限、页面权限

[image: image - 2024-05-06T140356.101.png; see source page]

## 3.Markdown 导入与导出

### 3.1导入 Markdown 文件

ONES Wiki 支持单个或批量导入 Markdown 文件，将 Markdown 语法标记渲染为 Wiki 协同页面正文样式。如果选择导入的文件是 zip 文件，并且包含 Markdown 中通过图片或链接语法声明的资源文件，导入 Markdown 时可将这些文件上传到 Wiki 页面中。

点击「+」，选择导入为 Wiki 协同页面，可选择导入 Markdown 文件格式。

[image: image.png; see source page]

 选择文件后，将进入批量导入过程。左下角进度管理器可观察导入进度，点击「查看详情」可查看进度详情。

[image: image.png; see source page]

导入完成后，点击进度管理器「查看详情」可跳转至导入页面。

[image: image.png; see source page]

### 3.2将 Wiki 页面导出为 Markdown

Wiki 协同页面支持导出为 Markdown 文件，页面附件、图片也可同步导出，导出文件格式为 zip，其中包含 .md 文件和资源、附件文件夹。

导出页面需要具备「页面组数据导出」权限；部分页面中插入的宏无法转为 Markdown 语法，会展示为文本提示，例如 [工作项列表] ；页面中插入的 流程图/UML 可导出为图片语法和图片资源；

[image: image.png; see source page]
