/**
 * 案例配图·需求场景-产品能力映射图（capability_map）——内容契约解析 + 服务端确定性模板渲染。
 *
 * 模型只负责从案例素材中提取目标/场景、业务阶段、ONES 模块与能力；画布、层级、颜色、
 * 换行和密度由本模块统一控制。这样既保留不同客户的内容差异，也让 Word 与 Web 中的图形
 * 稳定呈现为同一套「分层业务蓝图」。
 */

export type CapabilityTopBandKind = 'goals' | 'core_scenarios';

export interface CapabilityTopBand {
  kind: CapabilityTopBandKind;
  items: string[];
}

export interface CapabilityStage {
  label: string;
  module: string;
  capabilities: string[];
}

export interface CapabilityPlatformItem {
  title: string;
  detail?: string;
}

/**
 * v17：platformCapabilities 与 integrations 不再来自模型——平台支撑由调用方注入
 * ONES_PLATFORM_CAPABILITIES 固定词表，系统集成由调用方注入规划期提取的集成系统清单
 * （空清单时注入 ONES_STANDARD_INTEGRATIONS 标准集成兜底）。assurance（组织保障）已移除。
 */
export interface CapabilityMapBlueprint {
  topBand?: CapabilityTopBand;
  stages: CapabilityStage[];
  platformCapabilities?: CapabilityPlatformItem[];
  integrations?: string[];
}

export type CapabilityMapBlueprintParse = { blueprint: CapabilityMapBlueprint } | { error: string };

export const CAPABILITY_MAP_LIMITS = {
  /** v17：业务场景矩阵恒定 6~8 个阶段（素材不足时模型按能力图谱贴近客户实际补足到 6）。 */
  stagesMin: 6,
  stages: 8,
  stageLabelWidthEm: 10,
  moduleWidthEm: 14,
  capabilitiesMin: 2,
  capabilities: 6,
  capabilityWidthEm: 14,
  topItemsMin: 2,
  topItems: 6,
  topItemWidthEm: 14,
  platformItems: 8,
  platformTitleWidthEm: 12,
  platformDetailWidthEm: 18,
  integrations: 6,
  integrationWidthEm: 14,
} as const;

export const CAPABILITY_MAP_PALETTE = {
  primary: '#2467EC',
  primaryDark: '#1D4FA8',
  module: '#D6E7FB',
  support: '#E8F1FD',
  panel: '#F3F8FE',
  border: '#C8D9EE',
  text: '#1F2329',
  muted: '#5B6675',
  arrow: '#9CA3AF',
  white: '#FFFFFF',
} as const;

const CANVAS_W = 1440;
const CANVAS_H = 720;
const MARGIN = 16;
const ROW_GAP = 10;
const LABEL_W = 148;

