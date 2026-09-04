/**
 * 案例配图·方案价值图（value_map）——痛点/方案/价值左中右三分区（v17）。
 *
 * 模型只提供痛点与价值内容；画布高度按「中间栏嵌入的解决方案架构图」与左右列表自然高度
 * 动态取最大值（以架构图为锚对齐整体比例，消除上下留白）；痛点第 i 行与价值第 i 行共用
 * 行高、水平对齐（一一对位的视觉映射）；色块内条目整体垂直居中；措辞词库服务端校验
 * （痛点标题含负向词、价值标题含正向词，违规反馈重试）。
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
  detailMaxLines: 4,
} as const;

/** 痛点标题必含的负向语义词（任一命中即可；同时写进 prompt 供模型第一轮即达标）。 */
export const VALUE_MAP_PAIN_TITLE_WORDS = ['割裂', '不通', '效率低', '低效', '无法', '滞后', '分散', '重复', '难追溯', '依赖人工', '不透明', '孤岛', '不畅', '失控', '断层'] as const;
/** 价值标题必含的正向语义词（任一命中即可）。 */
export const VALUE_MAP_VALUE_TITLE_WORDS = ['提升', '加强', '有效', '贯通', '实现', '可控', '透明', '高效', '自动', '统一', '可追溯', '实时', '规范', '沉淀', '协同'] as const;

const PAIN_TITLE_PATTERN = new RegExp(VALUE_MAP_PAIN_TITLE_WORDS.join('|'));
const VALUE_TITLE_PATTERN = new RegExp(VALUE_MAP_VALUE_TITLE_WORDS.join('|'));

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

/** 三分区几何（v17 动态高度）：列宽/横距固定，列高与画布高按内容推导，两端共用同一套常量。
 * pillZone/colBottom 取 36/28——标题牌骑边占列内 ~24px，两值接近让列表居中后的上下视觉留白均衡。 */
