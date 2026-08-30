import JSZip from 'jszip';
import mammoth from 'mammoth';

/** OOXML（.docx/.xlsx/.pptx）正文提取：docx 走 mammoth，xlsx/pptx 手写 ZIP+XML 解析（零重依赖）。 */

export class OfficeExtractError extends Error {}

/** XML 实体反转义（OOXML 文本里 & 会序列化成 &amp; 等）。 */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function readXml(zip: JSZip, path: string): Promise<string | undefined> {
  return zip.file(path)?.async('string') ?? Promise.resolve(undefined);
}

/** 文件内数字排序：slide10 不能排在 slide2 前。 */
function byNumberedPath(prefix: string): (a: string, b: string) => number {
  return (a, b) => {
    const num = (p: string) => Number(p.slice(prefix.length).replace(/\D+$/, '')) || 0;
    return num(a) - num(b);
  };
}

/** .docx：mammoth extractRawText 已是纯文本（标题/表格行内联）。 */
async function extractDocx(bytes: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: bytes });
  return (result.value ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/** A1 列号 → 0 基列索引（A=0, B=1, …, AA=26）。 */
function colIndexOf(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase();
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** .xlsx：sharedStrings + 逐工作表 TSV（跨列对齐补空位），空单元格安全。 */
async function extractXlsx(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const sharedXml = await readXml(zip, 'xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sharedXml) {
    for (const si of sharedXml.match(/<si\b[\s\S]*?<\/si>/g) ?? []) {
      const text = (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
        .map((t) => unescapeXml(t.replace(/<\/?t[^>]*>/g, '')))
        .join('');
      shared.push(text);
    }
  }

  // 工作表名（尽力而为；缺失时按序号回退）
  const names: string[] = [];
  const workbookXml = await readXml(zip, 'xl/workbook.xml');
  if (workbookXml) {
    for (const match of workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)) {
      names.push(unescapeXml(match[1]));
    }
  }

  const sheetPaths = zip.file(/^xl\/worksheets\/sheet\d+\.xml$/).map((f) => f.name).sort(byNumberedPath('xl/worksheets/sheet'));
  const sections: string[] = [];
  for (let i = 0; i < sheetPaths.length; i++) {
    const xml = (await readXml(zip, sheetPaths[i])) ?? '';
    const rows: string[] = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = c.match(/\br="([A-Z]+\d+)"/i)?.[1] ?? '';
        const type = c.match(/\bt="([^"]+)"/)?.[1] ?? '';
        const value = type === 'inlineStr'
          ? unescapeXml(c.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/)?.[1] ?? '')
          : unescapeXml(c.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
        const resolved = type === 's' ? (shared[Number(value)] ?? value) : value;
        if (ref) {
          const col = colIndexOf(ref);
          while (cells.length < col) cells.push('');
          cells.push(resolved);
        } else {
          cells.push(resolved);
        }
      }
      if (cells.some((cell) => cell !== '')) rows.push(cells.join('\t').replace(/\t+$/, ''));
    }
    if (rows.length) sections.push(`### ${names[i] ?? `Sheet${i + 1}`}\n${rows.join('\n')}`);
  }
  return sections.join('\n\n').trim();
}

/** .pptx：逐页（slide 数字序）按段落提取 <a:t>，页间标记分页。 */
async function extractPptx(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const slidePaths = zip.file(/^ppt\/slides\/slide\d+\.xml$/).map((f) => f.name).sort(byNumberedPath('ppt/slides/slide'));
  const pages: string[] = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const xml = (await readXml(zip, slidePaths[i])) ?? '';
    const paragraphs = (xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [])
      .map((p) => (p.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) ?? [])
        .map((t) => unescapeXml(t.replace(/<\/?a:t[^>]*>/g, '')))
        .join(''))
      .map((text) => text.trim())
      .filter(Boolean);
    if (paragraphs.length) pages.push(`【第 ${i + 1} 页】\n${paragraphs.join('\n')}`);
  }
  return pages.join('\n\n').trim();
}

const EXTRACTORS = { docx: extractDocx, xlsx: extractXlsx, pptx: extractPptx } as const;

export type OfficeKind = keyof typeof EXTRACTORS;

/**
 * 提取 Office 正文文字。空文档/解析失败抛 OfficeExtractError（调用方转 400 业务错）。
 */
export async function extractOfficeText(kind: OfficeKind, bytes: Buffer): Promise<string> {
  try {
    const text = await EXTRACTORS[kind](bytes);
    if (!text) throw new OfficeExtractError(`未提取到文字（${kind} 可能为空文档或内容全部是非文本对象）`);
    return text;
  } catch (err) {
    if (err instanceof OfficeExtractError) throw err;
    throw new OfficeExtractError(`解析失败：${(err as Error).message}`);
  }
}
