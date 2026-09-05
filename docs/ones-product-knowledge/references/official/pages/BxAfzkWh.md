# 级联属性

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/BxAfzkWh
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 工作项 / 工作项属性类型 / 级联属性
Evidence: documentation, not runtime verification

## 级联属性

## 1.什么是级联属性？

级联属性是一种具有层级结构的选择字段，通过父子关系组织选项，上级选择决定下级可选范围，常用于地理位置选择（国家→省份→城市）、产品分类（大类→子类→具体型号）等需要逐级筛选的场景。

## 2.配置级联属性

1. 支持配置单选、多选级联属性

2. 级联属性支持配置「可选层级」，包含

  - 必须选到末级

  - 可选到任意一级

3. 配置选项：支持配置最多 12 个层级，可批量导入选项

[image: image.png; see source page]

[image: image.png; see source page]

## 3.使用属性说明

### 3.1 填写属性

可选到任意一级

[image: image.png; see source page]

必须选到末级

[image: image.png; see source page]

### 3.2 筛选说明

1. 填写属性，选择某个选项后，在选择框中展示属性值会默认带上父路径，但实际存储的值是具体的某个子节点，因此筛选工作项时，实际需要选中具体的子节点才可以筛选到对应的工作项数据

[image: image.png; see source page]

1. 筛选工作项的时候，若只选中父节点，只会筛选该父节点相关的值，若需要筛选包含子节点的工作项，可以勾选「包含子选项」

[image: image.png; see source page]

1.
