import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installService, LAUNCH_AGENT_LABEL, launchAgentLabel, renderLaunchAgent, servicePaths } from '../src/service.js';

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

test('service: plist pins CSM_DATA_DIR so non-default installs keep one data home', () => {
  // plist 在安装期固化数据目录：--data-dir 隔离安装的服务不再落回默认 ~/.csm-agent，
  // 与 shim 固化的 CSM_DATA_DIR 同源（CLI 与服务看到同一份库/配置/会话）。
  const plist = renderLaunchAgent(3210);
  assert.match(plist, /<key>CSM_DATA_DIR<\/key>\s*<string>[^<]+<\/string>/);
});

test('service: renderLaunchAgent honors an explicit node binary (update reuses the installed one)', () => {
  const plist = renderLaunchAgent(3212, '/opt/pinned-node/bin/node');
  assert.match(plist, /<string>\/opt\/pinned-node\/bin\/node<\/string>/);
  assert.match(plist, /<string>3212<\/string>/);
});

test('service: launchAgentLabel can be overridden for isolated acceptance', () => {
  const original = process.env.CSM_LAUNCH_AGENT_LABEL;
  try {
    delete process.env.CSM_LAUNCH_AGENT_LABEL;
    assert.equal(launchAgentLabel(), LAUNCH_AGENT_LABEL);
    assert.ok(servicePaths().plist.endsWith(`${LAUNCH_AGENT_LABEL}.plist`));
    process.env.CSM_LAUNCH_AGENT_LABEL = 'cn.csm-agent.accept';
    assert.equal(launchAgentLabel(), 'cn.csm-agent.accept');
    assert.ok(servicePaths().plist.endsWith('cn.csm-agent.accept.plist'));
    assert.match(renderLaunchAgent(3210), /<string>cn\.csm-agent\.accept<\/string>/);
  } finally {
    if (original === undefined) delete process.env.CSM_LAUNCH_AGENT_LABEL;
    else process.env.CSM_LAUNCH_AGENT_LABEL = original;
  }
});

test('service: install rejects a non-integer or out-of-range port before touching launchd', () => {
  for (const bad of [NaN, 0, -1, 65536, 1.5]) {
    assert.throws(() => installService(bad as number), /端口必须是 1-65535 的整数/);
  }
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
