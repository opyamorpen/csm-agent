import assert from 'node:assert/strict';
import test from 'node:test';
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
