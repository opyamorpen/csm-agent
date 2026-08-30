import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { extractText as extractPdfText } from 'unpdf';
import { dataDir } from './store.js';

/** 对话附件：分类/落盘/上下文块构建。文件落盘在 {dataDir}/attachments/<sessionId>/，消息体内联 base64。 */

export type AttachmentKind = 'text' | 'image' | 'pdf' | 'unsupported';

/** 客户端提交的待存附件（消息体 JSON 内嵌 base64）。 */
export interface IncomingAttachment {
  name: string;
  mimeType: string;
  data: string; // base64
}

/** 落盘后的附件元信息（下发给 SSE user 事件与展示层，不含文件内容）。 */
export interface StoredAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** 文本/PDF 注入上下文的字符上限：超出截断并在块内显式标注。 */
export const TEXT_CONTEXT_CAP = 50_000;

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.ndjson',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.css',
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.rb', '.php', '.sh', '.bash', '.zsh', '.sql', '.vue',
  '.toml', '.ini', '.conf', '.cfg', '.env',
]);

export class AttachmentError extends Error {}

/** 以 MIME 为主、扩展名兜底的附件分类。 */
export function classifyAttachment(mimeType: string, name: string): AttachmentKind {
  const mime = (mimeType || '').toLowerCase();
  const ext = extname(name || '').toLowerCase();
  if (IMAGE_MIME.has(mime)) return 'image';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml'
    || mime === 'application/x-yaml' || mime === 'application/yaml' || TEXT_EXT.has(ext)) return 'text';
  return 'unsupported';
}

function attachmentsDir(sessionId: string): string {
  return join(dataDir(), 'attachments', sessionId);
}

function manifestPath(sessionId: string): string {
  return join(attachmentsDir(sessionId), 'manifest.json');
}

async function loadManifest(sessionId: string): Promise<Record<string, StoredAttachment>> {
  try {
    return JSON.parse(await readFile(manifestPath(sessionId), 'utf8')) as Record<string, StoredAttachment>;
  } catch {
    return {};
  }
}

async function saveManifest(sessionId: string, manifest: Record<string, StoredAttachment>): Promise<void> {
  const tmp = `${manifestPath(sessionId)}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tmp, manifestPath(sessionId));
}

/** 清理整个会话的附件（删除会话时调用）。 */
export async function removeSessionAttachments(sessionId: string): Promise<void> {
  await rm(attachmentsDir(sessionId), { recursive: true, force: true });
}

/** 磁盘上的附件内容文件路径（manifest 权威，路径只作派生）。 */
export function attachmentFilePath(sessionId: string, id: string, name: string): string {
  const safe = name.replace(/[^\w.一-鿿-]+/g, '_').slice(-80);
  return join(attachmentsDir(sessionId), `${id}-${safe}`);
}

/** 读取附件元信息（GET 下载路由用；id 必须在 manifest 中，防止路径穿越）。 */
export async function getStoredAttachment(sessionId: string, id: string): Promise<StoredAttachment | null> {
  const manifest = await loadManifest(sessionId);
  return manifest[id] ?? null;
}

/**
 * 校验并落盘一条消息的附件。数量/单文件/总量超限、类型不支持直接抛 AttachmentError（映射 400）。
 * 返回元信息列表；内容文件按 manifest 记录的路径写入。
 */
export async function storeAttachments(sessionId: string, incoming: IncomingAttachment[]): Promise<StoredAttachment[]> {
  if (incoming.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`一次最多附带 ${MAX_ATTACHMENTS} 个附件（当前 ${incoming.length} 个）`);
  }
  let totalBytes = 0;
  const decoded: Array<{ meta: Omit<StoredAttachment, 'id'>; bytes: Buffer }> = [];
  for (const item of incoming) {
    const name = String(item.name ?? '').trim();
    if (!name) throw new AttachmentError('附件缺少文件名');
    const kind = classifyAttachment(String(item.mimeType ?? ''), name);
    if (kind === 'unsupported') {
      throw new AttachmentError(`不支持的附件类型「${name}」（${item.mimeType || '未知类型'}）：目前支持文本类（txt/md/csv/json/log/代码等）、PDF 和图片`);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(item.data, 'base64');
    } catch {
      throw new AttachmentError(`附件「${name}」base64 解码失败`);
    }
    if (!bytes.length) throw new AttachmentError(`附件「${name}」内容为空`);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`附件「${name}」超过单文件上限 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
    }
    totalBytes += bytes.length;
    decoded.push({ meta: { name, mimeType: String(item.mimeType || 'application/octet-stream'), size: bytes.length, kind }, bytes });
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AttachmentError(`附件总大小超过上限 ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB`);
  }

  await mkdir(attachmentsDir(sessionId), { recursive: true });
  const manifest = await loadManifest(sessionId);
  const stored: StoredAttachment[] = [];
  for (const { meta, bytes } of decoded) {
    const id = randomUUID();
    await writeFile(attachmentFilePath(sessionId, id, meta.name), bytes);
    const entry: StoredAttachment = { id, ...meta };
    manifest[id] = entry;
    stored.push(entry);
  }
  await saveManifest(sessionId, manifest);
  return stored;
}

function truncateText(text: string): { text: string; truncated: boolean } {
  return text.length > TEXT_CONTEXT_CAP
    ? { text: text.slice(0, TEXT_CONTEXT_CAP), truncated: true }
    : { text, truncated: false };
}

/**
 * 把用户消息 + 已落盘附件组装成 pi-ai 内容块：用户原文在前，随后每个附件一个块。
 * 文本/PDF → 注入正文的文本块（截断标注）；图片 → image 块（要求视觉模型）。
 */
export async function buildContentBlocks(
  message: string,
  sessionId: string,
  attachments: StoredAttachment[],
  options: { vision: boolean },
): Promise<(TextContent | ImageContent)[]> {
  const blocks: (TextContent | ImageContent)[] = [];
  const text = message.trim();
  if (text) blocks.push({ type: 'text', text });

  for (const attachment of attachments) {
    const path = attachmentFilePath(sessionId, attachment.id, attachment.name);
    if (attachment.kind === 'image') {
      if (!options.vision) {
        throw new AttachmentError(`附件「${attachment.name}」是图片，但当前模型不支持图片输入（视觉模型）。请在设置中切换支持视觉的模型，或勾选「支持图片输入」后重试。`);
      }
      const data = (await readFile(path).catch(() => { throw new AttachmentError(`附件「${attachment.name}」读取失败`); })).toString('base64');
      blocks.push({ type: 'image', data, mimeType: attachment.mimeType });
      continue;
    }
    const bytes = await readFile(path).catch(() => { throw new AttachmentError(`附件「${attachment.name}」读取失败`); });
    let body: string;
    if (attachment.kind === 'pdf') {
      try {
        const result = await extractPdfText(new Uint8Array(bytes), { mergePages: true });
        body = String(result.text ?? '');
      } catch (err) {
        throw new AttachmentError(`附件「${attachment.name}」PDF 解析失败：${(err as Error).message}`);
      }
      if (!body.trim()) {
        throw new AttachmentError(`附件「${attachment.name}」PDF 未提取到文字（可能是扫描件，目前仅支持文字型 PDF）`);
      }
    } else {
      body = bytes.toString('utf8');
    }
    const clipped = truncateText(body);
    const note = clipped.truncated ? `\n（附件原文过长，仅注入前 ${TEXT_CONTEXT_CAP} 字符）` : '';
    blocks.push({
      type: 'text',
      text: `【附件 ${attachment.name}】\n\`\`\`\n${clipped.text}\n\`\`\`${note}`,
    });
  }
  return blocks;
}
