import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Model, Models, Tool } from '@earendil-works/pi-ai';
import { loadMcpConfig } from './config.js';
import { McpHub } from './mcp/index.js';
import { confirmWriteTool } from './tools/confirm.js';
import { buildSystemPrompt } from './prompt.js';

export interface Runtime {
  models: Models;
  model: Model<any>;
  mcp: McpHub;
  tools: Tool[];
  systemPrompt: string;
}

/**
 * Build the shared runtime: model collection + MCP hub + tools + prompt.
 * MCP connection failures are logged but non-fatal, so the UI still starts
 * and shows which servers failed to connect.
 */
export async function createRuntime(): Promise<Runtime> {
  const configPath = process.env.CSM_MCP_CONFIG ?? 'config/mcp.yaml';
  const cfg = loadMcpConfig(configPath);

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
  await mcp.connect(cfg.servers);

  const tools = [confirmWriteTool, ...mcp.toPiTools()];
  const systemPrompt = buildSystemPrompt();
  return { models, model, mcp, tools, systemPrompt };
}
