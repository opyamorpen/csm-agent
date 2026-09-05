# 迁移前检查清单

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/5ZmVyrSX
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / 数据迁移 / Jira数据迁移 / 迁移至 ONES 私有部署 / 迁移前检查清单
Evidence: documentation, not runtime verification

## 迁移前检查清单

## 1 Jira 侧的检查

- 已经修正无效邮箱、重复邮箱的用户信息

- 备份 Jira 系统

- Jira 迁移工具已部署在 Jira 服务器内

- 确定Jira服务器部署形式

## 2 ONES 侧的检查

- 准备测试环境、正式生产环境

- 测试环境、正式生产环境备份

- 迁移数据需要提供环境下的 ONES 管理员账号

  - 如果 ONES 为多团队环境，迁移者需要为组织管理员，并且建议迁移者的 ONES 账号需要为每个团队的超级管理员。

- ONES 环境是否升级到了 v3.13.50

- 评估 ONES 环境磁盘容量是否充足，是否能够支持迁移：需要迁移的附件大小*2 > ONES剩余磁盘

  - ​​​​​​​如：需要迁移 60 GB 大小的 Jira 附件，则迁移至的 ONES 环境磁盘至少需要 120 GB

## 3 Jira 服务器 与 ONES 服务器的检查

当你使用 Jira 迁移工具高级版，在安装 Jira 的服务器中部署迁移工具后，建议你检查 Jira 服务器与 ONES 服务器之间的网络通信情况。

- 部署工具后，可通过以下命令检查Jira 服务器 与 ONES 服务器之间网络是否正常，服务器之间保持通信才可通过 Jira 迁移工具登录至 ONES。

```Plain Text
ssh jira@jira-server-ip



curl  https://{{ones-domain}}/project/api/project/auth/login_support

curl  http://{{ones-domain}}/project/api/project/auth/login_support



{{ones-domain}} 替换为实际的ONES服务域名/IP



返回一段json信息则代表网络通信正常
```
