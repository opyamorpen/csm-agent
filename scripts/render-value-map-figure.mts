/** value_map 确定性渲染探针：npx tsx scripts/render-value-map-figure.mts [outDir] */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { parseValueMapBlueprint, renderValueMapSvg } from '../src/workbench/case-value-map-figure.ts';

const outDir = process.argv[2] ?? 'scripts/.probe-value-map';
mkdirSync(outDir, { recursive: true });
const make = (count: number) => ({
  painPoints: Array.from({ length: count }, (_, i) => ({ title: ['数据不通', '协作不畅', '效率低下', '变更难控', '资源难统筹'][i], detail: ['项目进展依赖人工汇总，延期风险暴露较晚', '交付标准缺少统一留痕，问题反复沟通', '预算、工时和资源使用缺乏统一视图', '变更影响分散在多处记录，难以及时评估', '跨部门协作依靠多渠道同步，责任边界不清'][i] })),
  values: Array.from({ length: count }, (_, i) => ({ title: ['数据贯通', '协作顺畅', '效率提升', '变更可控', '资源配置更优'][i], detail: ['项目进展集中呈现，信息同步及时准确', '交付标准线上提交核准，过程记录可追溯', '预算、工时与资源统一查看，减少人工汇总', '变更基线与影响记录集中管理，差异清晰可见', '协作事项统一分派留痕，资源调度更及时'][i] })),
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
