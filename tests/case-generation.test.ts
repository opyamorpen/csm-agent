import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CaseGenerationRun, CaseModelScheduler } from '../src/workbench/case-generation.js';
import { WorkbenchDatabase } from '../src/workbench/database.js';

test('case scheduler reserves the next chapter slot and drains both figure slots after chapters', async () => {
  const scheduler = new CaseModelScheduler();
  const finish = scheduler.beginChapters();
  const figure1 = await scheduler.acquire('figure');
  let figure2Started = false;
  const figure2 = scheduler.acquire('figure').then((release) => { figure2Started = true; return release; });
  const chapter = await scheduler.acquire('chapter');
  assert.equal(figure2Started, false, 'a queued figure must not take the next chapter slot');
  chapter();
  await Promise.resolve();
  assert.equal(figure2Started, false);
  finish();
  const releaseFigure2 = await figure2;
  assert.equal(figure2Started, true);
  finish(); // idempotent completion cannot corrupt the shared reservation count
  figure1(); releaseFigure2();
});

test('case stages persist first thinking token, validation feedback, usage and exact checkpoint reuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-stage-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'stage-customer', name: 'Stage customer' });
    const job = db.createDraftJob('stage-customer', 'stage-fp', [], 'case_report');
    const prompts: string[] = [];
    const runtime: any = { llm: { provider: 'fake', model: 'fixture' }, models: {
      stream: (_model: unknown, context: any) => {
        prompts.push(context.messages[0].content);
        const text = prompts.length === 1 ? '{"count":0}' : '{"count":2}';
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'thinking_delta', delta: 'checking evidence' };
            yield { type: 'text_delta', delta: text };
          },
          result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text }],
            usage: { input: 123, output: 17, cacheRead: 80, cacheWrite: 0, totalTokens: 220 } }),
        };
      },
    } };
    const scheduler = new CaseModelScheduler();
    const run = new CaseGenerationRun(db, job.id, runtime, scheduler, 'signature', (s) => s.length, () => 1000, () => 1);
    const request = { stage: 'chapter:value', label: 'Value', prompt: 'Draft\n上下文：{"fact":"unchanged"}', systemPrompt: 'Facts only', maxTokens: 100,
      parse: (text: string) => { const result = JSON.parse(text); if (result.count !== 2) throw new Error('Expected two items'); return result; } };
    assert.deepEqual(await run.stage(request), { count: 2 });
    assert.match(prompts[1], /Expected two items/);
    assert.match(prompts[1], /上次输出：\n\{"count":0\}/, 'repair receives the actual failed response');
    assert.deepEqual(JSON.parse(prompts[1].split('上下文：')[1]), { fact: 'unchanged' });
    const calls = db.listCaseGenerationCalls(job.id);
    assert.deepEqual(calls.map((call) => call.status), ['rejected', 'accepted']);
    assert.notEqual(calls[0].requestHash, calls[1].requestHash);
    assert.ok(calls.every((call) => call.firstTokenAt && call.startedAt && call.finishedAt));
    assert.equal(calls[1].usage?.cacheRead, 80);
    assert.ok(!JSON.stringify(calls).includes('Facts only'), 'timing records contain no prompt');
    assert.deepEqual(await run.stage(request), { count: 2 });
    assert.equal(prompts.length, 2, 'identical accepted stage makes no model request');
    assert.equal(db.listCaseGenerationCalls(job.id).at(-1)?.status, 'reused');
    await run.stage({ ...request, prompt: request.prompt.replace('unchanged', 'new evidence') });
    assert.equal(prompts.length, 3, 'changed input invalidates the checkpoint');
    await run.stage(request);
    assert.equal(prompts.length, 3, 'an earlier exact input retains its own checkpoint');
    const otherModel = new CaseGenerationRun(db, job.id, runtime, scheduler, 'another-model', (s) => s.length, () => 1000, () => 1);
    await otherModel.stage(request);
    assert.equal(prompts.length, 4, 'model signature invalidates the checkpoint');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed stages are not cached and nonstreaming first-token time stays unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-case-stage-fail-'));
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'c', name: 'C' });
    const job = db.createDraftJob('c', 'fp', [], 'case_report');
    let calls = 0;
    const runtime: any = { models: { complete: async () => {
      calls++;
      return { stopReason: 'error', errorMessage: 'temporary failure', content: [] };
    } } };
    const run = new CaseGenerationRun(db, job.id, runtime, new CaseModelScheduler(), 'model', (s) => s.length, () => 1000, () => 1);
    await assert.rejects(run.stage({ stage: 'plan', label: 'Plan', prompt: '{}', systemPrompt: '', maxTokens: 100, attempts: 2, parse: JSON.parse }), /temporary failure/);
    assert.equal(calls, 2);
    assert.equal(db.getCaseCheckpoint(job.id, 'plan'), undefined);
    assert.ok(db.listCaseGenerationCalls(job.id).every((call) => call.status === 'error' && call.firstTokenAt === null && call.usage === null));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
