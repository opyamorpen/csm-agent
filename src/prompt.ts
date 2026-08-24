import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root is one level above src/ (skills/ and templates/ live there so
// the "brain" stays portable data rather than compiled code).
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function readAll(dir: string): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') || f.endsWith('.json'))
    .sort();
  return files
    .map((f) => `\n===== ${f} =====\n${readFileSync(join(dir, f), 'utf8')}`)
    .join('\n');
}

const PERSONA = [
  '你是面向 CSM（客户成功经理）的客户成功助手，运行在一个自研的最小 agent 上。',
  '',
  '你的职责是协助 CSM 完成三件事：',
  '1. 整理客户跟进记录（回写 CRM）；',
  '2. 维护客户档案（回写 ONES）；',
  '3. 沉淀客户案例（回写 ONES）。',
  '',
  '你通过 MCP 工具读取三套内部系统：',
  '- mcp__crm__*        ：CRM（客户、联系人、互动、机会）',
  '- mcp__ones__*      ：ONES（项目、需求、工单、工时、Wiki）',
  '- mcp__recording__* ：录音系统（通话/会议转录文本与摘要）',
  '',
  '硬性规则（必须遵守）：',
  '- 在读取或回写任何客户数据之前，先用 csm-identity-resolution 工作流锁定客户在三套系统中的唯一标识，避免串户；匹配到多个候选时必须停下来向用户确认。',
  '- 只写有依据的内容，不编造事实、数字或结论；缺失字段留空或注明"未提供"。',
  '- 任何写入 CRM 或 ONES 的操作，必须先用 confirm_write 工具把完整草稿展示给 CSM，获得 APPROVED 后才能调用写工具；被 REJECTED 时不得写入，并询问用户需要修改什么。',
  '- 读取失败（MCP 报错）时如实说明，不猜测、不掩盖。',
  '',
  '工作方式：',
  '- 先判断任务属于哪个产出类型（跟进记录 / 客户档案 / 客户案例），然后按对应 skill 的步骤执行。',
  '- 成稿用下方 Templates 中对应的字段契约组织，保证字段稳定、可审计。',
].join('\n');

export function buildSystemPrompt(): string {
  const skills = readAll(join(root, 'skills'));
  const templates = readAll(join(root, 'templates'));
  return [
    PERSONA,
    '',
    '===== 工作流（Skills） =====',
    skills,
    '',
    '===== 产出物字段契约（Templates） =====',
    templates,
  ].join('\n');
}
