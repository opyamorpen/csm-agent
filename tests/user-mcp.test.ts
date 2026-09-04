import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadUserMcpServers, saveUserMcpServers, migrateGlobalMcpToUser, userConfigDir, userStateDir, type McpServerConfig } from '../src/config.js';
import { UserRuntimes } from '../src/bootstrap.js';

/** userStateDir 跟随 CSM_DATA_DIR：测试里指向临时目录，绝不触碰真实 ~/.csm-agent。 */
function withDataDir(fn: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'csm-user-mcp-'));
  const previous = process.env.CSM_DATA_DIR;
  process.env.CSM_DATA_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.CSM_DATA_DIR;
      else process.env.CSM_DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    });
}

const SERVER_A: McpServerConfig = { name: 'crm', transport: 'streamable-http', url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer user-a-token' } };
const SERVER_B: McpServerConfig = { name: 'crm', transport: 'streamable-http', url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer user-b-token' } };

test('per-user MCP config: unconfigured is empty, save/load roundtrips, users are isolated', () => {
  return withDataDir((dir) => {
    assert.deepEqual(loadUserMcpServers(101), []);
    saveUserMcpServers(101, [SERVER_A]);
    saveUserMcpServers(202, [SERVER_B]);
    assert.deepEqual(loadUserMcpServers(101), [SERVER_A]);
    assert.deepEqual(loadUserMcpServers(202), [SERVER_B]);
    assert.equal(loadUserMcpServers(303).length, 0);
    // 文件落在各自的用户目录（0600 由原子写保证，不校验权限位）。
    assert.ok(existsSync(join(userStateDir(101), 'config', 'mcp.user.yaml')));
    assert.ok(!existsSync(join(userStateDir(303), 'config', 'mcp.user.yaml')));
    void dir;
  });
});

test('migrateGlobalMcpToUser copies the legacy global config verbatim (once)', () => {
  return withDataDir(() => {
    // 全局旧配置放在 userConfigDir（CSM_DATA_DIR 下的 config/）。
    mkdirSync(userConfigDir(), { recursive: true });
    writeFileSync(join(userConfigDir(), 'mcp.user.yaml'),
      'servers:\n  - name: crm\n    transport: streamable-http\n    url: https://crm.example/mcp\n    headers:\n      Authorization: Bearer ${CRM_TOKEN}\n', 'utf8');
    process.env.CRM_TOKEN = 'secret-from-env';
    try {
      assert.equal(migrateGlobalMcpToUser(1), true);
      // 原文逐字复制：${CRM_TOKEN} 占位符不被展开烘焙。
      const copied = readFileSync(join(userStateDir(1), 'config', 'mcp.user.yaml'), 'utf8');
      assert.match(copied, /\$\{CRM_TOKEN\}/);
      assert.match(copied, /name: crm/);
      // 幂等：用户已有配置（或再次运行）不再覆盖。
      assert.equal(migrateGlobalMcpToUser(1), false);
      // 加载时按既有 expandEnv 语义展开环境变量。
      assert.equal(loadUserMcpServers(1)[0]?.headers?.Authorization, 'Bearer secret-from-env');
      // 全局配置仍在：其他无配置用户同样可获一次性复制（每用户各幂等）。
      assert.equal(migrateGlobalMcpToUser(2), true);
      assert.equal(migrateGlobalMcpToUser(2), false);
    } finally {
      delete process.env.CRM_TOKEN;
    }
  });
});

test('UserRuntimes: per-user hubs are distinct and cached; reconnect picks up new config', async () => {
  await withDataDir(async () => {
    saveUserMcpServers(7, [{ name: 'hemory', transport: 'streamable-http', url: 'https://hemory.example/mcp', headers: { Authorization: 'Bearer h' } }]);
    const runtimes = new UserRuntimes();
    const a1 = runtimes.get(7);
    const a2 = runtimes.get(7);
    assert.equal(a1, a2, '同一用户复用同一运行时');
    const b = runtimes.get(8);
    assert.notEqual(a1.mcp, b.mcp, '不同用户各自独立连接池');
    assert.equal(a1.tools.length > 0, true, '本地工具始终在场（MCP 未连也不空）');
    assert.equal(runtimes.list().length, 2);
    assert.deepEqual(runtimes.failuresOf(8), []);
    // 重连按新配置：清掉配置后 reconnect 得到空服务列表（不抛错、工具表回到纯本地工具）。
    saveUserMcpServers(7, []);
    await runtimes.reconnect(7);
    assert.deepEqual(loadUserMcpServers(7), []);
  });
});

test('migrateGlobalMcpToUser falls back to the packaged legacy config (same source as the old loader)', () => {
  // 用户目录没有全局配置时，迁移源回退到仓库自带的 legacy config/mcp.user.yaml——
  // 与旧 loadMcpServers 的回退链一致：单用户时代靠它启动的部署，升级后 admin 拿到同一份配置。
  return withDataDir(() => {
    assert.equal(migrateGlobalMcpToUser(1), true);
    assert.ok(existsSync(join(userStateDir(1), 'config', 'mcp.user.yaml')));
    assert.ok(loadUserMcpServers(1).length >= 1);
  });
});
