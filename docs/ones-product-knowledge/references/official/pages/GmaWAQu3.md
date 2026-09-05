# 信息安全

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/GmaWAQu3
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 安全与合规 / 成员安全设置 / 信息安全
Evidence: documentation, not runtime verification

## 信息安全

#### 功能入口与权限

多团队的组织管理员可前往：「组织管理」>「成员安全设置」；单团队的超级管理员或团队管理员可前往：「配置中心」>「成员安全设置」，进行信息安全设置。

#### 功能说明

[image: _mz4tBDp7; see source page]

##### 成员邮箱可见性

将「成员邮箱可见性」配置为”加密”，以避免泄露成员邮箱信息。将成员邮箱可见性设置为「加密」后， 系统将隐藏邮箱前段信息，例如 email@example.com 加密成 ***@example.com。此外，团队成员仍能使用邮箱搜索成员。如下图，在选择工作项负责人的下拉菜单中，加密成员邮箱的效果。

[image: _XAQWNkUy; see source page]

##### 获取成员方式

设置「获取成员方式」，以定义团队成员在下拉菜单、弹窗等功能中，获取成员列表的方式。将获取成员方式设置为「受限」后，仅能通过搜索获取成员”，则除团队配置中心的页面外，团队成员只能通过搜索获取成员，系统默认不展示成员列表。

[image: _nnM0MHuO; see source page]

##### 工作项成员属性可选范围

设置「工作项成员属性可选范围」，以定义工作项成员属性获取成员的范围。将「工作项成员属性可选范围」设置为「所属项目的项目成员」后，项目内的成员属性字段仅可选择项目成员。配置会与“成为负责人”权限叠加生效。
