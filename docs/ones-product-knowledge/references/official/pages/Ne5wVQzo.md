# 如何排除异常情况

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/Ne5wVQzo
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 数据迁移 / Jira数据迁移 / 迁移至 ONES 私有部署 / 如何排除异常情况
Evidence: documentation, not runtime verification

## 如何排除异常情况

在使用 Jira 迁移工具的过程中，你可能会遇到不同的异常情况或者报错，你可以通过以下的表格来进行异常情况的排除：

- 如果在异常情况表中无法解决你的问题，请联系 ONES 售后服务团队并提供相关截图或问题描述（联系方式：400-188-1518）。

步骤异常情况原因解决方式

| 步骤 | 异常情况 | 原因 | 解决方式 |
| --- | --- | --- | --- |
| 评估迁移效果模式 | 评估迁移效果模式 | 评估迁移效果模式 | 评估迁移效果模式 |
| 选择 Jira 备份包 | [image: _ylrpHilM; see source page] | 填写“Location of JIRA Local Home”后，未点击「获取Jira备份包」进行路径校验。 | 点击「获取 Jira 备份包」校验路径是否正确。 |
| 评估迁移效果 | [image: _VxVT6Xv9; see source page] | 选择的 Jira 备份包数据格式错误。 | 检查所选择的 Jira 备份包数据格式。 |
| 评估迁移效果 | [image: _hYQ086jX; see source page] | Jira 备份包解析过程中，不在填写的“Location of JIRA Local Home”下。 | 1、检查所填写的“Location of JIRA Local Home”是否正确。<br><br>2、在 Jira 系统中重新备份数据包，上传最新的 Jira 备份包。 |
| 迁移 Jira 数据模式 | 迁移 Jira 数据模式 | 迁移 Jira 数据模式 | 迁移 Jira 数据模式 |
| 登录 ONES | [image: _RE7ZmyI8; see source page] | 1、ONES 账号或密码错误。<br><br>2、可能原因：1）账号或密码错误 2）该账号非填写的 ONES 服务域名/IP内的 ONES 账号。 | 到 ONES 环境中验证正确的账号密码。 |
| 登录 ONES | [image: _1Obu7M0G; see source page] | 填写的 ONES 账号或密码已经错误三次。 | 到 ONES 环境中验证正确的账号密码。 |
| 登录 ONES | [image: _lrlsOJTA; see source page] | 填写的 ONES 服务域名/IP为单团队，能够执行迁移的需要为 ONES 超级管理员。 | 具备 ONES 团队超级管理员权限。 |
| 登录 ONES | [image: _6ACGkpOV; see source page] | 填写的 ONES 服务域名/IP为多团队，能够执行迁移的需要为 ONES组织管理员。 | 具备 ONES 组织管理员权限。 |
| 登录 ONES | [image: _c6tHP5Tx; see source page] | 填写的 ONES 服务域名/IP为多团队，能够执行迁移的需要为当前环境下所有 ONES 团队的超级管理员。 | 具备当前环境下所有 ONES 团队的超级管理员 |
| 选择 Jira 备份包 | [image: _BoG0dsAt; see source page] | 填写“Location of JIRA Local Home”后，未点击「获取 Jira 备份包」进行路径校验。 | 点击「获取 Jira 备份包」校验路径是否正确。 |
| 解析 | [image: _YFCIBuOL; see source page] | 选择的 Jira 备份包数据格式错误。 | 检查所选择的 Jira 备份包数据格式。 |
| 解析 | [image: _iy8fzF6b; see source page] | Jira 备份包解析过程中，不在填写的“Location of JIRA Local Home”下。 | 1、检查所填写的“Location of JIRA Local Home”是否正确<br><br>2、在 Jira 系统中重新备份数据包，上传最新的 Jira 备份包 |
| 解析 | [image: _AlA7ms2N; see source page] | 当前 ONES 服务器下的磁盘容量不足 Jira 备份包全量迁移，可能会引起迁移失败。 | 1、选择数据规模较小的项目进行导入<br><br>2、扩充当前 ONES 服务器下磁盘容量 |
| 解析 | [image: _1vXgGMJC; see source page] | Jira 迁移工具无法获取云储存下磁盘大小，可能会引起迁移失败。 | 1、确认当前 ONES 服务器云储存下磁盘容量大小。 |
| 选择 ONES 团队 | [image: _rRxvSr0b; see source page] | 选择的 ONES 团队中，已经迁移了不同 Jira 服务器的 Jira 备份包。 | 1、选择相同 Jira 服务器 ID 的 Jira 备份包导入到该 ONES 团队。<br><br>2、重新选择 ONES 团队。 |
| 选择 ONES 团队 | [image: _8TWa74Hj; see source page] | 选择的 ONES 团队中，已经迁移了相同版本的 Jira 数据。 | 1、可以选择「继续迁移」。<br><br>2、可以选择「重新选择团队」，选择没有迁移记录的 ONES 团队。 |
| 选择 ONES 团队 | [image: _61LJQE64; see source page] | 选择的 ONES 团队中，已经迁移了不同版本的 Jira 数据。 | 1、可以选择「继续迁移」。<br><br>2、可以选择「重新选择团队」，选择没有迁移记录的 ONES 团队。 |
| 选择 ONES 团队 | [image: _zWTMMOfv; see source page] | 选择的 Jira 备份包不在 Jira 数据迁移工具支持的迁移版本范围内。 | 1、重新选择 Jira 备份包，选择迁移 Jira 数据迁移工具支持的迁移版本范围内的 Jira 版本。<br><br>2、可以选择「继续迁移」。 |
| 选择 ONES 团队 | [image: _20QHlL8W; see source page] | 选择的 ONES 团队曾经通过 ONES 配置中心中迁移过 Jira 数据。 | 重新选择 ONES 团队。 |
| 选择 ONES 团队 | [image: _5egZjQsZ; see source page] | 选择的 ONES 团已经迁移了非 Jira 数据。 | 重新选择 ONES 团队。 |
| 选择 Jira 项目 | [image: _cjqZL43d; see source page] | 选择了需要导入的 Jira 项目及其附件大小已经超过目前 ONES 服务器的磁盘容量。 | 1、选择删减部分需要导入的 Jira 项目。<br><br>2、扩充当前ONES 服务器下磁盘容量。 |
| 查看配置 | [image: _2OnO212i; see source page] | 填写的 ONES 服务域名/IP为单团队，能够执行迁移的需要为 ONES 超级管理员。 | 1、相关迁移配置将会保存。<br><br>2、点击「确认」后将登出账号，返回工具首页。<br><br>3、具备 ONES 超级管理员权限后可重新登录。 |
| 查看配置 | [image: _FfG2_kfU; see source page] | 填写的 ONES 服务域名/IP为多团队，能够执行迁移的需要为 ONES组织管理员。 | 1、相关迁移配置将会保存。<br><br>2、点击「确认」后将登出账号，返回工具首页。<br><br>3、具备 ONES 组织管理员权限后可重新登录。 |
| 查看配置 | [image: _5okGo0C9; see source page] | 填写的 ONES 服务域名/IP为多团队，能够执行迁移的需要为当前环境下所有 ONES 团队的超级管理员。 | 1、相关迁移配置将会保存。<br><br>2、点击「确认」后将登出账号，返回工具首页。<br><br>3、具备当前环境下所有 ONES 团队的超级管理员权限后可重新登录。 |
| 开始迁移 | [image: _diK10pNV; see source page] | 开始迁移时，点击「取消迁移」后已迁移至 ONES 团队中的数据将会保留，无法一键撤回，因此弹窗提醒。 | 开始迁移时，点击「取消迁移」：1、终止迁移进程，已迁移至 ONES 团队的数据将会保留，无法一键撤回。<br><br>2、当前迁移配置将会清空，登出账号。<br><br>3、点击「下载迁移日志」可下载当前执行的迁移日志。 |
| 全局 | [image: _T56uxBrF; see source page] | 迁移步骤中，点击「取消迁移」将清空当前迁移配置，因此弹窗提醒。 |  |
