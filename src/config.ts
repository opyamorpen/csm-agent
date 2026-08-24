import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  writeToolPatterns?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const configDir = join(here, '..', 'config');

const USER_CONFIG = join(configDir, 'mcp.user.yaml');

/** Expand ${ENV_VAR} placeholders inside a config tree using process.env. */
export function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) {
    return value.map(expandEnv);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnv(v);
    }
    return out;
  }
  return value;
}

export function loadMcpConfig(path: string): { servers: McpServerConfig[] } {
  const raw = yaml.load(readFileSync(path, 'utf8'));
  return expandEnv(raw) as unknown as { servers: McpServerConfig[] };
}

/**
 * Load the effective MCP server list:
 * 1. config/mcp.user.yaml if the user has saved one through the UI (gitignored);
 * 2. otherwise CSM_MCP_CONFIG if set;
 * 3. otherwise the shipped seed config/mcp.yaml.
 */
export function loadMcpServers(): McpServerConfig[] {
  if (existsSync(USER_CONFIG)) {
    return loadMcpConfig(USER_CONFIG).servers;
  }
  const seed = process.env.CSM_MCP_CONFIG ?? join(configDir, 'mcp.yaml');
  return loadMcpConfig(seed).servers;
}

/** Persist the user's MCP server list (gitignored; never committed). */
export function saveMcpServers(servers: McpServerConfig[]): void {
  writeFileSync(USER_CONFIG, yaml.dump({ servers }, { lineWidth: -1, noRefs: true }), 'utf8');
}
