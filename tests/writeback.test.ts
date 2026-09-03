import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCustomerBoundDraft, resolveDraftCustomer, applyDraftCustomerOptionBinding, enrichCustomerContext } from '../src/server.js';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import type { ConfirmDraft } from '../src/tools/confirm.js';
import type { CustomerContext } from '../src/tools/customer.js';

async function withDb(fn: (db: WorkbenchDatabase) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-writeback-'));
  const db = new WorkbenchDatabase(dir);
  try {
    await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedDeskCustomer(db: WorkbenchDatabase) {
  db.upsertCustomer({ id: 'crm-1', name: '客户甲', renewalDate: null, contractValue: 100 });
  db.upsertIdentity('crm-1', 'ones_customer_option', 'option-1', '客户甲');
}

function deskDraft(overrides: Partial<ConfirmDraft> = {}): ConfirmDraft {
  return {
    target_system: 'ones',
    target_object: 'ONES Desk / 工单',
    record_type: 'ticket',
    title: '工单',
    summary: '摘要',
    fields: { customer_id: 'crm-1', customer_name: '客户甲' },
    target_tool: 'mcp__ones__create_new_issue',
    target_arguments: { fieldValues: [
      { fieldID: 'JrvswW8P', value: 'option-1' },
      { fieldID: 'CATNfrrF', value: 'JuTTumjJ' },
      { fieldID: 'HS5u8PNB', value: 'Fzg8dBCT' },
      { fieldID: 'Su4v8xFs', value: 'M1eT99eW' },
      { fieldID: 'field029', value: 'UPYjaEgNQX1K9R3L' },
      { fieldID: 'field016', value: '完整描述' },
    ] },
    ...overrides,
  };
}

test('writeback: resolveDraftCustomer resolves identity carried by the draft itself', async () => {
  await withDb(async (db) => {
    seedDeskCustomer(db);
    // 草稿自带客户名（未绑定会话的贴图/聊天记录提单）：唯一精确匹配即解析成功。
    const byName = resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '客户甲' } }), null);
    assert.equal(byName?.customer.id, 'crm-1');
    assert.equal(byName?.onesOptionId, 'option-1');
    // 真实事故形态：customer_id 是模型乱填的非 ID 串（CRM 授权错误拿不到），名称仍可解析。
    const garbageId = resolveDraftCustomer(db, deskDraft({ fields: { customer_id: '未提供（CRM 查询接口报 NO_LICENSE_QUOTE_ERROR）', customer_name: '客户甲' } }), null);
    assert.equal(garbageId?.customer.id, 'crm-1');
    // 草稿无客户信息时回落会话上下文（绑定会话旧路径）。
    const session: CustomerContext = { customer_name: '客户甲', crm_customer_id: 'crm-1' };
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: {} }), session)?.customer.id, 'crm-1');
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: {} }), { customer_name: '客户甲' })?.customer.id, 'crm-1');
    // 简称命中给 canonical 客户。
    db.upsertCustomer({ id: 'crm-2', name: '乙全称公司', shortName: '乙简称', renewalDate: null, contractValue: 0 });
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '乙简称' } }), null)?.customer.name, '乙全称公司');
    // 同名歧义与完全无匹配都返回 null（宁可拒绝也不模糊归属）。
    db.upsertCustomer({ id: 'crm-3', name: '客户甲', renewalDate: null, contractValue: 0 });
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '客户甲' } }), null), null);
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '不存在的客户' } }), null), null);
  });
});

