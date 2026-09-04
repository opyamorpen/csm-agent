import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Model, Models, Tool } from '@earendil-works/pi-ai';
import { loadDotEnv, loadLlmConfig, saveLlmConfig, providerFor, loadUserMcpServers, type McpServerConfig, type LlmConfig } from './config.js';
import { registerCustomProvider, CUSTOM_PROVIDER_ID } from './custom-llm.js';
import { McpHub } from './mcp/index.js';
import { confirmWriteTool } from './tools/confirm.js';
import { resolveCustomerTool } from './tools/customer.js';
import { customerProfileTool, customerEventsTool } from './tools/workbench.js';
import { customerDetailTool } from './tools/customer-detail.js';
import { webSearchTool, recordWebIntelligenceTool } from './tools/websearch.js';
import { onesDeskFieldsTool } from './tools/onesdesk.js';
import { buildSystemPrompt, type ToolSummary } from './prompt.js';

export interface Runtime {
  models: Models;
  model: Model<any>;
  /** 按用户的 MCP 运行时：会话与写审批一律走属主本人的凭证连接。 */
  users: UserRuntimes;
  /** 系统（后台同步/生成服务）连接池：attachSystemUser 指定 admin 为系统用户后指向其 hub。 */
  readonly mcp: McpHub;
  llm: LlmConfig;
  /** Current tool list; refreshed on reload(). New sessions pick it up. */
  readonly tools: Tool[];
  readonly systemPrompt: string;
  /** 指定系统用户（admin）：其连接池同时服务后台任务，runtime.mcp/tools/systemPrompt 随之指向。 */
  attachSystemUser(userId: number): void;
  /** Switch the LLM (provider/model/apiKey). Persists and re-resolves the model. */
  setLlm: (cfg: LlmConfig) => Model<any>;
}

function toolSummaries(mcp: McpHub): ToolSummary[] {
  return mcp.listTools().map((t) => ({
    server: t.server,
    name: t.publicName,
    description: t.description,
  }));
}

/** Expose the API key as the provider's expected env var, then resolve the model. */
function resolveModel(models: Models, cfg: LlmConfig): Model<any> {
  if (cfg.apiKey) process.env[cfg.apiKeyEnv] = cfg.apiKey;
  const model = models.getModel(cfg.provider, cfg.model);
  if (!model) {
    const known = models
      .getModels(cfg.provider)
      .map((m) => m.id)
      .join(', ');
    throw new Error(`找不到模型 ${cfg.provider}/${cfg.model}；该 provider 可用模型: ${known || '(无)'}`);
  }
  return model;
}

/** Local (non-MCP) tools available to every session. */
export function localTools(): Tool[] {
  return [confirmWriteTool, resolveCustomerTool, customerProfileTool, customerEventsTool, customerDetailTool, webSearchTool, recordWebIntelligenceTool, onesDeskFieldsTool];
}

/** 一个登录用户的 MCP 运行时：本人的 hub + 派生工具表与系统提示词。 */
export interface UserRuntime {
  userId: number;
  mcp: McpHub;
  tools: Tool[];
  systemPrompt: string;
}

/**
 * 按用户的 MCP 连接池：每人各带 CRM/ONES/Hemory 凭证，会话与外部写走属主连接。
 * get() 同步返回（hub 可能仍在后台连接——与旧启动行为一致：HTTP 先行，MCP 后连，
 * 工具表连完后原地刷新，在途会话经 live getter 逐轮取新）。缓存的 hub 不逐出：
 * 连接均为 streamable-http 客户端，常驻成本可忽略（stdio OAuth 桥亦随用户常驻）。
 */
export class UserRuntimes {
  private readonly cache = new Map<number, UserRuntime>();
  private readonly connected = new Set<number>();

  get(userId: number): UserRuntime {
    const rt = this.ensure(userId);
    if (!this.connected.has(userId)) {
      this.connected.add(userId);
      this.connectInBackground(rt);
    }
    return rt;
  }

