import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonSchemaToTypeBox } from '../src/mcp/schema.js';

test('schema: unknown/empty input falls back to Any', () => {
  assert.ok(jsonSchemaToTypeBox(undefined));
  assert.ok(jsonSchemaToTypeBox(null));
  assert.ok(jsonSchemaToTypeBox({}));
  assert.ok(jsonSchemaToTypeBox({ type: 'wat' }));
});

test('schema: primitive types convert without throwing', () => {
  for (const t of ['string', 'number', 'integer', 'boolean', 'null']) {
    assert.ok(jsonSchemaToTypeBox({ type: t }));
  }
});

test('schema: object/array/enum/anyOf convert without throwing', () => {
  assert.ok(jsonSchemaToTypeBox({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }));
  assert.ok(jsonSchemaToTypeBox({ type: 'array', items: { type: 'string' } }));
  assert.ok(jsonSchemaToTypeBox({ enum: ['a', 'b'] }));
  assert.ok(jsonSchemaToTypeBox({ anyOf: [{ type: 'string' }, { type: 'null' }] }));
});

test('schema: single-element enum returns a literal (truthy)', () => {
  assert.ok(jsonSchemaToTypeBox({ enum: ['only'] }));
});