test('writeback: desk approval deterministically binds the resolved customer option', async () => {
  await withDb(async (db) => {
    seedDeskCustomer(db);
    const binding = resolveDraftCustomer(db, deskDraft(), null)!;
    // 模型自行搜索的选项 UUID 不可信（相似名误绑风险）：批准前确定性纠正为 confirmed 选项。
    const wrongOption = deskDraft({ target_arguments: { fieldValues: [
      { fieldID: 'JrvswW8P', value: 'similar-but-wrong' },
      { fieldID: 'CATNfrrF', value: 'JuTTumjJ' }, { fieldID: 'HS5u8PNB', value: 'Fzg8dBCT' },
      { fieldID: 'Su4v8xFs', value: 'M1eT99eW' }, { fieldID: 'field029', value: 'UPYjaEgNQX1K9R3L' },
      { fieldID: 'field016', value: '完整描述' },
    ] } });
    assert.equal(applyDraftCustomerOptionBinding(wrongOption, binding), null);
    const values = wrongOption.target_arguments.fieldValues as Array<{ fieldID: string; value: string }>;
    assert.equal(values.find((v) => v.fieldID === 'JrvswW8P')?.value, 'option-1', '错误选项应被规范化');
    assert.equal(values.length, 6, '规范化只替换不增删');
    assert.equal(validateCustomerBoundDraft(wrongOption, binding), null);
    // 草稿完全没带客户字段也会补上。
    const missing = deskDraft({ target_arguments: { fieldValues: [
      { fieldID: 'CATNfrrF', value: 'JuTTumjJ' }, { fieldID: 'HS5u8PNB', value: 'Fzg8dBCT' },
      { fieldID: 'Su4v8xFs', value: 'M1eT99eW' }, { fieldID: 'field029', value: 'UPYjaEgNQX1K9R3L' },
      { fieldID: 'field016', value: '完整描述' },
    ] } });
    assert.equal(applyDraftCustomerOptionBinding(missing, binding), null);
    assert.equal((missing.target_arguments.fieldValues as Array<{ fieldID: string }>).some((v) => v.fieldID === 'JrvswW8P'), true);
    // 无 confirmed 选项的客户：确定性绑定报可操作错误。
    db.upsertCustomer({ id: 'crm-bare', name: '无身份客户', renewalDate: null, contractValue: 0 });
    const bareBinding = resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '无身份客户' } }), null)!;
    assert.match(applyDraftCustomerOptionBinding(deskDraft(), bareBinding) ?? '', /未解析到已确认的 ONES 客户选项/);
    assert.match(validateCustomerBoundDraft(deskDraft(), null) ?? '', /草稿未携带可唯一解析的客户/);
  });
});

test('writeback: CRM followup and workhour validate against the resolved customer identity', async () => {
  await withDb(async (db) => {
    seedDeskCustomer(db);
    const binding = resolveDraftCustomer(db, deskDraft(), null)!;
    assert.equal(validateCustomerBoundDraft(deskDraft({ target_system: 'crm', record_type: 'followup', target_arguments: { customerId: 'crm-1' } }), binding), null);
    assert.match(validateCustomerBoundDraft(deskDraft({ target_system: 'crm', record_type: 'followup', target_arguments: { customerId: 'crm-2' } }), binding) ?? '', /CRM 回写参数/);
    // 未解析到售后工时项（未同步）时工时校验拒绝，而不是放进 ONES 端才报错。
    assert.match(validateCustomerBoundDraft(deskDraft({ record_type: 'workhour', target_arguments: { issueID: 'hours-1' } }), binding) ?? '', /售后客户/);
  });
});

test('writeback: enrichCustomerContext backfills authoritative ids for session convenience', async () => {
  await withDb(async (db) => {
    seedDeskCustomer(db);
    const enriched = enrichCustomerContext(db, { customer_name: '客户甲' });
    assert.equal(enriched?.crm_customer_id, 'crm-1');
    assert.equal(enriched?.ones_customer_option_id, 'option-1');
    assert.equal(enriched?.customer_name, '客户甲');
    // 唯一未命中（无匹配/歧义）返回 null，调用方保持原上下文。
    assert.equal(enrichCustomerContext(db, { customer_name: '不存在的客户' }), null);
    db.upsertCustomer({ id: 'crm-dup', name: '客户甲', renewalDate: null, contractValue: 0 });
    assert.equal(enrichCustomerContext(db, { customer_name: '客户甲' }), null);
  });
});
