/**
 * 旧式案例配图统一视觉外壳。
 *
 * flow_current、flow_target、milestone 仍由模型提供 SVG 内容；本模块只负责
 * 统一画布背景、标题牌、边框、内边距和常见高饱和颜色，不改变嵌入内容的比例。
 */

export type LegacyCaseFigureKind = 'flow_current' | 'flow_target' | 'milestone';

export const CASE_FIGURE_SHELL_PALETTE = {
  primary: '#2467EC',
  primaryDark: '#1D4FA8',
  panel: '#F3F8FE',
  module: '#D6E7FB',
  border: '#C8D9EE',
  text: '#1F2329',
  muted: '#5B6675',
  arrow: '#9CA3AF',
  white: '#FFFFFF',
} as const;

const TITLE_OF: Record<LegacyCaseFigureKind, string> = {
  flow_current: '现状流程',
  flow_target: '目标流程',
  milestone: '服务里程碑',
};

const NUMERIC_VIEWBOX = /^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/;
const MAX_SOURCE_DIMENSION = 4000;
const MIN_OUTER_WIDTH = 800;
const MIN_OUTER_HEIGHT = 540;
const PAD_X = 24;
const HEADER_H = 56;
const PAD_BOTTOM = 24;

const COLOR_MAP: Record<string, string> = {
  // 现有架构/价值图谱与常见模型主题色 → 统一蓝色层级。
  '#1665D8': CASE_FIGURE_SHELL_PALETTE.primaryDark,
  '#1D4FA8': CASE_FIGURE_SHELL_PALETTE.primaryDark,
  '#2467EC': CASE_FIGURE_SHELL_PALETTE.primary,
  '#D6E7FB': CASE_FIGURE_SHELL_PALETTE.module,
  '#E7F0FB': CASE_FIGURE_SHELL_PALETTE.panel,
  '#F0605C': CASE_FIGURE_SHELL_PALETTE.primary,
  '#D32F2F': CASE_FIGURE_SHELL_PALETTE.primary,
  '#F04438': CASE_FIGURE_SHELL_PALETTE.primary,
  '#E85D9E': CASE_FIGURE_SHELL_PALETTE.primary,
  '#2FBE72': CASE_FIGURE_SHELL_PALETTE.primary,
  '#29A2E6': CASE_FIGURE_SHELL_PALETTE.primary,
  '#0FB5AE': CASE_FIGURE_SHELL_PALETTE.primary,
  '#F6A821': CASE_FIGURE_SHELL_PALETTE.primary,
  '#9A5CD0': CASE_FIGURE_SHELL_PALETTE.primary,
  '#FCE9E7': CASE_FIGURE_SHELL_PALETTE.module,
  '#E6F6EB': CASE_FIGURE_SHELL_PALETTE.module,
  '#E2F3FC': CASE_FIGURE_SHELL_PALETTE.module,
  '#E3F7F6': CASE_FIGURE_SHELL_PALETTE.module,
  '#FFF4E1': CASE_FIGURE_SHELL_PALETTE.module,
  '#F3EBF9': CASE_FIGURE_SHELL_PALETTE.module,
};

const normalizeColor = (value: string): string => COLOR_MAP[value.toUpperCase()] ?? value;

function parseViewBox(svg: string): { minX: number; minY: number; width: number; height: number } | null {
  const openingEnd = svg.indexOf('>');
  if (openingEnd < 0) return null;
  const match = svg.slice(0, openingEnd + 1).match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (!match) return null;
  const values = match[1].match(NUMERIC_VIEWBOX);
  if (!values) return null;
  const [, minX, minY, width, height] = values.map(Number);
  if (![minX, minY, width, height].every(Number.isFinite) || width <= 0 || height <= 0
    || width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION) return null;
  return { minX, minY, width, height };
}

function recolor(svg: string): string {
  return svg.replace(/\b(fill|stroke|stop-color)\s*=\s*(["'])(#[0-9a-fA-F]{6})\2/g,
    (_whole, attr: string, quote: string, color: string) => `${attr}=${quote}${normalizeColor(color)}${quote}`);
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] as string));
}

/**
 * 给旧式模型 SVG 增加统一视觉外壳。输入应为已通过 sanitizeCaseSvg 的 SVG；
 * 适配器本身不依赖 sanitizeCaseSvg，调用方可在结果上再次消毒。
 */
