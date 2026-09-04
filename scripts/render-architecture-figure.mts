/**
 * 架构图模板探针：graph JSON → renderArchitectureSvg → SVG + PNG（resvg 栅格化，须在 repo 内跑）。
 * 用法：npx tsx scripts/render-architecture-figure.mts <graph.json> [out.png]
 * 不带参数时渲染内置夹具（n1 图 A 真实内容 / n3 / n7）到 scripts/.probe/ 下，供视觉迭代对照示例图。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArchitectureSvg, parseArchitectureGraph, type ArchitectureGraph } from '../src/workbench/case-architecture-figure.ts';
import { Resvg } from '@resvg/resvg-js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function rasterize(svg: string, outPng: string): void {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1440 },
    font: { loadSystemFonts: true, defaultFontFamily: 'PingFang SC' },
    background: 'rgba(255,255,255,1)',
  });
  writeFileSync(outPng, resvg.render().asPng());
}

function renderFixture(name: string, graph: ArchitectureGraph): void {
  const outDir = join(repoRoot, 'scripts', '.probe');
  mkdirSync(outDir, { recursive: true });
  const svg = renderArchitectureSvg(graph);
  if (!svg) throw new Error(`${name}: 渲染几何超限`);
  writeFileSync(join(outDir, `${name}.svg`), svg);
  rasterize(svg, join(outDir, `${name}.png`));
  console.log(`${name}: ${svg.length} chars → ${join(outDir, `${name}.png`)}`);
}

/** 图 A 真实内容（回归夹具）：OA 系统 3 模块 ↔ ONES 4 模块、3 条流。 */
const FIXTURE_N1: ArchitectureGraph = {
  systems: [{ id: 'oa', name: 'OA 系统', modules: ['单点认证', '通讯录用户目录', '需求收集入口'] }],
  hubModules: ['用户与组织架构', '流程自动化', '需求管理', '权限管理'],
  flows: [
    { from: 'oa', to: 'ones', label: '认证信息回传', steps: [{ text: '统一认证登录，认证信息回传建立账号映射', fields: ['账号ID'] }] },
    { from: 'oa', to: 'ones', label: '同步用户部门', steps: [{ text: '全量同步用户与部门到组织架构', fields: ['用户ID', '部门ID'] }] },
    { from: 'oa', to: 'ones', label: '提交需求', steps: [{ text: 'H5 链接直达需求收集入口提交需求' }] },
  ],
};

const FIXTURE_N3: ArchitectureGraph = {
  systems: [
    { id: 'erp', name: 'ERP 系统', modules: ['物料主数据', 'BOM 清单', '工单管理', '成本核算'] },
    { id: 'ehr', name: 'EHR 系统', modules: ['组织架构', '员工档案'] },
    { id: 'oa', name: 'OA 系统', modules: ['流程审批', '统一待办'] },
  ],
  hubModules: ['项目集管理', '工时管理', '需求管理', '测试管理', '效能度量'],
  flows: [
    { from: 'erp', to: 'ones', label: '物料成本', steps: [{ text: '物料与项目成本信息关联核算', fields: ['项目ID', '物料ID'] }] },
    { from: 'ehr', to: 'ones', label: '组织同步', steps: [{ text: '组织架构与人员信息全量同步', fields: ['用户ID', '部门ID'] }] },
    { from: 'oa', to: 'ones', label: '审批联动', steps: [{ text: '审批通过后自动创建需求与任务' }] },
    { from: 'ones', to: 'oa', label: '待办推送', steps: [{ text: '任务分配与到期提醒推送统一待办' }] },
  ],
};

/** n6 压力夹具（v17：上限 6 系统，左右各 3；模块按列预算由模板截断）。 */
const FIXTURE_N6: ArchitectureGraph = {
  systems: [
    { id: 'erp', name: 'ERP 系统', modules: ['物料主数据', '采购订单', '工单管理', '成本核算'] },
    { id: 'crm', name: 'CRM 系统', modules: ['客户管理', '商机管理', '合同管理', '报价管理'] },
    { id: 'ehr', name: 'EHR 系统', modules: ['组织架构', '员工档案', '考勤管理'] },
    { id: 'pdm', name: 'PDM 系统', modules: ['产品文档', '图纸管理', '变更管理'] },
    { id: 'oa', name: 'OA 系统', modules: ['流程审批', '统一待办', '公告发布'] },
    { id: 'svn', name: 'SVN 系统', modules: [] },
  ],
  hubModules: ['项目管理', '需求管理', '测试管理', '工时管理', '效能度量', '知识库'],
  flows: [
    { from: 'erp', to: 'ones', label: '物料关联', steps: [{ text: '物料与项目信息关联核算成本', fields: ['项目ID', '物料ID'] }] },
    { from: 'crm', to: 'ones', label: '客户商机', steps: [{ text: '客户与商机信息关联项目上下文' }] },
    { from: 'ehr', to: 'ones', label: '组织同步', steps: [{ text: '组织架构与人员全量同步', fields: ['用户ID'] }] },
    { from: 'pdm', to: 'ones', label: '文档挂接', steps: [{ text: '产品文档与需求任务挂接', fields: ['文档ID'] }] },
    { from: 'oa', to: 'ones', label: '审批联动', steps: [{ text: '审批通过自动创建需求与任务' }] },
    { from: 'ones', to: 'oa', label: '待办推送', steps: [{ text: '任务分配与到期提醒推送统一待办' }] },
    { from: 'ones', to: 'svn', label: '代码关联', steps: [{ text: '需求任务关联代码提交记录' }] },
  ],
};

/** n2~n5 布局档夹具（v17：左右两列轮转，2→1+1、3→2+1、4→2+2、5→3+2）。 */
const generatedLayout = (count: number): ArchitectureGraph => ({
  systems: Array.from({ length: count }, (_, index) => ({
    id: `sys${index + 1}`, name: `系统${index + 1}`,
    modules: index % 2 === 0 ? ['用户目录', '业务数据', '状态同步', '接口配置'] : ['组织架构', '审批流程'],
  })),
  hubModules: ['项目管理', '需求管理', '测试管理', '工时管理', '效能度量', '知识库'],
  flows: Array.from({ length: count }, (_, index) => ({
    from: index % 2 === 0 ? `sys${index + 1}` : 'ones',
    to: index % 2 === 0 ? 'ones' : `sys${index + 1}`,
    label: index % 2 === 0 ? '推送业务数据' : '输出业务状态',
    steps: [{ text: '业务对象与状态同步', fields: index % 2 ? ['对象ID'] : undefined }],
  })),
});

const [inputPath, outPng] = process.argv.slice(2);
if (inputPath) {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), inputPath), 'utf8'));
  const parsed = parseArchitectureGraph(raw.graph ?? raw);
  if ('error' in parsed) {
    console.error(`graph 校验未通过：${parsed.error}`);
    process.exit(1);
  }
  const svg = renderArchitectureSvg(parsed.graph);
  if (!svg) {
    console.error('渲染几何超限');
    process.exit(1);
  }
  const out = resolve(process.cwd(), outPng ?? inputPath.replace(/\.json$/, '.png'));
  rasterize(svg, out);
  console.log(`→ ${out}`);
} else {
  renderFixture('arch-n1', FIXTURE_N1);
  renderFixture('arch-n3', FIXTURE_N3);
  renderFixture('arch-n6', FIXTURE_N6);
  for (const count of [2, 3, 4, 5]) renderFixture(`arch-gen-n${count}`, generatedLayout(count));
}
