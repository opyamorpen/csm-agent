import { readFileSync } from 'node:fs';
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