const charWidthEm = (char: string): number => {
  const code = char.charCodeAt(0);
  if (code >= 0x2E80) return 1;
  if (/[MWmw]/.test(char)) return 0.9;
  if (/[iljI.,:;'!|()\[\]{}]/.test(char)) return 0.35;
  return 0.62;
};

const textWidth = (text: string, fontSize: number): number =>
  fontSize * [...text].reduce((width, char) => width + charWidthEm(char), 0);

const widthEm = (text: string): number => textWidth(text, 1);

const cleanText = (value: unknown): string | null =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || null : null;

const unique = (items: string[]): string[] => [...new Set(items)];

/**
 * 内容契约校验：重复与轻微超量静默收敛；关键结构、条目不足、超宽与内部信息命中返回
 * 可读错误，供模型下一轮按错误反馈修正。
 */
export function parseCapabilityMapBlueprint(
  value: unknown,
  opts: { textGuard?: (text: string) => string | null } = {},
): CapabilityMapBlueprintParse {
  const guard = opts.textGuard ?? (() => null);
  const errors: string[] = [];
  const push = (message: string) => { if (errors.length < 5) errors.push(message); };
  const guarded = (text: string, where: string) => {
    const label = guard(text);
    if (label) push(`${where} 含内部信息「${label}」`);
  };
  const checked = (raw: unknown, where: string, maxWidth: number): string | null => {
    const text = cleanText(raw);
    if (!text) { push(`${where} 不能为空`); return null; }
    if (widthEm(text) > maxWidth) push(`${where}「${text}」超过 ${maxWidth} 字宽`);
    guarded(text, where);
    return text;
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'blueprint 不是对象' };
  const raw = value as Record<string, unknown>;

  let topBand: CapabilityTopBand | undefined;
  if (raw.topBand != null) {
    if (!raw.topBand || typeof raw.topBand !== 'object' || Array.isArray(raw.topBand)) {
      push('topBand 须为对象或省略');
    } else {
      const entry = raw.topBand as Record<string, unknown>;
      const kind = cleanText(entry.kind);
      if (kind !== 'goals' && kind !== 'core_scenarios') push('topBand.kind 只能是 goals 或 core_scenarios');
      const items = unique((Array.isArray(entry.items) ? entry.items : [])
        .map((item, index) => checked(item, `topBand.items[${index}]`, CAPABILITY_MAP_LIMITS.topItemWidthEm))
        .filter((item): item is string => !!item)).slice(0, CAPABILITY_MAP_LIMITS.topItems);
      if (items.length && items.length < CAPABILITY_MAP_LIMITS.topItemsMin) {
        push(`topBand.items 有内容时至少 ${CAPABILITY_MAP_LIMITS.topItemsMin} 项`);
      }
      if ((kind === 'goals' || kind === 'core_scenarios') && items.length >= CAPABILITY_MAP_LIMITS.topItemsMin) {
        topBand = { kind, items };
      }
    }
  }

  const rawStages = Array.isArray(raw.stages) ? raw.stages : [];
  const stages: CapabilityStage[] = [];
  const stageKeys = new Set<string>();
  for (const [index, item] of rawStages.entries()) {
    if (stages.length >= CAPABILITY_MAP_LIMITS.stages) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { push(`stages[${index}] 不是对象`); continue; }
    const entry = item as Record<string, unknown>;
    const label = checked(entry.label, `stages[${index}].label`, CAPABILITY_MAP_LIMITS.stageLabelWidthEm);
    const module = checked(entry.module, `stages[${index}].module`, CAPABILITY_MAP_LIMITS.moduleWidthEm);
    const capabilities = unique((Array.isArray(entry.capabilities) ? entry.capabilities : [])
      .map((capability, capabilityIndex) => checked(capability, `stages[${index}].capabilities[${capabilityIndex}]`, CAPABILITY_MAP_LIMITS.capabilityWidthEm))
      .filter((capability): capability is string => !!capability)).slice(0, CAPABILITY_MAP_LIMITS.capabilities);
    if (capabilities.length < CAPABILITY_MAP_LIMITS.capabilitiesMin) {
      push(`stages[${index}].capabilities 至少 ${CAPABILITY_MAP_LIMITS.capabilitiesMin} 项`);
    }
    if (!label || !module || capabilities.length < CAPABILITY_MAP_LIMITS.capabilitiesMin) continue;
    const key = `${label}\u0000${module}`;
    if (stageKeys.has(key)) continue;
    stageKeys.add(key);
    stages.push({ label, module, capabilities });
  }
  if (stages.length < CAPABILITY_MAP_LIMITS.stagesMin) {
    push(`stages 去重后须有 ${CAPABILITY_MAP_LIMITS.stagesMin}~${CAPABILITY_MAP_LIMITS.stages} 个（实际 ${stages.length}；素材不足时按 ONES 能力图谱贴近客户业务补足到 ${CAPABILITY_MAP_LIMITS.stagesMin} 个）`);
  }

  if (errors.length) return { error: errors.join('；') };
  return {
    blueprint: {
      ...(topBand ? { topBand } : {}),
      stages,
    },
  };
}

const esc = (text: string): string => text.replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] as string
));

/** ASCII 单词整体换行、CJK 按字换行；末行孤字尽量回补。 */
function wrapMeasured(text: string, maxWidth: number, fontSize: number): string[] {
  const tokens: string[] = [];
  for (const char of text) {
    if (/[A-Za-z0-9_.%+\-/]/.test(char) && tokens.length && /[A-Za-z0-9_.%+\-/]$/.test(tokens[tokens.length - 1])) {
      tokens[tokens.length - 1] += char;
    } else {
      tokens.push(char);
    }
  }
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current && textWidth(current + token, fontSize) > maxWidth) {
      lines.push(current);
      current = token;
    } else {
      current += token;
    }
  }
  if (current) lines.push(current);
  if (lines.length > 1 && [...lines[lines.length - 1]].length === 1 && [...lines[lines.length - 2]].length > 3) {
    const previous = [...lines[lines.length - 2]];
    const moved = previous.pop()!;
    if (textWidth(moved + lines[lines.length - 1], fontSize) <= maxWidth) {
      lines.splice(lines.length - 2, 2, previous.join(''), moved + lines[lines.length - 1]);
    }
  }
  return lines.length ? lines : [''];
}

