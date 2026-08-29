import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInfo, serviceVersionInfo, startStalenessWatch, type BuildInfo } from '../src/version.js';

function writeStamp(dir: string, info: BuildInfo): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify(info));
}

test('version: readBuildInfo parses stamped file and tolerates missing or broken files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-version-'));
  try {
    assert.equal(readBuildInfo(join(dir, 'no-such-dist')), null, '缺失文件返回 null 而非抛错');
    writeStamp(dir, { buildId: 'b-1', gitSha: 'deadbeef', dirty: true, builtAt: '2026-08-28T00:00:00Z' });
    assert.deepEqual(readBuildInfo(dir), { buildId: 'b-1', gitSha: 'deadbeef', dirty: true, builtAt: '2026-08-28T00:00:00Z' });
    writeFileSync(join(dir, 'build-info.json'), 'not json');
    assert.equal(readBuildInfo(dir), null, '损坏 JSON 返回 null');
    writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ gitSha: 'x' }));
    assert.equal(readBuildInfo(dir), null, '缺 buildId 字段返回 null');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('version: serviceVersionInfo reports stale only when disk build differs from loaded build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-version-'));
  const previousSupervised = process.env.CSM_SUPERVISED;
  try {
    const loaded: BuildInfo = { buildId: 'b-1', gitSha: null, dirty: false, builtAt: '' };
    // 磁盘同构建：fresh。
    writeStamp(dir, loaded);
    process.env.CSM_SUPERVISED = undefined;
    let info = serviceVersionInfo(loaded, '2026-08-28T00:00:00Z', dir);
    assert.equal(info.stale, false);
    assert.equal(info.supervised, false);
    assert.equal(info.pid, process.pid);
    assert.equal(info.startedAt, '2026-08-28T00:00:00Z');
    // 磁盘换成新构建：stale=true，且 buildId 仍报告进程加载的旧构建。
    writeStamp(dir, { buildId: 'b-2', gitSha: null, dirty: false, builtAt: '' });
    info = serviceVersionInfo(loaded, '2026-08-28T00:00:00Z', dir);
    assert.equal(info.stale, true);
    assert.equal(info.buildId, 'b-1', '进程版本以启动时加载的构建为准');
    // 磁盘无构建信息（从未构建）：不算 stale（避免误报）。
    process.env.CSM_SUPERVISED = '1';
    info = serviceVersionInfo(loaded, '2026-08-28T00:00:00Z', join(dir, 'no-dist'));
    assert.equal(info.stale, false);
    assert.equal(info.supervised, true);
    // 进程无构建信息（旧进程形态）：同样不误报 stale。
    info = serviceVersionInfo(null, '2026-08-28T00:00:00Z', dir);
    assert.equal(info.stale, false);
    assert.equal(info.buildId, 'unknown');
  } finally {
    if (previousSupervised === undefined) delete process.env.CSM_SUPERVISED;
    else process.env.CSM_SUPERVISED = previousSupervised;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version: staleness watch fires onReload when the disk build changes and stays quiet otherwise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-version-'));
  try {
    const loaded: BuildInfo = { buildId: 'b-1', gitSha: null, dirty: false, builtAt: '' };
    writeStamp(dir, loaded);
    let reloads = 0;
    const timer = startStalenessWatch(loaded, { distDir: dir, intervalMs: 10, onReload: () => reloads++ });
    assert.ok(timer, '有加载构建时必须启动自检');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reloads, 0, '磁盘未变化不得触发');
    writeStamp(dir, { buildId: 'b-2', gitSha: null, dirty: false, builtAt: '' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(reloads >= 1, '磁盘构建变化必须触发 onReload');
    clearInterval(timer);
    // 无加载构建（从未构建的进程）不启动自检。
    assert.equal(startStalenessWatch(null, { distDir: dir, intervalMs: 10 }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('version: stamp-build --out 临时目录只写 dist 戳，不得改写 public/build-info.js 锚点', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'csm-version-stamp-'));
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const publicAnchor = join(repoRoot, 'public', 'build-info.js');
  const before = existsSync(publicAnchor) ? readFileSync(publicAnchor, 'utf8') : null;
  try {
    // 单测形态（--out 临时目录）曾把仓库 public/build-info.js 一起改写成幽灵构建时间——
    // 该时间没有对应 dist 构建，前端 staleness 横幅会误报且自动换新不会触发，这里锁定锚点必须保持原样。
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'stamp-build.mjs'), '--out', outDir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const distInfo = JSON.parse(readFileSync(join(outDir, 'build-info.json'), 'utf8'));
    assert.match(distInfo.buildId, /^([0-9a-f]{12}|nogit)-(dirty|clean)-/, 'buildId 形如 sha12-dirty-时间');
    const after = existsSync(publicAnchor) ? readFileSync(publicAnchor, 'utf8') : null;
    assert.equal(after, before, '--out 临时目录运行不得改写 public/build-info.js');
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
