import { createHash, randomUUID } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { extractText } from '../agent.js';
import type { WorkbenchDatabase } from './database.js';
import type { CaseGenerationCall } from './types.js';
import { completeModelWithProgress, modelProgressText } from './model-progress.js';

export function caseRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Keep a slot available for the next dependent chapter while figures run. */
export class CaseModelScheduler {
  private active = 0;
  private figures = 0;
  private chapterProducers = 0;
  private waiters: Array<{ kind: 'chapter' | 'figure'; resolve: (release: () => void) => void }> = [];

  beginChapters(): () => void {
    this.chapterProducers++;
    let finished = false;
    return () => { if (!finished) { finished = true; this.chapterProducers--; this.drain(); } };
  }

  acquire(kind: 'chapter' | 'figure'): Promise<() => void> {
    return new Promise((resolve) => { this.waiters.push({ kind, resolve }); this.drain(); });
  }

  private drain(): void {
    while (this.active < 2) {
      let index = this.waiters.findIndex((item) => item.kind === 'chapter');
      if (index < 0 && (this.chapterProducers === 0 || this.figures < 1)) index = this.waiters.findIndex((item) => item.kind === 'figure');
      if (index < 0) return;
      const [waiter] = this.waiters.splice(index, 1);
      this.active++;
      if (waiter.kind === 'figure') this.figures++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        if (waiter.kind === 'figure') this.figures--;
        this.drain();
      });
    }
  }
}

interface StageRequest<T> {
  stage: string;
  label: string;
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
  attempts?: number;
  kind?: 'chapter' | 'figure';
  parse: (text: string, attempt: number) => T;
  onProgress?: (text: string) => void;
}

/** Only validated stage outputs are reusable; prompts and credentials never enter timing records. */
export class CaseGenerationRun {
  constructor(
    private readonly db: WorkbenchDatabase,
    readonly jobId: string,
    private readonly runtime: Runtime,
    readonly scheduler: CaseModelScheduler,
    private readonly signature: string,
    private readonly estimateTokens: (text: string) => number,
    private readonly timeoutMs: (text: string) => number,
    private readonly retryBaseMs: () => number,
  ) {}

  async stage<T>(request: StageRequest<T>): Promise<T> {
    const requestHash = caseRequestHash({ signature: this.signature, stage: request.stage, prompt: request.prompt,
      systemPrompt: request.systemPrompt, maxTokens: request.maxTokens });
    const checkpoint = this.db.getCaseCheckpoint<T>(this.jobId, request.stage, requestHash);
    const makeCall = (attempt: number, prompt: string): CaseGenerationCall => ({
      id: randomUUID(), stage: request.stage, attempt, requestHash, queuedAt: new Date().toISOString(),
      startedAt: null, firstTokenAt: null, finishedAt: null, status: 'queued',
      inputTokensEstimate: this.estimateTokens(prompt), maxOutputTokens: request.maxTokens, usage: null, error: null,
    });
    if (checkpoint?.requestHash === requestHash) {
      const call = makeCall(0, request.prompt);
      call.status = 'reused'; call.finishedAt = call.queuedAt;
      this.db.saveCaseGenerationCall(this.jobId, call);
      request.onProgress?.(`${request.label}复用已通过校验的阶段结果`);
      return checkpoint.value;
    }
    let feedback = '';
    let previousOutput = '';
    let lastError = '';
    const maxAttempts = request.attempts ?? 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const instruction = `\n\n上一次输出未通过校验：${feedback}\n请基于以下上次输出修正上述错误，保留合格内容与证据，仅针对错误做修复，重新输出符合契约的完整本阶段 JSON。\n上次输出：\n${previousOutput}\n`;
      const contextMarker = request.prompt.indexOf('\n上下文：');
      const contextAt = contextMarker < 0 ? -1 : contextMarker + 1;
      const prompt = !feedback ? request.prompt : contextAt < 0 ? request.prompt + instruction
        : request.prompt.slice(0, contextAt) + instruction + request.prompt.slice(contextAt);
      const call = makeCall(attempt, prompt);
      call.requestHash = caseRequestHash({ signature: this.signature, stage: request.stage, prompt, systemPrompt: request.systemPrompt, maxTokens: request.maxTokens });
      this.db.saveCaseGenerationCall(this.jobId, call);
      const release = await this.scheduler.acquire(request.kind ?? 'chapter');
      call.startedAt = new Date().toISOString(); call.status = 'running';
      this.db.saveCaseGenerationCall(this.jobId, call);
      request.onProgress?.(`${request.label}实际请求开始（第 ${attempt}/${maxAttempts} 次，排队 ${Math.round((Date.parse(call.startedAt) - Date.parse(call.queuedAt)) / 1000)} 秒）`);
      let response: Awaited<ReturnType<typeof completeModelWithProgress>> | undefined;
      try {
        response = await completeModelWithProgress(this.runtime, {
          systemPrompt: request.systemPrompt, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }], tools: [],
        }, request.onProgress ? (tick) => request.onProgress!(`${request.label} ${modelProgressText(tick)}`) : undefined,
        { maxTokens: request.maxTokens, timeoutMs: this.timeoutMs(prompt) }, () => {
          call.firstTokenAt = new Date().toISOString(); this.db.saveCaseGenerationCall(this.jobId, call);
        });
        const usage = response.usage;
        if (usage && (usage.totalTokens > 0 || usage.input > 0 || usage.output > 0 || usage.cacheRead > 0)) {
          call.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens };
        }
        if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error(response.errorMessage || response.stopReason);
      } catch (error) {
        call.status = 'error'; call.error = (error as Error).message;
      } finally {
        call.finishedAt = new Date().toISOString();
        release();
      }
      if (call.status !== 'error' && response) {
        try {
          const parsed = request.parse(extractText(response.content), attempt);
          this.db.saveCaseCheckpoint(this.jobId, request.stage, requestHash, parsed);
          call.status = 'accepted'; this.db.saveCaseGenerationCall(this.jobId, call);
          request.onProgress?.(`${request.label}通过校验（请求 ${Math.round((Date.parse(call.finishedAt!) - Date.parse(call.startedAt!)) / 1000)} 秒，已输出 ${extractText(response.content).length} 字）`);
          return parsed;
        } catch (error) {
          call.status = 'rejected'; call.error = (error as Error).message + (response.stopReason === 'length' ? '（stopReason=length，输出被截断）' : '');
          feedback = call.error;
          previousOutput = extractText(response.content);
        }
      }
      lastError = `${request.label}${call.status === 'error' ? '模型调用失败' : '契约不合格'}（第 ${attempt}/${maxAttempts} 次）: ${call.error}`;
      this.db.saveCaseGenerationCall(this.jobId, call);
      request.onProgress?.(lastError);
      if (attempt < maxAttempts && call.status === 'error') {
        const delay = Math.min(120_000, this.retryBaseMs() * 3 ** (attempt - 1));
        request.onProgress?.(`${request.label} ${Math.round(delay / 1000)} 秒后自动重试`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(lastError);
  }
}