function textBlock(text: string, x: number, centerY: number, maxWidth: number, fontSize: number,
  color: string, options: { weight?: string; lineHeight?: number; maxLines?: number } = {}): string {
  const lineHeight = options.lineHeight ?? Math.round(fontSize * 1.28);
  const lines = wrapMeasured(text, maxWidth, fontSize).slice(0, options.maxLines ?? 2);
  const firstY = centerY - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines.map((line, index) => index === 0
    ? `<tspan x="${x}">${esc(line)}</tspan>`
    : `<tspan x="${x}" dy="${lineHeight}">${esc(line)}</tspan>`).join('');
  return `<text x="${x}" y="${firstY}" text-anchor="middle" dominant-baseline="middle" font-size="${fontSize}"${options.weight ? ` font-weight="${options.weight}"` : ''} fill="${color}">${tspans}</text>`;
}

interface Density {
  stageFont: number;
  moduleFont: number;
  itemFont: number;
  itemLine: number;
}

function densityOf(blueprint: CapabilityMapBlueprint): Density {
  const maxItems = Math.max(...blueprint.stages.map((stage) => stage.capabilities.length));
  if (blueprint.stages.length <= 6 && maxItems <= 4) return { stageFont: 19, moduleFont: 16, itemFont: 14, itemLine: 18 };
  if (blueprint.stages.length <= 7 && maxItems <= 5) return { stageFont: 18, moduleFont: 15, itemFont: 13, itemLine: 17 };
  return { stageFont: 17, moduleFont: 14, itemFont: 13, itemLine: 16 };
}

function rowLabel(parts: string[], id: string, label: string, x: number, y: number, w: number, h: number): void {
  const p = CAPABILITY_MAP_PALETTE;
  parts.push(`<g id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${p.primary}"/>`);
  parts.push(textBlock(label, x + w / 2, y + h / 2, w - 22, 20, p.white, { weight: 'bold', lineHeight: 24, maxLines: 2 }));
  parts.push('</g>');
}

function bandRow(parts: string[], input: {
  id: string; label: string; items: Array<{ title: string; detail?: string }>;
  x: number; y: number; w: number; h: number;
}): void {
  const p = CAPABILITY_MAP_PALETTE;
  parts.push(`<g id="${input.id}"><rect x="${input.x}" y="${input.y}" width="${input.w}" height="${input.h}" rx="10" fill="${p.support}" stroke="${p.border}"/>`);
  rowLabel(parts, `${input.id}-label`, input.label, input.x + 8, input.y + 8, LABEL_W - 16, input.h - 16);
  const contentX = input.x + LABEL_W + 8;
  const contentW = input.w - LABEL_W - 16;
  const gap = 10;
  const cardW = (contentW - gap * (input.items.length - 1)) / input.items.length;
  for (const [index, item] of input.items.entries()) {
    const cardX = contentX + index * (cardW + gap);
    parts.push(`<rect x="${cardX}" y="${input.y + 8}" width="${cardW}" height="${input.h - 16}" rx="8" fill="${p.white}" stroke="${p.border}"/>`);
    const titleY = item.detail ? input.y + input.h / 2 - 10 : input.y + input.h / 2;
    parts.push(textBlock(item.title, cardX + cardW / 2, titleY, cardW - 18, item.detail ? 15 : 16, p.primaryDark,
      { weight: 'bold', lineHeight: 18, maxLines: item.detail ? 1 : 2 }));
    if (item.detail) parts.push(textBlock(item.detail, cardX + cardW / 2, input.y + input.h / 2 + 15, cardW - 18, 12, p.muted, { maxLines: 1 }));
  }
  parts.push('</g>');
}

