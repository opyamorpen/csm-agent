import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('private cloud instance cards omit event metadata and evidence ids', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/function renderBusinessRecords[\s\S]*?\n  }\n\n  function renderWorkhours/)?.[0];

  assert.ok(renderer, 'renderBusinessRecords source was not found');
  assert.match(renderer, /if \(sourceType !== 'private_cloud_instance'\) \{\s*item\.append\(el\('div', 'cell-sub'/);
  assert.match(renderer, /if \(sourceType !== 'private_cloud_instance'\) item\.append\(el\('div', 'evidence-id'/);
});

test('renewal risk dimensions use Chinese business labels', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const labels = source.match(/const RISK_DIMENSION_LABEL = \{[\s\S]*?\n  \};/)?.[0];
  const renderer = source.match(/function renderRisk[\s\S]*?\n  }\n\n  function renderTimeline/)?.[0];

  assert.ok(labels, 'risk dimension labels were not found');
  assert.match(labels, /renewal: '续约'/);
  assert.match(labels, /contract: '合同'/);
  assert.match(labels, /engagement: '互动'/);
  assert.match(labels, /delivery: '交付'/);
  assert.match(labels, /voice: '客户声音'/);
  assert.ok(renderer, 'renderRisk source was not found');
  assert.match(renderer, /RISK_DIMENSION_LABEL\[key\] \|\| key/);
});

test('draft inbox exposes regenerate control and operations label', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];

  assert.ok(renderer, 'loadDraftBatches source was not found');
  assert.match(renderer, /\['stale', 'partial', 'failed'\]\.includes\(batch\.status\)/);
  assert.match(renderer, /\/api\/draft-batches\/\$\{batch\.id\}\/regenerate/);
  assert.match(source, /operations: '运维工单'/);
});

test('customer detail tabs drop meetings and followups list CRM sales records by create time', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const tabStrip = source.match(/const overview = el\('div'\);[\s\S]*?tabs\[0\]\.button\.click\(\);/)?.[0];

  assert.ok(tabStrip, 'customer detail tab strip source was not found');
  assert.doesNotMatch(tabStrip, /addTab\('meetings'/);
  assert.doesNotMatch(source, /function renderMeetings/);
  assert.match(tabStrip, /addTab\('followup', '跟进记录', renderFollowups\(timeline\)/);

  const renderer = source.match(/function renderFollowups[\s\S]*?\n  }\n\n  async function startAgentDraft/)?.[0];
  assert.ok(renderer, 'renderFollowups source was not found');
  assert.match(renderer, /event\.sourceType === 'crm_followup'/);
  assert.match(renderer, /payload\?\.createTime/);
  assert.match(renderer, /createdAt\(right\) - createdAt\(left\)/);
  assert.doesNotMatch(renderer, /nextAction/);
});
