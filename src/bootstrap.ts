import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Model, Models, Tool } from '@earendil-works/pi-ai';
import { loadMcpServers, loadDotEnv, type McpServerConfig } from './config.js';
import { McpHub } from './mcp/index.js';
import { confirmWriteTool } from './tools/confirm.js';
import { resolveCustomerTool } from './tools/customer.js';
import { buildSystemPrompt, type ToolSummary } from './prompt.js';

export interface Runtime {
  models: Models;
  model: Model<any>;
  mcp: McpHub;
  systemPrompt: string;
  /** Current tool list; refreshed on reload(). New sessions pick it up. */
  tools: Tool[];
  /** Reconnect MCP servers with a new config and refresh the tool list + prompt. */
  reload: (servers: McpServerConfig[]) => Promise<void>;
}

function toolSummaries(mcp: McpHub): ToolSummary[] {
  return mcp.listTools().map((t) => ({
    server: t.server,
    name: t.publicName,
    description: t.description,
  }));
}

/**
 * Build the shared runtime: model collection + MCP hub + tools + prompt.
 * MCP connection failures are logged but non-fatal, so the UI still starts
 * and shows which servers failed to connect.
 */
export async function createRuntime(): Promise<Runtime> {
  loadDotEnv();

  const models = builtinModels();
  const provider = process.env.CSM_PROVIDER ?? 'deepseek';
  const modelId = process.env.CSM_MODEL ?? 'deepseek-v4-flash';
  const model = models.getModel(provider, modelId);
  if (!model) {
    throw new Error(
      `找不到模型 ${provider}/${modelId}；可用的 deepseek 模型: ${models.getModels('deepseek').map((m) => m.id).join(', ')}`,
    );
  }

  const mcp = new McpHub();
  await mcp.connect(loadMcpServers());

  const runtime: Runtime = {
    models,
    model,
    mcp,
    systemPrompt: buildSystemPrompt(toolSummaries(mcp)),
    tools: [confirmWriteTool, resolveCustomerTool, ...mcp.toPiTools()],
    reload: async (servers) => {
      await mcp.reconnect(servers);
      runtime.tools = [confirmWriteTool, resolveCustomerTool, ...mcp.toPiTools()];
      runtime.systemPrompt = buildSystemPrompt(toolSummaries(mcp));
    },
  };
  return runtime;
}
