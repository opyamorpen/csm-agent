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
