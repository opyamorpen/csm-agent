import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@earendil-works/pi-ai';
import type { McpServerConfig } from '../config.js';
import { jsonSchemaToTypeBox } from './schema.js';

export interface McpToolSpec {
  publicName: string;
  server: string;
  rawName: string;
  description: string;
  inputSchema: unknown;
}

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
  tools: McpToolSpec[];
}

export const DEFAULT_WRITE_PATTERNS = [
  'create', 'update', 'delete', 'add', 'save', 'write', 'post', 'put', 'insert', 'remove', 'log', 'publish',
];

export function toPublicName(server: string, raw: string): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${sanitize(server)}__${sanitize(raw)}`;
}

/** Heuristic: a tool whose (lowercased) name contains any pattern is a write. */
export function isWriteToolName(rawName: string, patterns: string[]): boolean {
  const n = rawName.toLowerCase();
  return patterns.some((p) => n.includes(p.toLowerCase()));
}

export function mcpResultToText(result: unknown): string {
  const r = result as { content?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content as Array<Record<string, unknown>>) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block && block.type === 'resource' && (block.resource as { uri?: string })?.uri) {
        parts.push(`[resource: ${(block.resource as { uri: string }).uri}]`);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
  }
  if (r.structuredContent !== undefined) {
    const structured = JSON.stringify(r.structuredContent);
    // Some servers return the same JSON in a text block and structuredContent.
    // Keeping both makes the otherwise valid JSON impossible to parse downstream.
    if (!parts.includes(structured)) parts.push(structured);
  }
  return parts.join('\n') || '(empty result)';
}

export class McpHub {
  private servers = new Map<string, ConnectedServer>();
  private toolIndex = new Map<string, { server: string; rawName: string; client: Client }>();

  /** Servers that failed to connect, keyed by server name. */
  readonly failures = new Map<string, string>();

  async connect(configs: McpServerConfig[]): Promise<void> {
    for (const cfg of configs) {
      try {
        await this.connectOne(cfg);
      } catch (err) {
        const message = (err as Error).message;
        this.failures.set(cfg.name, message);
        console.warn(`[mcp] 连接 "${cfg.name}" 失败（已跳过）: ${message}`);
      }
    }
  }

  /** Close all connections and reconnect with a fresh config. */
  async reconnect(configs: McpServerConfig[]): Promise<void> {
    await this.closeAll();
    this.servers.clear();
    this.toolIndex.clear();
    this.failures.clear();
    await this.connect(configs);
  }

  private async connectOne(cfg: McpServerConfig): Promise<void> {
    const client = new Client({ name: 'csm-agent', version: '0.1.0' }, { capabilities: {} });
    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new Error(`MCP server "${cfg.name}": stdio transport requires "command"`);
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        stderr: 'inherit',
      });
      await client.connect(transport);
    } else {
      if (!cfg.url) throw new Error(`MCP server "${cfg.name}": streamable-http transport requires "url"`);
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
      await client.connect(transport);
    }

    const listed = await client.listTools();
    const specs: McpToolSpec[] = (listed.tools ?? []).map((t) => ({
      publicName: toPublicName(cfg.name, t.name),
      server: cfg.name,
      rawName: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));

    this.servers.set(cfg.name, { config: cfg, client, tools: specs });
    for (const spec of specs) {
      this.toolIndex.set(spec.publicName, { server: cfg.name, rawName: spec.rawName, client });
    }
  }

  listTools(): McpToolSpec[] {
    return [...this.servers.values()].flatMap((c) => c.tools);
  }

  /** Names of currently connected servers (diagnostics for unknown-tool errors). */
  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  toPiTools(): Tool[] {
    return this.listTools().map((t) => ({
      name: t.publicName,
      description: `${t.description}\n\n(MCP server: ${t.server})`,
      parameters: jsonSchemaToTypeBox(t.inputSchema),
    }));
  }

  resolve(publicName: string): { server: string; rawName: string } | undefined {
    const t = this.toolIndex.get(publicName);
    return t ? { server: t.server, rawName: t.rawName } : undefined;
  }

  isWrite(server: string, rawName: string): boolean {
    const cfg = this.servers.get(server)?.config;
    if (cfg?.readTools?.includes(rawName)) return false;
    if (cfg?.writeTools?.includes(rawName)) return true;
    const patterns = cfg?.writeToolPatterns ?? DEFAULT_WRITE_PATTERNS;
    return isWriteToolName(rawName, patterns);
  }

  async call(publicName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const t = this.toolIndex.get(publicName);
    if (!t) return { text: `Unknown tool: ${publicName}`, isError: true };
    const result = await t.client.callTool({ name: t.rawName, arguments: args });
    return { text: mcpResultToText(result), isError: !!result.isError };
  }

  async closeAll(): Promise<void> {
    for (const c of this.servers.values()) {
      try {
        await c.client.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}
