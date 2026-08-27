import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { appRoot, readInstallLayout, readPackageVersion } from '../src/managed-install.js';
import { applyUpdate, planUpdate, serviceBelongsToRoot } from '../src/update.js';
import { runUninstall, SHIM_MARKER } from '../src/uninstall.js';

function sh(command: string, cwd?: string): string {
  return execFileSync('/bin/bash', ['-c', command], { cwd, encoding: 'utf8' });
}

function makeRepo(path: string, version: string): void {
  mkdirSync(path, { recursive: true });
  sh(`git init -q -b main && git config user.email t@t && git config user.name t`, path);
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'csm-agent', version, bin: { 'csm-agent': 'dist/cli.js' } }));
  writeFileSync(join(path, 'dist-cli.js'), `console.log('${version}')\n`);
  sh('git add -A && git commit -qm init', path);
}

/** 远端裸仓库 + 一个受管 clone（带安装标记），模拟 install.sh 安装结果。 */
function makeInstalledClone(t: { name: string }): { remote: string; root: string; binDir: string; dataDir: string } {
  const base = mkdtempSync(join(tmpdir(), `csm-update-${t.name}-`));
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  const root = join(base, 'app');
  const binDir = join(base, 'bin');
  const dataDir = join(base, 'data');
  sh(`git init -q --bare -b main ${JSON.stringify(remote)}`);
  makeRepo(work, '0.2.0');
  sh(`git remote add origin ${JSON.stringify(remote)} && git push -q origin main`, work);
  sh(`git clone -q ${JSON.stringify(remote)} ${JSON.stringify(root)}`);
  mkdirSync(binDir);
  mkdirSync(dataDir);
  writeFileSync(join(root, '.install_method'), 'install.sh\n');
  writeFileSync(join(root, '.install-layout.json'), JSON.stringify({
    method: 'install.sh', appDir: root, binDir, appsDir: join(base, 'Applications'), port: 3212, branch: 'main', nodeDir: null, service: false,
  }));
  return { remote, root, binDir, dataDir };
}

function pushNewVersion(work: string, version: string): void {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'csm-agent', version, bin: { 'csm-agent': 'dist/cli.js' } }));
  sh('git add -A && git commit -qm bump && git push -q origin main', work);
}

test('update: up-to-date install reports without touching anything', (t) => {
  const { root } = makeInstalledClone(t);
  const plan = planUpdate(root);
  assert.equal(plan.action, 'up-to-date');
  assert.equal(plan.localChanges.length, 0); // .install_method 是 untracked，不算本地改动
  assert.equal(readPackageVersion(root), '0.2.0');
  rmSync(dirname(root), { recursive: true, force: true });
});

test('update: fetches new version, resets, rebuilds and reports version change', (t) => {
  const { remote, root } = makeInstalledClone(t);
  const work = join(dirname(root), 'work');
  pushNewVersion(work, '0.3.0');
  const plan = planUpdate(root);
  assert.equal(plan.action, 'update');
  assert.equal(plan.localChanges.length, 0);
  const report = applyUpdate(root, plan, {
    runBuildSteps: () => { /* 注入构建，避免真实 npm ci */ },
    rebuildDesktop: () => 'skipped',
  });
  assert.equal(report.status, 'updated');
  assert.equal(report.oldVersion, '0.2.0');
  assert.equal(report.newVersion, '0.3.0');
  assert.equal(report.desktop, 'skipped');
  assert.equal(report.serviceRestarted, false); // 无 plist，不动服务
  assert.equal(readPackageVersion(root), '0.3.0');
  rmSync(dirname(root), { recursive: true, force: true });
});

test('update: refuses to reset tracked local changes', (t) => {
  const { root } = makeInstalledClone(t);
  writeFileSync(join(root, 'dist-cli.js'), 'modified\n');
  const plan = planUpdate(root);
  assert.ok(plan.localChanges.length > 0);
  assert.throws(() => {
    if (plan.localChanges.length) throw new Error('local changes');
  }, /local changes/);
  assert.equal(readFileSync(join(root, 'dist-cli.js'), 'utf8'), 'modified\n');
  rmSync(dirname(root), { recursive: true, force: true });
});

test('update: serviceBelongsToRoot only matches a plist referencing this install', (t) => {
  const base = mkdtempSync(join(tmpdir(), `csm-svc-${t.name}-`));
  const root = join(base, 'app');
  makeRepo(root, '0.2.0');
  const plist = join(base, 'cn.csm-agent.service.plist');
  writeFileSync(plist, `<plist><string>${root}/dist/cli.js</string></plist>`);
  assert.equal(serviceBelongsToRoot(root, plist), true);
  assert.equal(serviceBelongsToRoot(join(base, 'other-app'), plist), false);
  assert.equal(serviceBelongsToRoot(root, join(base, 'missing.plist')), false);
  rmSync(base, { recursive: true, force: true });
});

