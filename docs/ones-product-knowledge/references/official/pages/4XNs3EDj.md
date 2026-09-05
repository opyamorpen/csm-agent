# baseURL 修改注意事项

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/4XNs3EDj
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 企业设置 / 高级设置 / baseURL 修改注意事项
Evidence: documentation, not runtime verification

## baseURL 修改注意事项

如果你不得不变更统 baseURL，请先了解以下影响范围，并做好变更计划，以便保障你的团队正常使用系统。我们强烈建议你遵循以下步骤，完成 baseURL 变更过程。

#### 变更步骤：

1. 变更前准备

  1. 阅读下面的 baseURL 修改影响范围与解决方案列表（表1），并确保你对其中每一项都没有疑问；

  2. 准备新的 baseURL（域名或者 IP），并确保终端用户可以在浏览器通过新的 baseURL 访问 ONES 系统；

2. 挑选变更时间

  1. 因为 baseURL 的变更可能会导致一部分功能异常，需要对其进行调整后才可以恢复正常使用。因此我们强烈建议在非工作时间进行baseURL 配置变更。并且预留足够的时间（建议起码 2天）对受影响的功能进行调整以及测试，确保正常使用。

3. 通知所有成员

  1. 变更前通知：终端用户使用新的 baseURL 进行访问需要重新登录；

  2. 变更前通知：新 baseURL 正式可用时间；

  3. 变更前通知：其他可能受影响的使用；

4. 执行变更

  1. 在「高级设置」模块填入新 baseURL 值，然后更新；

5. 调整其他受影响的功能与配置项

  1. 对照受影响的功能列表（表1），根据指引逐一对受影响功能进行调整，并验证正常可用；

6. 团队成员通过新 baseURL 正常使用系统

  1. 配置变更结束，告知团队成员可以通过新 baseURL 正常使用系统。

表1：baseURL 修改影响范围与解决方案

| 业务模块 | 影响范围（以下情况可能发生） | 解决方案 |
| --- | --- | --- |
| 工单小程序 | - 工单小程序全体功能不可用 | 调整后，需要在「企业微信管理」后台调整 ONES 的回调地址； |
| 插件 | - 依赖 ONES Baseurl 回调地址的插件不可用 | 调整插件实现，更新插件版本； |
| wps | - wps 全体功能不可用 | 调整后，需要在 wps 后台 调整 ONES 的回调地址； |
| 第三方登录 | - 以下三方集成所有功能不可用<br><br>- 企业微信<br><br>- 飞书<br><br>- 钉钉<br><br>- 谷歌<br><br>- SAML<br><br>- CAS | baseURL 变更后，需要在调整第三方集成的回调地址后，第三方集成才可以恢复正常使用。各集成调整方式如下：<br><br>1. 企业微信：<br><br>      1. 单点登录：配置自检应用→可信域名、授权回调域需要更新为新的 baseURL；（不可用）<br><br>      2. 单点登录：企业微信后台把「应用主页」将 Project 前内容替换成 baseURL内容；<br><br>      3. 同步：「企业微信管理工具」→「通讯录同步」→「设置接收事件服务器」中的 URL 字段，将 project 前内容替换成 baseURL 内容；<br><br>2. 飞书：<br><br>      1. 在飞书后台→「自建应用详情」→「应用功能」→「网页」→「桌面端主页」、「移动端主页」中将 Project 前内容替换成 baseURL 内容；<br><br>      2. 在飞书后台→「自建应用详情」→「安全设置」→「重定向URL」中的「绑定企业重定向 URL」、「登录重定向 URL」内容，将 Project 前内容替换成 baseURL内容；<br><br>      3. 设置同步，进入飞书开放平台→「自建应用详情」→「事件订阅」，将 「请求网址URL」内容中 project 前内容替换成 baseURL 内容；<br><br>3. 钉钉：<br><br>      1. 进入「应用详情」→「基础信息」→「开发管理」下的「应用首页地址」中的 project 前内容替换成 baseURL 内容；<br><br>      2. 进入「应用详情」→「应用功能」→「登录与分享」下的「回调域名」替换成 baseURL 内容；<br><br>      3. 同步，进入「钉钉开放平台」→「应用详情」→「应用功能」→「事件与回调」内容中 Project前内容替换成 baseURL 内容；<br><br>4. Google SSO：<br><br>      1. 到 Google 控制台调整相关回调地址；<br><br>5. SAML：<br><br>      1. 将 SAML 服务中的回调地址替换成 baseURL 内容。<br><br>      2. 将 SAML 服务中的 ONES 系统元数据地址内容中 api 前内容替换成 baseURL 内容；<br><br>6. CAS：<br><br>      1. 将 CAS 服务中的回调地址替换成 baseURL 内容。 |
| 邮件通知、企业微信通知 | 变更前发送的旧邮件内包含的链接可能无法打开，包括以下通知类型：<br><br>- 工作项通知<br><br>- 证书过期通知<br><br>- 密码过期通知<br><br>- 新增相关工作项通知 | 无解决方案 |
| 对象存储 | 以下情况可能发生：<br><br>附件不可上传、下载、预览；<br><br>Wiki 页面无法查看、编辑、新建；<br><br>头像、logo、ico不可上传、查看； | 存储类型为 【对象存储】，需要到对象存储管理后台调整跨域配置； 存储类型为 【插件提供存储】，是否有影响，取决于插件的实现。如果有影响需要修改插件。 |
| Devops | - Devops的回调<br><br>- OAuth认证 | 需要到对接的流水线那边，调整ONES的回调地址<br><br>1. GitHub/公有Gitlab：<br><br>       a. 系统自动重置webhook：点击「重置webhook」；<br><br>       b. 手工配置webhook：在对应的代码仓中点击：Settings→Webhook 将 Webhook URL 中的内容中 project 前内替               换成 baseURL内容。<br><br>       c. Github 和公有Gitlab 对应应用中的 Redirect URI 中的 project 前内容替换成 baseURL内容。<br><br>2. 私有 GitLab：<br><br>  1. 系统自动重置webhook：点击「重置webhook」；<br><br>  2. 手工配置webhook：在对应的代码仓中点击：Settings→Webhook 将 Webhook URL 中的内容中 project 前内替换成 baseURL内容。<br><br>  3. 在 GitLab 中点击：Settings → Applications 中的 Redirect URI 中的 project 前内容替换成 baseURL内容。<br><br>3. SVN：<br><br>  1. 重新操作「配置 Webhook」中的第二步；<br><br>4. 私有部署 Bitbucket：<br><br>  1. 系统自动重置webhook：点击「重置webhook」；<br><br>  2. 手工配置webhook：在对应的代码仓中点击：Settings→Webhook 将 Webhook URL 中的内容中 project 前内容替换成 baseURL内容。 |
| 导入工具 | - Confluence 导入<br><br>- Jira 导入 | 需要到导入工具那边，调整ONES的回调地址 |
