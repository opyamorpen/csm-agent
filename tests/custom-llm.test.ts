import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import {
  completionsUrl,
  messagesUrl,
  probeUrl,
  registerCustomProvider,
  testCustomEndpoint,
  CUSTOM_PROVIDER_ID,
} from '../src/custom-llm.js';

test('completionsUrl: strips trailing slashes and appends the completions path', () => {
  assert.equal(completionsUrl('https://relay.ones.pro/v1'), 'https://relay.ones.pro/v1/chat/completions');
  assert.equal(completionsUrl('https://relay.ones.pro/v1///'), 'https://relay.ones.pro/v1/chat/completions');
});

test('messagesUrl/probeUrl: anthropic protocol appends /v1/messages; openai stays the default', () => {
  assert.equal(messagesUrl('https://open.bigmodel.cn/api/anthropic'), 'https://open.bigmodel.cn/api/anthropic/v1/messages');
  assert.equal(messagesUrl('https://open.bigmodel.cn/api/anthropic///'), 'https://open.bigmodel.cn/api/anthropic/v1/messages');
  assert.equal(probeUrl('https://relay.example/v1'), 'https://relay.example/v1/chat/completions');
  assert.equal(probeUrl('https://relay.example/v1', 'openai'), 'https://relay.example/v1/chat/completions');
  assert.equal(probeUrl('https://open.bigmodel.cn/api/anthropic', 'anthropic'), 'https://open.bigmodel.cn/api/anthropic/v1/messages');
});

test('registerCustomProvider: model resolves through the runtime collection', () => {
  const models = builtinModels();
  registerCustomProvider(models, { baseUrl: 'https://relay.example/v1', model: 'ucloud-qwen3.8-max' });
  const model = models.getModel(CUSTOM_PROVIDER_ID, 'ucloud-qwen3.8-max');
  assert.ok(model, 'custom model should resolve after registration');
  assert.equal(model.baseUrl, 'https://relay.example/v1');
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.provider, CUSTOM_PROVIDER_ID);

  // Re-registration replaces the endpoint (same provider id) so switching
  // baseUrl/model stays consistent.
  registerCustomProvider(models, { baseUrl: 'https://other.example/v1', model: 'another-model' });
  assert.equal(models.getModel(CUSTOM_PROVIDER_ID, 'ucloud-qwen3.8-max'), undefined);
  const next = models.getModel(CUSTOM_PROVIDER_ID, 'another-model');
  assert.ok(next);
  assert.equal(next.baseUrl, 'https://other.example/v1');
});

test('registerCustomProvider: anthropic protocol registers an anthropic-messages model', () => {
  const models = builtinModels();
  registerCustomProvider(models, {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3-flash',
    protocol: 'anthropic',
    vision: true,
  });
  const model = models.getModel(CUSTOM_PROVIDER_ID, 'glm-5.3-flash');
  assert.ok(model, 'anthropic custom model should resolve after registration');
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
  assert.deepEqual(model.input, ['text', 'image']);
});

interface ProbeServer {
  url: string;
  requests: Array<{ auth?: string; path?: string; apiKey?: string; anthropicVersion?: string; body: any }>;
  close(): Promise<void>;
}

function startProbe(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void): Promise<ProbeServer> {
  const requests: Array<{ auth?: string; path?: string; apiKey?: string; anthropicVersion?: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      requests.push({
        auth: req.headers.authorization,
        path: req.url,
        apiKey: req.headers['x-api-key'] as string | undefined,
        anthropicVersion: req.headers['anthropic-version'] as string | undefined,
        body,
      });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('testCustomEndpoint: sends a streaming chat probe with bearer auth (openai default)', async () => {
  const probe = await startProbe((req, res, body) => {
    assert.equal(req.url, '/chat/completions');
    assert.equal(body.stream, true);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n');
  });
  try {
    await testCustomEndpoint({ baseUrl: probe.url, model: 'test-model', apiKey: 'sk-probe' });
    assert.equal(probe.requests.length, 1);
    assert.equal(probe.requests[0].auth, 'Bearer sk-probe');
    assert.equal(probe.requests[0].apiKey, undefined);
    assert.equal(probe.requests[0].body.model, 'test-model');
  } finally {
    await probe.close();
  }
});

test('testCustomEndpoint: anthropic probe posts to /v1/messages with x-api-key', async () => {
  const probe = await startProbe((req, res, body) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(body.stream, true);
    assert.ok(typeof body.max_tokens === 'number', 'anthropic protocol requires max_tokens');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start"}\n\n');
  });
  try {
    await testCustomEndpoint({ baseUrl: probe.url, model: 'glm-5.3-flash', apiKey: 'sk-anthropic', protocol: 'anthropic' });
    assert.equal(probe.requests.length, 1);
    assert.equal(probe.requests[0].apiKey, 'sk-anthropic');
    assert.equal(probe.requests[0].anthropicVersion, '2023-06-01');
    assert.equal(probe.requests[0].auth, undefined);
    assert.equal(probe.requests[0].body.model, 'glm-5.3-flash');
  } finally {
    await probe.close();
  }
});

test('testCustomEndpoint: rejects HTTP errors with status detail', async () => {
  const probe = await startProbe((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  try {
    await assert.rejects(
      testCustomEndpoint({ baseUrl: probe.url, model: 'test-model', apiKey: 'sk-bad' }),
      /HTTP 401/,
    );
  } finally {
    await probe.close();
  }
});

test('testCustomEndpoint: reports connection failures readably', async () => {
  await assert.rejects(
    testCustomEndpoint({ baseUrl: 'http://127.0.0.1:1', model: 'test-model', apiKey: 'sk-x' }),
    /自定义端点验证失败/,
  );
});
