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

// ── Per-user MCP configuration (multi-user: each person's own CRM/ONES/Hemory credentials) ──

/** Root of user-scoped writable state: <CSM_DATA_DIR>/users/<id>. Global llm/search still under userConfigDir(). */
export function userStateDir(userId: number): string {
  const dataRoot = process.env.CSM_DATA_DIR ?? join(homedir(), '.csm-agent');
  return join(dataRoot, 'users', String(userId));
}

function userMcpPath(userId: number): string {
  return join(userStateDir(userId), 'config', 'mcp.user.yaml');
}

/**
 * The user's own MCP server list. Unconfigured = empty array (each server is optional;
 * missing ones simply mean that user has no related capabilities, and synchronization related to that user skips it).
 */
export function loadUserMcpServers(userId: number): McpServerConfig[] {
  try {
    return loadMcpConfig(userMcpPath(userId)).servers ?? [];
  } catch {
    return [];
  }
}

export function saveUserMcpServers(userId: number, servers: McpServerConfig[]): void {
  mkdirSync(join(userStateDir(userId), 'config'), { recursive: true, mode: 0o700 });
  atomicWriteYaml(userMcpPath(userId), { servers });
}

/**
 * One-time migration for the single-user era: on upgrade, copy the global mcp config verbatim to the specified user (admin),
 * so existing connections and ${ENV} placeholders continue to be used seamlessly. Idempotent: skip if the user already has a config.
 * Copy the original text rather than a yaml round-trip, to prevent the expanded env variable values from being baked into the file.
 */
