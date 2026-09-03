import { createProvider, envApiKeyAuth, type Model, type MutableModels } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';

export const CUSTOM_PROVIDER_ID = 'custom';
export const CUSTOM_API_KEY_ENV = 'CSM_CUSTOM_API_KEY';

/** 端点协议：openai = OpenAI 兼容（追加 /chat/completions），anthropic = Anthropic 兼容（追加 /v1/messages）。 */
export type CustomLlmProtocol = 'openai' | 'anthropic';

/** A user-declared OpenAI/Anthropic-compatible endpoint (base_url + model + api_key). */
export interface CustomLlmEndpoint {
  baseUrl?: string;
  model: string;
  apiKey?: string;
  /** 用户声明的视觉（图片输入）能力：custom 端点无法探测，只能靠配置。 */
  vision?: boolean;
  /** 缺省 openai（兼容旧配置）；anthropic 走 Claude Code 风格的 /v1/messages。 */
  protocol?: CustomLlmProtocol;
}

/** Normalize an OpenAI-style base URL (strip trailing slashes) and append the completions path. */
export function completionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

/** Anthropic 协议请求路径：SDK 与 Claude Code 均按 {base}/v1/messages 访问。 */
export function messagesUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/v1/messages';
}

/** Resolve the probe/request URL for the configured protocol (openai by default). */
export function probeUrl(baseUrl: string, protocol: CustomLlmProtocol = 'openai'): string {
  return protocol === 'anthropic' ? messagesUrl(baseUrl) : completionsUrl(baseUrl);
}

function normalizeProtocol(protocol?: CustomLlmProtocol): CustomLlmProtocol {
  return protocol === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * Construct a single-entry catalog model for the custom endpoint (openai-completions
 * or anthropic-messages). Cost is unknown (relay pricing is opaque) and reported as
 * zero, matching the "missing data stays unknown" rule; context/maxTokens are safe
 * defaults that only affect usage accounting, not request shape.
 */
function customModelFor(
  model: string,
  baseUrl: string,
  vision = false,
  protocol: CustomLlmProtocol = 'openai',
): Model<'openai-completions'> | Model<'anthropic-messages'> {
  const common: Omit<Model<'openai-completions'>, 'api' | 'compat'> = {
    id: model,
    name: model,
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  };
  if (protocol === 'anthropic') return { ...common, api: 'anthropic-messages' };
  return {
    ...common,
    api: 'openai-completions',
    // Conservative overrides for relay endpoints: omit the OpenAI-specific
    // `store` param and use the broadly supported `max_tokens` field.
    compat: { supportsStore: false, maxTokensField: 'max_tokens' },
  };
}

/**
 * Register (or replace, by provider id) the custom provider on the runtime model
 * collection. The saved API key is exposed through the provider's expected env
 * var, mirroring the built-in provider flow; anthropic 协议下 pi-ai 用 Anthropic
 * SDK 以 x-api-key 发请求。
 */
export function registerCustomProvider(models: MutableModels, endpoint: CustomLlmEndpoint): void {
  if (!endpoint.baseUrl) throw new Error('自定义服务商缺少 Base URL');
  if (endpoint.apiKey) process.env[CUSTOM_API_KEY_ENV] = endpoint.apiKey;
  const protocol = normalizeProtocol(endpoint.protocol);
  const provider = createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: protocol === 'anthropic' ? '自定义（Anthropic 兼容）' : '自定义（OpenAI 兼容）',
    baseUrl: endpoint.baseUrl,
    auth: { apiKey: envApiKeyAuth('自定义端点 API Key', [CUSTOM_API_KEY_ENV]) },
    models: [customModelFor(endpoint.model, endpoint.baseUrl, endpoint.vision === true, protocol)],
    api: protocol === 'anthropic' ? anthropicMessagesApi() : openAICompletionsApi(),
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
  const protocol = normalizeProtocol(endpoint.protocol);
  const url = probeUrl(endpoint.baseUrl, protocol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(protocol === 'anthropic'
          ? {
              'x-api-key': endpoint.apiKey ?? '',
              'anthropic-version': '2023-06-01',
            }
          : endpoint.apiKey
            ? { Authorization: `Bearer ${endpoint.apiKey}` }
            : {}),
      },
      body: JSON.stringify(
        protocol === 'anthropic'
          ? { model: endpoint.model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }], stream: true }
          : { model: endpoint.model, messages: [{ role: 'user', content: 'ping' }], stream: true },
      ),
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
      throw new Error(`端点连接超时（${timeoutMs / 1000}s）：${url}`);
    }
    const reason = (error as Error).message || String(error);
    throw new Error(`自定义端点验证失败（${endpoint.model} @ ${url}，${protocol} 协议）：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