function managedShim(path: string, root: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${SHIM_MARKER}\nexec node ${root}/dist/cli.js "$@"\n`);
  chmodSync(path, 0o755);
}

test('uninstall: removes managed artifacts, keeps user data by default, purges with --purge --yes', async (t) => {
  const { root, binDir, dataDir } = makeInstalledClone(t);
  const appsDir = join(dirname(root), 'Applications');
  mkdirSync(appsDir, { recursive: true });
  const appLink = join(appsDir, 'CSM Agent.app');
  const shim = join(binDir, 'csm-agent');
  managedShim(shim, root);
  mkdirSync(join(root, 'dist-mac', 'CSM Agent.app'), { recursive: true });
  symlinkSync(join(root, 'dist-mac', 'CSM Agent.app'), appLink);
  // 用户数据
  const sessions = join(dataDir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 's1.json'), '{}');

  const original = process.env.CSM_DATA_DIR;
  process.env.CSM_DATA_DIR = dataDir;
  try {
    const keepOut = await runUninstallCapture({ purge: false, yes: true }, root);
    assert.equal(keepOut.dataRetained, dataDir);
    assert.equal(keepOut.shim.removed, shim);
    assert.equal(keepOut.appLink.removed, appLink);
    assert.equal(keepOut.appDirRemoved, true);
    assert.equal(existsSync(shim), false);
    assert.equal(existsSync(appLink), false);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(join(sessions, 's1.json')), true);
  } finally {
    if (original === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = original;
  }
  rmSync(dirname(root), { recursive: true, force: true });
});

test('uninstall: never deletes a real (non-symlink) app bundle or foreign shim', async (t) => {
  const { root, binDir, dataDir } = makeInstalledClone(t);
  const appsDir = join(dirname(root), 'Applications');
  mkdirSync(appsDir, { recursive: true });
  const realApp = join(appsDir, 'CSM Agent.app');
  mkdirSync(realApp, { recursive: true }); // 真实目录，非符号链接
  const foreignShim = join(binDir, 'csm-agent');
  writeFileSync(foreignShim, '#!/bin/sh\nexec something-else\n');
  chmodSync(foreignShim, 0o755);
  const original = process.env.CSM_DATA_DIR;
  process.env.CSM_DATA_DIR = dataDir;
  try {
    const out = await runUninstallCapture({ purge: false, yes: true }, root);
    assert.ok(String(out.appLink.skipped).includes('未删除'));
    assert.ok(String(out.shim.skipped).includes('未删除') || String(out.shim.skipped).includes('非本安装'));
    assert.equal(existsSync(realApp), true);
    assert.equal(existsSync(foreignShim), true);
  } finally {
    if (original === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = original;
  }
  rmSync(dirname(root), { recursive: true, force: true });
});

test('uninstall: shim written with an alias path form is still removed', async (t) => {
  const { root, binDir, dataDir } = makeInstalledClone(t);
  const appsDir = join(dirname(root), 'Applications');
  mkdirSync(appsDir, { recursive: true });
  // macOS 上 /var 与 /tmp 分别是 /private/var、/private/tmp 的符号链接：
  // shim 用 realpath 形式写入（与 layout 记录的短形式不同）仍须能归属本安装
  const aliasRoot = realpathSync(root);
  if (aliasRoot === root) {
    t.skip('此环境路径无别名形式，跳过');
    return;
  }
  const shim = join(binDir, 'csm-agent');
  writeFileSync(shim, `#!/usr/bin/env bash\n${SHIM_MARKER}\nexec node ${aliasRoot}/dist/cli.js "$@"\n`);
  chmodSync(shim, 0o755);
  const appBundle = join(root, 'dist-mac', 'CSM Agent.app');
  mkdirSync(appBundle, { recursive: true });
  symlinkSync(join(aliasRoot, 'dist-mac', 'CSM Agent.app'), join(appsDir, 'CSM Agent.app'));
  const original = process.env.CSM_DATA_DIR;
  process.env.CSM_DATA_DIR = dataDir;
  try {
    const out = await runUninstallCapture({ purge: false, yes: true }, root);
    assert.equal(out.shim.removed, shim);
    assert.equal(out.appLink.removed, join(appsDir, 'CSM Agent.app'));
  } finally {
    if (original === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = original;
  }
  rmSync(dirname(root), { recursive: true, force: true });
});

async function runUninstallCapture(options: { purge: boolean; yes: boolean }, root: string): Promise<Record<string, any>> {
  const chunks: string[] = [];
  const originalLog = console.log;
  console.log = ((value: string) => { chunks.push(String(value)); }) as typeof console.log;
  try {
    await runUninstall(options, root);
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(chunks.join(''));
}

test('managed-install: dev checkout is not a managed install and layout parse is safe', () => {
  assert.equal(existsSync(join(appRoot(), '.install_method')), false);
  assert.equal(readInstallLayout(appRoot()), null);
  assert.equal(typeof readPackageVersion(appRoot()), 'string');
});

test('cli: update/uninstall registered in capabilities and help', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.match(cli, /\{ command: 'update', workflow: 'self-update'/);
  assert.match(cli, /\{ command: 'uninstall', workflow: 'self-update'/);
  assert.match(cli, /csm-agent update/);
  assert.match(cli, /csm-agent uninstall \[--purge\]/);
  const helpResult = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'help'], { cwd: appRoot(), encoding: 'utf8' });
  assert.equal(helpResult.status, 0);
  assert.match(helpResult.stdout, /csm-agent update/);
});
