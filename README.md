# csm-agent

面向 **CSM（客户成功经理）** 的最小自研 agent。它通过 MCP 连接三套内部系统——
CRM、ONES（项目管理）、长期录音系统——读取数据，综合成三类结构化产出，
并在**人工确认后**回写：

| 产出 | 回写目标 |
|---|---|
| 客户跟进记录 | CRM |
| 客户档案 | ONES（默认 Wiki 页面组「客户档案」） |
| 客户案例 | ONES（默认 Wiki 页面组「案例库」） |

技术上**不依赖 DeepSeek Harness**：
- LLM 层：`@earendil-works/pi-ai`（统一 LLM API，支持 DeepSeek / OpenAI / Anthropic 等）
- MCP 层：官方 `@modelcontextprotocol/sdk`（stdio 与 streamable-http）
- agent 循环：自研（`src/agent.ts`，约 200 行）

## 目录结构

```
csm-agent/
├── config/mcp.yaml        # 三个 MCP server 连接与凭据引用（占位，需填真实端点）
├── skills/                # 可移植「大脑」：工作流（markdown），版本化、可团队分发
│   ├── identity-resolution.md
│   ├── followup.md
│   ├── profile.md
│   └── case.md
├── templates/             # 三类产出的 JSON Schema（字段契约）
│   ├── followup.json
│   ├── profile.json
│   └── case.json
├── src/
│   ├── index.ts           # CLI 入口
│   ├── agent.ts           # thin agent loop + confirm_write 确认闸门
│   ├── prompt.ts          # CSM 人设 + 系统提示词（加载 skills/templates）
│   ├── config.ts          # 加载 config/mcp.yaml，展开 ${ENV_VAR}
│   ├── mcp/
│   │   ├── index.ts       # MCP 连接、工具注册、调用分发
│   │   └── schema.ts      # JSON Schema → TypeBox 转换
│   └── tools/
│       └── confirm.ts     # confirm_write 工具（回写前人工批准）
└── tests/                 # node:test 单测（确认闸门、schema 转换、env 展开）
```

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置
cp config/mcp.yaml config/local.yaml   # 填入真实 MCP 端点与凭据环境变量

# 3. 注入凭据
export DEEPSEEK_API_KEY=...            # LLM（默认 deepseek/deepseek-v4-flash）
export ONES_MCP_TOKEN=...
export CRM_MCP_TOKEN=...
export RECORDING_MCP_TOKEN=...

# 4. 跑起来（CLI，交互式确认）
npm run dev "整理 XX 客户本周的跟进记录"
```

模型可用环境变量覆盖：`CSM_PROVIDER`（默认 `deepseek`）、`CSM_MODEL`（默认 `deepseek-v4-flash`）。

## 确认协议（硬约束）

任何**写操作**（创建/更新 CRM 跟进记录、创建 ONES 页面/工作项等）都必须先经过
`confirm_write` 工具获得人工批准：

1. 模型综合出草稿后，调用 `confirm_write`，把草稿摘要 + 完整字段展示给 CSM。
2. agent 循环挂起，等待 CSM 在交互界面批准/拒绝。
3. 批准后才放行本次写工具调用（一次性，用完即失效）；拒绝则写工具调用会被拒绝并提示修改。

`confirm_write` 在 **agent 循环层**强制校验，而非仅靠提示词——未经批准直接调用写工具会被拦截。

## 依赖版本说明

- `@earendil-works/pi-ai` 锁定 `0.82.1`（API 已据此验证；升级前跑回归）。
- `@modelcontextprotocol/sdk` 锁定 `1.30.0`。
- Node >= 20。

## 边界与已知限制

- MCP 只桥接 tools（resources/prompts 未用）；录音系统需以 tool 暴露转录文本。
- 写/读工具判定用 `writeToolPatterns` 启发式，阶段 0 拿到真实 tool 清单后需校准。
- 会话持久化/压缩、Web UI、Mac 打包为后续阶段（见仓库 issue / roadmap）。
