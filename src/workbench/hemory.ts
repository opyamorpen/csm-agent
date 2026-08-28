import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { extractText } from '../agent.js';
import { WorkbenchDatabase } from './database.js';
import type { HemorySegmentationJob, SourceEvent } from './types.js';

// v3.2：v3.1 的 40 行上限对长会仍过切（2 小时会议 898 行被切成 19 片，最小 376 字）；
// 上限提到 100 行并全面转向合并优先——同一对象/同一诉求的连续讨论（含原因、方案、细节、结论、追问）
// 必须保持一段，只有业务对象切换或明显独立新请求才切。
// 主边界 = 业务对象变化；次边界 = 同一对象内明显独立的新请求/新决策流。
export const HEMORY_SEGMENTATION_VERSION = 'hemory-topic-segments-v3.2';
export const HEMORY_SEGMENTATION_VERSION_PREFIX = 'v3.2';
export const HEMORY_MIN_FRAGMENT_LINES = 3;
export const HEMORY_MIN_FRAGMENT_CHARS = 40;
export const HEMORY_SEGMENTATION_MAX_STAGE_ATTEMPTS = 3;

interface TranscriptLine {
  spokenAt: string;
  speaker: string;
  text: string;
}

interface ModelSegment {
  startIndex: number;
  endIndex: number;
  topic: string;
  summary: string;
  subject: string;
  focus: string;
  topicKey: string;
  include: boolean;
  discardReason?: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cleanJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* inspect embedded JSON below */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* invalid model output */ }
  }
  return null;
}

function transcriptLines(event: SourceEvent): TranscriptLine[] {
  const raw = Array.isArray(event.payload?.lines) ? event.payload.lines : [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.spokenAt !== 'string' || typeof item.text !== 'string' || !item.text.trim()) return [];
    return [{ spokenAt: item.spokenAt, speaker: typeof item.speaker === 'string' ? item.speaker : '-', text: item.text.trim() }];
  });
}

export function isMeaningfulHemoryFragment(lines: TranscriptLine[]): boolean {
  const substantive = lines.filter((line) => line.text.replace(/[\s，。！？、,.!?；;：:]/g, '').length >= 4);
  const chars = substantive.map((line) => line.text).join('').replace(/\s/g, '').length;
  return substantive.length >= HEMORY_MIN_FRAGMENT_LINES && chars >= HEMORY_MIN_FRAGMENT_CHARS;
}

