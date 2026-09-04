/** value_map 确定性渲染探针：npx tsx scripts/render-value-map-figure.mts [outDir] */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { parseValueMapBlueprint, renderValueMapSvg } from '../src/workbench/case-value-map-figure.ts';

const outDir = process.argv[2] ?? 'scripts/.probe-value-map';
mkdirSync(outDir, { recursive: true });
const make = (count: number) => ({
  painPoints: Array.from({ length: count }, (_, i) => ({ title: ['进度信息分散', '质量验收不稳', '资源投入难看清', '变更影响难追踪', '跨部门协同低效'][i], detail: ['项目进展依赖人工汇总，延期风险暴露较晚', '交付标准缺少统一留痕，问题反复沟通', '预算、工时和资源使用缺乏统一视图', '变更影响分散在多处记录，难以及时评估', '跨部门协作依靠多渠道同步，责任边界不清'][i] })),
  values: Array.from({ length: count }, (_, i) => ({ title: ['项目进度可控', '质量要求不跑偏', '资源投入有节奏', '范围变更说得清', '协同责任更清晰'][i], detail: ['排期、工时与实际进展集中呈现，及时调整', '交付标准线上提交与核准，过程记录可追溯', '预算、工时与资源饱和度统一查看，提前调度', '变更基线与影响记录集中管理，差异清晰可见', '协作事项统一分派与留痕，减少重复沟通'][i] })),
});
for (const count of [3, 4, 5]) {
  const parsed = parseValueMapBlueprint(make(count));
  if (!('blueprint' in parsed)) throw new Error(parsed.error);
  const svg = renderValueMapSvg(parsed.blueprint);
  if (!svg) throw new Error(`value-map-${count} render failed`);
  writeFileSync(`${outDir}/value-map-${count}.svg`, svg);
  writeFileSync(`${outDir}/value-map-${count}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 1440 }, font: { loadSystemFonts: true, defaultFontFamily: 'PingFang SC' }, background: 'rgba(255,255,255,1)' }).render().asPng());
}
console.log(`rendered ${outDir}/value-map-3.png, value-map-4.png, value-map-5.png`);
