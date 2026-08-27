import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionTranscript, type TranscriptSession } from '../src/transcript.js';

function session(partial?: Partial<TranscriptSession>): TranscriptSession {
  return {
    title: '测试会话',
    createdAt: new Date('2026-08-20T02:00:00Z').getTime(),
    updatedAt: new Date('2026-08-27T06:30:00Z').getTime(),
    events: [],
    customer: { customer_name: '云启科技', crm_customer_id: 'cust_1' },
    ...partial,
  };
}

test('transcript: header includes title, customer binding and Shanghai-time range', () => {
  const text = formatSessionTranscript(session());
  assert.match(text, /# 测试会话/);
  assert.match(text, /客户：云启科技（CRM cust_1）/);
  // 02:00Z = 上海 10:00；06:30Z = 上海 14:30。
  assert.match(text, /会话时间：\d{4}\/\d{2}\/\d{2} 10:00 - \d{4}\/\d{2}\/\d{2} 14:30（北京时间）/);
});

test('transcript: unbound sessions show 未绑定客户 and fallback title', () => {
  const text = formatSessionTranscript(session({ title: '', customer: null }));
  assert.match(text, /# 新对话/);
  assert.match(text, /客户：未绑定客户/);
});

test('transcript: renders dialogue only, tool traces are excluded from sharing', () => {
  const text = formatSessionTranscript(session({
    events: [
      { seq: 1, event: { type: 'user', text: '整理本周跟进' } },
      { seq: 2, event: { type: 'turn_start' } },
      { seq: 3, event: { type: 'tool_call', name: 'get_customer_profile', arguments: { customer_id: 'cust_1' } } },
      { seq: 4, event: { type: 'tool_result', name: 'get_customer_profile', result: 'x'.repeat(600) } },
      { seq: 5, event: { type: 'text', text: '已整理完成' } },
      { seq: 6, event: { type: 'turn_end' } },
    ],
  }));
  assert.match(text, /用户：整理本周跟进/);
  assert.match(text, /助手：已整理完成/);
  // 工具轨迹（调用/结果）与 turn 标记都不进入分享文本。
  assert.doesNotMatch(text, /get_customer_profile/);
  assert.doesNotMatch(text, /调用工具/);
  assert.doesNotMatch(text, /工具结果/);
  assert.doesNotMatch(text, /turn_start|turn_end/);
});

test('transcript: confirm drafts render target system and tool', () => {
  const text = formatSessionTranscript(session({
    events: [
      { seq: 1, event: { type: 'confirm', draft: {
        target_system: 'crm', target_object: 'CRM 跟进记录', record_type: 'followup',
        title: '本周沟通记录', summary: 's', fields: {}, target_tool: 'data_record_create',
        target_arguments: {},
      } } },
      { seq: 2, event: { type: 'confirm' } }, // 无草稿的 confirm 跳过
    ],
  }));
  assert.match(text, /\[待确认草稿\] 本周沟通记录 ｜ 目标: crm ｜ 工具: data_record_create/);
});
