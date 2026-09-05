# 邮件设置

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/FMiza5KR
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 企业设置 / 邮件设置
Evidence: documentation, not runtime verification

## 邮件设置

#### 功能入口与权限

多团队的组织管理员可前往：「组织管理」>「邮件设置」；单团队的超级管理员或团队管理员可前往：「配置中心」>「邮件设置」，进行邮件通知服务配置。

#### 功能说明

配置后，可以实现通过邮件发送工作项、页面等动态通知。

##### 1. 开启邮件通知服务

在「邮件设置」中开启「邮件通知服务」。

###### 1.1 设置 SMTP 信息

在出现的设置页面中，设置 SMTP 信息。包括SMTP 服务器地址、SMTP 服务器端口、SMTP 用户名、SMTP 密码，并设置验证方式（Plain、SSL、StartTLS）

「SMTP 服务器端口」与「验证方式」填写注意事项：

为保证邮件正常发送，请通过你的 SMTP 服务器供应商确定端口号与验证方式的对应关系，填写正确端口号与对应验证方式；

「SMTP 用户名」填写注意事项：

如果你的 SMTP 服务支持单独的 SMTP 用户，请将对应用户名填写到「SMTP 用户名」中。如果没有区分，请将发件人邮箱充当 SMTP 用户，填进「SMTP 用户名」中。

「SMTP 密码」填写注意事项：

如果你的 SMTP 服务设置开启了「客户端授权码」，你可能不能直接通过 SMTP 用户的登录密码来配置「SMTP 密码」。这种情况请在 SMTP 服务中生成授权码密码，把生成的授权密码填写到「SMTP 密码」输入框中；

[image: _CJlw9oMB; see source page]

###### 1.2 设置邮件模版

设置发送邮件所显示的：主题、发件人名称、发件人邮箱、顶栏信息、签名与备案信息，具体发送效果见下图。

[image: _8IvKBlrx; see source page]

###### 1.3 点击「保存」

系统将自动检测填写信息是否有效，如果检测通过将自动保存设置并启用邮件通知服务。

##### 2. 勾选「邮件」通知方式

你可以在工作项通知、工作项提醒、页面通知等通知功能中，勾选邮件通知方式。

[image: _kQ8eVil7; see source page]
