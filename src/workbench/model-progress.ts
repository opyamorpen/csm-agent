import type { Runtime } from '../bootstrap.js';

/**
 * 生成类功能（周报/案例）的模型调用进度助手。
 *
 * pi-ai 的 complete() 本就是 stream().result() 的封装——底层永远走流，只是丢弃了增量。
 * 这里改走 stream() 消费 text_delta/thinking_delta，节流聚合为「已输出 N 字（最近片段）」
 * 的进度 tick；返回值与 complete() 完全一致（provider 故障仍是 stopReason='error' +
 * errorMessage，不抛异常），调用方的重试/解析逻辑零改动。
 *
 * 测试假模型往往只实现 complete（无 stream），此时静默回退、不产生任何 tick。
 */

/** 进度节流间隔：更快的流式增量只刷新计数，不落库不回调。 */
const PROGRESS_TICK_MS = 1_500;
/** 片段截断长度（展示用，不是数据）。 */
const SNIPPET_LIMIT = 60;

export interface ModelProgressTick {
  /** 已累计输出的正文字符数。 */
  chars: number;
  /** 尾部最近一段可读片段（正文优先、思考兜底；可为空——JSON 输出的碎片常无可读段）。 */
  snippet: string;
}

export type ModelProgressCallback = (tick: ModelProgressTick) => void;

/**
 * 从流式累积文本中提取「最近一段可读片段」：生成任务是整段 JSON 输出，尾部常是
 * 未闭合的结构噪音（键名、标点、转义符）；优先取正文里最近的连续 CJK/词句段，
 * 正文无匹配再退回思考文本的尾部，都没有就返回空串只报字数。
 */
export function progressSnippet(textTail: string, thinkingTail: string): string {
  const readable = textTail
    .replace(/\\n/g, '\n')
    // 连续 ASCII 键名/结构符压成空格，保留 CJK 与正常词句
    .replace(/[A-Za-z0-9_]+"?\s*:|\\"|[[\]{}"]/g, ' ')
    .replace(/\s+/g, ' ');
  const match = readable.match(/[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9，。、；：！？,.:;!? ]{8,}/g);
  if (match?.length) {
    const last = match[match.length - 1].trim();
    if (last.length >= 10) return last.length > SNIPPET_LIMIT ? `…${last.slice(-SNIPPET_LIMIT)}` : last;
  }
  const thought = thinkingTail.replace(/\s+/g, ' ').trim();
  if (thought.length >= 10) return thought.length > SNIPPET_LIMIT ? `…${thought.slice(-SNIPPET_LIMIT)}` : thought;
  return '';
}

/**
 * 流式调用 + 进度回调；models 无 stream 能力（测试假模型）时回退 complete。
 * options 透传给 models.stream/complete：maxTokens 提升输出预算（长 JSON 输出 + reasoning token 共享上限，
 * 服务端默认 8k 会被截断成 stopReason=length——案例/周报需要显式大预算）；timeoutMs 放宽到 120s
 * （中继端点大上下文首字节常见 40~60s，pi-ai/undici 默认 10s 连接超时对慢节点过短）。
 */
export async function completeModelWithProgress(
  runtime: Runtime,
  context: Parameters<Runtime['models']['complete']>[1],
  onTick?: ModelProgressCallback,
  options: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<Runtime['models']['complete']>>> {
  const request = Object.keys(options).length ? options : undefined;
  if (!onTick || typeof runtime.models.stream !== 'function') {
    return runtime.models.complete(runtime.model, context, request);
  }
  const stream = runtime.models.stream(runtime.model, context, request);
  let textChars = 0;
  let textTail = '';
  let thinkingTail = '';
  let lastTickAt = 0;
  let lastChars = -1;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && (now - lastTickAt < PROGRESS_TICK_MS || textChars === lastChars)) return;
    lastTickAt = now;
    lastChars = textChars;
    onTick({ chars: textChars, snippet: progressSnippet(textTail, thinkingTail) });
  };
  for await (const ev of stream) {
    if (ev.type === 'text_delta' && ev.delta) {
      textChars += ev.delta.length;
      textTail = (textTail + ev.delta).slice(-400);
      emit();
    } else if (ev.type === 'thinking_delta' && ev.delta) {
      thinkingTail = (thinkingTail + ev.delta).slice(-400);
      emit();
    }
  }
  emit(true);
  return stream.result();
}

/** tick → 一行进度文案（周报/案例共用）。 */
export function modelProgressText(tick: ModelProgressTick): string {
  return tick.snippet
    ? `模型撰写中… 已输出 ${tick.chars} 字（${tick.snippet}）`
    : `模型撰写中… 已输出 ${tick.chars} 字`;
}
