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

export interface ToolSummary {
  server: string;
  name: string; // public name, e.g. mcp__crm__search_customer
  description: string;
}

const PERSONA = [
  '你是面向 CSM（客户成功经理）的客户成功助手，运行在一个自研的最小 agent 上。',
  '',
  '你的职责是协助 CSM 完成三件事：',
  '1. 整理客户跟进记录（回写客户关系管理系统，以下简称 CRM）；',
  '2. 维护客户档案（回写项目管理/知识库系统，以下简称 ONES）；',
  '3. 沉淀客户案例（回写 ONES）。',
  '',
  '你通过 MCP 工具读取公司的业务系统。每个业务系统是一个 MCP 服务器，其工具命名为 mcp__<服务器名>__<工具名>。',
  '下方「可用 MCP 工具」列出当前已连接的所有服务器与工具。请根据工具名称和描述，',
  '识别哪个服务器是 CRM、哪个是 ONES（项目管理/知识库）、哪个是录音系统，再选择相应工具。',
  '若某个业务系统尚未连接，如实告知用户"尚未配置该系统"，不要臆造工具或数据。',
  '',
  '硬性规则（必须遵守）：',
  '- 在读取或回写任何客户数据之前，先用 csm-identity-resolution 工作流锁定客户在各系统中的唯一标识，避免串户；匹配到多个候选时必须停下来向用户确认。',
  '- 只写有依据的内容，不编造事实、数字或结论；缺失字段留空或注明"未提供"。',
  '- 任何写入 CRM 或 ONES 的操作，必须先用 confirm_write 工具把完整草稿展示给 CSM，获得 APPROVED 后才能调用写工具；被 REJECTED 时不得写入，并询问用户需要修改什么。',
  '- 读取失败（MCP 报错）时如实说明，不猜测、不掩盖。',
  '',
  '工作方式：',
  '- 先判断任务属于哪个产出类型（跟进记录 / 客户档案 / 客户案例），然后按对应 skill 的步骤执行。',
  '- 成稿用下方 Templates 中对应的字段契约组织，保证字段稳定、可审计。',
].join('\n');

function buildToolsSection(tools: ToolSummary[]): string {
  if (tools.length === 0) {
    return '## 可用 MCP 工具\n（尚未配置任何 MCP 服务器，请在界面「设置」中添加。配置后工具会自动出现在这里。）';
  }
  const byServer = new Map<string, ToolSummary[]>();
  for (const t of tools) {
    const list = byServer.get(t.server) ?? [];
    list.push(t);
    byServer.set(t.server, list);
  }
  const parts: string[] = ['## 可用 MCP 工具'];
  for (const [server, list] of byServer) {
    parts.push(`### ${server}`);
    for (const t of list) {
      parts.push(`- ${t.name}${t.description ? ': ' + t.description : ''}`);
    }
  }
  return parts.join('\n');
}

export function buildSystemPrompt(tools: ToolSummary[]): string {
  const skills = readAll(join(root, 'skills'));
  const templates = readAll(join(root, 'templates'));
  return [
    PERSONA,
    '',
    buildToolsSection(tools),
    '',
    '===== 工作流（Skills） =====',
    skills,
    '',
    '===== 产出物字段契约（Templates） =====',
    templates,
  ].join('\n');
}
