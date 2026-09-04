/**
 * 案例配图·痛点-方案-价值全景图（value_map）。
 * 模型只提供痛点与价值内容，服务端固定绘制三分区，并为 capability_map 预留可替换的方案内容槽位。
 */

export interface ValueMapItem {
  title: string;
  detail: string;
}

export interface ValueMapBlueprint {
  painPoints: ValueMapItem[];
  values: ValueMapItem[];
}

export type ValueMapBlueprintParse = { blueprint: ValueMapBlueprint } | { error: string };

export const VALUE_MAP_LIMITS = {
  minItems: 3,
  maxItems: 5,
  titleWidthEm: 14,
  detailWidthEm: 34,
  detailMaxLines: 5,
} as const;

export const VALUE_MAP_PALETTE = {
  pain: '#F04438',
  painTint: '#FFF4F2',
  value: '#2467EC',
  panel: '#F3F8FE',
  support: '#E8F1FD',
  border: '#C8D9EE',
  text: '#1F2329',
  muted: '#5B6675',
  white: '#FFFFFF',
} as const;

const widthEm = (text: string): number => [...text].reduce((sum, char) => {
  const code = char.charCodeAt(0);
  if (code >= 0x2E80) return sum + 1;
  if (/[MWmw]/.test(char)) return sum + 0.9;
  if (/[iljI.,:;'!|()[\]{}]/.test(char)) return sum + 0.35;
  return sum + 0.62;
}, 0);

const clean = (value: unknown): string | null =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || null : null;

/** 结构校验：去重与轻微超量裁剪，数量不足/不对齐/超宽/禁区词交给重试反馈。 */
export function parseValueMapBlueprint(value: unknown, opts: { textGuard?: (text: string) => string | null } = {}): ValueMapBlueprintParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'value_map blueprint 不是对象' };
  const raw = value as Record<string, unknown>;
  const errors: string[] = [];
  const push = (message: string) => { if (errors.length < 5) errors.push(message); };
  const parseItems = (key: 'painPoints' | 'values'): ValueMapItem[] => {
    const rawItems = Array.isArray(raw[key]) ? raw[key] : [];
    const items: ValueMapItem[] = [];
    const seen = new Set<string>();
    for (const [index, item] of rawItems.entries()) {
      if (items.length >= VALUE_MAP_LIMITS.maxItems) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { push(`${key}[${index}] 不是对象`); continue; }
      const entry = item as Record<string, unknown>;
      const title = clean(entry.title);
      const detail = clean(entry.detail);
      if (!title || !detail) { push(`${key}[${index}] 须包含非空 title/detail`); continue; }
      if (widthEm(title) > VALUE_MAP_LIMITS.titleWidthEm) push(`${key}[${index}].title 超过 ${VALUE_MAP_LIMITS.titleWidthEm} 字宽`);
      if (widthEm(detail) > VALUE_MAP_LIMITS.detailWidthEm) push(`${key}[${index}].detail 超过 ${VALUE_MAP_LIMITS.detailWidthEm} 字宽`);
      const guardedTitle = opts.textGuard?.(title);
      const guardedDetail = opts.textGuard?.(detail);
      if (guardedTitle) push(`${key}[${index}].title 含内部信息「${guardedTitle}」`);
      if (guardedDetail) push(`${key}[${index}].detail 含内部信息「${guardedDetail}」`);
      if (seen.has(title)) continue;
      seen.add(title);
      items.push({ title, detail });
    }
    if (items.length < VALUE_MAP_LIMITS.minItems) push(`${key} 数量须为 ${VALUE_MAP_LIMITS.minItems}~${VALUE_MAP_LIMITS.maxItems} 条（实际 ${items.length}）`);
    return items;
  };
  const painPoints = parseItems('painPoints');
  const values = parseItems('values');
  if (painPoints.length !== values.length) push(`painPoints 与 values 数量必须相等（实际 ${painPoints.length}/${values.length}）`);
  if (errors.length) return { error: errors.join('；') };
  return { blueprint: { painPoints, values } };
}

const esc = (text: string): string => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] as string));

