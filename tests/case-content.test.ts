import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { CASE_CONTENT_VERSION, caseContentReview, caseLessonsLabel, casePracticeLibrary, casePracticesFor, validatePracticeIds } from '../src/workbench/case-content.js';
import { caseFigureAnchorText, coverageNeedsEnrichment, parseCaseContent, renderCaseMarkdown } from '../src/workbench/cases.js';
import { renderCaseDocx } from '../src/workbench/case-docx.js';

test('practice selections are bounded and validated, frozen text survives a library release', () => {
  assert.deepEqual(validatePracticeIds(undefined), []);
  for (const value of ['intake-governance', ['unknown'], ['intake-governance', 'intake-governance'], ['intake-governance', 'phased-adoption', 'role-usability']]) {
    assert.throws(() => validatePracticeIds(value), /practice_ids/);
  }
  assert.throws(() => parseCaseContent({ solution_sections: [{ title: '方案', text: '事实', practice_ids: ['invalid'] }] }), /practice_ids/);
  const library = casePracticeLibrary();
  const digest = library.digest;
  library.items[0].text = '旧版本冻结的条件化方法';
  const section = { practice_ids: ['intake-governance'] };
  assert.equal(casePracticesFor({ practice_library: library }, section)[0].text, '旧版本冻结的条件化方法');
  assert.equal(casePracticeLibrary().digest, digest);
  assert.notEqual(casePracticeLibrary().items[0].text, library.items[0].text);
  assert.deepEqual(casePracticesFor({}, section), []);
});

test('background claims require a locatable non-media source, not just an unrelated official ref', () => {
  const fields = { company_info: '已核验的公司信息', project_background: '合作背景', business_status: ['现状'], demands: ['诉求'],
    solution_sections: [{ title: '方案', text: '方案事实' }], value_items: ['采用变化'], summary: '总结',
    claim_evidence: [ ['intro', '已核验的公司信息'], ['intro', '合作背景'], ['status', '现状'], ['demands', '诉求'], ['solution', '方案事实'], ['value', '采用变化'], ['summary', '总结'] ].map(([section, claim]) => ({ section, claim, source_refs: ['web1', 'web2'], excerpt: '原文事实' })) };
  const sources: any[] = [{ id: 'web1', source_system: 'web', source_type: 'web:media', title: '报道', excerpt: '原文事实' },
    { id: 'web2', source_system: 'web', source_type: 'web:customer_official', title: '官网', excerpt: '另一条信息' }];
  assert.throws(() => parseCaseContent(fields, { requirePublic: true, sources }), /不能仅由媒体/);
  sources[0].source_type = 'web:customer_official';
  assert.doesNotThrow(() => parseCaseContent(fields, { requirePublic: true, sources }));
});

test('Markdown and Word embed identical frozen practices; legacy lessons retain their label', async () => {
  const fields = { company_info: '客户档案', project_background: '建设背景', business_status: ['人工汇总'], demands: ['集中管理'],
    solution_sections: [{ title: '统一入口', text: '客户确认配置统一入口。', practice_ids: ['intake-governance'] }],
    value_items: ['已开始使用'], lessons: ['适用于归口责任明确的场景。'], summary: '有据总结',
    content_version: CASE_CONTENT_VERSION, practice_library: casePracticeLibrary() };
  const draft: any = { title: '案例', fields };
  const markdown = renderCaseMarkdown(draft);
  const practice = fields.practice_library.items[0].text;
  assert.ok(markdown.includes(practice));
  assert.ok(markdown.indexOf(fields.solution_sections[0].text) < markdown.indexOf(practice));
  assert.match(markdown, /### 可复制实践/);
  const zip = await JSZip.loadAsync(await renderCaseDocx(draft));
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.ok(xml.includes(practice));
  assert.match(xml, /可复制实践/);
  assert.equal(caseLessonsLabel({}), '经验复盘与沉淀');
  assert.match(renderCaseMarkdown({ ...draft, fields: { ...fields, content_version: undefined } }), /### 经验复盘与沉淀/);
  assert.doesNotMatch(markdown, /practice_library|source_refs|docs.ones.cn/);
});

test('practice-only changes do not change figure anchors; customer facts do', () => {
  const before = { texts: ['客户采用的统一入口'], sectionTitles: ['需求治理'], practiceIds: [['intake-governance']] };
  const after = { ...before, practiceIds: [['role-usability']] };
  assert.equal(caseFigureAnchorText('solution', before), caseFigureAnchorText('solution', after));
  assert.notEqual(caseFigureAnchorText('solution', before), caseFigureAnchorText('solution', { ...after, texts: ['新的有据方案'] }));
  assert.equal(caseFigureAnchorText('value', { texts: ['已确认价值'], lessons: ['旧复盘'] }), caseFigureAnchorText('value', { texts: ['已确认价值'], lessons: ['新增可复制实践'] }));
  assert.doesNotMatch(caseFigureAnchorText('solution', before), /intake-governance|统一表单/);
});

test('content diagnostics distinguish unexpanded evidence, missing material and edited unsupported prose', () => {
  const source = { id: 's1', title: '客户决策', excerpt: '客户选择先配置统一入口，再逐步扩大使用范围。' };
  const fields = { company_info: '客户档案', solution_sections: [{ title: '入口', text: source.excerpt }],
    claim_evidence: [{ claim: source.excerpt, source_refs: ['s1'], excerpt: source.excerpt }] };
  const review = caseContentReview(fields, [source]);
  assert.equal(review.dimensions.find((item) => item.key === 'decision')?.status, 'covered');
  assert.equal(review.dimensions.find((item) => item.key === 'governance')?.status, 'missing');
  const edited = caseContentReview({ ...fields, solution_sections: [{ title: '入口', text: '已经配置全部流程' }] }, [source]);
  assert.equal(edited.dimensions.find((item) => item.key === 'mechanism')?.status, 'available');
  const coverage = { valueSignals: { total: 0, cited: 0 }, painSignals: { total: 0, cited: 0 }, authoritativeWeb: { total: 0, cited: 0 }, fallbackCited: 0, content: edited };
  assert.equal(coverageNeedsEnrichment(coverage), true);
  assert.equal(coverageNeedsEnrichment({ ...coverage, content: caseContentReview({}, []) }), false, 'short prose or missing sources alone must not trigger filler');
  assert.equal(edited.target.min, 5000);
});