  /** 配置重存：断开旧连接并按新配置全量重连，工具表/提示词随后刷新。 */
  async reconnect(userId: number): Promise<void> {
    const rt = this.ensure(userId);
    this.connected.add(userId);
    await rt.mcp.reconnect(loadUserMcpServers(userId));
    this.refresh(rt);
  }

  /** 断连自愈：遍历缓存用户，只重试仍处 failures 的服务（每人每次重读自己的配置）。 */
  async retryFailed(): Promise<void> {
    for (const rt of this.cache.values()) {
      if (rt.mcp.failures.size === 0) continue;
      try {
        await rt.mcp.retryFailed(loadUserMcpServers(rt.userId));
        this.refresh(rt);
      } catch (err) {
        console.error(`[mcp] 用户 ${rt.userId} 断连自愈重试失败:`, err);
      }
    }
  }

  /** 当前缓存的全部用户运行时（诊断/自愈循环遍历用）。 */
  list(): UserRuntime[] {
    return [...this.cache.values()];
  }

  failuresOf(userId: number): Array<[string, string]> {
    const rt = this.cache.get(userId);
    return rt ? [...rt.mcp.failures.entries()] : [];
  }

  private ensure(userId: number): UserRuntime {
    let rt = this.cache.get(userId);
    if (!rt) {
      rt = { userId, mcp: new McpHub(), tools: localTools(), systemPrompt: buildSystemPrompt([]) };
      this.cache.set(userId, rt);
    }
    return rt;
  }

  private connectInBackground(rt: UserRuntime): void {
    void (async () => {
      try {
        await rt.mcp.connect(loadUserMcpServers(rt.userId));
      } catch (err) {
        console.error(`[mcp] 用户 ${rt.userId} 连接失败:`, err);
      } finally {
        this.refresh(rt);
      }
    })();
  }

  private refresh(rt: UserRuntime): void {
    rt.tools = [...localTools(), ...rt.mcp.toPiTools()];
    rt.systemPrompt = buildSystemPrompt(toolSummaries(rt.mcp));
  }
}

/**
 * Build the shared runtime: model collection + per-user MCP runtimes + tools + prompt.
 * MCP connection failures are logged but non-fatal, so the UI still starts
 * and shows which servers failed to connect.
 */
export async function createRuntime(): Promise<Runtime> {
  loadDotEnv();

  const models = builtinModels();
  const llm = loadLlmConfig();
  // Saved API key takes precedence; otherwise keep env/.env value if present.
  if (llm.apiKey) process.env[llm.apiKeyEnv] = llm.apiKey;
  if (llm.provider === CUSTOM_PROVIDER_ID && llm.baseUrl) registerCustomProvider(models, llm);

  const model = resolveModel(models, llm);

  const users = new UserRuntimes();
  // 系统（后台服务）连接池：attachSystemUser 之前是一个空 hub 占位，
  // startServer 在 ensureBootstrapAdmin 之后立刻挂接 admin 的运行时。
  let systemRt: UserRuntime | null = null;
  const placeholderHub = new McpHub();

  const runtime: Runtime = {
    models,
    model,
    users,
    llm,
    get mcp(): McpHub {
      return systemRt?.mcp ?? placeholderHub;
    },
    get tools(): Tool[] {
      return systemRt?.tools ?? [];
    },
    get systemPrompt(): string {
      return systemRt?.systemPrompt ?? '';
    },
    attachSystemUser(userId: number): void {
      systemRt = users.get(userId);
      console.log(`[mcp] 系统用户连接池已挂接（用户 ${userId}），后台同步/生成走其凭证`);
    },
    setLlm: (cfg) => {
      const normalized = { ...cfg, apiKeyEnv: providerFor(cfg.provider)?.apiKeyEnv ?? cfg.apiKeyEnv };
      if (normalized.provider === CUSTOM_PROVIDER_ID && normalized.baseUrl && normalized.model) {
        registerCustomProvider(models, normalized);
      }
      // Resolve before persisting so a bad model never lands on disk and
      // breaks the next boot.
      const next = resolveModel(models, normalized);
      saveLlmConfig(normalized);
      runtime.model = next;
      runtime.llm = normalized;
      return next;
    },
  };
  return runtime;
}
