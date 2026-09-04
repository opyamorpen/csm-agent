/** 统一视觉外壳探针：npx tsx scripts/render-case-figure-shell.mts [outDir] */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { sanitizeCaseSvg } from '../src/workbench/cases.ts';
import { styleCaseFigureSvg } from '../src/workbench/case-figure-shell.ts';

const outDir = process.argv[2] ?? 'scripts/.probe-figure-shell';
mkdirSync(outDir, { recursive: true });
const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 480">'
  + '<rect x="36" y="58" width="200" height="64" rx="8" fill="#FCE9E7" stroke="#F0605C" stroke-width="2"/>'
  + '<text x="136" y="96" font-size="18" text-anchor="middle" fill="#1F2329">流程节点</text>'
  + '<path d="M236 90 H 390" stroke="#F0605C" stroke-width="3"/>'
  + '<rect x="390" y="58" width="200" height="64" rx="8" fill="#E6F6EB" stroke="#2FBE72" stroke-width="2"/>'
  + '<text x="490" y="96" font-size="18" text-anchor="middle" fill="#1F2329">完成节点</text></svg>';
const clean = sanitizeCaseSvg(source);
if (!clean) throw new Error('probe source SVG rejected');
for (const kind of ['flow_current', 'flow_target', 'milestone'] as const) {
  const svg = styleCaseFigureSvg({ kind, svg: clean, caption: kind });
  if (!svg || !sanitizeCaseSvg(svg)) throw new Error(`${kind} shell rejected`);
  writeFileSync(`${outDir}/${kind}.svg`, svg);
  writeFileSync(`${outDir}/${kind}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: 'PingFang SC' }, background: 'rgba(255,255,255,1)' }).render().asPng());
}
console.log(`rendered ${outDir}/flow_current.png, ${outDir}/flow_target.png, ${outDir}/milestone.png`);