export function migrateGlobalMcpToUser(userId: number): boolean {
  const target = userMcpPath(userId);
  if (existsSync(target)) return false;
  const source = firstExisting([userConfigPath('mcp.user.yaml'), legacyConfigPath('mcp.user.yaml')]);
  if (!source) return false;
  try {
    const raw = readFileSync(source, 'utf8');
    mkdirSync(join(userStateDir(userId), 'config'), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, raw, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
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
  /** OpenAI-compatible base URL; only meaningful for the 'custom' provider. */
  baseUrl?: string;
  /**
   * 视觉（图片输入）能力。builtin 目录模型按 pi-ai 目录自动判定（此字段忽略）；
   * custom 端点无法探测，须用户显式声明——决定附件图片是否作为 image 块发给模型。
   */
  vision?: boolean;
  /**
   * custom 端点协议：openai（缺省，追加 /chat/completions）或 anthropic
   * （追加 /v1/messages，Claude Code 风格中继/智谱 Coding Plan 的 Anthropic 端点）。
   */
  protocol?: 'openai' | 'anthropic';
}

/** Provider id → { label, apiKeyEnv, defaultModel }. */
export const LLM_PROVIDERS: Array<{ id: string; label: string; apiKeyEnv: string; defaultModel: string }> = [
  { id: 'deepseek', label: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-v4-flash' },
  { id: 'openai', label: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic (Claude)', apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-5' },
  { id: 'moonshotai', label: 'Moonshot (Kimi)', apiKeyEnv: 'MOONSHOT_API_KEY', defaultModel: 'moonshot-v1-8k' },
  { id: 'groq', label: 'Groq', apiKeyEnv: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', apiKeyEnv: 'CSM_CUSTOM_API_KEY', defaultModel: '' },
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
    const model = typeof raw?.model === 'string' && raw.model ? raw.model : p.defaultModel;
    const baseUrl = typeof raw?.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : undefined;
    // An incomplete custom config (hand-edited YAML) cannot resolve a model; fall
    // back to the default provider so the service still boots and stays fixable
    // from the settings UI.
    if (provider === 'custom' && (!model || !baseUrl)) {
      const fallback = providerFor('deepseek')!;
      return { provider: 'deepseek', model: fallback.defaultModel, apiKeyEnv: fallback.apiKeyEnv };
    }
    return {
      provider,
      model,
      apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : undefined,
      apiKeyEnv: typeof raw?.apiKeyEnv === 'string' ? raw.apiKeyEnv : p.apiKeyEnv,
      ...(provider === 'custom' && baseUrl ? { baseUrl } : {}),
      ...(raw?.vision === true ? { vision: true } : {}),
      ...(provider === 'custom' && raw?.protocol === 'anthropic' ? { protocol: 'anthropic' } : {}),
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
  if (cfg.provider === 'custom' && cfg.baseUrl?.trim()) out.baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '');
  if (cfg.vision === true) out.vision = true;
  // openai 是缺省协议，省略不落盘，旧 YAML 的读写行为保持不变。
  if (cfg.provider === 'custom' && cfg.protocol === 'anthropic') out.protocol = 'anthropic';
  if (cfg.apiKey && cfg.apiKey.trim()) out.apiKey = cfg.apiKey.trim();
  mkdirSync(userConfigDir(), { recursive: true, mode: 0o700 });
  atomicWriteYaml(userConfigPath('llm.user.yaml'), out);
}

function atomicWriteYaml(path: string, obj: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, yaml.dump(obj, { lineWidth: -1, noRefs: true }), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

// ── Web search configuration ───────────────────────────────────────────────

export interface SearchConfig {
  provider: 'tavily';
  /** API key value; only written to disk, never returned by GET. */
  apiKey?: string;
  /** Max results per query, capped server-side. */
  maxResults: number;
  /** Anonymous keyless search tier when no API key is set (default: on). */
  keylessFallback: boolean;
}

export const SEARCH_PROVIDERS: Array<{ id: string; label: string; apiKeyEnv: string; defaultMaxResults: number }> = [
  { id: 'tavily', label: 'Tavily', apiKeyEnv: 'TAVILY_API_KEY', defaultMaxResults: 5 },
];

export const DEFAULT_SEARCH_CONFIG: SearchConfig = { provider: 'tavily', maxResults: 5, keylessFallback: true };

/** Public view of the search config: key presence only, never the key itself. */
export function searchConfigStatus(cfg: SearchConfig): Record<string, unknown> {
  return { provider: cfg.provider, apiKeyConfigured: !!cfg.apiKey, maxResults: cfg.maxResults, keylessFallback: cfg.keylessFallback };
}

export function loadSearchConfig(): SearchConfig {
  try {
    const path = userConfigPath('search.user.yaml');
    if (!existsSync(path)) {
      // Fall back to env var when no user config exists yet.
      const key = process.env.TAVILY_API_KEY;
      return key ? { provider: 'tavily', apiKey: key, maxResults: 5, keylessFallback: true } : DEFAULT_SEARCH_CONFIG;
    }
    const parsed = yaml.load(readFileSync(path, 'utf8')) as Partial<SearchConfig> & { search?: Partial<SearchConfig> };
    const raw = parsed?.search && typeof parsed.search === 'object' ? parsed.search : parsed;
    const apiKey = typeof raw?.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : process.env.TAVILY_API_KEY;
    const maxResults = Math.min(10, Math.max(1, Number(raw?.maxResults ?? 5) || 5));
    const keylessFallback = raw?.keylessFallback === false ? false : true;
    return { provider: 'tavily', apiKey, maxResults, keylessFallback };
  } catch {
    return DEFAULT_SEARCH_CONFIG;
  }
}

export function saveSearchConfig(cfg: SearchConfig): void {
  const out: SearchConfig = {
    provider: 'tavily',
    maxResults: Math.min(10, Math.max(1, Number(cfg.maxResults) || 5)),
    keylessFallback: cfg.keylessFallback === false ? false : true,
  };
  if (cfg.apiKey && cfg.apiKey.trim()) out.apiKey = cfg.apiKey.trim();
  mkdirSync(userConfigDir(), { recursive: true, mode: 0o700 });
  atomicWriteYaml(userConfigPath('search.user.yaml'), out);
}

// ── 企业微信扫码登录（接入层：配置齐备即启用；未配置时登录页只显示密码） ──

export interface WecomConfig {
  /** 企业 ID（企微管理后台「我的企业」页）。 */
  corpid: string;
  /** 自建应用的 AgentId。 */
  agentid: string;
  /** 自建应用的 Secret（只写不读，GET 接口不回显）。 */
  secret: string;
}

/**
 * 读取企微登录配置（config/wecom.user.yaml）。三字段齐备才视为已配置；
 * 任何缺失返回 null（登录页自动隐藏扫码入口）。
 */
export function loadWecomConfig(): WecomConfig | null {
  try {
    const path = userConfigPath('wecom.user.yaml');
    if (!existsSync(path)) return null;
    const raw = yaml.load(readFileSync(path, 'utf8')) as Partial<WecomConfig> | null;
    const corpid = typeof raw?.corpid === 'string' ? raw.corpid.trim() : '';
    const agentid = typeof raw?.agentid === 'string' ? raw.agentid.trim() : '';
    const secret = typeof raw?.secret === 'string' ? raw.secret.trim() : '';
    if (!corpid || !agentid || !secret) return null;
    return { corpid, agentid, secret };
  } catch {
    return null;
  }
}
