import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCustomerBoundDraft, resolveDraftCustomer, applyDraftCustomerOptionBinding, enrichCustomerContext, resolveCustomerForContext } from '../src/server.js';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import type { ConfirmDraft } from '../src/tools/confirm.js';

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
    // 草稿自带客户名：唯一精确匹配即解析成功（会话与客户解耦，草稿自含身份是唯一来源）。
    const byName = resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '客户甲' } }));
    assert.equal(byName?.customer.id, 'crm-1');
    assert.equal(byName?.onesOptionId, 'option-1');
    // 真实事故形态：customer_id 是模型乱填的非 ID 串（CRM 授权错误拿不到），名称仍可解析。
    const garbageId = resolveDraftCustomer(db, deskDraft({ fields: { customer_id: '未提供（CRM 查询接口报 NO_LICENSE_QUOTE_ERROR）', customer_name: '客户甲' } }));
    assert.equal(garbageId?.customer.id, 'crm-1');
    // 草稿无客户信息时返回 null——会话不承载客户状态，没有兜底级。
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: {} })), null);
    // 简称命中给 canonical 客户。
    db.upsertCustomer({ id: 'crm-2', name: '乙全称公司', shortName: '乙简称', renewalDate: null, contractValue: 0 });
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '乙简称' } }))?.customer.name, '乙全称公司');
    // 同名歧义与完全无匹配都返回 null（宁可拒绝也不模糊归属）。
    db.upsertCustomer({ id: 'crm-3', name: '客户甲', renewalDate: null, contractValue: 0 });
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '客户甲' } })), null);
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '不存在的客户' } })), null);
  });
});

/** 断言用：只保留 resolved 分支（assert.equal 不做类型收窄，这里用三元显式收窄）。 */
function resolvedCustomer(db: WorkbenchDatabase, name: string) {
  const resolution = resolveCustomerForContext(db, { customer_name: name });
  return resolution.status === 'resolved' ? resolution : undefined;
}

test('writeback: customer resolution tiers — exact / alias / unique substring / ambiguity rejection', async () => {
  await withDb(async (db) => {
    // 真实事故形态：全称「天津中科晶禾…」、CRM 售后简称填的是全称本身、品牌简称挂在被过滤的旧 AccountObj 行上。
    db.upsertCustomer({ id: 'crm-1', name: '天津中科晶禾电子科技有限责任公司', shortName: '天津中科晶禾电子科技有限责任公司', renewalDate: null, contractValue: 0 });
    db.upsertCustomer({ id: 'crm-2', name: '中科慧拓（北京）科技有限公司', renewalDate: null, contractValue: 0 });
    // 精确（全称/简称）。
    const exact = resolvedCustomer(db, '天津中科晶禾电子科技有限责任公司');
    assert.equal(exact?.matchedBy, 'exact');
    assert.equal(exact?.customer.id, 'crm-1');
    // 唯一子串兜底：口语缩略「中科晶禾」只出现在晶禾客户名内 → 命中（此前必然失败的根因场景）。
    const substring = resolvedCustomer(db, '中科晶禾');
    assert.equal(substring?.matchedBy, 'substring');
    assert.equal(substring?.customer.id, 'crm-1');
    // 子串撞多家（「中科」两家都含）→ 歧义拒绝；单字符不走子串层，但 LIKE 召回进候选供用户确认。
    assert.equal(resolveCustomerForContext(db, { customer_name: '中科' }).status, 'ambiguous');
    const single = resolveCustomerForContext(db, { customer_name: '晶' });
    assert.equal(single.status, 'not_found');
    assert.deepEqual(single.status === 'not_found' ? single.suggestions.map((c) => c.id) : [], ['crm-1']);
    // 别名：维护/去空/去重（品牌名与全称无子串关系，只能靠别名解析）。
    db.setCustomerAliases('crm-1', ['青禾晶元', ' 青禾晶元 ', '']);
    assert.deepEqual(db.listCustomerAliases('crm-1'), ['青禾晶元']);
    const byAlias = resolvedCustomer(db, '青禾晶元');
    assert.equal(byAlias?.matchedBy, 'alias');
    assert.equal(byAlias?.customer.id, 'crm-1');
    // 别名同样参与唯一子串兜底。
    assert.equal(resolvedCustomer(db, '青禾')?.customer.id, 'crm-1');
    // overview 与搜索入口都带别名。
    assert.deepEqual((db.overview('crm-1') as { aliases: string[] }).aliases, ['青禾晶元']);
    assert.deepEqual(db.listCustomers('青禾晶元').map((c) => c.id), ['crm-1']);
    // 别名维护写审计。
    const auditRow = db.db.prepare("SELECT details_json FROM audit_log WHERE action='customer_aliases_update' AND entity_id='crm-1'").get() as { details_json: string };
    assert.ok(JSON.parse(auditRow.details_json).aliases.includes('青禾晶元'));
    // 跨客户冲突：撞其他可见客户的名称/别名拒绝；隐藏旧行（AccountObj）的简称不参与校验。
    assert.throws(() => db.setCustomerAliases('crm-2', ['青禾晶元']), /冲突/);
    assert.throws(() => db.setCustomerAliases('crm-1', ['中科慧拓（北京）科技有限公司']), /冲突/);
    db.upsertCustomer({ id: 'crm-3', name: '天津中科晶禾电子科技有限责任公司', shortName: '青禾晶元', sourceObject: 'AccountObj', renewalDate: null, contractValue: 0 });
    db.setCustomerAliases('crm-2', ['慧拓']);
    // 草稿 confirm 门同一条解析链：别名与口语子串都能绑定草稿客户（读写统一口径）。
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '青禾晶元' } }))?.customer.id, 'crm-1');
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '中科晶禾' } }))?.customer.id, 'crm-1');
    assert.equal(resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '慧拓' } }))?.customer.id, 'crm-2');
  });
});

test('writeback: desk approval deterministically binds the resolved customer option', async () => {
  await withDb(async (db) => {
    seedDeskCustomer(db);
    const binding = resolveDraftCustomer(db, deskDraft())!;
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
    const bareBinding = resolveDraftCustomer(db, deskDraft({ fields: { customer_name: '无身份客户' } }))!;
    assert.match(applyDraftCustomerOptionBinding(deskDraft(), bareBinding) ?? '', /未解析到已确认的 ONES 客户选项/);
    assert.match(validateCustomerBoundDraft(deskDraft(), null) ?? '', /草稿未携带可唯一解析的客户/);
  });
});

test('writeback: CRM followup and workhour validate against the resolved customer identity', async () => {
  await withDb(async (db) => {
    seedDeskCustomer(db);
    const binding = resolveDraftCustomer(db, deskDraft())!;
    assert.equal(validateCustomerBoundDraft(deskDraft({ target_system: 'crm', record_type: 'followup', target_arguments: { customerId: 'crm-1' } }), binding), null);
    assert.match(validateCustomerBoundDraft(deskDraft({ target_system: 'crm', record_type: 'followup', target_arguments: { customerId: 'crm-2' } }), binding) ?? '', /CRM 回写参数/);
    // 未解析到售后工时项（未同步）时工时校验拒绝，而不是放进 ONES 端才报错。
    assert.match(validateCustomerBoundDraft(deskDraft({ record_type: 'workhour', target_arguments: { issueID: 'hours-1' } }), binding) ?? '', /售后客户/);
  });
});

test('writeback: enrichCustomerContext resolves authoritative ids for the stateless identity lookup', async () => {
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