/** 固定 1440×720 的自适应分层蓝图（v17：全宽布局，无组织保障侧栏；平台支撑/系统集成由调用方注入恒定内容）。 */
export function renderCapabilityMapSvg(blueprint: CapabilityMapBlueprint): string | null {
  if (blueprint.stages.length < CAPABILITY_MAP_LIMITS.stagesMin || blueprint.stages.length > CAPABILITY_MAP_LIMITS.stages) return null;
  const p = CAPABILITY_MAP_PALETTE;
  const hasTop = !!blueprint.topBand?.items.length;
  const hasPlatform = !!blueprint.platformCapabilities?.length;
  const hasIntegrations = !!blueprint.integrations?.length;
  const contentW = CANVAS_W - MARGIN * 2;
  const topH = hasTop ? 76 : 0;
  const platformH = hasPlatform ? 80 : 0;
  const integrationH = hasIntegrations ? 72 : 0;
  const activeRows = 1 + Number(hasTop) + Number(hasPlatform) + Number(hasIntegrations);
  const mainH = CANVAS_H - MARGIN * 2 - ROW_GAP * (activeRows - 1) - topH - platformH - integrationH;
  if (mainH < 350) return null;

  const parts: string[] = [];
  let y = MARGIN;
  if (hasTop) {
    bandRow(parts, {
      id: 'cap-top',
      label: blueprint.topBand!.kind === 'goals' ? '目标' : '核心场景',
      items: blueprint.topBand!.items.map((title) => ({ title })),
      x: MARGIN, y, w: contentW, h: topH,
    });
    y += topH + ROW_GAP;
  }

  const mainY = y;
  parts.push(`<g id="cap-main"><rect x="${MARGIN}" y="${mainY}" width="${contentW}" height="${mainH}" rx="10" fill="${p.panel}" stroke="${p.border}"/>`);
  rowLabel(parts, 'cap-main-label', '业务场景', MARGIN + 8, mainY + 8, LABEL_W - 16, mainH - 16);
  const gridX = MARGIN + LABEL_W + 8;
  const gridW = contentW - LABEL_W - 16;
  const stageGap = 16;
  const stageW = (gridW - stageGap * (blueprint.stages.length - 1)) / blueprint.stages.length;
  const stageY = mainY + 14;
  const stageH = 56;
  const moduleY = stageY + stageH + 12;
  const moduleH = 50;
  const bodyY = moduleY + moduleH + 8;
  const bodyH = mainY + mainH - 14 - bodyY;
  const density = densityOf(blueprint);
  parts.push(`<defs><marker id="cap-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${p.arrow}"/></marker></defs>`);
  for (const [index, stage] of blueprint.stages.entries()) {
    const x = gridX + index * (stageW + stageGap);
    parts.push(`<g id="cap-stage-${index}"><rect x="${x}" y="${stageY}" width="${stageW}" height="${stageH}" rx="9" fill="${p.primary}"/>`);
    parts.push(textBlock(stage.label, x + stageW / 2, stageY + stageH / 2, stageW - 20, density.stageFont, p.white,
      { weight: 'bold', lineHeight: density.stageFont + 4, maxLines: 2 }));
    if (index < blueprint.stages.length - 1) {
      const x1 = x + stageW + 3;
      const x2 = x + stageW + stageGap - 3;
      parts.push(`<line x1="${x1}" y1="${stageY + stageH / 2}" x2="${x2}" y2="${stageY + stageH / 2}" stroke="${p.arrow}" stroke-width="2" marker-end="url(#cap-arrow)"/>`);
    }
    parts.push(`<rect x="${x}" y="${moduleY}" width="${stageW}" height="${moduleH}" rx="8" fill="${p.module}"/>`);
    parts.push(textBlock(stage.module, x + stageW / 2, moduleY + moduleH / 2, stageW - 18, density.moduleFont, p.primaryDark,
      { weight: 'bold', lineHeight: density.moduleFont + 4, maxLines: 2 }));
    parts.push(`<rect x="${x}" y="${bodyY}" width="${stageW}" height="${bodyH}" rx="8" fill="${p.white}" stroke="${p.border}"/>`);
    const interval = bodyH / stage.capabilities.length;
    for (const [capabilityIndex, capability] of stage.capabilities.entries()) {
      const centerY = bodyY + interval * (capabilityIndex + 0.5);
      parts.push(textBlock(capability, x + stageW / 2, centerY, stageW - 18, density.itemFont, p.text,
        { lineHeight: density.itemLine, maxLines: 2 }));
    }
    parts.push('</g>');
  }
  parts.push('</g>');

  y = mainY + mainH;
  if (hasPlatform) {
    y += ROW_GAP;
    bandRow(parts, { id: 'cap-platform', label: '平台支撑', items: blueprint.platformCapabilities!, x: MARGIN, y, w: contentW, h: platformH });
    y += platformH;
  }
  if (hasIntegrations) {
    y += ROW_GAP;
    bandRow(parts, { id: 'cap-integrations', label: '系统集成', items: blueprint.integrations!.slice(0, CAPABILITY_MAP_LIMITS.integrations).map((title) => ({ title })), x: MARGIN, y, w: contentW, h: integrationH });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" font-family="PingFang SC, Microsoft YaHei, sans-serif"><rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${p.white}"/>${parts.join('')}</svg>`;
}
