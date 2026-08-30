import { createProvider, envApiKeyAuth, type Model, type MutableModels } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const CUSTOM_PROVIDER_ID = 'custom';
export const CUSTOM_API_KEY_ENV = 'CSM_CUSTOM_API_KEY';

/** A user-declared OpenAI-compatible endpoint (base_url + model + api_key). */
export interface CustomLlmEndpoint {
  baseUrl?: string;
  model: string;
  apiKey?: string;
  /** 用户声明的视觉（图片输入）能力：custom 端点无法探测，只能靠配置。 */
  vision?: boolean;
}

/** Normalize an OpenAI-style base URL (strip trailing slashes) and append the completions path. */
export function completionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

/**
 * Construct a single-entry OpenAI-completions catalog model for the custom
 * endpoint. Cost is unknown (relay pricing is opaque) and reported as zero,
 * matching the "missing data stays unknown" rule; context/maxTokens are safe
 * defaults that only affect usage accounting, not request shape.
 */
function customModelFor(model: string, baseUrl: string, vision = false): Model<'openai-completions'> {
  return {
    id: model,
    name: model,
    api: 'openai-completions',
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
    // Conservative overrides for relay endpoints: omit the OpenAI-specific
    // `store` param and use the broadly supported `max_tokens` field.
    compat: { supportsStore: false, maxTokensField: 'max_tokens' },
  };
}

/**
 * Register (or replace, by provider id) the custom OpenAI-compatible provider
 * on the runtime model collection. The saved API key is exposed through the
 * provider's expected env var, mirroring the built-in provider flow.
 */
export function registerCustomProvider(models: MutableModels, endpoint: CustomLlmEndpoint): void {
  if (!endpoint.baseUrl) throw new Error('自定义服务商缺少 Base URL');
  if (endpoint.apiKey) process.env[CUSTOM_API_KEY_ENV] = endpoint.apiKey;
  const provider = createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: '自定义（OpenAI 兼容）',
    baseUrl: endpoint.baseUrl,
    auth: { apiKey: envApiKeyAuth('自定义端点 API Key', [CUSTOM_API_KEY_ENV]) },
    models: [customModelFor(endpoint.model, endpoint.baseUrl, endpoint.vision === true)],
    api: openAICompletionsApi(),
  });
  models.setProvider(provider);
}

/**
 * Probe an endpoint with a real streaming chat request before saving the
 * config. pi-ai always streams completions, so the probe exercises the same
 * path the agent will use and surfaces auth/model/protocol issues early.
 * Throws with a readable cause on failure.
 */
export async function testCustomEndpoint(endpoint: CustomLlmEndpoint, timeoutMs = 15000): Promise<void> {
  if (!endpoint.baseUrl) throw new Error('自定义服务商缺少 Base URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(completionsUrl(endpoint.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const detail = text ? `: ${text.slice(0, 200)}` : '';
      throw new Error(`端点返回 HTTP ${res.status}${detail}`);
    }
    if (!res.body) throw new Error('端点未返回响应体');
    const reader = res.body.getReader();
    try {
      const { done, value } = await reader.read();
      if (done && !value) throw new Error('端点返回了空流');
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`端点连接超时（${timeoutMs / 1000}s）：${completionsUrl(endpoint.baseUrl)}`);
    }
    const reason = (error as Error).message || String(error);
    throw new Error(`自定义端点验证失败（${endpoint.model} @ ${endpoint.baseUrl}）：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
