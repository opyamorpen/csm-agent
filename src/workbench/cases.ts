import type { McpGateway } from '../agent.js';
import { argumentsHash } from '../approval.js';
import { WorkbenchDatabase } from './database.js';
import type { CaseDraft } from './types.js';

function renderCaseMarkdown(draft: CaseDraft): string {
  const f = draft.fields as Record<string, any>;
  const section = (title: string, value: unknown) => `## ${title}\n\n${Array.isArray(value) ? value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n') : value || '待补充'}\n`;
  return [
    `# ${draft.title}\n`,
    section('客户背景', f.background),
    section('业务痛点', f.pain_points),
    section('解决方案', f.solution),
    section('实施过程', f.implementation),
    section('成果', f.results),
    section('客户原话', f.customer_quote),
    section('可复用经验', f.reusable_lessons),
    section('证据引用', draft.evidenceRefs),
    section('脱敏检查', f.redaction_review),
  ].join('\n');
}

export class CaseService {
  constructor(private readonly db: WorkbenchDatabase, private readonly mcp: McpGateway) {}

  generate(customerId: string): CaseDraft {
    const customer = this.db.getCustomer(customerId);
    if (!customer) throw new Error('customer not found');
    const evidence = this.db.listEvidence(customerId);
    const timeline = this.db.listTimeline(customerId, 100);
    const outcomes = evidence.filter((item) => item.kind === 'outcome');
    const needs = evidence.filter((item) => item.kind === 'opportunity' || item.kind === 'fact');
    const quote = outcomes.find((item) => item.sourceSystem === 'hemory')?.detail ?? '';
    return this.db.createCaseDraft(customerId, `${customer.name}客户成功案例`, {
      customer_id: customer.id,
      customer_name: customer.name,
      industry: customer.industry ?? '',
      background: `${customer.name}${customer.industry ? `属于${customer.industry}行业` : ''}，当前使用产品：${customer.products?.join('、') || '待补充'}。`,
      pain_points: needs.slice(0, 5).map((item) => item.detail),
      solution: '请由 CSM 基于关联需求、工单和会议证据补充最终解决方案。',
      implementation: timeline.filter((item) => item.sourceSystem === 'ones').slice(0, 8).map((item) => `${item.occurredAt.slice(0, 10)} ${item.title}`).join('\n'),
      results: outcomes.slice(0, 5).map((item) => ({ metric: item.label, value: item.detail })),
      customer_quote: quote,
      reusable_lessons: [],
      redaction_review: '待 CSM 确认客户名称、联系人、合同与录音引用的脱敏口径。',
    }, [...new Set([...evidence.map((item) => item.id!).filter(Boolean), ...timeline.map((item) => item.id)])]);
  }

  publishPreview(draftId: string, parentPageID: string): { draft: CaseDraft; tool: string; args: Record<string, unknown>; approvalHash: string } {
    const draft = this.db.getCaseDraft(draftId);
    if (!draft || draft.status !== 'draft') throw new Error('draft not publishable');
    if (!parentPageID.trim()) throw new Error('缺少 ONES 案例库父页面 ID');
    const tool = 'mcp__ones__create_page';
    const args = { parentPageID, title: draft.title, content: renderCaseMarkdown(draft) };
    return { draft, tool, args, approvalHash: argumentsHash({ draftId, version: draft.version, tool, args }) };
  }

  async publish(draftId: string, version: number, parentPageID: string, approvalHash: string): Promise<CaseDraft> {
    const preview = this.publishPreview(draftId, parentPageID);
    const expected = argumentsHash({ draftId, version, tool: preview.tool, args: preview.args });
    if (preview.draft.version !== version || expected !== approvalHash) throw new Error('草稿版本或批准内容已变化，请重新确认');
    const result = await this.mcp.call(preview.tool, preview.args);
    if (result.isError) throw new Error(result.text);
    let pageId = '';
    try {
      const parsed = JSON.parse(result.text);
      pageId = String(parsed.pageID ?? parsed.id ?? parsed.data?.pageID ?? '');
    } catch {
      pageId = result.text.match(/[0-9a-f-]{8,}/i)?.[0] ?? '';
    }
    const published = this.db.markCasePublished(draftId, version, pageId || 'created-without-returned-id');
    if (!published) throw new Error('草稿状态已变化');
    this.db.audit('csm', 'publish_case', 'case_draft', draftId, { version, pageId: published.publishedPageId, approvalHash });
    return published;
  }
}
