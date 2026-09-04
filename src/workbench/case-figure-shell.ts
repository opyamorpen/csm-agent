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

