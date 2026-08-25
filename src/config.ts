import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
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
  /** Explicit capability policy. Exact names win over legacy patterns. */
  writeTools?: string[];
  readTools?: string[];
  writeToolPatterns?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const packagedConfigDir = join(packageRoot, 'config');

export function userConfigDir(): string {
  return process.env.CSM_CONFIG_DIR ?? join(process.env.CSM_DATA_DIR ?? join(homedir(), '.csm-agent'), 'config');
}

function userConfigPath(name: string): string {
  return join(userConfigDir(), name);
}

function legacyConfigPath(name: string): string {
  return join(packagedConfigDir, name);
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
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

/**
 * Load the effective MCP server list:
 * 1. writable user config under ~/.csm-agent/config (or CSM_CONFIG_DIR);
 * 2. legacy project config/mcp.user.yaml for a non-breaking migration;
 * 3. CSM_MCP_CONFIG when set;
 * 4. the shipped seed config/mcp.yaml.
 */
export function loadMcpServers(): McpServerConfig[] {
  const saved = firstExisting([userConfigPath('mcp.user.yaml'), legacyConfigPath('mcp.user.yaml')]);
  if (saved) return loadMcpConfig(saved).servers;
  const seed = process.env.CSM_MCP_CONFIG ?? join(packagedConfigDir, 'mcp.yaml');
  return loadMcpConfig(seed).servers;
}

/** Persist MCP settings outside the package installation so a global CLI stays writable. */
export function saveMcpServers(servers: McpServerConfig[]): void {
  mkdirSync(userConfigDir(), { recursive: true, mode: 0o700 });
  atomicWriteYaml(userConfigPath('mcp.user.yaml'), { servers });
}

/**
 * Load a project-root `.env` file into process.env (only keys not already
 * present). The packaged macOS app launches the server without a shell, so
 * API keys and `${ENV_VAR}` tokens referenced in the MCP config must come
 * from `.env` (which is gitignored).
 */
export function loadDotEnv(): void {
  const candidates = [
    process.env.CSM_ENV_FILE ? resolve(process.env.CSM_ENV_FILE) : '',
    resolve(process.cwd(), '.env'),
    join(process.env.CSM_DATA_DIR ?? join(homedir(), '.csm-agent'), '.env'),
    join(packageRoot, '.env'),
  ].filter(Boolean);
  const envPath = firstExisting([...new Set(candidates)]);
  if (!envPath) return;
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env file */
  }
}

// ── LLM (model) configuration ──────────────────────────────────────────────

export interface LlmConfig {
  provider: string;
  model: string;
  /** API key value; only written to disk, never returned by GET. */
  apiKey?: string;
  /** Environment variable the key should be exposed as. */
  apiKeyEnv: string;
}

/** Provider id → { label, apiKeyEnv, defaultModel }. */
export const LLM_PROVIDERS: Array<{ id: string; label: string; apiKeyEnv: string; defaultModel: string }> = [
  { id: 'deepseek', label: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-v4-flash' },
  { id: 'openai', label: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic (Claude)', apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-5' },
  { id: 'moonshotai', label: 'Moonshot (Kimi)', apiKeyEnv: 'MOONSHOT_API_KEY', defaultModel: 'moonshot-v1-8k' },
  { id: 'groq', label: 'Groq', apiKeyEnv: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile' },
];

export function providerFor(id: string) {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

export function loadLlmConfig(): LlmConfig {
  try {
    const path = firstExisting([userConfigPath('llm.user.yaml'), legacyConfigPath('llm.user.yaml')]);
    if (!path) throw new Error('LLM config not found');
    const parsed = yaml.load(readFileSync(path, 'utf8')) as Partial<LlmConfig> & { llm?: Partial<LlmConfig> };
    // v0.1 briefly wrote `{ llm: ... }`; accept it so existing local config survives.
    const raw = parsed?.llm && typeof parsed.llm === 'object' ? parsed.llm : parsed;
    const provider = typeof raw?.provider === 'string' ? raw.provider : 'deepseek';
    const p = providerFor(provider) ?? providerFor('deepseek')!;
    return {
      provider,
      model: typeof raw?.model === 'string' && raw.model ? raw.model : p.defaultModel,
      apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : undefined,
      apiKeyEnv: typeof raw?.apiKeyEnv === 'string' ? raw.apiKeyEnv : p.apiKeyEnv,
    };
  } catch {
    const p = providerFor('deepseek')!;
    return { provider: 'deepseek', model: p.defaultModel, apiKeyEnv: p.apiKeyEnv };
  }
}

export function saveLlmConfig(cfg: LlmConfig): void {
  const p = providerFor(cfg.provider) ?? providerFor('deepseek')!;
  const out: LlmConfig = {
    provider: cfg.provider,
    model: cfg.model || p.defaultModel,
    apiKeyEnv: p.apiKeyEnv,
  };
  if (cfg.apiKey && cfg.apiKey.trim()) out.apiKey = cfg.apiKey.trim();
  mkdirSync(userConfigDir(), { recursive: true, mode: 0o700 });
  atomicWriteYaml(userConfigPath('llm.user.yaml'), out);
}

function atomicWriteYaml(path: string, obj: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, yaml.dump(obj, { lineWidth: -1, noRefs: true }), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}