export function styleCaseFigureSvg(input: {
  kind: LegacyCaseFigureKind;
  svg: string;
  caption: string;
}): string | null {
  const source = input.svg.trim();
  if (!source.startsWith('<svg') || !source.endsWith('</svg>')) return null;
  const viewBox = parseViewBox(source);
  if (!viewBox || !input.caption.trim()) return null;
  const title = TITLE_OF[input.kind];
  const outerWidth = Math.max(MIN_OUTER_WIDTH, Math.round(viewBox.width + PAD_X * 2));
  const outerHeight = Math.max(MIN_OUTER_HEIGHT, Math.round(viewBox.height + HEADER_H + PAD_BOTTOM));
  const contentW = outerWidth - PAD_X * 2;
  const contentH = outerHeight - HEADER_H - PAD_BOTTOM;
  const titleWidth = Math.max(144, Math.min(260, title.length * 24 + 42));
  const sourceRootEnd = source.indexOf('>');
  const sourceClosing = source.lastIndexOf('</svg>');
  if (sourceRootEnd < 0 || sourceClosing <= sourceRootEnd) return null;
  const sourceInner = recolor(source.slice(sourceRootEnd + 1, sourceClosing));
  const titleX = (outerWidth - titleWidth) / 2;
  const titleY = 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outerWidth} ${outerHeight}" font-family="PingFang SC, Microsoft YaHei, sans-serif">`
    + `<rect width="${outerWidth}" height="${outerHeight}" fill="${CASE_FIGURE_SHELL_PALETTE.white}"/>`
    + `<rect x="${PAD_X}" y="${HEADER_H}" width="${contentW}" height="${contentH}" rx="12" fill="${CASE_FIGURE_SHELL_PALETTE.panel}" stroke="${CASE_FIGURE_SHELL_PALETTE.border}" stroke-width="2"/>`
    + `<rect x="${titleX}" y="${titleY}" width="${titleWidth}" height="40" rx="8" fill="${CASE_FIGURE_SHELL_PALETTE.primary}"/>`
    + `<text x="${outerWidth / 2}" y="${titleY + 26}" text-anchor="middle" font-size="22" font-weight="bold" fill="${CASE_FIGURE_SHELL_PALETTE.white}">${escapeText(title)}</text>`
    + `<svg id="case-figure-content" x="${PAD_X + 8}" y="${HEADER_H + 8}" width="${contentW - 16}" height="${contentH - 16}" viewBox="${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}" preserveAspectRatio="xMidYMid meet">${sourceInner}</svg>`
    + '</svg>';
}

/* --------------------- 连线沉底 + 白描边保护（v17） --------------------- */

const EDGE_TAGS = new Set(['line', 'path', 'polyline']);
const HALO_COLOR = CASE_FIGURE_SHELL_PALETTE.panel;
const HALO_WIDEN = 6;

interface TopLevelChunk {
  /** 元素原文（含标签）；textRun 为标签外的裸文本片段。 */
  source: string;
  tag: string | null;
  selfClosing: boolean;
  textRun: boolean;
}

/** 从 from 起找 tag 的匹配闭标签结束位置（处理同名嵌套与自闭合；找不到返回 -1）。 */
function findMatchingClose(inner: string, tag: string, from: number): number {
  const tokenPattern = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, 'gi');
  tokenPattern.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(inner)) !== null) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (!match[1]) depth += 1; // 自闭合开标签不进栈
    if (depth === 0) return match.index + match[0].length;
  }
  return -1;
}

/** 把 SVG 内层拆成顶层元素/裸文本块（只拆一层，不递归展开 <g>；嵌套元素保持原样整体搬运）。 */
function splitTopLevelChunks(inner: string): TopLevelChunk[] {
  const chunks: TopLevelChunk[] = [];
  // 属性段用非贪婪：贪婪会把自闭合斜杠吞进属性，`<line .../>` 被当成未闭合开标签而丢弃。
  const tagPattern = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const pushTextRun = (text: string) => {
    if (text.trim()) chunks.push({ source: text, tag: null, selfClosing: false, textRun: true });
  };
  while ((match = tagPattern.exec(inner)) !== null) {
    if (match.index > cursor) pushTextRun(inner.slice(cursor, match.index));
    const [, tag, , selfClose] = match;
    let whole: string;
    if (selfClose) {
      whole = match[0];
    } else {
      const end = findMatchingClose(inner, tag, match.index + match[0].length);
      if (end < 0) break; // 未闭合（非法）：停止拆分，剩余内容按原序保守保留
      whole = inner.slice(match.index, end);
      tagPattern.lastIndex = end;
    }
    chunks.push({ source: whole, tag: tag.toLowerCase(), selfClosing: !!selfClose, textRun: false });
    cursor = tagPattern.lastIndex;
  }
  if (cursor < inner.length) pushTextRun(inner.slice(cursor));
  return chunks;
}

