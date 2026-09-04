import type { WecomConfig } from './config.js';

/**
 * 企业微信扫码登录的服务端对接（接入层）：
 * ① 前端跳转企微 Web 登录扫码页（wwlogin qrConnect）→ ② 企微回调带 code →
 * ③ 服务端用 corpid+secret 换 access_token（缓存至过期前 5 分钟）→
 * ④ code 换 userid（cgi-bin/auth/getuserinfo，企业成员返回 userid）→ ⑤ 匹配
 * users.wecom_userid 建会话。
 *
 * 未配置（config/wecom.user.yaml 三字段不齐）时端点对外呈「未启用」，
 * 登录页只显示密码。真实端到端联调需企微管理后台配置「登录可信域名」
 * （部署域名确定后设置），此前以 mock 测试覆盖协议分支。
 */

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

export interface WecomApiResult {
  ok: boolean;
  userid?: string;
  externalUserid?: string;
  error?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;
/** 测试钩子：清空 access_token 缓存。 */
export function resetWecomTokenCache(): void {
  tokenCache = null;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

async function getJson(url: string, fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl(url);
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 企业 access_token（gettoken），进程内缓存；errcode≠0 按失败抛错。 */
export async function wecomAccessToken(config: WecomConfig, fetchImpl: FetchLike): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(config.corpid)}&corpsecret=${encodeURIComponent(config.secret)}`;
  const data = await getJson(url, fetchImpl);
  const token = typeof data?.access_token === 'string' ? data.access_token : '';
  const expiresIn = Number(data?.expires_in ?? 0);
  const errcode = Number(data?.errcode ?? 0);
  if (!token || errcode !== 0) {
    throw new Error(`企业微信 access_token 获取失败: errcode=${errcode} errmsg=${String(data?.errmsg ?? '')}`);
  }
  tokenCache = { token, expiresAt: Date.now() + Math.max(0, expiresIn - 300) * 1000 };
  return token;
}

/** code 换登录身份：企业成员返回 userid；外部联系人返回 external_userid（本系统不认领）。 */
export async function wecomUseridForCode(config: WecomConfig, code: string, fetchImpl: FetchLike): Promise<WecomApiResult> {
  try {
    const token = await wecomAccessToken(config, fetchImpl);
    const url = `${API_BASE}/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`;
    const data = await getJson(url, fetchImpl);
    const errcode = Number(data?.errcode ?? 0);
    if (errcode !== 0) {
      return { ok: false, error: `企业微信 code 校验失败: errcode=${errcode} errmsg=${String(data?.errmsg ?? '')}` };
    }
    const userid = typeof data?.userid === 'string' ? data.userid : '';
    const externalUserid = typeof data?.external_userid === 'string' ? data.external_userid : '';
    if (!userid && !externalUserid) return { ok: false, error: '企业微信未返回用户身份' };
    return { ok: true, ...(userid ? { userid } : {}), ...(externalUserid ? { externalUserid } : {}) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** 生成一次性 state（OAuth 重定向 CSRF 防护）。 */
export function newWecomState(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

/**
 * state 临时登记处（内存态，5 分钟有效）：回调必须携带登记过的 state。
 * 多实例部署时改为共享存储（当前单实例假设）。
 */
const pendingStates = new Map<string, number>();
export function registerWecomState(state: string): void {
  const now = Date.now();
  for (const [key, at] of pendingStates) {
    if (now - at > 5 * 60_000) pendingStates.delete(key);
  }
  pendingStates.set(state, now);
}
export function consumeWecomState(state: string): boolean {
  const at = pendingStates.get(state);
  if (at == null) return false;
  pendingStates.delete(state);
  return Date.now() - at <= 5 * 60_000;
}

/** 企微 Web 登录扫码页 URL（企业自建应用形态）。 */
export function wecomLoginUrl(config: WecomConfig, redirectUri: string, state: string): string {
  return 'https://login.work.weixin.qq.com/wwlogin/sso/qrConnect'
    + `?appid=${encodeURIComponent(config.corpid)}`
    + `&agentid=${encodeURIComponent(config.agentid)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`;
}
