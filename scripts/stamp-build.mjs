#!/usr/bin/env node
/**
 * 构建戳：npm run build 时先于 tsc 运行。把 git SHA + dirty 标记 + 构建时间写入
 * dist/build-info.json（服务端读取）与 public/build-info.js（前端 window.__CSM_BUILD__），
 * 两者共享同一 buildId——「进程内代码」与「页面脚本」的版本比对以此为锚点，
 * 旧进程加载新 UI（或反之）可以被前端横幅与 /api/version 立刻暴露。
 *
 * --out <dir> 指定 dist 输出目录（默认 dist），单测用它写临时目录；public 锚点只在
 * 输出目录就是仓库 dist 的真实构建时才改写——单测的临时 --out 若也改写它，每次 npm test
 * 都会把前端比对锚点推进到一个没有对应 dist 的幽灵构建时间，制造 staleness 误报。
 * git 不可用时（如源码包拷贝）退化为纯时间戳构建号，不阻塞构建。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArgIndex = args.indexOf('--out');
const outDir = outArgIndex >= 0 ? resolve(args[outArgIndex + 1] ?? 'dist') : join(repoRoot, 'dist');
const publicDir = join(repoRoot, 'public');

function git(...pieces) {
  try { return execFileSync('git', pieces, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

let gitSha = git('rev-parse', 'HEAD');
let dirty = false;
if (gitSha) {
  try { dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; }
  catch { dirty = false; }
} else {
  gitSha = null;
}
const builtAt = new Date().toISOString();
const buildId = `${gitSha ? gitSha.slice(0, 12) : 'nogit'}-${dirty ? 'dirty' : 'clean'}-${builtAt}`;
const info = { buildId, gitSha, dirty, builtAt };

const stampsPublicAnchor = outDir === join(repoRoot, 'dist');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
if (stampsPublicAnchor) {
  // 已有 build-info.js 被提交过的仓库里，重写会改变工作区状态；保持幂等即可（内容含时间戳必然变化）。
  writeFileSync(join(publicDir, 'build-info.js'), `// 构建时生成（gitignore）：前端与 /api/version 的 buildId 比对锚点。\nwindow.__CSM_BUILD__ = ${JSON.stringify(info)};\n`, 'utf8');
}

console.log(`build stamp: ${buildId} -> ${join(outDir, 'build-info.json')}${stampsPublicAnchor ? `, ${join(publicDir, 'build-info.js')}` : ''}`);
export { info };
