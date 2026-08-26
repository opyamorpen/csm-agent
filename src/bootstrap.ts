import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Model, Models, Tool } from '@earendil-works/pi-ai';
import { loadDotEnv, loadLlmConfig, saveLlmConfig, providerFor, type McpServerConfig, type LlmConfig } from './config.js';
import { McpHub } from './mcp/index.js';
import { confirmWriteTool } from './tools/confirm.js';
import { resolveCustomerTool } from './tools/customer.js';
import { customerProfileTool, customerEventsTool } from './tools/workbench.js';
import { webSearchTool, recordWebIntelligenceTool } from './tools/websearch.js';
import { buildSystemPrompt, type ToolSummary } from './prompt.js';

export interface Runtime {
  models: Models;
  model: Model<any>;
  mcp: McpHub;
  systemPrompt: string;
  llm: LlmConfig;
  /** Current tool list; refreshed on reload(). New sessions pick it up. */
  tools: Tool[];
  /** Reconnect MCP servers with a new config and refresh the tool list + prompt. */
  reloadMcp: (servers: McpServerConfig[]) => Promise<void>;
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
  return [confirmWriteTool, resolveCustomerTool, customerProfileTool, customerEventsTool, webSearchTool, recordWebIntelligenceTool];
}

/**
 * Build the shared runtime: model collection + MCP hub + tools + prompt.
 * MCP connection failures are logged but non-fatal, so the UI still starts
 * and shows which servers failed to connect.
 */
export async function createRuntime(): Promise<Runtime> {
  loadDotEnv();

  const models = builtinModels();
  const llm = loadLlmConfig();
  // Saved API key takes precedence; otherwise keep env/.env value if present.
  if (llm.apiKey) process.env[llm.apiKeyEnv] = llm.apiKey;

  const model = resolveModel(models, llm);

  const mcp = new McpHub();
  // Note: MCP servers are connected asynchronously AFTER the HTTP server
  // starts (see index.ts), so the UI is available immediately instead of
  // blocking on slow connections (e.g. ONES's OAuth via mcp-remote).

  const runtime: Runtime = {
    models,
    model,
    mcp,
    llm,
    systemPrompt: buildSystemPrompt(toolSummaries(mcp)),
    tools: localTools(),
    reloadMcp: async (servers) => {
      await mcp.reconnect(servers);
      runtime.tools = [...localTools(), ...mcp.toPiTools()];
      runtime.systemPrompt = buildSystemPrompt(toolSummaries(mcp));
    },
    setLlm: (cfg) => {
      const normalized = { ...cfg, apiKeyEnv: providerFor(cfg.provider)?.apiKeyEnv ?? cfg.apiKeyEnv };
      saveLlmConfig(normalized);
      if (normalized.apiKey) process.env[normalized.apiKeyEnv] = normalized.apiKey;
      const next = resolveModel(models, normalized);
      runtime.model = next;
      runtime.llm = normalized;
      return next;
    },
  };
  return runtime;
}
