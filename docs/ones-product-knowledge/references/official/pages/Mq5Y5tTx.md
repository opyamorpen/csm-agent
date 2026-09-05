# MCP 服务与外部集成

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/Mq5Y5tTx
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES AI 智能助手 / MCP 服务与外部集成
Evidence: documentation, not runtime verification

## MCP 服务与外部集成

ONES 遵循 MCP（Model Context Protocol）开放标准，将平台能力以工具集的形式对外发布。任何支持 MCP 协议的客户端——包括 Cursor、Trae、Codex 等 AI 编程工具，以及 Notion 等效率工具——都可以通过 OAuth 授权连接 ONES，在各自的工作界面中直接读取和操作 ONES 数据。

这意味着你不需要离开正在使用的工具，就能完成查询工作项、更新状态、记录工时、搜索知识库等操作。ONES 目前发布了 60+ MCP 工具，覆盖项目管理、知识库、测试管理和账号信息等模块。

本章介绍 MCP 服务的基本概念、授权管理流程，以及在主流 IDE 中的集成配置方法。
