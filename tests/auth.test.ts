import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  hashPassword, verifyPassword, PHANTOM_HASH, issueToken, tokenFingerprint, validatePassword, generatePassword,
  LoginRateLimiter, cookieValue, sessionCookieHeader, clearSessionCookieHeader, sessionExpiry, ensureBootstrapAdmin,
} from '../src/auth.js';
import { WorkbenchDatabase } from '../src/workbench/database.js';

async function withDb(fn: (db: WorkbenchDatabase) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-auth-'));
  const db = new WorkbenchDatabase(dir);
  try {
    await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('password hashing roundtrips and rejects wrong or malformed input', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$/);
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('wrong password', hash), false);
  // 两次哈希盐不同（明文相同哈希也不同），幻影哈希自身可校验（用户不存在时的等耗时路径）。
  assert.notEqual(hash, hashPassword('correct horse battery staple'));
  assert.equal(verifyPassword('anything', PHANTOM_HASH), false);
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', ''), false);
});

test('password policy and generator', () => {
  assert.ok(validatePassword('short'), '5 位不达标');
  assert.equal(validatePassword('123456'), null, '6 位达标（下限 6）');
  assert.ok(validatePassword('12345'));
  assert.equal(validatePassword('longenough1'), null);
  assert.equal(validatePassword('x'.repeat(201)), '密码过长（上限 200 位）');
  const generated = generatePassword(16);
  assert.equal(generated.length, 16);
  // 生成器排除易混字符（0/O/1/I/l）
  assert.match(generated, /^[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
});

test('issued tokens are unique and fingerprints are deterministic', () => {
  const first = issueToken();
  const second = issueToken();
  assert.notEqual(first.token, second.token);
  assert.equal(tokenFingerprint(first.token).tokenHash, first.tokenHash);
  assert.match(first.tokenHash, /^[0-9a-f]{64}$/);
});

test('login rate limiter locks after consecutive failures and clears on success', () => {
  const limiter = new LoginRateLimiter(5, 60_000);
  const key = '1.2.3.4|admin';
  assert.equal(limiter.checkLocked(key).locked, false);
  for (let i = 0; i < 5; i++) limiter.recordFailure(key);
  const locked = limiter.checkLocked(key);
  assert.equal(locked.locked, true);
  assert.ok(locked.retryAfterSec > 0);
  // 成功登录清零：锁过期路径外，recordSuccess 立即解除。
  limiter.recordSuccess(key);
  assert.equal(limiter.checkLocked(key).locked, false);
});

test('cookie helpers parse and format the session cookie', () => {
  const header = sessionCookieHeader('tok', 3600);
  assert.match(header, /^csm_session=tok; HttpOnly; SameSite=Lax; Path=\/; Max-Age=3600$/);
  assert.match(clearSessionCookieHeader(), /Max-Age=0/);
  assert.equal(cookieValue('a=1; csm_session=abc; b=2', 'csm_session'), 'abc');
  assert.equal(cookieValue(undefined, 'csm_session'), undefined);
  assert.equal(cookieValue('novalue', 'csm_session'), undefined);
});

test('session expiry slides only past the touch interval', () => {
  const far = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
  assert.equal(sessionExpiry(far).expired, false);
  assert.ok(sessionExpiry(far).nextExpiresAt, '远端会话应给出续期时刻');
  const recent = new Date(Date.now() - 1000).toISOString();
  assert.equal(sessionExpiry(far, recent).nextExpiresAt, undefined, '刚 touch 过的会话不重复续期');
  assert.equal(sessionExpiry(new Date(Date.now() - 1000).toISOString()).expired, true);
  assert.equal(sessionExpiry('garbage').expired, true);
});

test('bootstrap admin is created once with env or generated password', async () => {
  await withDb(async (db) => {
    process.env.CSM_ADMIN_PASSWORD = 'env-pass-123';
    try {
      const first = ensureBootstrapAdmin(db);
      assert.equal(first.created, true);
      const admin = db.getUserByUsername('admin');
      assert.ok(admin);
      assert.equal(admin!.role, 'admin');
      assert.equal(verifyPassword('env-pass-123', admin!.passwordHash), true);
      // 幂等：已有用户不再创建（也不会再打印/覆盖密码）。
      delete process.env.CSM_ADMIN_PASSWORD;
      const second = ensureBootstrapAdmin(db);
      assert.equal(second.created, false);
      assert.equal(db.countUsers(), 1);
      assert.equal(verifyPassword('env-pass-123', db.getUserByUsername('admin')!.passwordHash), true);
    } finally {
      delete process.env.CSM_ADMIN_PASSWORD;
    }
  });
  await withDb((db) => {
    // 无环境变量：生成随机密码（只回显一次），校验可通过 whoami 场景复现的哈希路径。
    const result = ensureBootstrapAdmin(db);
    assert.equal(result.created, true);
    assert.ok(result.generatedPassword && result.generatedPassword.length >= 12);
    assert.equal(verifyPassword(result.generatedPassword!, db.getUserByUsername('admin')!.passwordHash), true);
  });
});

test('user CRUD, duplicate rejection and credential lifecycle', async () => {
  await withDb((db) => {
    const user = db.createUser({ username: 'csm1', displayName: '一号', passwordHash: hashPassword('pass-12345') });
    assert.equal(user.username, 'csm1');
    assert.equal(user.role, 'member');
    assert.equal(user.status, 'active');
    assert.equal(db.getUserByUsername('csm1')!.passwordHash.length > 10, true);
    assert.throws(() => db.createUser({ username: 'csm1', passwordHash: 'x' }), /UNIQUE/);
    // 更新：改角色与显示名，密码哈希不显式传时保持原值。
    const updated = db.updateUser(user.id, { role: 'admin', displayName: '一号（管理员）' });
    assert.equal(updated!.role, 'admin');
    assert.equal(verifyPassword('pass-12345', db.getUserByUsername('csm1')!.passwordHash), true);
    // 重置密码后旧密码失效。
    db.updateUser(user.id, { passwordHash: hashPassword('new-pass-678') });
    assert.equal(verifyPassword('pass-12345', db.getUserByUsername('csm1')!.passwordHash), false);
    // 会话凭证：签发→命中→滑动续期→按用户收回。
    const { tokenHash } = issueToken();
    db.createAuthSession(tokenHash, user.id, new Date(Date.now() + 3600_000).toISOString());
    const found = db.findAuthSession(tokenHash);
    assert.equal(found?.user.username, 'csm1');
    db.touchAuthSession(tokenHash, new Date(Date.now() + 7200_000).toISOString());
    db.deleteUserAuthSessions(user.id);
    assert.equal(db.findAuthSession(tokenHash), null);
    // PAT：签发→命中→列表→按 id+属主吊销（他人吊不掉）。
    const pat = issueToken();
    const record = db.createAuthToken(pat.tokenHash, user.id, 'ci');
    assert.equal(db.findAuthToken(pat.tokenHash)!.username, 'csm1');
    assert.equal(db.listAuthTokens(user.id).length, 1);
    const other = db.createUser({ username: 'csm2', passwordHash: 'x' });
    assert.equal(db.deleteAuthToken(record.id, other.id), false);
    assert.equal(db.deleteAuthToken(record.id, user.id), true);
    assert.equal(db.findAuthToken(pat.tokenHash), null);
    db.deleteAuthTokenByHash(pat.tokenHash);
    // 用户列表不含密码哈希。
    for (const listed of db.listUsers()) assert.equal('passwordHash' in listed, false);
  });
});
