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
