import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCustomerBoundDraft } from '../src/server.js';
import type { ConfirmDraft } from '../src/tools/confirm.js';
import type { CustomerContext } from '../src/tools/customer.js';

const customer: CustomerContext = {
  customer_name: '客户甲',
  crm_customer_id: 'crm-1',
  ones_customer_option_id: 'option-1',
  customer_manhour_issue_id: 'hours-1',
};

function draft(overrides: Partial<ConfirmDraft> = {}): ConfirmDraft {
  return {
    target_system: 'ones',
    target_object: 'ONES Desk / 工单',
    record_type: 'ticket',
    title: '工单',
    summary: '摘要',
    fields: { customer_id: 'crm-1', customer_name: '客户甲' },
    target_tool: 'mcp__ones__create_new_issue',
    target_arguments: { fieldValues: [{ fieldID: 'JrvswW8P', value: 'option-1' }] },
    ...overrides,
  };
}

test('writeback: ONES work item requires the exact customer option binding', () => {
  assert.equal(validateCustomerBoundDraft(draft(), customer), null);
  assert.match(validateCustomerBoundDraft(draft({ target_arguments: { fieldValues: [] } }), customer) ?? '', /JrvswW8P/);
  assert.match(validateCustomerBoundDraft(draft({ fields: { customer_id: 'crm-2', customer_name: '客户甲' } }), customer) ?? '', /不一致/);
});

test('writeback: workhour and CRM followup bind their authoritative customer identities', () => {
  assert.equal(validateCustomerBoundDraft(draft({ record_type: 'workhour', target_arguments: { issueID: 'hours-1' } }), customer), null);
  assert.match(validateCustomerBoundDraft(draft({ record_type: 'workhour', target_arguments: { issueID: 'hours-2' } }), customer) ?? '', /售后客户/);
  assert.equal(validateCustomerBoundDraft(draft({ target_system: 'crm', record_type: 'followup', target_arguments: { customerId: 'crm-1' } }), customer), null);
  assert.match(validateCustomerBoundDraft(draft({ target_system: 'crm', record_type: 'followup', target_arguments: { customerId: 'crm-2' } }), customer) ?? '', /CRM 回写参数/);
});

test('writeback: approval falls back to workbench-resolved ids when the session context is stale', () => {
  // 会话上下文缺失 option id / 工时项 id，但工作台库已确认身份：放行（会话创建早于身份解析的真实场景）。
  const stale: CustomerContext = { customer_name: '客户甲', crm_customer_id: 'crm-1' };
  const resolve = () => ({ ones_customer_option_id: 'option-1', customer_manhour_issue_id: 'hours-1' });
  assert.equal(validateCustomerBoundDraft(draft(), stale, resolve), null);
  assert.equal(validateCustomerBoundDraft(draft({ record_type: 'workhour', target_arguments: { issueID: 'hours-1' } }), stale, resolve), null);
  // 库里同样没有解析结果：拒绝并提示刷新客户同步。
  assert.match(validateCustomerBoundDraft(draft(), stale, () => ({})) ?? '', /未解析，请刷新客户同步/);
  // 工作台库当前值优先于会话上下文的过期值：草稿仍绑旧 option 时按新值报错，错误信息给出期望值。
  assert.match(validateCustomerBoundDraft(draft(), customer, () => ({ ones_customer_option_id: 'option-2' })) ?? '', /option-2/);
  assert.equal(validateCustomerBoundDraft(draft({ target_arguments: { fieldValues: [{ fieldID: 'JrvswW8P', value: 'option-2' }] } }),
    customer, () => ({ ones_customer_option_id: 'option-2' })), null);
});