const charWidth = (char: string): number => {
  const code = char.charCodeAt(0);
  if (code >= 0x2E80) return 1;
  if (/[MWmw]/.test(char)) return 0.9;
  if (/[iljI.,:;'!|()[\]{}]/.test(char)) return 0.35;
  return 0.62;
};

const textWidth = (text: string, fontSize: number): number => [...text].reduce((sum, char) => sum + charWidth(char) * fontSize, 0);

function wrapMeasured(text: string, maxWidth: number, fontSize: number): string[] {
  const tokens: string[] = [];
  for (const char of text) {
    if (/[A-Za-z0-9_.%+\-/]/.test(char) && tokens.length && /[A-Za-z0-9_.%+\-/]$/.test(tokens[tokens.length - 1])) tokens[tokens.length - 1] += char;
    else tokens.push(char);
  }
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current && textWidth(current + token, fontSize) > maxWidth) { lines.push(current); current = token; }
    else current += token;
  }
  if (current) lines.push(current);
  if (lines.length > 1 && [...lines.at(-1) ?? ''].length === 1 && [...lines.at(-2) ?? ''].length > 3) {
    const previous = [...lines[lines.length - 2]];
    const moved = previous.pop()!;
    if (textWidth(moved + lines.at(-1)!, fontSize) <= maxWidth) lines.splice(lines.length - 2, 2, previous.join(''), moved + lines.at(-1));
  }
  return lines.length ? lines : [''];
}

function textBlock(parts: string[], text: string, x: number, centerY: number, width: number, size: number, color: string,
  weight = 'normal', maxLines = 3, lineHeight = Math.round(size * 1.25)): void {
  const lines = wrapMeasured(text, width, size).slice(0, maxLines);
  const firstY = centerY - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines.map((line, index) => index === 0 ? `<tspan x="${x}">${esc(line)}</tspan>` : `<tspan x="${x}" dy="${lineHeight}">${esc(line)}</tspan>`).join('');
  parts.push(`<text x="${x}" y="${firstY}" text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${color}">${tspans}</text>`);
}

const CANVAS_W = 1440;
const CANVAS_H = 720;
const MARGIN = 24;
const TOP = { x: 24, y: 24, w: 1392, h: 160 };
const LEFT = { x: 24, y: 208, w: 988, h: 488 };
const RIGHT = { x: 1030, y: 208, w: 386, h: 488 };

