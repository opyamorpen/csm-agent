# 在表格中插入下拉列表

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/qTY8kYHV
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Wiki / 数据表格页面编辑与管理 / 在表格中插入下拉列表
Evidence: documentation, not runtime verification

## 在表格中插入下拉列表

## 功能场景

下拉列表是一种数据验证能力，使用下拉列表，能够保证成员在单元格汇总填写符合要求的内容，也能提升内容填写的效率。

## 功能说明和产品规则

可以通过工具栏中的添加下拉列表按钮在当前选中单元格中添加下拉列表，也可通过总菜单中的插入菜单选择下拉列表来添加。因为下拉列表是一种数据验证能力，也可通过总菜单中的数据菜单中的数据验证进行添加，使用数据验证的说明可以参照「在表格中进行数据验证」。

[image: kRLs-x2epC38PSvXDZWopEJ8MHdgEds-sn7kP7K5IJY.png; see source page]

点击下拉列表之后会在界面右侧出现下拉列表配置面板，可在面板中下拉列表应用范围以及列表选项。

[image: kUZxcpVK7qAKMJ5HZyq6YADryBJENg0DK1DLxQcW1W0.png; see source page]

### 2.1 配置列表选项

选项列表可以自行输入，也可以引用数据。选择引用数据时，可以将表格中某一个区域中的数据作为列表选项，可以通过输入单元格范围会点击输入框右边的框选按钮之后在表格中框选范围即可引用数据作为选项。成功引用数据之后，当引用范围内的数据发生变更时，列表选项也会跟随变更。在配置列表选项时，可以给选项配置背景颜色，配置选项背景颜色之后，在列表下拉菜单以及选中的选项中的都会出现对应的选项背景颜色，便于快速区分选项。

[image: Cg28xzSzg3BxGU9TH-ZZbIRg6ny41rTYjNS7Px3FeEM.png; see source page]

### 2.2 二次编辑列表选项

当列表创建成功之后，再次点击数据验证或点击列表中的「编辑选项按钮」，即可编辑已经创建列表的选项。编辑选项时，如果勾选了「更新已填写的下拉选项」，则会将已经选择的、变更的选项变更为新的数据。例如下图，将选项值 30 修改为 40，勾选「更新已填写的下拉选项」，提交后，会将已经选择了「30」这个选项的单元格中的数据都变更为「40」。

[image: BxIzRJ9TFFaPKBdyH6t-syozPkondZdMTt9umI_TwHQ.png; see source page]

### 2.3 清除下拉列表

在二次编辑下拉列表时，点击下拉列表配置面板右下角的「清除下拉列表」按钮即可清除当前应用范围内的下拉列表。清楚下拉列表之后，已选择的选项值将会被保留在单元格中。
