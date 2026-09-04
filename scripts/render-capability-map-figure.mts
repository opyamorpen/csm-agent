/** capability_map（解决方案架构图）确定性渲染探针：npx tsx scripts/render-capability-map-figure.mts [outDir]
 * v17：模型契约只含场景矩阵（stages 恒 6~8 + 可选 topBand）；平台支撑固定词表与系统集成清单
 * 由调用方注入（与 cases.ts 生成路径同构），本探针按两种清单形态各出一版样张。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { parseCapabilityMapBlueprint, renderCapabilityMapSvg, type CapabilityMapBlueprint } from '../src/workbench/case-capability-map-figure.ts';
import { ONES_PLATFORM_CAPABILITIES, ONES_STANDARD_INTEGRATIONS } from '../src/workbench/case-ones-knowledge.ts';

const stage = (label: string, module: string, capabilities: string[]) => ({ label, module, capabilities });
const stages = [
  stage('需求收集', 'ONES Project', ['外链表单提报', '自定义必填项', '需求统一入池', '提报记录留痕']),
  stage('登记准入审批', '流程自动化', ['状态发起审批', '登记准入流转', '部门领导背书', '负责人留痕']),
  stage('分析拆分关联', '需求管理', ['拆分敏稳态需求', '双向关联原始需求', '列表快速跳转', '数据权限隔离']),
  stage('纳入年度计划', '项目管理', ['立项审批通过', '纳入年度计划', '标记纳入年份', '进度趋势分析']),
  stage('单点登录同步', 'ONES Account', ['OAuth2 单点认证', '内网账号直登', '组织通讯录同步', '离职账号停用']),
  stage('测试验收', 'ONES TestCase', ['用例覆盖需求', '缺陷闭环回归', '验收报告留痕']),
];
const standard = { topBand: { kind: 'goals' as const, items: ['降低协作成本', '提升交付质量', '加快产品上市'] }, stages };
const dense = { ...standard, stages: [...stages, stage('运营持续改进', 'ONES Performance', ['交付效能分析', '质量趋势分析', '过程效能分析', '仪表盘展示', '多项目对比', '持续优化复盘'])] };

const outDir = process.argv[2] ?? 'tmp/capability-map-figures';
mkdirSync(outDir, { recursive: true });
const variants: Array<[string, CapabilityMapBlueprint]> = [
  ['standard-with-integrations', { ...standard, platformCapabilities: [...ONES_PLATFORM_CAPABILITIES], integrations: ['OA 系统', '统一认证平台', '信宝 APP', '自研业务系统'] }],
  ['standard-standard-integrations', { ...standard, platformCapabilities: [...ONES_PLATFORM_CAPABILITIES], integrations: [...ONES_STANDARD_INTEGRATIONS] }],
  ['dense-with-integrations', { ...dense, platformCapabilities: [...ONES_PLATFORM_CAPABILITIES], integrations: ['OA 系统', '统一认证平台', '信宝 APP', '自研业务系统'] }],
];
for (const [name, blueprint] of variants) {
  const checked = parseCapabilityMapBlueprint(blueprint);
  if (!('blueprint' in checked)) throw new Error(checked.error);
  const merged: CapabilityMapBlueprint = { ...checked.blueprint, platformCapabilities: blueprint.platformCapabilities, integrations: blueprint.integrations };
  const svg = renderCapabilityMapSvg(merged);
  if (!svg) throw new Error(`${name} render failed`);
  writeFileSync(`${outDir}/${name}.svg`, svg);
  writeFileSync(`${outDir}/${name}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 1440 }, font: { loadSystemFonts: true, defaultFontFamily: 'PingFang SC' }, background: 'rgba(255,255,255,1)' }).render().asPng());
}
console.log(`rendered ${outDir}: ${variants.map(([name]) => name).join(', ')}`);
