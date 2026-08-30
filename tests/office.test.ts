import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { extractOfficeText, OfficeExtractError } from '../src/office.js';
import { classifyAttachment, storeAttachments, buildContentBlocks, AttachmentError } from '../src/attachments.js';

let dir = '';
const sessionId = 'sess-office-1';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'csm-office-'));
  process.env.CSM_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CSM_DATA_DIR;
});

// ── classify：OOXML MIME 优先、扩展名兜底、OLE2 单独归类 ──
test('classifyAttachment: Office OOXML 与旧版 OLE2 分流', () => {
  assert.equal(classifyAttachment('application/vnd.openxmlformats-officedocument.wordprocessingml.document', '周报.docx'), 'docx');
  assert.equal(classifyAttachment('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '数据.xlsx'), 'xlsx');
  assert.equal(classifyAttachment('application/vnd.openxmlformats-officedocument.presentationml.presentation', '汇报.pptx'), 'pptx');
  assert.equal(classifyAttachment('', '文档.docx'), 'docx', 'MIME 缺失时扩展名兜底');
  assert.equal(classifyAttachment('application/msword', '旧文档.doc'), 'ole');
  assert.equal(classifyAttachment('', '老表.xls'), 'ole');
});

// ── 最小 OOXML fixture（jszip 现造，闭环验证提取链路）──
async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>项目周报标题</w:t></w:r></w:p><w:p><w:r><w:t>本周完成 12 项交付。</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="需求清单" sheetId="1"/><sheet name="风险" sheetId="2"/></sheets></workbook>');
  zip.file('xl/sharedStrings.xml', '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>需求名称</t></si><si><t>状态</t></si><si><t>登录重构</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row>' // B2 缺失：跨列对齐补空
    + '</sheetData></worksheet>');
  zip.file('xl/worksheets/sheet2.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>验收阻塞</t></is></c></row>'
    + '</sheetData></worksheet>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>封面：项目里程碑</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第一段。</a:t></a:r></a:p><a:p><a:r><a:t>第二段 &amp; 要点。</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('extractOfficeText: docx 提取段落文字（mammoth）', async () => {
  const text = await extractOfficeText('docx', await makeDocx());
  assert.ok(text.includes('项目周报标题'));
  assert.ok(text.includes('本周完成 12 项交付'));
});

test('extractOfficeText: xlsx 按工作表分节，sharedStrings/inlineStr/跨列对齐', async () => {
  const text = await extractOfficeText('xlsx', await makeXlsx());
  assert.ok(text.includes('### 需求清单'));
  assert.ok(text.includes('需求名称\t状态'), 'sharedStrings 引用应解析为文字');
  assert.ok(text.includes('登录重构\t\t42'), 'B2 缺失应在 C 列值前补一个空位');
  assert.ok(text.includes('### 风险'));
  assert.ok(text.includes('验收阻塞'), 'inlineStr 内联字符串应可读');
});

test('extractOfficeText: pptx 逐页提取并合并段落', async () => {
  const text = await extractOfficeText('pptx', await makePptx());
  assert.ok(text.includes('【第 1 页】'));
  assert.ok(text.includes('封面：项目里程碑'));
  assert.ok(text.includes('【第 2 页】'));
  assert.ok(text.includes('第一段。\n第二段 & 要点。'), '段落换行合并 + XML 实体反转义');
});

test('extractOfficeText: 空文档明确业务错误（不静默吞）', async () => {
  const zip = new JSZip();
  zip.folder('word')?.file('document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
  await assert.rejects(extractOfficeText('docx', await zip.generateAsync({ type: 'nodebuffer' })), OfficeExtractError);
});

test('buildContentBlocks: Office 附件注入正文；旧版 OLE2 给出另存指引', async () => {
  const docxStored = await storeAttachments(sessionId, [{
    name: '项目周报.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data: (await makeDocx()).toString('base64'),
  }]);
  const blocks = await buildContentBlocks('帮我总结这份周报', sessionId, docxStored, { vision: false });
  assert.equal(blocks[1].type, 'text');
  assert.ok((blocks[1] as { text: string }).text.includes('【附件 项目周报.docx】'));
  assert.ok((blocks[1] as { text: string }).text.includes('项目周报标题'));

  const oleStored = await storeAttachments(sessionId, [{ name: '老文档.doc', mimeType: 'application/msword', data: Buffer.from('ole').toString('base64') }]);
  await assert.rejects(
    buildContentBlocks('读', sessionId, oleStored, { vision: false }),
    /旧版 Office 二进制格式（\.doc\/\.xls\/\.ppt），暂不支持/,
  );
});

test('storeAttachments: unsupported 文案列出 Office 支持清单', async () => {
  await assert.rejects(
    storeAttachments(sessionId, [{ name: 'a.zip', mimeType: 'application/zip', data: 'eA==' }]),
    (err: unknown) => err instanceof AttachmentError && /Office（docx\/xlsx\/pptx）/.test((err as Error).message),
  );
});
