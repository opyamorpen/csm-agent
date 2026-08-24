import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCustomerContext, extractCustomerContext, CUSTOMER_CONTEXT_TOOL_NAME } from '../src/tools/customer.js';

test('extractCustomerContext: picks known fields, stringifies, drops empties', () => {
  const out = extractCustomerContext({
    customer_name: '云启科技',
    crm_customer_id: 123 as unknown as string, // non-string dropped
    industry: ' 软件 ',
    unknown_field: 'x',
    summary: '',
  });
  assert.deepEqual(out, { customer_name: '云启科技', industry: '软件' });
});

test('mergeCustomerContext: non-empty wins, empty keeps old, unknown ignored', () => {
  const prev = { customer_name: '旧名', industry: '软件', health: '绿' };
  const merged = mergeCustomerContext(prev, { customer_name: '新名', industry: '', summary: '摘要' });
  assert.equal(merged.customer_name, '新名');
  assert.equal(merged.industry, '软件'); // empty next keeps old
  assert.equal(merged.health, '绿'); // untouched field kept
  assert.equal(merged.summary, '摘要');
});

test('mergeCustomerContext: null prev works', () => {
  const merged = mergeCustomerContext(null, { customer_name: 'A', health: '' });
  assert.deepEqual(merged, { customer_name: 'A' });
});

test('resolve_customer tool name constant', () => {
  assert.equal(CUSTOMER_CONTEXT_TOOL_NAME, 'resolve_customer');
});
