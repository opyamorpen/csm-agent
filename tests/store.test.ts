import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, makeRecordFromDraft, customerOf, type RecordEntry } from '../src/store.js';

function tmpStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'csm-store-'));
  return new Store(dir);
}

test('store: save/load/list/delete sessions', () => {
  const store = tmpStore();
  const now = Date.now();
  store.saveSession({ id: 'a', title: '会话A', createdAt: now, updatedAt: now, messages: [{ role: 'user', content: 'hi', timestamp: now }], events: [{ seq: 1, event: { type: 'user', text: 'hi' } }] });
  store.saveSession({ id: 'b', title: '会话B', createdAt: now + 1, updatedAt: now + 1, messages: [], events: [] });

  const list = store.listSessions();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'b'); // sorted by updatedAt desc

  const loaded = store.loadSession('a');
  assert.ok(loaded);
  assert.equal(loaded!.title, '会话A');
  assert.equal((loaded!.messages as any[]).length, 1);
  assert.equal((loaded!.events as any[]).length, 1);

  store.deleteSession('a');
  assert.equal(store.listSessions().length, 1);
  assert.equal(store.loadSession('a'), undefined);
});

test('store: records persist and reload across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-store-'));
  const rec: RecordEntry = {
    id: 'r1', sessionId: 's1', type: 'followup', title: '跟进', customer: '客户A',
    target: 'crm', status: 'draft', fields: { customer_name: '客户A' }, createdAt: 1, updatedAt: 1,
  };
  const store1 = new Store(dir);
  store1.records.push(rec);
  store1.persistRecords();

  const store2 = new Store(dir);
  assert.equal(store2.records.length, 1);
  assert.equal(store2.records[0].status, 'draft');

  // file content is valid JSON with records array
  const raw = JSON.parse(readFileSync(join(dir, 'records.json'), 'utf8'));
  assert.ok(Array.isArray(raw.records));
});

test('store: corrupt records file falls back to empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-store-'));
  writeFileSync(join(dir, 'records.json'), '{not json', 'utf8');
  const store = new Store(dir);
  assert.deepEqual(store.records, []);
});

test('makeRecordFromDraft / customerOf', () => {
  const draft = {
    target_system: 'crm', target_object: 'CRM 跟进记录', record_type: 'followup',
    title: '测试标题', summary: 's', fields: { customer_name: '云启科技', customer_id: 'cust_1' },
  };
  const rec = makeRecordFromDraft(draft, 's1', 'r1', 123);
  assert.equal(rec.status, 'draft');
  assert.equal(rec.type, 'followup');
  assert.equal(rec.title, '测试标题');
  assert.equal(rec.customer, '云启科技');
  assert.equal(rec.target, 'crm');
  assert.deepEqual(rec.fields, draft.fields);

  assert.equal(customerOf({ ...draft, fields: { customer_id: 'only-id' } }), 'only-id');
  assert.equal(customerOf({ ...draft, fields: undefined as any }), '');
});
