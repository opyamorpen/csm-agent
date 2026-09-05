# 登录验证

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/YS9kSvv9
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 管理员手册 / 账号集成 / 了解账号集成 / 登录验证
Evidence: documentation, not runtime verification

## 登录验证

## 1.概述

ONES 支持通过外部服务进行验证登录，包括 AD/LDAP 验证，主流企业级IM工具、标准协议单点登录（SSO）等。通过外部服务登录 ONES 有以下好处：

1. 相比起简单的账密登录，单点登录等验证方式更加安全快捷；

2. 如果你的团队使用多个子系统，单点登录可以大大降低用户登录、使用系统的操作成本；

3. 终端用户无需记住密码，为使用系统带来便捷性；

[image: image (19).png; see source page]

## 2.系统支持的登录验证服务与协议

| 登录验证服务与协议 |
| --- |
| [LDAP](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/7kgu26Pt) |
| [AD](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Ut5d8BM7) |
| [钉钉](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/TDCogFi4) |
| [企业微信](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/Dp1AfNq7) |
| [飞书](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/5tQvsrBe) |
| [CAS 2.0](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/RUGuqAzF) |
| [SAML 2.0](https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/JrZtz5TS/page/5CkczZhV) |

## 3.JIT (Just-In-Time) 登录方式

当不确定有什么团队成员需要使用 ONES 工作时，可以使用 JIT 登录方式。当成员需要使用ONES 时，可以通过外部服务 JIT 登录到系统时，系统将自动为成员生成账号，成员进入系统后即可正常使用。
