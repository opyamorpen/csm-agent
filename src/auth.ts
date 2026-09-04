import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { WorkbenchDatabase } from './workbench/database.js';

/**
 * 登录与凭证服务：密码哈希（node:crypto scrypt，无外部依赖）、令牌签发
 * （随机令牌只在创建时明文出现，库内存 SHA-256 指纹）、登录失败限速（内存态）。
 * 服务端会话（auth_sessions，浏览器 cookie）与个人访问令牌（auth_tokens，CLI/CI
 * Bearer）共用同一签发/指纹机制，差别只在有无过期时间。
 */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** 令牌本体长度（base64url 后 43 字符）；库内只存 sha256 十六进制指纹。 */
export function issueToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: tokenFingerprint(token).tokenHash };
}

export function tokenFingerprint(token: string): { tokenHash: string } {
  return { tokenHash: createHash('sha256').update(token).digest('hex') };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * 校验密码。存储格式损坏按不匹配处理（不抛错），并在用户不存在时用固定的
 * 「幻影哈希」走完同一条 scrypt 路径，避免用户名枚举计时差。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt.length || !expected.length) return false;
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 与 verifyPassword 同参数、同耗时，用于「用户不存在」时抹平计时差。 */
export const PHANTOM_HASH = hashPassword(randomBytes(24).toString('base64url'));

export const PASSWORD_MIN_LENGTH = 8;

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (password.length > 200) return '密码过长（上限 200 位）';
  return null;
}

const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 生成可抄写的一次性密码（去掉易混字符；仅用于 admin 建号/重置时回显一次）。 */
export function generatePassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  return out;
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}$/;

/** 登录会话有效期：7 天滑动续期（每次通过鉴权且距上次 touch >5 分钟时续）。 */
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

interface RateEntry {
  failures: number;
  lockedUntil: number;
}

/**
 * 登录失败限速（内存态，进程重启清零）：同一 用户名+来源 连续 5 次失败锁 15 分钟。
 * 登录是低频操作，锁表驻留内存即可；暴力破解的代价已被会话哈希与锁窗抬高到不可行。
 */
export class LoginRateLimiter {
  private readonly entries = new Map<string, RateEntry>();

  constructor(private readonly maxFailures = 5, private readonly lockMs = 15 * 60 * 1000) {}

  checkLocked(key: string): { locked: boolean; retryAfterSec: number } {
    const entry = this.entries.get(key);
    if (!entry || entry.lockedUntil <= Date.now()) return { locked: false, retryAfterSec: 0 };
    return { locked: true, retryAfterSec: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
  }

  recordFailure(key: string): void {
    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = Date.now() + this.lockMs;
      entry.failures = 0;
    }
    this.entries.set(key, entry);
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }
}

/**
 * 首次启动引导：users 表为空时创建 admin（密码取 CSM_ADMIN_PASSWORD，否则生成随机
 * 密码打印到日志一次）。存量单用户部署升级后由该 admin 承接全部历史数据归属。
 */
export function ensureBootstrapAdmin(db: WorkbenchDatabase): { created: boolean; username: string; generatedPassword?: string } {
  if (db.countUsers() > 0) return { created: false, username: '' };
  const fromEnv = process.env.CSM_ADMIN_PASSWORD?.trim() ?? '';
  const password = fromEnv || generatePassword();
  const user = db.createUser({ username: 'admin', displayName: '管理员', role: 'admin', passwordHash: hashPassword(password) });
  db.audit('system', 'auth.bootstrap_admin', 'user', String(user.id), { passwordSource: fromEnv ? 'env' : 'generated' }, user.id);
  if (!fromEnv) {
    console.log('════════════════════════════════════════════════════════════');
    console.log('  已创建初始管理员账号（仅此一次显示，请立即登录并妥善保存）：');
    console.log(`  用户名: admin`);
    console.log(`  密  码: ${password}`);
    console.log('  也可重启服务前设置 CSM_ADMIN_PASSWORD 环境变量来固定初始密码。');
    console.log('════════════════════════════════════════════════════════════');
  } else {
    console.log('[auth] 已按 CSM_ADMIN_PASSWORD 创建初始管理员账号 admin');
  }
  return { created: true, username: 'admin', generatedPassword: fromEnv ? undefined : password };
}

/** 从 Cookie 头解析指定 cookie 值（登录会话令牌载体）。 */
export function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export const SESSION_COOKIE = 'csm_session';

export function sessionCookieHeader(token: string, maxAgeSec: number): string {
  // Secure 先不加：当前部署形态是本机/内网 HTTP；挂到 HTTPS 反代后由部署配置补（阶段 5）。
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** 会话滑动续期辅助：过期返回 true；未过期且距上次 touch 超过间隔则给出新到期时刻。 */
export function sessionExpiry(expiresAt: string, lastSeenAt?: string): { expired: boolean; nextExpiresAt?: string } {
  const now = Date.now();
  if (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) return { expired: true };
  if (lastSeenAt && now - Date.parse(lastSeenAt) < SESSION_TOUCH_INTERVAL_MS) return { expired: false };
  return { expired: false, nextExpiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
}
