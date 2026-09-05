# 卡片配置

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/7gnwhM6p
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 效能管理 / 卡片配置
Evidence: documentation, not runtime verification

## 卡片配置

## 1.添加卡片

点击仪表盘名称，进入仪表盘详情页

[image: image - 2024-05-06T142426.659.png; see source page]

点击右上角“编辑仪表盘”，进入仪表盘编辑页面

[image: image - 2024-05-06T142428.259.png; see source page]

点击右上角“添加卡片”

[image: image - 2024-05-06T142429.768.png; see source page]

选择需要的数据集与图表类型，点击右下角“确定”，进入图表编辑页

[image: image - 2024-05-06T142431.203.png; see source page]

配置数据与样式，之后先点击右下角“应用”，再点击右上角“保存”

[image: image - 2024-05-06T142513.480.png; see source page]

此时会收到提示“保存成功”，接下来点击右上角“完成编辑”

[image: image - 2024-05-06T142515.115.png; see source page]

再次收到提示“保存成功”，就完成了卡片的新建与保存

[image: image - 2024-05-06T142516.388.png; see source page]

## 2.编辑已有卡片

点击卡片右上角“更多”，选择“编辑”

[image: image - 2024-05-06T142518.106.png; see source page]

点击“编辑仪表盘”之后，点击卡片右上角的笔形标志

[image: image - 2024-05-06T142558.721.png; see source page]

以上2种方式均可进入卡片的图表编辑页。进入编辑页后，保存方法与前述新建过程中的保存方法相同。

## 3.图表编辑

### 3.1 数据集

数据集是指图表制作的数据来源。

为方便用户使用，我们已经将用户产生的数据划分为了 5 个数据集，分别是：工作项、项目、迭代、工时、团队成员。切换入口如下。

[image: image - 2024-05-06T142600.587.png; see source page]

在每个数据集中都有一些可以直接使用的指标和可供分析的维度，您也可以通过已有维度加工成新的指标使用。维度通常来自于工作项属性。当您需要一个新的维度时，可以去新建一个对应的工作项属性，之后系统会自动将其同步到数据集。

查看每个数据集的指标、维度详情入口如下。

[image: image - 2024-05-06T142604.713.png; see source page]

在详情中，您可以查看指标计算方式，或按需复制对应的sql表达式，用于后续的自定义指标加工。

[image: image - 2024-05-06T142606.208.png; see source page]

### 3.2 指标选择

指标通常指数据统计的结果，比如工作项总数、团队成员总数、项目利润总值等，也可以简单理解为柱状图中y轴呈现的内容。

在当前编辑页面，指标的来源有 3 种：

1.可以直接用的，来自于系统内置；

[image: image - 2024-05-06T142642.797.png; see source page]

2.从维度转换的，比如对工作项生存时长求平均值；

[image: image - 2024-05-06T142644.003.png; see source page]

3.自定义的，通过写sql语句自定义指标，所需字段可以点击“查看字段”进行查看。

[image: image - 2024-05-06T142645.754.png; see source page]

sql的写法参考 [https://clickhouse.com/docs/en/sql-reference/functions/arithmetic-functions](https://clickhouse.com/docs/en/sql-reference/functions/arithmetic-functions)

### 3.3 维度选择

维度通常指进行数据分析的角度，例如：从负责人的维度分析任务数。也可以简单理解成柱状图中x轴的内容。

[image: image - 2024-05-06T142647.050.png; see source page]

在编辑页面点击“添加维度”即可完成维度选择。一般建议仅添加 1 个维度即可，能够比较精准地分析数据。

[image: image - 2024-05-06T142651.391.png; see source page]

### 3.4 分组

当您想对上述图表做进一步的分析时，您可以添加一个分组，例如下图。这样不仅可以看到每人负责的任务总量，还可以看到其中不同状态的分布。对于添加分组的数量，建议添加不超过 1 个。

[image: image - 2024-05-06T142743.502.png; see source page]

### 3.5 筛选

需要对当前数据源设定筛选条件时，可以使用下图中配置

[image: image - 2024-05-06T142745.138.png; see source page]

此处也支持通过写sql自定义筛选条件。

### 3.6 排序

您可以制定按照某一个选定的指标或维度进行正排或倒排。

[image: image - 2024-05-06T142746.625.png; see source page]

### 3.7 设置基准线

您可以指定一个值设为平均线、警戒线、目标达成线等。

[image: image - 2024-05-06T142748.026.png; see source page]

### 3.8 图表类型拓展

除了选择图表类型时可见的基础图表，我们还提供了更多的图表模式设置如下。

1.堆积柱状图，用于对基础柱状图做更精细的分析，配合分组一起使用；

[image: image - 2024-05-06T142749.822.png; see source page]

2.堆积百分比柱状图，常用于表示不同内容的相对占比，配合分组一起使用；

[image: image - 2024-05-06T142902.604.png; see source page]

3.基础面积图，可以配合分组做出如下效果；

[image: image - 2024-05-06T142904.340.png; see source page]

4.百分比面积图，可用于表示不同时间周期内不同内容的占比变化；

[image: image - 2024-05-06T142905.868.png; see source page]

5.环形图，是饼图的另一种表现方法；

[image: image - 2024-05-06T142907.332.png; see source page]

6.表格，表格可以不显示指标，仅显示源数据，从而作为明细表去更好地搭配其他图表展示。如图，被选中的维度即作为表头展示。

[image: image - 2024-05-06T142909.417.png; see source page]

### 3.9 图表样式设置

图表风格可以自由切换，如下：

[image: image - 2024-05-06T143016.265.png; see source page]

[image: image - 2024-05-06T143017.871.png; see source page]

[image: image - 2024-05-06T143019.659.png; see source page]

也可以指定图表元素是否显示，如下：

[image: image - 2024-05-06T143021.322.png; see source page]

[image: image - 2024-05-06T143023.385.png; see source page]

[image: image - 2024-05-06T143108.176.png; see source page]