function validateSegments(value: unknown, lineCount: number): ModelSegment[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { segments?: unknown }).segments)) {
    throw new Error('模型未返回 segments 数组');
  }
  const segments = (value as { segments: unknown[] }).segments.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 个片段不是对象`);
    const item = raw as Record<string, unknown>;
    const startIndex = Number(item.start_index);
    const endIndex = Number(item.end_index);
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex < startIndex || endIndex >= lineCount) {
      throw new Error(`第 ${index + 1} 个片段索引无效`);
    }
    if (typeof item.topic !== 'string' || !item.topic.trim() || typeof item.summary !== 'string' || !item.summary.trim()) {
      throw new Error(`第 ${index + 1} 个片段缺少话题或摘要`);
    }
    if (typeof item.subject !== 'string' || !item.subject.trim() || typeof item.focus !== 'string' || !item.focus.trim()) {
      throw new Error(`第 ${index + 1} 个片段缺少业务对象（subject）或核心问题（focus）`);
    }
    if (typeof item.topic_key !== 'string' || !item.topic_key.trim()) {
      throw new Error(`第 ${index + 1} 个片段缺少 topic_key`);
    }
    return { startIndex, endIndex, topic: item.topic.trim(), summary: item.summary.trim(),
      subject: item.subject.trim(), focus: item.focus.trim(), topicKey: item.topic_key.trim(),
      include: item.include === true,
      discardReason: typeof item.discard_reason === 'string' ? item.discard_reason : undefined };
  });
  if (!segments.length || segments[0].startIndex !== 0 || segments.at(-1)!.endIndex !== lineCount - 1) {
    throw new Error('模型分段没有覆盖完整转写');
  }
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].startIndex !== segments[i - 1].endIndex + 1) throw new Error('模型分段存在重叠或缺口');
  }
  return segments;
}

async function callSegmenter(runtime: Runtime, systemPrompt: string, prompt: string): Promise<unknown> {
  const response = await runtime.models.complete(runtime.model, {
    systemPrompt,
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    tools: [],
  });
  if (response.stopReason === 'error') throw new Error((response as { errorMessage?: string }).errorMessage ?? '模型调用失败');
  return cleanJson(extractText(response.content));
}

// 每阶段最多调用 3 次：结构或语义校验失败时把错误附进提示词重试，仍失败则抛错由 job attempts 兜底。
async function completeStage(runtime: Runtime, stageName: string, buildPrompt: (retryError?: string) => string, lineCount: number): Promise<ModelSegment[]> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < HEMORY_SEGMENTATION_MAX_STAGE_ATTEMPTS; attempt++) {
    let parsed: unknown;
    try {
      parsed = await callSegmenter(runtime, '你是 CSM Agent 的会议分段器。只整理给定转写，不调用工具，不执行写入。', buildPrompt(lastError?.message));
    } catch (error) {
      lastError = error as Error;
      continue;
    }
    try {
      return validateSegments(parsed, lineCount);
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw new Error(`${stageName}失败（已重试 ${HEMORY_SEGMENTATION_MAX_STAGE_ATTEMPTS} 次）：${lastError?.message ?? '模型未返回有效分段'}`);
}

const SEGMENT_SCHEMA_DOC = '{"segments":[{"start_index":0,"end_index":2,"topic":"话题标题","summary":"忠于原文的摘要","subject":"业务对象（如具体项目/系统/合同/团队）","focus":"本段核心问题的概括（描述用，不触发切分）","topic_key":"录音内唯一事件键（同一事件复现时必须复用）","include":true,"discard_reason":""}]}';

const EVENT_SLICING_RULES = `事件切分规则（合并优先，避免切分过细）：
- 主切割边界：业务对象变化（项目/系统/合同/团队等切换）必须切段。
- 次切割边界：同一对象内开始了明显独立的新请求或新决策流才切段，且必须非常明确。
- 以下情况一律不切，保持在同一段：同一请求的原因、方案、细节澄清、追问、排期、决定、后续行动；话题内的自然漂移与深入；插话；时间间隔；同一大话题下讨论多个相关方案或路径；从需求讨论过渡到演示、再到结论与安排。
- 粒度期望：围绕同一对象或同一诉求的连续讨论保持为一个大片段，一场 30 分钟录音通常只有 1~4 个片段，一场 2 小时会议通常 5~8 个片段；切分过细是错误，宁可一段略大也不要切碎。单段一般不超过 100 条发言——明显超过时才按其中独立的子请求/子决策再拆。
- 同一事件被其他话题打断后再次出现时，保持多个连续片段，但 topic_key 必须相同；不把中间无关原文并入。
- topic_key 在录音内唯一标识事件；不同事件禁止共用。`;

async function proposeSegments(runtime: Runtime, recordingId: string, lines: TranscriptLine[]): Promise<ModelSegment[]> {
  const evidence = lines.map((line, index) => ({ index, spoken_at: line.spokenAt, speaker: line.speaker, text: line.text }));
  const transcriptJson = JSON.stringify(evidence);
  const partitionPrompt = (retryError?: string) => `整理一场 Hemory 录音的完整转写，按事件切片。每条输入必须且只能属于一个片段，索引必须连续覆盖 0 到 ${lines.length - 1}。\n`
    + `${EVENT_SLICING_RULES}\n`
    + `只输出 JSON：${SEGMENT_SCHEMA_DOC}。\n`
    + `include 规则：片段必须构成独立、完整的客户业务事件（例如一个完整请求及其讨论闭环）；寒暄、环境音、零散的一两句话、无明确业务信息的内容必须为 false，且不得为凑门槛把它并入相邻事件。摘要不得补造客户、负责人、日期、时长或结论。\n`
    + `${retryError ? `上一次输出校验失败：${retryError}。请修正后重新输出完整 JSON。\n` : ''}`
    + `录音 ID：${recordingId}\n完整转写：${transcriptJson}`;
  const partitioned = await completeStage(runtime, '事件分区', partitionPrompt, lines.length);

  const reviewPrompt = (retryError?: string) => `复核以下 Hemory 录音的事件切片结果，双向调整：
