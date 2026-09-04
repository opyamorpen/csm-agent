import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadWecomConfig } from '../src/config.js';
import { wecomAccessToken, wecomUseridForCode, newWecomState, registerWecomState, consumeWecomState, resetWecomTokenCache, wecomLoginUrl, type FetchLike } from '../src/wecom.js';
import { buildHandler } from '../src/server.js';
import { Store } from '../src/store.js';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { ensureBootstrapAdmin, hashPassword } from '../src/auth.js';
import type { Runtime } from '../src/bootstrap.js';

const CONFIG: { corpid: string; agentid: string; secret: string } = { corpid: 'ww1234567890', agentid: '1000002', secret: 'secret-x' };

function withConfigDir(fn: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'csm-wecom-'));
  const previousConfig = process.env.CSM_CONFIG_DIR;
  const previousData = process.env.CSM_DATA_DIR;
  process.env.CSM_CONFIG_DIR = join(dir, 'config');
  process.env.CSM_DATA_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previousConfig === undefined) delete process.env.CSM_CONFIG_DIR;
      else process.env.CSM_CONFIG_DIR = previousConfig;
      if (previousData === undefined) delete process.env.CSM_DATA_DIR;
      else process.env.CSM_DATA_DIR = previousData;
      rmSync(dir, { recursive: true, force: true });
    });
}

