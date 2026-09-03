import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { LAUNCH_AGENT_LABEL, renderLaunchAgent } from '../src/service.js';

test('service: launch agent keeps the built CLI alive without embedding credentials', () => {
  const plist = renderLaunchAgent(3210);
  assert.match(plist, new RegExp(LAUNCH_AGENT_LABEL));
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<string>3210<\/string>/);
  assert.doesNotMatch(plist, /TOKEN|PASSWORD|SECRET|API_KEY/);
});

test('service: launch agent marks the process supervised so stale builds self-swap', () => {
  const plist = renderLaunchAgent(3210);
  // CSM_SUPERVISED=1：服务检测到 dist 更新后自退出，靠 KeepAlive 拉起新构建（旧进程自愈的关键标记）。
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>CSM_SUPERVISED<\/key>\s*<string>1<\/string>/);
});

test('service: 启动孤儿清扫必须先于调度器挂载（hermory 启动补跑不被误标「服务重启中断」）', () => {
  // 2026-09-03 事故：scheduleHemorySync 启动即 catchUp 补跑漏槽并创建 running run，
  // failOrphanedSyncRuns 落在其后会把刚建的 run 几毫秒内清扫成 failed「服务重启中断」
  // （异步工作实际仍在跑，run 记录全花、hasSuccessfulSyncScope 永不满足 → 每次启动重复补跑）。
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const sweep = source.indexOf('db.failOrphanedSyncRuns()');
  const hermoryScheduler = source.indexOf('scheduleHemorySync(sync');
  assert.ok(sweep > -1, 'server.ts 应调用 db.failOrphanedSyncRuns()');
  assert.ok(hermoryScheduler > -1, 'server.ts 应挂载 scheduleHemorySync');
  assert.ok(
    sweep < hermoryScheduler,
    `孤儿清扫（字节偏移 ${sweep}）必须先于调度器挂载（字节偏移 ${hermoryScheduler}）`,
  );
});
