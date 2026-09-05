# 引用外部数据属性

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/7HQmBFVx
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 工作项 / 工作项属性类型 / 引用外部数据属性
Evidence: documentation, not runtime verification

## 引用外部数据属性

该字段类型可将外部系统数据通过接口传入ONES后，经过清洗转换函数，转化为系统内的菜单的选项值。



具体配置方法如下：

[image: _1Ydm6CiV; see source page]

1. 创建字段，选择类型为“单选/多选 引用外部数据”

2. 点击“外部数据配置”按钮，在新弹窗中进行接口与约束相关配置

[image: _6_i_G7J6; see source page]

[image: _kXWKkEof; see source page]

3. 外部URL中输入接口的链接

4. Method如果选择“POST”下方会出现body条件。

[image: _WAR5FZu5; see source page]

3.

5. 输入外部URL以后，【接口校验】按钮可点击，点击后，跳出弹窗出现接口返回参数，用户可确认接口返回值是否是要引用的信息，并在【校验接口】后方显示接口校验结果。

6. 点击确定可完成字段创建

6.