function fakeFetch(urls: Record<string, unknown>, counter = { gettoken: 0, getuserinfo: 0 }): FetchLike {
  return async (url: string) => {
    for (const [key, payload] of Object.entries(urls)) {
      if (url.includes(key)) {
        if (key === 'gettoken') counter.gettoken += 1;
        if (key === 'getuserinfo') counter.getuserinfo += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      }
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
}

test('wecom config: absent or incomplete means disabled', () => {
  return withConfigDir(() => {
    assert.equal(loadWecomConfig(), null, '无配置文件 → 未启用');
    mkdirSync(join(process.env.CSM_CONFIG_DIR!), { recursive: true });
    writeFileSync(join(process.env.CSM_CONFIG_DIR!, 'wecom.user.yaml'), 'corpid: ww123\nagentid: "1000002"\n', 'utf8');
    assert.equal(loadWecomConfig(), null, '缺 secret → 未启用');
    writeFileSync(join(process.env.CSM_CONFIG_DIR!, 'wecom.user.yaml'), `corpid: ${CONFIG.corpid}\nagentid: "${CONFIG.agentid}"\nsecret: ${CONFIG.secret}\n`, 'utf8');
    assert.deepEqual(loadWecomConfig(), CONFIG, '三字段齐备 → 已配置');
  });
});

test('wecom access_token is cached and code exchange parses both envelopes', async () => {
  resetWecomTokenCache();
  const counter = { gettoken: 0, getuserinfo: 0 };
  const fetchOk = fakeFetch({
    gettoken: { errcode: 0, access_token: 'TOKEN-1', expires_in: 7200 },
    getuserinfo: { errcode: 0, userid: 'bo.wecom' },
  }, counter);
  await wecomAccessToken(CONFIG, fetchOk);
  await wecomAccessToken(CONFIG, fetchOk);
  assert.equal(counter.gettoken, 1, '有效期内 access_token 只取一次');
  const member = await wecomUseridForCode(CONFIG, 'code-1', fetchOk);
  assert.deepEqual({ ok: member.ok, userid: member.userid }, { ok: true, userid: 'bo.wecom' });

  resetWecomTokenCache();
  const fetchFail = fakeFetch({ gettoken: { errcode: 0, access_token: 'T', expires_in: 7200 }, getuserinfo: { errcode: 40029, errmsg: 'invalid code' } });
  const failed = await wecomUseridForCode(CONFIG, 'code-bad', fetchFail);
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /40029/);

  resetWecomTokenCache();
  const fetchExternal = fakeFetch({ gettoken: { errcode: 0, access_token: 'T', expires_in: 7200 }, getuserinfo: { errcode: 0, external_userid: 'woEXT' } });
  const external = await wecomUseridForCode(CONFIG, 'code-ext', fetchExternal);
  assert.equal(external.ok, true);
  assert.equal(external.userid, undefined, '外部联系人不产 userid（服务端拒绝登录）');
});

test('wecom state guard: single-use with TTL', () => {
  const state = newWecomState();
  assert.equal(consumeWecomState(state), false, '未登记的 state 不得通过');
  registerWecomState(state);
  assert.equal(consumeWecomState(state), true, '登记后一次性通过');
  assert.equal(consumeWecomState(state), false, 'state 不可重放');
});

test('wecom login url carries corpid/agentid/redirect/state', () => {
  const url = wecomLoginUrl(CONFIG, 'http://127.0.0.1:3212/api/auth/wecom/callback', 'STATE123');
  assert.match(url, /wwlogin\/sso\/qrConnect/);
  assert.match(url, /appid=ww1234567890/);
  assert.match(url, /agentid=1000002/);
  assert.match(url, /state=STATE123/);
  assert.ok(url.includes(encodeURIComponent('http://127.0.0.1:3212/api/auth/wecom/callback')));
});

/** HTTP 全链路（buildHandler + mock 企微 API）：未配置隐藏、配置后 state 校验与绑定用户建会话。 */
function fakeRuntime(): Runtime {
  const fakeUserRt = { userId: 0, mcp: { failures: new Map<string, string>() }, tools: [], systemPrompt: '' };
  return {
    models: {} as never, model: { input: [] } as never,
    users: { get: () => fakeUserRt, failuresOf: () => [], reconnect: async () => {}, retryFailed: async () => {}, list: () => [fakeUserRt] },
    mcp: fakeUserRt.mcp, tools: [], systemPrompt: '', llm: {} as never,
    attachSystemUser: () => {}, setLlm: (() => ({})) as never,
  } as unknown as Runtime;
}

async function withWecomServer(fn: (ctx: {
  base: string;
  writeConfig: () => void;
  stubWecomApi: (userid: string | null) => void;
  memberId: number;
}) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-wecom-http-'));
  const store = new Store(dir);
  const db = new WorkbenchDatabase(dir);
  const previousConfig = process.env.CSM_CONFIG_DIR;
  const previousData = process.env.CSM_DATA_DIR;
  process.env.CSM_CONFIG_DIR = join(dir, 'config');
  process.env.CSM_DATA_DIR = dir;
  process.env.CSM_ADMIN_PASSWORD = 'admin-pass-1';
  try {
    ensureBootstrapAdmin(db);
  } finally {
    delete process.env.CSM_ADMIN_PASSWORD;
  }
  const member = db.createUser({ username: 'csm1', displayName: '一号', passwordHash: hashPassword('member-pass-1'), wecomUserid: 'bo.wecom' });
  const services = { db, sync: { refreshAll: () => ({}) }, cases: {}, drafts: {}, weekly: {}, wiki: {}, opportunities: {} } as never;
  const server = http.createServer(buildHandler(fakeRuntime(), store, services, 1));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 企微 API 打桩：拦 qyapi 请求，其余透传原 fetch（本地服务调用不受影响）。
  const originalFetch = globalThis.fetch;
  let wecomUserid: string | null = null;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input.url ?? '');
    if (url.startsWith('https://qyapi.weixin.qq.com/')) {
      if (url.includes('gettoken')) {
        return new Response(JSON.stringify({ errcode: 0, access_token: 'T-STUB', expires_in: 7200 }), { status: 200 });
      }
      if (url.includes('getuserinfo')) {
        const body = wecomUserid
          ? { errcode: 0, userid: wecomUserid }
          : { errcode: 40029, errmsg: 'invalid code' };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await fn({
      base,
      writeConfig: () => {
        mkdirSync(join(dir, 'config'), { recursive: true });
        writeFileSync(join(dir, 'config', 'wecom.user.yaml'), `corpid: ${CONFIG.corpid}\nagentid: "${CONFIG.agentid}"\nsecret: ${CONFIG.secret}\n`, 'utf8');
      },
      stubWecomApi: (userid: string | null) => {
        resetWecomTokenCache();
        wecomUserid = userid;
      },
      memberId: member.id,
    });
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
    db.close();
    if (previousConfig === undefined) delete process.env.CSM_CONFIG_DIR;
    else process.env.CSM_CONFIG_DIR = previousConfig;
    if (previousData === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = previousData;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('wecom endpoints: hidden until configured; full flow binds a session', async () => {
  await withWecomServer(async ({ base, writeConfig, stubWecomApi }) => {
    // 未配置：status=false，login-url 404（登录页不显示扫码入口）。
    assert.equal((await (await fetch(`${base}/api/auth/wecom/status`)).json()).configured, false);
    assert.equal((await fetch(`${base}/api/auth/wecom/login-url`)).status, 404);
    // 配置后：status=true；login-url 带 state。
    writeConfig();
    assert.equal((await (await fetch(`${base}/api/auth/wecom/status`)).json()).configured, true);
    const loginUrl = (await (await fetch(`${base}/api/auth/wecom/login-url`)).json()) as { url: string };
    assert.match(loginUrl.url, /appid=ww1234567890/);
    const state = new URL(loginUrl.url).searchParams.get('state')!;
    assert.ok(state);
    // 回调：state 错误 → 302 错误参数；code 无效（mock 失败）→ 302 错误；成功 → 302 '/' + 会话 cookie。
    const bad = await fetch(`${base}/api/auth/wecom/callback?code=c1&state=tampered`, { redirect: 'manual' });
    assert.equal(bad.status, 302);
    assert.match(bad.headers.get('location') ?? '', /wecom_login_error=/);
    const invalid = await fetch(`${base}/api/auth/wecom/callback?code=c2&state=${state}`, { redirect: 'manual' });
    assert.match(invalid.headers.get('location') ?? '', /wecom_login_error=/, 'state 已被上次消费或 code 校验失败');
    // 重新取一个新 state 走成功路径（绑定用户 bo.wecom → csm1）。
    const second = (await (await fetch(`${base}/api/auth/wecom/login-url`)).json()) as { url: string };
    const state2 = new URL(second.url).searchParams.get('state')!;
    stubWecomApi('bo.wecom');
    const ok = await fetch(`${base}/api/auth/wecom/callback?code=c3&state=${state2}`, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/');
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /^csm_session=/);
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.username, 'csm1');
    // 未绑定的企微账号 → 明确提示找管理员绑定。
    const third = (await (await fetch(`${base}/api/auth/wecom/login-url`)).json()) as { url: string };
    stubWecomApi('stranger.wecom');
    const stranger = await fetch(`${base}/api/auth/wecom/callback?code=c4&state=${new URL(third.url).searchParams.get('state')}`, { redirect: 'manual' });
    assert.match(decodeURIComponent(stranger.headers.get('location') ?? ''), /未绑定系统用户/);
  });
});
