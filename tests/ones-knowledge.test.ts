import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildSystemPrompt } from '../src/prompt.js';
import { casePracticeLibrary } from '../src/workbench/case-content.js';
import { CASE_GENERATION_VERSION, caseFingerprint } from '../src/workbench/cases.js';
import { ONES_CAPABILITY_MAP, ONES_KNOWLEDGE_VERSION } from '../src/workbench/case-ones-knowledge.js';

test('regular agent receives the same bounded, versioned knowledge as case generation', () => {
  const prompt = buildSystemPrompt([]);
  assert.equal(prompt.split(ONES_CAPABILITY_MAP).length, 2);
  assert.equal(ONES_KNOWLEDGE_VERSION, 'private-v7.26.0-20260905');
  assert.ok(ONES_CAPABILITY_MAP.length < 3000, 'full manual must stay outside the prompt');
  assert.match(prompt, /客户交付\/配置\/集成\/收益证据/);
  assert.match(prompt, /unknown/);
  assert.match(prompt, /confirm_write/);
});

test('bundled current manual is complete, intact and resolves every editorial practice source', () => {
  const root = new URL('../docs/ones-product-knowledge/references/official/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.included, 317);
  assert.equal(manifest.excluded, 0);
  const urls = new Set<string>();
  for (const page of manifest.pages) {
    const body = readFileSync(new URL(page.file, root), 'utf8');
    assert.equal(createHash('sha256').update(body).digest('hex'), page.sha256, page.url);
    urls.add(page.url);
  }
  for (const practice of casePracticeLibrary().items) {
    assert.ok(practice.sources.length);
    for (const source of practice.sources) assert.ok(urls.has(source), source);
  }
});

test('drafts made without a knowledge fingerprint are not silently reused', () => {
  const legacy = createHash('sha256').update(JSON.stringify({
    version: CASE_GENERATION_VERSION, practices: casePracticeLibrary().digest,
    profile: { id: 'knowledge-fixture' }, events: [], evidence: [], risk: null, opportunities: [],
  })).digest('hex');
  assert.notEqual(caseFingerprint('knowledge-fixture', []), legacy);
  assert.equal(caseFingerprint('knowledge-fixture', []), caseFingerprint('knowledge-fixture', []));
});