const attrValue = (element: string, name: string): string | null => {
  const match = element.match(new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`));
  return match ? match[1].replace(/^["']|["']$/g, '') : null;
};

const replaceAttr = (element: string, name: string, value: string): string =>
  element.replace(new RegExp(`(\\b${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`), `$1"${value}"`);

/** 边元素判定：line/path/polyline、带非 none 描边、且不含文字子节点（带标签的连线留在原位）。 */
const isEdgeChunk = (chunk: TopLevelChunk): boolean => !chunk.textRun && chunk.tag !== null && EDGE_TAGS.has(chunk.tag)
  && !!attrValue(chunk.source, 'stroke') && attrValue(chunk.source, 'stroke')!.toLowerCase() !== 'none'
  && !/<text\b/i.test(chunk.source);

/** 背景块判定：rect、无描边、面积 ≥ 画布 60%（装饰性小块不算背景）。 */
const isBackgroundChunk = (chunk: TopLevelChunk, canvasArea: number): boolean => {
  if (chunk.textRun || chunk.tag !== 'rect') return false;
  if (attrValue(chunk.source, 'stroke')) return false;
  const w = Number(attrValue(chunk.source, 'width'));
  const h = Number(attrValue(chunk.source, 'height'));
  return Number.isFinite(w) && Number.isFinite(h) && w * h >= canvasArea * 0.6;
};

/** 给边元素生成同几何白描边克隆（无箭头、透明填充，垫在边正下方）。 */
function haloClone(edge: string): string {
  const width = Number(attrValue(edge, 'stroke-width')) || 2;
  let halo = replaceAttr(edge, 'stroke', HALO_COLOR);
  halo = replaceAttr(halo, 'stroke-width', String(width + HALO_WIDEN));
  halo = halo.replace(/\s*(?:marker-end|markerEnd|marker-start|markerStart)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, '');
  halo = /\bfill\s*=/.test(halo) ? replaceAttr(halo, 'fill', 'none') : halo.replace(/<(\w+)/, '<$1 fill="none"');
  if (!/\bstroke-linecap\s*=/.test(halo)) halo = halo.replace(/<(\w+)/, '<$1 stroke-linecap="round"');
  return halo;
}

/**
 * 模型流程图的连线沉底 + 白描边（v17）：把顶层连线元素统一移到所有形状/文字之前绘制，
 * 白底节点自然盖住穿越节点的线段（文字永不被线压）；每条边前垫同几何 halo，开放空间里
 * 贴线文字也有浅底衬托。只搬运顶层元素、不递归展开 <g>（嵌套组合保持模型原序，
 * 残余重叠由 findFigureEdgeTextOverlaps 反馈重试兜底）。结构异常时原样返回，绝不弄丢内容。
 */
export function relayerFigureEdges(svg: string): string {
  const trimmed = svg.trim();
  const rootEnd = trimmed.indexOf('>');
  const closing = trimmed.lastIndexOf('</svg>');
  if (rootEnd < 0 || closing <= rootEnd) return trimmed;
  const viewBox = parseViewBox(trimmed);
  const canvasArea = viewBox ? viewBox.width * viewBox.height : 0;
  const inner = trimmed.slice(rootEnd + 1, closing);
  const chunks = splitTopLevelChunks(inner);
  const edges: string[] = [];
  const backgrounds: string[] = [];
  const rest: string[] = [];
  for (const chunk of chunks) {
    if (!chunk.textRun && chunk.tag === 'defs') { rest.push(chunk.source); continue; } // defs 保持首次出现原位语义，与内容同组搬运
    if (canvasArea > 0 && isBackgroundChunk(chunk, canvasArea)) { backgrounds.push(chunk.source); continue; }
    if (isEdgeChunk(chunk)) { edges.push(chunk.source); continue; }
    rest.push(chunk.source);
  }
  if (!edges.length) return trimmed; // 无边可沉，原样返回（背景块缺失时仍可安全沉底：外壳面板先于模型内容绘制）
  const layered = [...backgrounds, ...edges.flatMap((edge) => [haloClone(edge), edge]), ...rest];
  return `${trimmed.slice(0, rootEnd + 1)}${layered.join('')}${trimmed.slice(closing)}`;
}

/** 估宽（与各渲染器同口径：CJK 1em、宽字母 0.9、窄字符 0.35、其余 0.62）。 */
const estCharWidthEm = (char: string): number => {
  const code = char.charCodeAt(0);
  if (code >= 0x2E80) return 1;
  if (/[MWmw]/.test(char)) return 0.9;
  if (/[iljI.,:;'!|()[\]{}]/.test(char)) return 0.35;
  return 0.62;
};

const estTextWidth = (text: string, fontSize: number): number =>
  fontSize * [...text].reduce((sum, char) => sum + estCharWidthEm(char), 0);

interface Box4 { x0: number; y0: number; x1: number; y1: number }
interface Seg { x1: number; y1: number; x2: number; y2: number }

const segIntersectsBox = (seg: Seg, box: Box4): boolean => {
  const steps = Math.max(2, Math.ceil(Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) / 4));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const px = seg.x1 + (seg.x2 - seg.x1) * t;
    const py = seg.y1 + (seg.y2 - seg.y1) * t;
    if (px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1) return true;
  }
  return false;
};

/**
 * 检出「连线穿过文字包络盒」的位置（反馈重试用，软校验）：line 元素与 path 的 M/L 直线段
 * 逐段对 text 包络盒采样求交；文字若整体落在某个实底 rect 内（节点内标签），穿越视为被
 * 节点遮挡、不算问题。返回如「(120,45)-(210,45) 与文字「提交审批」重叠」的描述清单。
 */
export function findFigureEdgeTextOverlaps(svg: string): string[] {
  const viewBox = parseViewBox(svg);
  if (!viewBox) return [];
  const canvasArea = viewBox.width * viewBox.height;
  const rects: Box4[] = [];
  for (const match of svg.matchAll(/<rect\b([^>]*)>/g)) {
    const attrs = match[1];
    const num = (name: string): number | null => {
      const found = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`));
      const parsed = found ? Number(found[1].replace(/^["']|["']$/g, '')) : NaN;
      return Number.isFinite(parsed) ? parsed : null;
    };
    const x = num('x') ?? 0;
    const y = num('y') ?? 0;
    const w = num('width');
    const h = num('height');
    if (w == null || h == null) continue;
    const fill = (attrs.match(/\bfill\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/)?.[1] ?? '"#000"').replace(/^["']|["']$/g, '');
    if (fill.toLowerCase() === 'none') continue;
    if (canvasArea > 0 && w * h >= canvasArea * 0.6) continue; // 整幅背景不算节点（否则所有文字都"在节点内"）
    rects.push({ x0: x, y0: y, x1: x + w, y1: y + h });
  }
  const segs: Array<{ seg: Seg; label: string }> = [];
  for (const match of svg.matchAll(/<line\b([^>]*)>/g)) {
    const attrs = match[1];
    const num = (name: string) => Number(attrs.match(new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`))?.[1].replace(/^["']|["']$/g, '') ?? NaN);
    const [x1, y1, x2, y2] = [num('x1'), num('y1'), num('x2'), num('y2')];
    if ([x1, y1, x2, y2].every(Number.isFinite)) segs.push({ seg: { x1, y1, x2, y2 }, label: `(${x1},${y1})-(${x2},${y2})` });
  }
  for (const match of svg.matchAll(/<path\b([^>]*)\bd\s*=\s*("[^"]*"|'[^']*')/g)) {
    const d = match[2].replace(/^["']|["']$/g, '');
    const points = [...d.matchAll(/([ML])\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g)].map((m) => ({ cmd: m[1], x: Number(m[2]), y: Number(m[3]) }));
    for (let index = 1; index < points.length; index += 1) {
      if (points[index].cmd !== 'L') continue;
      const a = points[index - 1];
      const b = points[index];
      if ([a.x, a.y, b.x, b.y].every(Number.isFinite)) segs.push({ seg: { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, label: `路径段(${a.x},${a.y})-(${b.x},${b.y})` });
    }
  }
  const overlaps: string[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = match[1];
    const content = match[2].replace(/<[^>]+>/g, '').trim();
    if (!content) continue;
    const x = Number(attrs.match(/\bx\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/)?.[1].replace(/^["']|["']$/g, '') ?? NaN);
    const y = Number(attrs.match(/\by\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/)?.[1].replace(/^["']|["']$/g, '') ?? NaN);
    const fontSize = Number(attrs.match(/\bfont-size\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/)?.[1].replace(/^["']|["']$/g, '') ?? 14);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(fontSize)) continue;
    const width = estTextWidth(decodeText(content), fontSize);
    const anchor = (attrs.match(/\btext-anchor\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/)?.[1].replace(/^["']|["']$/g, '') ?? 'start');
    const cx = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    const box: Box4 = { x0: cx, y0: y - fontSize, x1: cx + width, y1: y + fontSize * 0.35 };
    const insideNode = rects.some((rect) => box.x0 >= rect.x0 && box.x1 <= rect.x1 && box.y0 >= rect.y0 && box.y1 <= rect.y1);
    if (insideNode) continue;
    for (const { seg, label } of segs) {
      if (segIntersectsBox(seg, box)) {
        overlaps.push(`${label} 与文字「${decodeText(content).slice(0, 10)}」重叠`);
        break;
      }
    }
  }
  return overlaps;
}

const decodeText = (text: string): string => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

