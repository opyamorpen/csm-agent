import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttachmentError,
  MAX_ATTACHMENTS,
  classifyAttachment,
  storeAttachments,
  getStoredAttachment,
  buildContentBlocks,
  removeSessionAttachments,
  TEXT_CONTEXT_CAP,
} from '../src/attachments.js';

let dir = '';
const sessionId = 'sess-test-1';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'csm-attach-'));
  process.env.CSM_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CSM_DATA_DIR;
});

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

test('classifyAttachment: MIME 优先，扩展名兜底，未知类型不支持', () => {
  assert.equal(classifyAttachment('image/png', 'a.png'), 'image');
  assert.equal(classifyAttachment('application/pdf', 'a.pdf'), 'pdf');
  assert.equal(classifyAttachment('', '文档.pdf'), 'pdf', 'PDF 扩展名兜底');
  assert.equal(classifyAttachment('text/plain', 'a.txt'), 'text');
  assert.equal(classifyAttachment('application/json', 'a.json'), 'text');
  assert.equal(classifyAttachment('application/octet-stream', 'notes.log'), 'text', '文本类扩展名兜底');
  assert.equal(classifyAttachment('application/zip', 'a.zip'), 'unsupported');
});

test('storeAttachments: 落盘 + manifest 元信息可读', async () => {
  const stored = await storeAttachments(sessionId, [
    { name: '需求说明.txt', mimeType: 'text/plain', data: b64('需求正文') },
  ]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'text');
  assert.equal(stored[0].size, Buffer.byteLength('需求正文'));
  const meta = await getStoredAttachment(sessionId, stored[0].id);
  assert.equal(meta?.name, '需求说明.txt');
  assert.equal(await getStoredAttachment(sessionId, 'not-exists'), null);
});

test('storeAttachments: 数量/大小/类型校验', async () => {
  const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', data: b64('x') }));
  await assert.rejects(storeAttachments(sessionId, many), AttachmentError);
  await assert.rejects(
    storeAttachments(sessionId, [{ name: 'big.bin', mimeType: 'application/octet-stream', data: 'eA==' }]),
    /不支持的附件类型/,
  );
  await assert.rejects(
    storeAttachments(sessionId, [{ name: 'empty.txt', mimeType: 'text/plain', data: '' }]),
    /内容为空/,
  );
});

test('buildContentBlocks: 消息在前，文本附件注入正文并包围栏', async () => {
  const stored = await storeAttachments(sessionId, [{ name: '日志片段.log', mimeType: 'text/plain', data: b64('ERROR at 10:00') }]);
  const blocks = await buildContentBlocks('帮我分析这个报错', sessionId, stored, { vision: false });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'text', text: '帮我分析这个报错' });
  const att = blocks[1] as { type: 'text'; text: string };
  assert.equal(att.type, 'text');
  assert.ok(att.text.includes('【附件 日志片段.log】'));
  assert.ok(att.text.includes('ERROR at 10:00'));
});

test('buildContentBlocks: 超长文本截断并显式标注', async () => {
  const long = 'x'.repeat(TEXT_CONTEXT_CAP + 100);
  const stored = await storeAttachments(sessionId, [{ name: 'big.md', mimeType: 'text/markdown', data: Buffer.from(long).toString('base64') }]);
  const blocks = await buildContentBlocks('', sessionId, stored, { vision: false });
  assert.equal(blocks.length, 1, '无消息文本时不产生空文本块');
  const att = blocks[0] as { type: 'text'; text: string };
  assert.ok(att.text.includes('仅注入前'), '截断需显式标注');
  const fenced = att.text.split('```')[1];
  assert.equal(fenced.trim().length, TEXT_CONTEXT_CAP);
});

test('buildContentBlocks: 图片在视觉模型下走 image 块，否则拒绝', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const stored = await storeAttachments(sessionId, [{ name: '截图.png', mimeType: 'image/png', data: png.toString('base64') }]);
  const withVision = await buildContentBlocks('看图说话', sessionId, stored, { vision: true });
  const image = withVision[1] as { type: 'image'; data: string; mimeType: string };
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(Buffer.from(image.data, 'base64').length, png.length);
  await assert.rejects(buildContentBlocks('看图说话', sessionId, stored, { vision: false }), /不支持图片输入/);
});

test('buildContentBlocks: PDF 提取正文文字注入（扫描件明确报错）', async () => {
  // 手工最小单页 PDF：pdf.js 走恢复模式提取（verified: unpdf 可解析此形态）。
  const pdf = `%PDF-1.1
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 52 >>
stream
BT /F1 24 Tf 72 720 Td (AttachmentWork) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
  const stored = await storeAttachments(sessionId, [{ name: '需求说明.pdf', mimeType: 'application/pdf', data: Buffer.from(pdf).toString('base64') }]);
  const blocks = await buildContentBlocks('总结文档', sessionId, stored, { vision: false });
  const att = blocks[1] as { type: 'text'; text: string };
  assert.equal(att.type, 'text');
  assert.ok(att.text.includes('AttachmentWork'), 'PDF 正文应进入上下文');
  assert.ok(att.text.includes('【附件 需求说明.pdf】'));

  await assert.rejects(
    buildContentBlocks('x', sessionId, [{ ...stored[0], id: 'broken', name: '坏.pdf' }], { vision: false }),
    AttachmentError,
    '读取不到的附件应抛业务错误而不是静默吞掉',
  );
});

test('removeSessionAttachments: 会话删除时清理附件目录', async () => {
  const stored = await storeAttachments(sessionId, [{ name: 'a.txt', mimeType: 'text/plain', data: b64('hi') }]);
  assert.ok(existsSync(join(dir, 'attachments', sessionId, 'manifest.json')));
  void stored;
  await removeSessionAttachments(sessionId);
  assert.equal(existsSync(join(dir, 'attachments', sessionId)), false);
});