1. 拆开确实混合的片段——一个片段里混进了明显不同的业务对象，或同一对象内明确独立的新请求/新决策流（如“还有一件事”引出的新话题、问题 A 的讨论里夹着问题 B 的结论）；标题里出现两个不相关主题是混合信号。
2. 合并被过度切分的相邻片段——相邻片段属于同一对象且围绕同一请求展开（例如原因与方案被切开、方案与决定被切开、需求与演示被切开、细节追问被单独切开），必须合并回一个片段；切分过细是错误，2 小时会议切成十几个片段属于严重过切。目标：30 分钟录音 1~4 个片段。
3. 只有远超 100 条发言的超长片段才按其中明显独立的子请求/子决策再拆，100 条以内的片段一律优先考虑合并而不是拆分。
${EVENT_SLICING_RULES}
- 调整后必须重新输出全部片段的完整 JSON（不是增量），索引连续覆盖 0 到 ${lines.length - 1}。
- include 与 topic_key 一并复核：合并后的片段沿用其中更有代表性的一组字段；同一事件的多个片段共用 topic_key；不足门槛的独立碎片 include=false。
只输出 JSON：${SEGMENT_SCHEMA_DOC}。
${retryError ? `上一次输出校验失败：${retryError}。请修正后重新输出完整 JSON。\n` : ''}
录音 ID：${recordingId}
当前切片结果：${JSON.stringify(partitioned.map(({ startIndex, endIndex, topic, summary, subject, focus, topicKey, include }) => ({ start_index: startIndex, end_index: endIndex, topic, summary, subject, focus, topic_key: topicKey, include })))}
完整转写：${transcriptJson}`;
  return completeStage(runtime, '单一主题复核', reviewPrompt, lines.length);
}

export function hemorySegmentationFingerprint(recording: SourceEvent): string {
  return hash(`${HEMORY_SEGMENTATION_VERSION}:${recording.externalId}:${recording.payloadHash}`);
}

export interface HemorySegmentationResult {
  events: SourceEvent[];
  proposedCount: number;
  includedCount: number;
}

// 相邻且同 topic_key 的片段属于模型未合并的同一事件，代码层防御合并；被其他片段隔开的同 key 片段保留多段。
function mergeAdjacentSameTopicSegments(segments: ModelSegment[]): ModelSegment[] {
  const merged: ModelSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && previous.topicKey === segment.topicKey && segment.startIndex === previous.endIndex + 1) {
      previous.endIndex = segment.endIndex;
      previous.include = previous.include || segment.include;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

export class HemorySegmentationService {
  private processing = new Map<string, Promise<HemorySegmentationResult>>();

  constructor(private readonly db: WorkbenchDatabase, private readonly runtime: Runtime,
    private readonly onSegmented?: (events: SourceEvent[]) => void) {}

  async segmentRecording(recording: SourceEvent): Promise<SourceEvent[]> {
    return (await this.segmentRecordingDetailed(recording)).events;
  }

  async segmentRecordingDetailed(recording: SourceEvent): Promise<HemorySegmentationResult> {
    if (recording.sourceSystem !== 'hemory' || recording.sourceType !== 'raw_transcript') throw new Error('只允许分段 Hemory 原始转写');
    const fingerprint = hemorySegmentationFingerprint(recording);
    const job = this.db.createHemorySegmentationJob(recording.id, fingerprint);
    if (job.status === 'succeeded') {
      const events = this.db.listActiveHemoryFragmentsForRecording(recording.id);
      return { events, proposedCount: events.length, includedCount: events.length };
    }
    if (job.attempts >= 3) throw new Error(job.error ?? 'Hemory 分段已达到最大重试次数');
    const running = this.processing.get(job.id);
    if (running) return running;
    const promise = this.process(job, recording).finally(() => this.processing.delete(job.id));
    this.processing.set(job.id, promise);
    return promise;
  }

  resumePending(): void {
    for (const job of this.db.listPendingHemorySegmentationJobs()) {
      if (job.attempts >= 3) continue;
      const recording = this.db.getSourceEvent(job.recordingEventId);
      if (recording) void this.segmentRecording(recording);
    }
  }

  private async process(job: HemorySegmentationJob, recording: SourceEvent): Promise<HemorySegmentationResult> {
    this.db.updateHemorySegmentationJob(job.id, 'running');
    try {
      const lines = transcriptLines(recording);
      if (!lines.length) throw new Error('Hemory 录音没有可分段的转写行');
      const recordingId = String(recording.payload?.recordingId ?? recording.externalId);
      const proposed = mergeAdjacentSameTopicSegments(await proposeSegments(this.runtime, recordingId, lines));
      // 片段不按客户名称自动归属：转写里提到客户名更多是在引用其他客户的案例（如「像 X 客户一样」），
      // 并不代表在与该客户沟通；全部片段一律进入待归属收件箱，由 CSM 人工标记。
      interface Surviving { segment: ModelSegment; evidence: TranscriptLine[]; transcript: string;
        start: TranscriptLine; end: TranscriptLine }
      const surviving: Surviving[] = [];
      for (const segment of proposed) {
        const evidence = lines.slice(segment.startIndex, segment.endIndex + 1);
        if (!segment.include || !isMeaningfulHemoryFragment(evidence)) continue;
        const transcript = evidence.map((line) => `${line.speaker}: ${line.text}`).join('\n');
        surviving.push({ segment, evidence, transcript, start: evidence[0], end: evidence.at(-1)! });
      }
      // 同 key 的片段按出现顺序编号并共享 topicGroupId（录音内唯一）；不跨录音关联。
      const partsByKey = new Map<string, number>();
      for (const { segment } of surviving) partsByKey.set(segment.topicKey, (partsByKey.get(segment.topicKey) ?? 0) + 1);
      const seenKeys = new Map<string, number>();
      const events: SourceEvent[] = [];
      for (const item of surviving) {
        const segment = item.segment;
        const part = (seenKeys.get(segment.topicKey) ?? 0) + 1;
        seenKeys.set(segment.topicKey, part);
        const externalId = `${HEMORY_SEGMENTATION_VERSION_PREFIX}:${recordingId}:${item.start.spokenAt}:${segment.startIndex}:${item.end.spokenAt}:${segment.endIndex}`;
        const previous = this.db.findSourceEvent('hemory', 'ai_topic_segment', externalId);
        const event = this.db.upsertSourceEvent({ customerId: null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
          externalId, title: segment.topic.slice(0, 160), occurredAt: item.start.spokenAt, confidence: 0.2,
          attributionStatus: 'unattributed', payload: { recordingId, rawRecordingEventId: recording.id, recordingHash: recording.payloadHash,
            generationVersion: HEMORY_SEGMENTATION_VERSION, topic: segment.topic, summary: segment.summary,
            subject: segment.subject, focus: segment.focus, topicKey: segment.topicKey,
            topicGroupId: `${recordingId}:${segment.topicKey}`, topicPartIndex: part, topicPartCount: partsByKey.get(segment.topicKey) ?? 1,
            startAt: item.start.spokenAt, endAt: item.end.spokenAt, speakers: [...new Set(item.evidence.map((line) => line.speaker).filter(Boolean))],
            transcript: item.transcript, evidence: item.evidence, startIndex: segment.startIndex, endIndex: segment.endIndex } });
        if (previous && previous.payloadHash !== event.payloadHash) this.db.markDraftsStaleForEvents([event.id]);
        events.push(event);
      }
      this.db.activateHemoryFragments(recording.id, job.fingerprint, events.map((event) => event.id));
      const generator = `${this.runtime.llm.provider}/${this.runtime.llm.model}`;
      this.db.updateHemorySegmentationJob(job.id, 'succeeded', { segmentCount: events.length, generator });
      this.db.audit('agent', 'segment_hemory_recording', 'source_event', recording.id,
        { fingerprint: job.fingerprint, generator, inputLines: lines.length, includedSegments: events.length, proposedSegments: proposed.length });
      try { this.onSegmented?.(events); }
      catch (error) { this.db.audit('agent', 'process_hemory_segment_callback_failed', 'source_event', recording.id, { error: (error as Error).message }); }
      return { events, proposedCount: proposed.length, includedCount: events.length };
    } catch (error) {
      this.db.updateHemorySegmentationJob(job.id, 'failed', { error: (error as Error).message });
      throw error;
    }
  }
}
