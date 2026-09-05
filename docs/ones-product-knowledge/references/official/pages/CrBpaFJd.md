# 用量统计与权限管理

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/CrBpaFJd
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES AI 智能助手 / 配置与管理 / 用量统计与权限管理
Evidence: documentation, not runtime verification

## 用量统计与权限管理

### 用量统计

进入路径：配置中心 > Assistant 配置 > 用量统计。

该页面用于统计 ONES Assistant 的 AI 用量，帮助管理员了解团队的 AI 使用情况并进行成本管控。

页面展示以下指标：

- AI 请求用量：累计的 AI 请求总量

私有部署环境下，AI 请求频次和用量的限制由部署方案决定。如果团队用量接近上限，请联系管理员调整配额或评估是否需要升级方案。

### 权限管理

默认情况下，仅团队负责人可以修改 ONES Assistant 的配置项（包括模型配置、功能配置等）。如果需要授权其他成员参与配置管理，可以在权限设置中添加。

进入路径：配置中心 > 团队权限 > Copilot 管理员。

在该页面中，可以将具有配置权限的成员添加为 Copilot 管理员。被授权的成员将拥有与团队负责人相同的 Assistant 配置管理权限，包括模型配置的查看和修改、功能配置的调整、用量统计的查看等。

建议将 Copilot 管理员权限授予熟悉 AI 模型服务和团队 IT 基础设施的成员，以确保模型配置的合理性和安全性。
