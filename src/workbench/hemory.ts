import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { extractText } from '../agent.js';
import { WorkbenchDatabase } from './database.js';
import type { HemorySegmentationJob, SourceEvent } from './types.js';

export const HEMORY_SEGMENTATION_VERSION = 'hemory-topic-segments-v1';
export const HEMORY_MIN_FRAGMENT_LINES = 3;
export const HEMORY_MIN_FRAGMENT_CHARS = 40;

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
    return { startIndex, endIndex, topic: item.topic.trim(), summary: item.summary.trim(), include: item.include === true,
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

async function proposeSegments(runtime: Runtime, recordingId: string, lines: TranscriptLine[]): Promise<ModelSegment[]> {
  const evidence = lines.map((line, index) => ({ index, spoken_at: line.spokenAt, speaker: line.speaker, text: line.text }));
  const prompt = `整理一场 Hemory 录音的完整转写，按连贯业务话题切分。每条输入必须且只能属于一个片段，索引必须连续覆盖 0 到 ${lines.length - 1}。\n`
    + `只输出 JSON：{"segments":[{"start_index":0,"end_index":2,"topic":"话题标题","summary":"忠于原文的摘要","include":true,"discard_reason":""}]}。\n`
    + `include 规则：至少包含 3 条有实际信息的发言，形成独立、连贯的客户业务话题；寒暄、环境音、零散的一两句话、无明确业务信息的内容必须为 false。`
    + `不得为了达到门槛合并不相关短句。摘要不得补造客户、负责人、日期、时长或结论。\n录音 ID：${recordingId}\n完整转写：${JSON.stringify(evidence)}`;
  const response = await runtime.models.complete(runtime.model, {
    systemPrompt: '你是 CSM Agent 的会议分段器。只整理给定转写，不调用工具，不执行写入。',
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    tools: [],
  });
  if (response.stopReason === 'error') throw new Error((response as { errorMessage?: string }).errorMessage ?? '模型调用失败');
  return validateSegments(cleanJson(extractText(response.content)), lines.length);
}

export function hemorySegmentationFingerprint(recording: SourceEvent): string {
  return hash(`${HEMORY_SEGMENTATION_VERSION}:${recording.externalId}:${recording.payloadHash}`);
}

export class HemorySegmentationService {
  private processing = new Map<string, Promise<SourceEvent[]>>();

  constructor(private readonly db: WorkbenchDatabase, private readonly runtime: Runtime,
    private readonly onSegmented?: (events: SourceEvent[]) => void) {}

  async segmentRecording(recording: SourceEvent): Promise<SourceEvent[]> {
    if (recording.sourceSystem !== 'hemory' || recording.sourceType !== 'raw_transcript') throw new Error('只允许分段 Hemory 原始转写');
    const fingerprint = hemorySegmentationFingerprint(recording);
    const job = this.db.createHemorySegmentationJob(recording.id, fingerprint);
    if (job.status === 'succeeded') return this.db.listActiveHemoryFragmentsForRecording(recording.id);
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

  private async process(job: HemorySegmentationJob, recording: SourceEvent): Promise<SourceEvent[]> {
    this.db.updateHemorySegmentationJob(job.id, 'running');
    try {
      const lines = transcriptLines(recording);
      if (!lines.length) throw new Error('Hemory 录音没有可分段的转写行');
      const recordingId = String(recording.payload?.recordingId ?? recording.externalId);
      const proposed = await proposeSegments(this.runtime, recordingId, lines);
      const events: SourceEvent[] = [];
      for (const segment of proposed) {
        const evidence = lines.slice(segment.startIndex, segment.endIndex + 1);
        if (!segment.include || !isMeaningfulHemoryFragment(evidence)) continue;
        const transcript = evidence.map((line) => `${line.speaker}: ${line.text}`).join('\n');
        const matches = this.db.listCustomers().filter((customer) => [customer.name, customer.shortName].filter(Boolean)
          .some((name) => `${segment.topic}\n${segment.summary}\n${transcript}`.includes(name!)));
        const customer = matches.length === 1 ? matches[0] : undefined;
        const attributionStatus = matches.length === 1 ? 'confirmed' : matches.length > 1 ? 'ambiguous' : 'unattributed';
        const start = evidence[0];
        const end = evidence.at(-1)!;
        const externalId = `${recordingId}:${start.spokenAt}:${segment.startIndex}:${end.spokenAt}:${segment.endIndex}`;
        const previous = this.db.findSourceEvent('hemory', 'ai_topic_segment', externalId);
        const event = this.db.upsertSourceEvent({ customerId: customer?.id ?? null, sourceSystem: 'hemory', sourceType: 'ai_topic_segment',
          externalId, title: segment.topic.slice(0, 160), occurredAt: start.spokenAt, confidence: customer ? 0.85 : 0.2,
          attributionStatus, payload: { recordingId, rawRecordingEventId: recording.id, recordingHash: recording.payloadHash,
            generationVersion: HEMORY_SEGMENTATION_VERSION, topic: segment.topic, summary: segment.summary,
            startAt: start.spokenAt, endAt: end.spokenAt, speakers: [...new Set(evidence.map((line) => line.speaker).filter(Boolean))],
            transcript, evidence, startIndex: segment.startIndex, endIndex: segment.endIndex } });
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
      return events;
    } catch (error) {
      this.db.updateHemorySegmentationJob(job.id, 'failed', { error: (error as Error).message });
      throw error;
    }
  }
}
