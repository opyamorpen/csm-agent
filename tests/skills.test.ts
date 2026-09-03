import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Skills 与 PERSONA 是注入模型的「工作流代码」：贴图/聊天记录提单工作流的关键句一旦被误删，
// 行为会静默退化（模型不再走先取字段契约→confirm_write 的流程），这里按字面量守住契约。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const writeback = readFileSync(join(root, 'skills', 'customer-writeback.md'), 'utf8');
const persona = readFileSync(join(root, 'src', 'prompt.ts'), 'utf8');

test('skill contract: 从贴图/粘贴聊天记录提 ONES 工作项的工作流', () => {
  // 入口与类型路由
  assert.ok(writeback.includes('用户贴图（截图）或粘贴一段聊天记录'), '缺少贴图/聊天记录入口条目');
  assert.ok(writeback.includes('缺陷指认 → ticket（工单）'), '缺少 bug→ticket 路由');
  assert.ok(writeback.includes('→ suggestion（建议类型=新需求）'), '缺少 需求→suggestion 路由');
  assert.ok(writeback.includes('→ operations（运维工单）'), '缺少 运维→operations 路由');
  assert.ok(writeback.includes('客户名唯一明确时直接写入草稿 fields.customer_name，无需先绑定会话'), '缺少草稿自含客户身份规则');
  assert.ok(writeback.includes('识别不出、同名歧义或类型有歧义时先问用户，不猜'), '缺少歧义先问规则');
  // 证据纪律与兜底
  assert.ok(writeback.includes('截图只描述所见事实'), '缺少截图证据纪律');
  assert.ok(writeback.includes('摘录关键原文并注明说话人'), '缺少聊天记录摘录规则');
  assert.ok(writeback.includes('贴入内容里没有的信息一律不写'), '缺少不虚构规则');
  assert.ok(writeback.includes('兜底值，不确定项写入 unknowns 一并展示'), '缺少兜底+unknowns 规则');
  // 流程契约
  assert.ok(writeback.includes('get_ones_desk_required_fields(record_type=…)'), '缺少先取字段契约步骤');
  assert.ok(writeback.includes('描述只写入 field016 一处'), '缺少描述字段落点');
  assert.ok(writeback.includes('fieldValues 除规格字段、`JrvswW8P`、field016 外不得添加任何其他字段 ID'), '缺少未知字段禁令');
  assert.ok(writeback.includes('批准后按原参数调用 create_new_issue'), '缺少批准后原参数回写步骤');
  // 自动优先与多条处理
  assert.ok(writeback.includes('不连环追问'), '缺少自动优先规则');
  assert.ok(writeback.includes('逐条 `confirm_write` 依次确认'), '缺少多条依次确认规则');
  assert.ok(writeback.includes('被用户拒绝后不得原样重新提交相同参数'), '缺少拒后重提禁令');
});

test('persona contract: 贴图/聊天记录提单路由', () => {
  assert.ok(persona.includes('用户贴图（截图）或粘贴聊天记录要求「提 bug / 提需求 / 提工单」时'), 'PERSONA 缺少提单路由');
  assert.ok(persona.includes('从贴入内容提取证据直接生成 ONES 工作项待确认草稿（confirm_write）'), 'PERSONA 缺少 confirm_write 产出');
  assert.ok(persona.includes('信息足够时不连环追问'), 'PERSONA 缺少自动优先规则');
});
