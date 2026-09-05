# 如何配置多个集成组合使用？以AD和企业微信为例

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/Qb4g3X1N
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 常见问题 / 集成如何组合使用 / 如何配置多个集成组合使用？以AD和企业微信为例
Evidence: documentation, not runtime verification

## 如何配置多个集成组合使用？以AD和企业微信为例

## 1.适用版本

此文档仅适用于「企业版-私有部署」的 ONES 系统 v3.6及以后的版本

## 2. 功能场景

如果企业用户目录服务和企业IM应用之间没有打通用户数据，或者企业内部使用了不同的IM应用，比如飞书、企业微信，企业通常需要在各个系统中维护的应用账号。企业可以在ONES系统中添加多个账号集成，通过相同的邮箱将不同应用账号匹配到统一的系统账号，本文内容以配置「AD」用户目录同步和「企业微信」消息通知为例介绍了如何通过“匹配邮箱相同的账号”实现多集成的组合使用。

## 3. 操作流程

#### 3.1 添加同步源「AD」

打开「账号集成」首页，添加「AD」并且启用「用户目录同步」，AD配置详情可以查看：[AD集成配置](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/SR7kTUiA/page/NdeMYR5Z)

[image: image (31).png; see source page]

在「添加LDAP/AD」页面选择账号绑定方式时需要选择 “自动绑定「邮箱」相同的系统账号”。

[image: image (32).png; see source page]

在详情启用「用户目录同步」。

[image: image (33).png; see source page]

### 3.2 配置「企业微信」消息通知

完成配置并启用「AD」后，继续在「账号集成」添加「企业微信」，企业微信配置详情可以查看[企业微信集成配置](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/SR7kTUiA/page/BpZcPqse)

[image: image (34).png; see source page]

在「添加企业微信」页面选择账号绑定方式时需要选择 “自动绑定「邮箱」相同的系统账号”；

[image: image (35).png; see source page]

添加「企业微信」后，在详情启用「消息通知」。

[image: image - 2024-05-15T145550.556.png; see source page]

完成上述配置后，通过AD同步的用户即可以直接在「企业微信」接受和查看系统消息。
