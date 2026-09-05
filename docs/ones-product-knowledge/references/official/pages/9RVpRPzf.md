# 配置与使用

Source: https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/FhmJNPFc/page/9RVpRPzf
Version: ONES private deployment v7.26.0
Captured: 2026-09-05
Path: 私有部署 - v7.26.0 / 产品手册 / ONES AI 智能助手 / MCP 服务与外部集成 / 配置与使用
Evidence: documentation, not runtime verification

## 配置与使用

本节介绍如何在主流 IDE 和 AI 工具中配置 ONES MCP 服务器，实现在编码环境中直接操作 ONES 数据。

### 准备工作

在开始配置之前，请确保以下条件已满足：

1. 已获取你所在团队的 MCP 服务器地址（获取方式见 [MCP 服务概述]）

2. 本地已安装 Node.js 环境（用于运行 npx mcp-remote 代理）

3. 已安装支持 MCP 协议的客户端（Cursor、Trae 或 Codex）

### 在 Codex 中配置

#### 第一步：进入 MCP 服务器配置

打开 Codex 的设置页面，在左侧导航中选择 MCP 服务器，进入 MCP 配置界面。

#### 第二步：填写表单

Codex 提供了表单化的配置方式，依次填写以下字段：

- 启动命令：npx

- 参数（每行一个）：-y、mcp-remote、https://your-ones-mcp-server

- 环境变量：留空

- 工作目录：填写你的代码项目路径（如 ~/code）

填写完成后点击保存。

#### 第三步：完成授权

保存后 Codex 会启动连接流程并触发 OAuth 授权，操作方式与 Cursor 和 Trae 一致。



### 在 Cursor 中配置

#### 第一步：打开 MCP 配置页面

进入 Cursor 的 Settings > Tools & MCPs 页面。如果尚未配置任何 MCP 服务，页面会显示 "No MCP Tools" 的空状态提示，并提供 "Add Custom MCP" 入口。

#### 第二步：编辑 mcp.json 文件

点击 "Add Custom MCP" 或直接编辑项目根目录下的 .cursor/mcp.json 文件，填入以下配置：

```json
{

  "mcpServers": {

    "ONES": {

      "command": "npx",

      "args": [

        "-y",

        "mcp-remote",

        "https://your-ones-mcp-server"

      ],

      "env": {}

    }

  }

}
```

将 https://your-ones-mcp-server 替换为你从 ONES 个人中心复制的实际 MCP 服务器地址。

#### 第三步：完成授权

保存配置后，Cursor 会自动启动 MCP 连接。首次连接时浏览器会弹出 ONES OAuth 授权页面，选择授权范围后确认即可。授权流程的详细说明见 [MCP 服务概述] 中的「授权流程」章节。

#### 第四步：验证连接

授权成功后，回到 Settings > Tools & MCPs 页面，Installed MCP Servers 下会出现 "ONES" 条目，展开可以看到所有可用的 MCP 工具列表。工具按功能分组显示，包括 create_new_issue、execute_issue_workflow、find_similar_issues、get_issue_activities 等 60+ 个工具。

如果连接失败，请检查以下几点：确认 Node.js 已安装且 npx 命令可用；确认 MCP 服务器地址正确无多余空格；确认网络可以访问 ONES 服务。

### 在 Trae 中配置

#### 第一步：进入 MCP 配置页面

打开 Trae 的 设置 > MCP 页面，点击右上角的添加按钮，选择「手动配置」方式。

#### 第二步：填写配置

在手动配置面板中，切换到简易配置（JSON）标签页，将以下 JSON 配置粘贴到编辑区：

```json
{

  "mcpServers": {

    "ONES": {

      "command": "npx",

      "args": [

        "-y",

        "mcp-remote",

        "https://your-ones-mcp-server"

      ],

      "env": {}

    }

  }

}
```

同样将服务器地址替换为实际地址后点击确认。

#### 第三步：完成授权并验证

确认配置后，Trae 会尝试连接 ONES MCP 服务器并触发 OAuth 授权。授权成功后，MCP 页面中的 ONES 条目会显示为已连接状态，展开后列出所有可用工具及其英文描述。

### 使用场景示例

配置完成后，你可以在 IDE 的 AI 对话窗口中直接与 ONES 交互。以下是一些典型场景：

查询我的待办任务：

```Plain Text
帮我查找分配给我的、状态为进行中的工作项
```

修复缺陷后更新状态：

```Plain Text
将 WORKFLOWAI-15 的状态流转为"已修复"，并添加评论"已在 v2.3.1 分支修复，等待测试验证"
```

批量拆解需求：

```Plain Text
将需求 WORKFLOWAI-10 拆解为 3 个子任务：前端页面开发、后端接口开发、联调测试，分别分配给 alice、bob 和 charlie
```

记录工时：

```Plain Text
为 WORKFLOWAI-15 登记今天的工时 4 小时，备注"完成核心逻辑开发"
```

查找相关文档：

```Plain Text
在知识库中搜索与 SSO 单点登录相关的技术方案文档
```

在 IDE 中使用 ONES MCP 工具时，AI Agent 会根据你的自然语言描述自动选择合适的工具执行操作。你无需记忆具体的工具名称，只需用日常语言描述你想做的事情即可。
