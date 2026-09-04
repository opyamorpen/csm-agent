import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { parseCapabilityMapBlueprint, renderCapabilityMapSvg, type CapabilityMapBlueprint } from '../src/workbench/case-capability-map-figure.ts';

const standard: CapabilityMapBlueprint = {
  topBand: { kind: 'goals', items: ['降低协作成本', '提升交付质量', '加快产品上市'] },
  stages: [
    { label: '需求收集', module: 'ONES Project', capabilities: ['外链表单提报', '自定义必填项', '需求统一入池', '提报记录留痕'] },
    { label: '登记准入审批', module: '流程自动化', capabilities: ['状态发起审批', '登记准入流转', '部门领导背书', '负责人留痕'] },
    { label: '分析拆分关联', module: '需求管理', capabilities: ['拆分敏稳态需求', '双向关联原始需求', '列表快速跳转', '数据权限隔离'] },
    { label: '纳入年度计划', module: '项目管理', capabilities: ['立项审批通过', '纳入年度计划', '标记纳入年份', '进度趋势分析'] },
    { label: '单点登录同步', module: 'ONES Account', capabilities: ['OAuth2 单点认证', '内网账号直登', '组织通讯录同步', '离职账号停用'] },
  ],
  platformCapabilities: [{ title: '统一需求池', detail: '结构化表单汇入' }, { title: '流程自动化', detail: '状态流转与审批' }, { title: '权限管理', detail: '按部门分层管控' }, { title: '私有化部署', detail: '内网环境适配' }],
  integrations: ['OA', '统一认证平台', '信宝 APP', '自研业务系统'],
  assurance: ['精益管理体系', '质量管理规范', '协同设计开发', '过程资产沉淀', '组织机制保障'],
};
const sparse: CapabilityMapBlueprint = { stages: standard.stages.slice(0, 3).map((stage) => ({ ...stage, capabilities: stage.capabilities.slice(0, 2) })) };
const dense: CapabilityMapBlueprint = { ...standard, stages: [...standard.stages, { label: '运营持续改进', module: 'ONES Performance', capabilities: ['交付效能分析', '质量趋势分析', '过程效能分析', '仪表盘展示', '多项目对比', '持续优化复盘'] }], assurance: ['体系保障一', '体系保障二', '体系保障三', '体系保障四', '体系保障五', '体系保障六'] };

const outDir = process.argv[2] ?? 'tmp/capability-map-figures';
mkdirSync(outDir, { recursive: true });
for (const [name, blueprint] of Object.entries({ standard, sparse, dense })) {
  const checked = parseCapabilityMapBlueprint(blueprint);
  if (!('blueprint' in checked)) throw new Error(checked.error);
  const svg = renderCapabilityMapSvg(checked.blueprint);
  if (!svg) throw new Error(`${name} render failed`);
  writeFileSync(`${outDir}/${name}.svg`, svg);
  writeFileSync(`${outDir}/${name}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 1440 }, font: { loadSystemFonts: true, defaultFontFamily: 'PingFang SC' }, background: 'rgba(255,255,255,1)' }).render().asPng());
}
console.log(`rendered ${outDir}/standard.png, sparse.png, dense.png`);