export const VALUE_MAP_GEOMETRY = {
  canvasW: 1440,
  colY: 32,
  bottomPad: 24,
  /** 列顶部预留给标题牌的区域（牌体骑在列框上缘）。 */
  pillZone: 36,
  colBottom: 28,
  painX: 24,
  painW: 300,
  solutionX: 340,
  solutionW: 760,
  valueX: 1116,
  valueW: 300,
  embedW: 744,
  /** 解决方案架构图（capability_map 恒 1440×720）按 embedW 宽嵌入后的高度。 */
  defaultEmbedH: 372,
  titleBandH: 34,
  rowGap: 10,
  minRowH: 86,
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

/** 结构校验：去重与轻微超量裁剪，数量不足/不对齐/超宽/措辞词库/禁区词交给重试反馈。 */
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
      if (key === 'painPoints' && !PAIN_TITLE_PATTERN.test(title)) {
        push(`painPoints[${index}].title「${title}」须体现痛点负向措辞（含 ${VALUE_MAP_PAIN_TITLE_WORDS.slice(0, 6).join('/')} 等任一词，如「数据割裂」「进度无法追踪」），不要只描述现状`);
      }
      if (key === 'values' && !VALUE_TITLE_PATTERN.test(title)) {
        push(`values[${index}].title「${title}」须体现价值正向措辞（含 ${VALUE_MAP_VALUE_TITLE_WORDS.slice(0, 6).join('/')} 等任一词，如「数据贯通」「效率提升」）`);
      }
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
    // 行首标点防御：全角标点吸附到前一 token，避免换行后以 ，。；等开头（vision 验收真实案例的排版瑕疵）。
    if (/[，。；、！？：）」』]/.test(char) && tokens.length) tokens[tokens.length - 1] += char;
    else if (/[A-Za-z0-9_.%+\-/]/.test(char) && tokens.length && /[A-Za-z0-9_.%+\-/]$/.test(tokens[tokens.length - 1])) tokens[tokens.length - 1] += char;
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

const G = VALUE_MAP_GEOMETRY;
const PAIN_DETAL_FONT = 14;
const PAIN_DETAIL_LH = 18;
const VALUE_DETAIL_LH = 17;

/** 嵌入区（与 injectValueMapSolutionSvg 同一口径：从画布高反推，两侧几何必须一致）。 */
const embedAreaOf = (canvasH: number) => {
  const colH = canvasH - G.colY - G.bottomPad;
  return { x: G.solutionX + 8, y: G.colY + G.pillZone, w: G.embedW, h: colH - G.pillZone - G.colBottom };
};

/**
 * 三分区渲染（v17）：画布高 = colY + max(中间栏需求高, 左右列表自然高) + bottomPad。
 * 行高 = max(该行痛点需求, 该行价值需求, minRowH)，两侧行高一致 → 第 i 行痛点与第 i 行价值
 * 水平对齐；列表整列与中间嵌入图各自在列内垂直居中。
 */
export function renderValueMapSvg(blueprint: ValueMapBlueprint): string | null {
  const count = blueprint.painPoints.length;
  if (count < VALUE_MAP_LIMITS.minItems || count > VALUE_MAP_LIMITS.maxItems || blueprint.values.length !== count) return null;
  const p = VALUE_MAP_PALETTE;

  const painDetailLines = blueprint.painPoints.map((item) => wrapMeasured(item.detail, G.painW - 60, PAIN_DETAL_FONT).slice(0, VALUE_MAP_LIMITS.detailMaxLines).length);
  const valueDetailLines = blueprint.values.map((item) => wrapMeasured(item.detail, G.valueW - 60, PAIN_DETAL_FONT).slice(0, VALUE_MAP_LIMITS.detailMaxLines).length);
  const rowHeights = blueprint.painPoints.map((_item, index) => Math.max(
    G.titleBandH + 6 + painDetailLines[index] * PAIN_DETAIL_LH + 14,
    G.titleBandH + 6 + valueDetailLines[index] * VALUE_DETAIL_LH + 14,
    G.minRowH,
  ));
  const listNeed = G.pillZone + rowHeights.reduce((sum, h) => sum + h, 0) + G.rowGap * (count - 1) + G.colBottom;
  const colH = Math.max(G.pillZone + G.defaultEmbedH + G.colBottom, listNeed);
  const canvasH = G.colY + colH + G.bottomPad;
  const listOffset = Math.max(0, (colH - listNeed) / 2);

  const parts: string[] = [];
  parts.push(`<rect width="${G.canvasW}" height="${canvasH}" fill="${p.white}"/>`);

  // 痛点列（左）。标题带固定在卡顶（左右两列跨色带完全水平对齐，行映射一眼可见），
  // detail 在带下方剩余空间内垂直居中。
  parts.push(`<rect x="${G.painX}" y="${G.colY}" width="${G.painW}" height="${colH}" rx="12" fill="${p.painTint}" stroke="${p.pain}" stroke-width="2" stroke-dasharray="10 7"/>`);
  parts.push(`<rect x="${G.painX + G.painW / 2 - 92}" y="${G.colY - 16}" width="184" height="40" rx="6" fill="${p.pain}"/>`);
  textBlock(parts, '痛点及挑战', G.painX + G.painW / 2, G.colY + 4, 170, 22, p.white, 'bold', 1);
  const painCardW = G.painW - 32;
  for (const [index, item] of blueprint.painPoints.entries()) {
    const rowY = G.colY + G.pillZone + listOffset + rowHeights.slice(0, index).reduce((sum, h) => sum + h + G.rowGap, 0);
    const cardH = rowHeights[index];
    const x = G.painX + 16;
    parts.push(`<rect x="${x}" y="${rowY}" width="${painCardW}" height="${cardH}" rx="8" fill="${p.white}" stroke="${p.pain}" stroke-width="1.5"/>`);
    parts.push(`<rect x="${x + 8}" y="${rowY + 8}" width="${painCardW - 16}" height="${G.titleBandH}" rx="5" fill="${p.pain}"/>`);
    textBlock(parts, `${index + 1}. ${item.title}`, x + painCardW / 2, rowY + 8 + G.titleBandH / 2 + 1, painCardW - 30, 16, p.white, 'bold', 2, 18);
    const areaTop = rowY + 8 + G.titleBandH + 6;
    const areaBottom = rowY + cardH - 6;
    textBlock(parts, item.detail, x + painCardW / 2, (areaTop + areaBottom) / 2, painCardW - 30, PAIN_DETAL_FONT, p.text, 'normal', VALUE_MAP_LIMITS.detailMaxLines, PAIN_DETAIL_LH);
  }

  // 方案列（中，嵌入区占位；capability_map 完成后由 injectValueMapSolutionSvg 注入）。
  parts.push(`<rect x="${G.solutionX}" y="${G.colY}" width="${G.solutionW}" height="${colH}" rx="12" fill="${p.panel}" stroke="${p.value}" stroke-width="2" stroke-dasharray="10 7"/>`);
  parts.push(`<rect x="${G.solutionX + G.solutionW / 2 - 52}" y="${G.colY - 16}" width="104" height="40" rx="6" fill="${p.value}"/>`);
  textBlock(parts, '方案', G.solutionX + G.solutionW / 2, G.colY + 4, 80, 22, p.white, 'bold', 1);
  const area = embedAreaOf(canvasH);
  parts.push(`<g id="value-map-solution-content"><text x="${area.x + area.w / 2}" y="${area.y + area.h / 2 + 7}" text-anchor="middle" font-size="20" fill="${p.muted}">方案详见解决方案架构图</text></g>`);

  // 价值列（右）。
  parts.push(`<rect x="${G.valueX}" y="${G.colY}" width="${G.valueW}" height="${colH}" rx="12" fill="${p.support}" stroke="${p.value}" stroke-width="2" stroke-dasharray="10 7"/>`);
  parts.push(`<rect x="${G.valueX + G.valueW / 2 - 52}" y="${G.colY - 16}" width="104" height="40" rx="6" fill="${p.value}"/>`);
  textBlock(parts, '价值', G.valueX + G.valueW / 2, G.colY + 4, 80, 22, p.white, 'bold', 1);
  for (const [index, item] of blueprint.values.entries()) {
    const rowY = G.colY + G.pillZone + listOffset + rowHeights.slice(0, index).reduce((sum, h) => sum + h + G.rowGap, 0);
    const cardH = rowHeights[index];
    const x = G.valueX + 16;
    parts.push(`<rect x="${x}" y="${rowY}" width="${G.valueW - 32}" height="${cardH}" rx="7" fill="${p.white}" stroke="${p.value}" stroke-width="1.2"/>`);
    parts.push(`<rect x="${x + 6}" y="${rowY + 8}" width="${G.valueW - 44}" height="${G.titleBandH}" rx="5" fill="${p.value}"/>`);
    textBlock(parts, `${index + 1}. ${item.title}`, x + (G.valueW - 32) / 2, rowY + 8 + G.titleBandH / 2 + 1, G.valueW - 54, 16, p.white, 'bold', 2, 16);
    const areaTop = rowY + 8 + G.titleBandH + 6;
    const areaBottom = rowY + cardH - 6;
    textBlock(parts, item.detail, x + (G.valueW - 32) / 2, (areaTop + areaBottom) / 2, G.valueW - 54, PAIN_DETAL_FONT, p.text, 'normal', VALUE_MAP_LIMITS.detailMaxLines, VALUE_DETAIL_LH);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${G.canvasW} ${canvasH}" font-family="PingFang SC, Microsoft YaHei, sans-serif">${parts.join('')}</svg>`;
}

/**
 * 注入解决方案架构图（capability_map 已消毒 SVG）到方案列槽位。嵌入区几何与
 * renderValueMapSvg 的 embedAreaOf 同源（由画布高反推），等比 meet 居中。
 */
export function injectValueMapSolutionSvg(svg: string, solutionSvg: string | null): string | null {
  const rootEnd = svg.indexOf('>');
  const closing = svg.lastIndexOf('</svg>');
  if (rootEnd < 0 || closing <= rootEnd || !svg.includes('id="value-map-solution-content"')) return null;
  const viewBoxMatch = svg.slice(0, rootEnd + 1).match(/viewBox=["']([^"']+)["']/);
  const canvasH = Number(viewBoxMatch?.[1]?.trim().split(/\s+/)[3]);
  if (!Number.isFinite(canvasH) || canvasH <= 0) return null;
  const area = embedAreaOf(canvasH);
  const inner = solutionSvg ? (() => {
    const sourceRootEnd = solutionSvg.indexOf('>');
    const sourceClosing = solutionSvg.lastIndexOf('</svg>');
    const viewBox = solutionSvg.match(/viewBox=["']([^"']+)["']/)?.[1];
    if (sourceRootEnd < 0 || sourceClosing <= sourceRootEnd || !viewBox) return '';
    return `<svg x="${area.x}" y="${area.y}" width="${area.w}" height="${area.h}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${solutionSvg.slice(sourceRootEnd + 1, sourceClosing)}</svg>`;
  })() : `<text x="${area.x + area.w / 2}" y="${area.y + area.h / 2 + 7}" text-anchor="middle" font-size="20" fill="${VALUE_MAP_PALETTE.muted}">方案详见解决方案架构图</text>`;
  return svg.replace(/<g id="value-map-solution-content">[\s\S]*?<\/g>/, `<g id="value-map-solution-content">${inner}</g>`);
}
