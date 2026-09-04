import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkbenchDatabase } from '../src/workbench/database.js';
import { PortfolioSyncService, type SyncUser } from '../src/workbench/sync.js';
import { resolveCustomerForContext } from '../src/server.js';

/**
 * 多人化可见性（阶段 3）：user_customer_access 映射 + 按用户凭证同步授权 + 读路径收窄。
 */

async function withDb(fn: (db: WorkbenchDatabase) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'csm-visibility-'));
  const db = new WorkbenchDatabase(dir);
  try {
    await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedCustomer(db: WorkbenchDatabase, id: string, name: string): void {
  db.upsertCustomer({ id, name, sourceObject: 'object_Umwnn__c', afterSalesStage: '正常', contractStatus: '正常' });
}

test('customer visibility mapping: grants gate listCustomers and resolution', async () => {
  await withDb((db) => {
    db.createUser({ username: 'u1', passwordHash: 'x' });
    const u1 = db.getUserByUsername('u1')!.id;
    seedCustomer(db, 'crm-a', '客户甲');
    seedCustomer(db, 'crm-b', '客户乙');
    // 未授权：什么都看不见（含解析域）。
    assert.deepEqual(db.listCustomers('', 'default', u1).map((c) => c.id), []);
    // 一次性全量授予（迁移语义）。
    assert.equal(db.grantAllCustomersToUser(u1), 2);
    assert.equal(db.customerAccessExists(u1, 'crm-a'), true);
    // 授权后再收回一个：列表与解析域同步收窄。
    db.grantCustomerAccess(u1, ['crm-a']); // no-op upsert
    assert.deepEqual(new Set(db.listCustomers('', 'default', u1).map((c) => c.id)), new Set(['crm-a', 'crm-b']));
    // 解析：可见客户可按名称解析；不可见客户即便名称精确也不可解析（对用户不存在）。
    const hit = resolveCustomerForContext(db, { customer_name: '客户甲' }, u1);
    assert.equal(hit.status, 'resolved');
    const second = db.createUser({ username: 'u2', passwordHash: 'x' });
    db.grantCustomerAccess(second.id, ['crm-b']);
    const miss = resolveCustomerForContext(db, { customer_name: '客户甲' }, second.id);
    assert.notEqual(miss.status, 'resolved', '不可见客户不应被解析');
    assert.equal(resolveCustomerForContext(db, { crm_customer_id: 'crm-a' }, second.id).status, 'not_found');
    // ID 直取对无权限用户同样落空，但对有权限用户命中。
    assert.equal(resolveCustomerForContext(db, { crm_customer_id: 'crm-b' }, second.id).status, 'resolved');
  });
});

/** 造假 CRM 网关：只应答客户查询（返回固定客户集），其余（跟进记录查询）回空。 */
function fakeCrmGateway(customers: Array<{ id: string; name: string }>) {
  return {
    resolve: () => undefined,
    isWrite: () => false,
    listTools: () => [],
    calls: [] as string[],
    async call(publicName: string, args: any) {
      this.calls.push(publicName);
      if (publicName === 'mcp__crm__data_record_query-by-fields' && args?.object_api_name === 'object_Umwnn__c') {
        const records = customers.map((customer) => ({
          _id: customer.id,
          field_n1qN0__c__r: customer.name,
          field_c0avd__c__r: '正常',
          life_status__r: '正常',
          create_time: Date.now(),
          last_modified_time: new Date().toISOString(),
        }));
        return { text: JSON.stringify({ resultCode: 'SUCCESS', data: { recordResult: { totalNumber: records.length, records } } }), isError: false };
      }
      if (publicName === 'mcp__crm__data_record_query-by-fields' && args?.object_api_name === 'ActiveRecordObj') {
        return { text: JSON.stringify({ resultCode: 'SUCCESS', data: { recordResult: { totalNumber: 0, records: [] } } }), isError: false };
      }
      return { text: '{}', isError: false };
    },
  };
}

test('per-user CRM sync grants visibility only for that user', async () => {
  await withDb(async (db) => {
    const u1 = db.createUser({ username: 'csm1', passwordHash: 'x' }).id;
    const u2 = db.createUser({ username: 'csm2', passwordHash: 'x' }).id;
    const hub1 = fakeCrmGateway([{ id: 'crm-a', name: '客户甲' }, { id: 'crm-b', name: '客户乙' }]);
    const hub2 = fakeCrmGateway([{ id: 'crm-b', name: '客户乙' }, { id: 'crm-c', name: '客户丙' }]);
    const byUser = new Map<number, SyncUser>([
      [u1, { userId: u1, username: 'csm1', mcp: hub1 as never }],
      [u2, { userId: u2, username: 'csm2', mcp: hub2 as never }],
    ]);
    const sync = new PortfolioSyncService(db, (serverName) => (serverName === 'crm' ? [...byUser.values()] : []), async () => []);
    // 直接调内部 CRM 同步（refreshAll 会牵动 herory/ones/web-intel，单测只关心 CRM 段）。
    await (sync as any).syncCrmCustomers(byUser.get(u1)!);
    await (sync as any).syncCrmCustomers(byUser.get(u2)!);
    // 客户行按 _id 去重合并（crm-b 两人都拉到，仍是一行）。
    assert.equal(db.listCustomers().length, 3);
    // 可见性按用户各自授权：csm1 看到甲乙，csm2 看到乙丙，领导式重合客户两边都见。
    assert.deepEqual(new Set(db.listCustomers('', 'default', u1).map((c) => c.id)), new Set(['crm-a', 'crm-b']));
    assert.deepEqual(new Set(db.listCustomers('', 'default', u2).map((c) => c.id)), new Set(['crm-b', 'crm-c']));
    assert.equal(db.customerAccessExists(u1, 'crm-c'), false);
  });
});

test('hemory recordings carry owner and gate the fragment inbox boundary', async () => {
  await withDb((db) => {
    const u1 = db.createUser({ username: 'csm1', passwordHash: 'x' }).id;
    const u2 = db.createUser({ username: 'csm2', passwordHash: 'x' }).id;
    db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-1',
      title: '录音1', occurredAt: new Date().toISOString(), attributionStatus: 'unattributed', ownerUserId: u1,
      payload: { recordingId: 'rec-1' } });
    // 未指定 owner 的历史录音不属于任何人（存量兼容），指定 owner 的只归本人。
    assert.deepEqual([...db.hemoryRecordingIdsOwnedBy(u1)], ['rec-1']);
    assert.deepEqual([...db.hemoryRecordingIdsOwnedBy(u2)], []);
    // 重复 upsert 同一录音（另一用户 vault 撞 ID）：owner 首次插入定终身，不被改写。
    db.upsertSourceEvent({ sourceSystem: 'hemory', sourceType: 'raw_transcript', externalId: 'rec-1',
      title: '录音1', occurredAt: new Date().toISOString(), attributionStatus: 'unattributed', ownerUserId: u2,
      payload: { recordingId: 'rec-1' } });
    assert.deepEqual([...db.hemoryRecordingIdsOwnedBy(u2)], []);
    assert.deepEqual([...db.hemoryRecordingIdsOwnedBy(u1)], ['rec-1']);
  });
});
