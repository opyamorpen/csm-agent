# 其他说明

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/Hq17rhUK
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES Project / 工时管理 / 资源管理 / 其他说明
Evidence: documentation, not runtime verification

## 其他说明

### 顶部导航栏设置

支持管理员配置应用顶部导航栏的排序、启用、禁用

[image: _exAc6rAY; see source page]



### 数据查看权限

每个成员在团队中的角色各不相同，为合适的成员授予合适的权限至关重要。不同权限的成员，在 资源管理 应用中查看数据的方式与操作都各不相同。

资源管理作为一个跨项目统筹管理的场景，在 规划与跟踪 中，系统会根据成员在所有项目中的工作项数据计算排期、投入以及饱和值情况，包括查看者无权查看的项目或工作项类型。为了避免敏感信息泄露，规划与跟踪 会对根据查看者的权限，对成员的工作项数据进行相应的过滤处理。

- 无工作项编辑权限或管理工时权限，查看者仅可查看工作项详情。

[image: _HBlb8RYO; see source page]

- 无项目查看权限或工作项查看权限，查看者仅可查看工作项标题，不可查看工作项详情。

[image: _dVzLPLXs; see source page]



### 功能权限配置

「资源管理」管理员：拥有此权限的成员，可以查看、编辑 资源管理 中 规划与跟踪 、 工时报表 和 工时日志 的全部团队数据。

- 具备 超级管理员 或 团队管理员 权限的成员，可以前往 配置中心-团队配置-团队权限 中设置此权限。