/** 固定三分区渲染；solutionFigureSvg 由外层编排在生成完成后注入。 */
export function renderValueMapSvg(blueprint: ValueMapBlueprint): string | null {
  const count = blueprint.painPoints.length;
  if (count < VALUE_MAP_LIMITS.minItems || count > VALUE_MAP_LIMITS.maxItems || blueprint.values.length !== count) return null;
  const parts: string[] = [];
  const painGap = 14;
  const painW = (TOP.w - 40 - painGap * (count - 1)) / count;
  parts.push(`<rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${VALUE_MAP_PALETTE.white}"/>`);
  parts.push(`<rect x="${TOP.x}" y="${TOP.y}" width="${TOP.w}" height="${TOP.h}" rx="12" fill="${VALUE_MAP_PALETTE.painTint}" stroke="${VALUE_MAP_PALETTE.pain}" stroke-width="2" stroke-dasharray="10 7"/>`);
  parts.push(`<rect x="${CANVAS_W / 2 - 92}" y="${TOP.y - 16}" width="184" height="40" rx="6" fill="${VALUE_MAP_PALETTE.pain}"/>`);
  textBlock(parts, '痛点及挑战', CANVAS_W / 2, TOP.y + 4, 170, 22, VALUE_MAP_PALETTE.white, 'bold', 1);
  for (const [index, item] of blueprint.painPoints.entries()) {
    const x = TOP.x + 20 + index * (painW + painGap);
    const y = TOP.y + 34;
    const h = TOP.h - 44;
    parts.push(`<rect x="${x}" y="${y}" width="${painW}" height="${h}" rx="8" fill="${VALUE_MAP_PALETTE.white}" stroke="${VALUE_MAP_PALETTE.pain}" stroke-width="1.5"/>`);
    parts.push(`<rect x="${x + 8}" y="${y + 8}" width="${painW - 16}" height="34" rx="5" fill="${VALUE_MAP_PALETTE.pain}"/>`);
    textBlock(parts, `${index + 1}. ${item.title}`, x + painW / 2, y + 25, painW - 30, 16, VALUE_MAP_PALETTE.white, 'bold', 2, 18);
    textBlock(parts, item.detail, x + painW / 2, y + 77, painW - 30, 14, VALUE_MAP_PALETTE.text, 'normal', 3, 18);
  }

  parts.push(`<rect x="${LEFT.x}" y="${LEFT.y}" width="${LEFT.w}" height="${LEFT.h}" rx="12" fill="${VALUE_MAP_PALETTE.panel}" stroke="${VALUE_MAP_PALETTE.value}" stroke-width="2" stroke-dasharray="10 7"/>`);
  parts.push(`<rect x="${LEFT.x + LEFT.w / 2 - 52}" y="${LEFT.y - 16}" width="104" height="40" rx="6" fill="${VALUE_MAP_PALETTE.value}"/>`);
  textBlock(parts, '方案', LEFT.x + LEFT.w / 2, LEFT.y + 4, 80, 22, VALUE_MAP_PALETTE.white, 'bold', 1);
  parts.push(`<g id="value-map-solution-content"><text x="${LEFT.x + LEFT.w / 2}" y="${LEFT.y + LEFT.h / 2 + 7}" text-anchor="middle" font-size="20" fill="${VALUE_MAP_PALETTE.muted}">方案详见业务解决方案图</text></g>`);

  parts.push(`<rect x="${RIGHT.x}" y="${RIGHT.y}" width="${RIGHT.w}" height="${RIGHT.h}" rx="12" fill="${VALUE_MAP_PALETTE.support}" stroke="${VALUE_MAP_PALETTE.value}" stroke-width="2" stroke-dasharray="10 7"/>`);
  parts.push(`<rect x="${RIGHT.x + RIGHT.w / 2 - 52}" y="${RIGHT.y - 16}" width="104" height="40" rx="6" fill="${VALUE_MAP_PALETTE.value}"/>`);
  textBlock(parts, '价值', RIGHT.x + RIGHT.w / 2, RIGHT.y + 4, 80, 22, VALUE_MAP_PALETTE.white, 'bold', 1);
  const valueGap = 10;
  const cardH = (RIGHT.h - 78 - valueGap * (count - 1)) / count;
  if (cardH < 66) return null;
  for (const [index, item] of blueprint.values.entries()) {
    const x = RIGHT.x + 16;
    const y = RIGHT.y + 54 + index * (cardH + valueGap);
    parts.push(`<rect x="${x}" y="${y}" width="${RIGHT.w - 32}" height="${cardH}" rx="7" fill="${VALUE_MAP_PALETTE.white}" stroke="${VALUE_MAP_PALETTE.value}" stroke-width="1.2"/>`);
    parts.push(`<rect x="${x}" y="${y}" width="${RIGHT.w - 32}" height="34" rx="7" fill="${VALUE_MAP_PALETTE.value}"/>`);
    textBlock(parts, `${index + 1}. ${item.title}`, x + (RIGHT.w - 32) / 2, y + 17, RIGHT.w - 54, 16, VALUE_MAP_PALETTE.white, 'bold', 2, 16);
    textBlock(parts, item.detail, x + (RIGHT.w - 32) / 2, y + 54, RIGHT.w - 54, 14, VALUE_MAP_PALETTE.text, 'normal', VALUE_MAP_LIMITS.detailMaxLines, 17);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" font-family="PingFang SC, Microsoft YaHei, sans-serif">${parts.join('')}</svg>`;
}

export function injectValueMapSolutionSvg(svg: string, solutionSvg: string | null): string | null {
  const rootEnd = svg.indexOf('>');
  const closing = svg.lastIndexOf('</svg>');
  if (rootEnd < 0 || closing <= rootEnd || !svg.includes('id="value-map-solution-content"')) return null;
  const inner = solutionSvg ? (() => {
    const sourceRootEnd = solutionSvg.indexOf('>');
    const sourceClosing = solutionSvg.lastIndexOf('</svg>');
    const viewBox = solutionSvg.match(/viewBox=["']([^"']+)["']/)?.[1];
    if (sourceRootEnd < 0 || sourceClosing <= sourceRootEnd || !viewBox) return '';
    return `<svg x="64" y="240" width="908" height="424" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${solutionSvg.slice(sourceRootEnd + 1, sourceClosing)}</svg>`;
  })() : `<text x="518" y="458" text-anchor="middle" font-size="20" fill="${VALUE_MAP_PALETTE.muted}">方案详见业务解决方案图</text>`;
  return svg.replace(/<g id="value-map-solution-content">[\s\S]*?<\/g>/, `<g id="value-map-solution-content">${inner}</g>`);
}
