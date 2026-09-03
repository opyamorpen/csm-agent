import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 一键安装器的显示/行为契约：install.sh 是用户机器上唯一入口，这里用字面量锚定
 * 本轮加固的关键行为，防止后续改动无声倒退（bash -n 先保证语法可执行）。
 */

const installSh = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8');
const buildMacAppSh = readFileSync(new URL('../scripts/build-mac-app.sh', import.meta.url), 'utf8');

function bashSyntaxOk(relativePath: string): boolean {
  const result = spawnSync('/bin/bash', ['-n', fileURLToPath(new URL(relativePath, import.meta.url))]);
  return result.status === 0;
}

test('install: scripts pass bash syntax check', () => {
  assert.ok(bashSyntaxOk('../scripts/install.sh'), 'install.sh 应无 bash 语法错误');
  assert.ok(bashSyntaxOk('../scripts/build-mac-app.sh'), 'build-mac-app.sh 应无 bash 语法错误');
});

test('install: 头部文档以「先下载后执行」为推荐形式（curl 失败即刻显式报错）', () => {
  assert.match(installSh, /-o \/tmp\/csm-agent-install\.sh && bash \/tmp\/csm-agent-install\.sh/);
});

test('install: Node tarball 下载必须做 SHA256 校验，捆绑 Node 复用须全版本精确匹配', () => {
  assert.match(installSh, /SHASUMS256\.txt/);
  assert.match(installSh, /shasum -a 256 -c/);
  // 只认 v${NODE_VERSION} 全版本（旧 22.x 不得混用）
  assert.ok(installSh.includes('= "v${NODE_VERSION}"'), '捆绑 Node 复用应精确匹配 v${NODE_VERSION}');
});

test('install: layout 用 node JSON.stringify 安全生成（不再用未转义 heredoc）', () => {
  assert.match(installSh, /JSON\.stringify\(layout/);
  assert.doesNotMatch(installSh, /cat > "\$APP_DIR\/\.install-layout\.json" <<EOF/, '不得回退到未转义 heredoc 写 layout');
});

test('install: 已存在但非受管的目录自动移到 *.broken-<ts> 后重新克隆（重跑自愈）', () => {
  assert.match(installSh, /APP_DIR\.broken-/);
  assert.match(installSh, /mv "\$APP_DIR" "\$backup"/);
});

test('install: 服务就绪须轮询 /api/version 校验 buildId 与磁盘一致且非 stale（取代 sleep 2）', () => {
  assert.match(installSh, /wait_service_ready/);
  assert.match(installSh, /\/api\/version/);
  assert.match(installSh, /build-info\.json/);
  assert.doesNotMatch(installSh, /sleep 2\nfi/, '不得回退到固定 sleep 就当服务已就绪');
  // doctor 失败必须显式失败（不得 || true 吞掉）
  assert.match(installSh, /doctor.*\|\| die/);
  assert.doesNotMatch(installSh, /\|\| true\n\nsay "安装完成/, '收尾前不得吞掉自检失败');
});

test('install: shim 固化 CSM_DATA_DIR（非默认 --data-dir 安装 CLI/服务/数据一致）', () => {
  assert.match(installSh, /CSM_DATA_DIR="\$DATA_DIR"\nexport CSM_DATA_DIR/);
});

test('install: 端口参数必须校验 1-65535', () => {
  assert.match(installSh, /端口必须是 1-65535 的整数/);
  assert.match(installSh, /\*\[!0-9\]\*/, '端口应拒绝非数字');
});

test('install: 支持 --repo/--branch 指定安装源（默认不变），构建只跑一遍', () => {
  assert.match(installSh, /--repo\) arg_repo=/);
  assert.match(installSh, /--branch\) arg_branch=/);
  assert.match(installSh, /CSM_INSTALL_REPO/);
  assert.match(installSh, /CSM_SKIP_SERVER_BUILD=1/);
  assert.match(buildMacAppSh, /CSM_SKIP_SERVER_BUILD/, 'build-mac-app.sh 应尊重跳过重复构建');
});

test('install: 桌面 App 构建失败不阻断安装（警告后继续），PATH 按登录 shell 写 rc', () => {
  assert.match(installSh, /桌面 App 构建失败（CLI 与服务不受影响）/);
  assert.match(installSh, /\.bash_profile/);
  assert.match(installSh, /\.zshrc/);
  assert.match(installSh, /\.profile/);
});

test('install: 收尾打印安装指纹（gitSha 比对锚点）', () => {
  assert.match(installSh, /安装指纹/);
  assert.match(installSh, /rev-parse HEAD/);
  assert.match(installSh, /version --json/);
});
