/**
 * 案例配图·系统集成架构图（architecture）——内容契约解析 + 服务端确定性模板渲染（case-v13）。
 *
 * 设计原则：模板固定「形态」（画布、主题色表、中心枢纽、星形走线、编号注释框、三级字号），
 * 客户间差异（外部系统数量/名称/模块/流向）全部由模型输出的内容 graph 吸收——多系统围枢纽
 * 与单系统对接（OA+ONES）是同一骨架的两个实例。模型不再手绘 SVG（v9/v10 实测：主题色、
 * 占满画布等软约束屡被无视），渲染产物仍过 sanitizeCaseSvg 兜底（服务端产物当防御，非裁判）。
 */

export interface ArchitectureFlowStep {
  text: string;
  fields?: string[];
}

export interface ArchitectureFlow {
  from: string;
  to: string;
  label: string;
  steps: ArchitectureFlowStep[];
}

export interface ArchitectureSystemNode {
  id: string;
  name: string;
  modules: string[];
}

export interface ArchitectureGraph {
  systems: ArchitectureSystemNode[];
  hubModules: string[];
  flows: ArchitectureFlow[];
}

export type ArchitectureGraphParse = { graph: ArchitectureGraph } | { error: string };

/** 平台保留 id（flows 里 from/to 用 "ones" 指 ONES 平台）。 */
export const ARCHITECTURE_HUB_KEY = 'ones';

export const ARCHITECTURE_LIMITS = {
  systems: 8,
  systemModules: 6,
  /** 文本长度界按显示宽度（em）：汉字计 1、英文/数字约计 0.6（widthEm）。 */
  nameWidthEm: 12,
  moduleWidthEm: 11,
  hubModulesMin: 3,
  hubModules: 8,
  flows: 10,
  labelWidthEm: 12,
  steps: 3,
  stepWidthEm: 36,
  fields: 4,
  fieldWidthEm: 14,
} as const;

/**
 * 固定主题色表（{solid 实色, tint 浅底}）：ONES 枢纽恒为深蓝；外部系统按声明顺序取色——
 * 颜色只编码身份（同色 = 同系统），不编码业务含义，保证图内唯一、跨客户视觉语言一致。
 */
export const ARCHITECTURE_FIGURE_PALETTE = {
  hub: { solid: '#1665D8', tint: '#E7F0FB' },
  externals: [
    { solid: '#F0605C', tint: '#FCE9E7' },
    { solid: '#29A2E6', tint: '#E2F3FC' },
    { solid: '#2FBE72', tint: '#E6F6EB' },
    { solid: '#9A5CD0', tint: '#F3EBF9' },
    { solid: '#F6A821', tint: '#FFF4E1' },
    { solid: '#0FB5AE', tint: '#E3F7F6' },
    { solid: '#E85D9E', tint: '#FCE9F2' },
    { solid: '#7A8BA6', tint: '#EEF1F6' },
  ],
} as const;

const ID_PATTERN = /^[a-z0-9_-]{1,16}$/;

/** 估宽：按字符分级——CJK/全角 1em；W/M/w/m 等宽字母 ~0.9em；i/l/句读窄字符 ~0.35em；
 * 其余 ASCII ~0.62em（像素级防线实测教训：均摊系数会漏掉宽字母，行宽低估 5~10% 即贴框溢出）。 */
const charWidthEm = (char: string): number => {
  const code = char.charCodeAt(0);
  if (code >= 0x2E80) return 1;
  if (/[MWmw]/.test(char)) return 0.9;
  if (/[iljI.,:;'!|()\[\]{}]/.test(char)) return 0.35;
  return 0.62;
};

const textWidth = (text: string, fontSize: number): number =>
  fontSize * [...text].reduce((width, char) => width + charWidthEm(char), 0);

/** 显示宽度（em 单位）：长度界的统一口径——真实验收教训：按码点计字数会把「OAuth2 统一认证」
 * 「开放 REST API」这类真实产品词卡在 10 字上限外（ASCII 逐字符计 1），模型 4 连拒后丢图。 */
const widthEm = (text: string): number => textWidth(text, 1);

/** 文本规整：非字符串返回 null；字符串压空白、去首尾。 */
function cleanText(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
}

/**
 * graph 内容硬校验（违规返回具体错误，供重试日志与逐图重试）：
 * 规模界、id 合法性与引用完整性、每条流必须有一端是 ONES（本 kind 的业务契约）、
 * 文本长度界与禁区词（textGuard 由调用方注入，复用案例正文内部证据检查）。
 * 重复模块/字段静默去重；规模轻微超限静默截断（长度/引用类错误才拒绝）。
 */
export function parseArchitectureGraph(value: unknown, opts: { textGuard?: (text: string) => string | null } = {}): ArchitectureGraphParse {
  const guard = opts.textGuard ?? (() => null);
  const errors: string[] = [];
  const push = (message: string) => {
    if (errors.length < 3) errors.push(message);
  };
  const guarded = (text: string, where: string): void => {
    const label = guard(text);
    if (label) push(`${where} 含内部信息「${label}」`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'graph 不是对象' };
  const raw = value as Record<string, unknown>;

  const rawSystems = Array.isArray(raw.systems) ? raw.systems : [];
  if (!rawSystems.length || rawSystems.length > ARCHITECTURE_LIMITS.systems) {
    return { error: `systems 数量须在 1~${ARCHITECTURE_LIMITS.systems} 之间（实际 ${rawSystems.length}；素材无外部系统对接时应输出全空 graph）` };
  }
  const systems: ArchitectureSystemNode[] = [];
  const knownIds = new Set<string>([ARCHITECTURE_HUB_KEY]);
  for (const [index, item] of rawSystems.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { push(`systems[${index}] 不是对象`); continue; }
    const entry = item as Record<string, unknown>;
    const id = cleanText(entry.id)?.toLowerCase() ?? '';
    if (!ID_PATTERN.test(id)) { push(`systems[${index}].id 须为小写字母/数字/下划线/中划线（≤16 字符）`); continue; }
    if (id === ARCHITECTURE_HUB_KEY) { push(`systems[${index}].id 不得使用保留 id "ones"`); continue; }
    if (knownIds.has(id)) { push(`systems[${index}].id 重复：${id}`); continue; }
    knownIds.add(id);
    const name = cleanText(entry.name) ?? '';
    if (!name || widthEm(name) > ARCHITECTURE_LIMITS.nameWidthEm) push(`systems[${index}].name 须为 1~${ARCHITECTURE_LIMITS.nameWidthEm} 字宽（汉字计 1、英文/数字约计 0.6）`);
    guarded(name, `systems[${index}].name`);
    const modules = [...new Set((Array.isArray(entry.modules) ? entry.modules : []).map((module) => cleanText(module) ?? '').filter(Boolean))];
    if (modules.length > ARCHITECTURE_LIMITS.systemModules) push(`systems[${index}].modules 超过 ${ARCHITECTURE_LIMITS.systemModules} 个（请精选主要模块）`);
    modules.forEach((module, moduleIndex) => {
      if (widthEm(module) > ARCHITECTURE_LIMITS.moduleWidthEm) push(`systems[${index}].modules[${moduleIndex}]「${module}」超过 ${ARCHITECTURE_LIMITS.moduleWidthEm} 字宽`);
      guarded(module, `systems[${index}].modules[${moduleIndex}]`);
    });
    systems.push({ id, name, modules: modules.slice(0, ARCHITECTURE_LIMITS.systemModules) });
  }
  if (!systems.length) return { error: `systems 无合法条目（${errors[0] ?? '结构错误'}）` };

  const hubModules = [...new Set((Array.isArray(raw.hubModules) ? raw.hubModules : []).map((module) => cleanText(module) ?? '').filter(Boolean))];
  if (hubModules.length < ARCHITECTURE_LIMITS.hubModulesMin || hubModules.length > ARCHITECTURE_LIMITS.hubModules) {
    push(`hubModules 数量须在 ${ARCHITECTURE_LIMITS.hubModulesMin}~${ARCHITECTURE_LIMITS.hubModules} 之间（实际 ${hubModules.length}）`);
  }
  hubModules.forEach((module, index) => {
    if (widthEm(module) > ARCHITECTURE_LIMITS.moduleWidthEm) push(`hubModules[${index}]「${module}」超过 ${ARCHITECTURE_LIMITS.moduleWidthEm} 字宽`);
    guarded(module, `hubModules[${index}]`);
  });

  const rawFlows = Array.isArray(raw.flows) ? raw.flows : [];
  if (!rawFlows.length || rawFlows.length > ARCHITECTURE_LIMITS.flows) {
    return { error: `flows 数量须在 1~${ARCHITECTURE_LIMITS.flows} 之间（实际 ${rawFlows.length}）` };
  }
  const flows: ArchitectureFlow[] = [];
  for (const [index, item] of rawFlows.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { push(`flows[${index}] 不是对象`); continue; }
    const entry = item as Record<string, unknown>;
    const from = cleanText(entry.from)?.toLowerCase() ?? '';
    const to = cleanText(entry.to)?.toLowerCase() ?? '';
    if (!knownIds.has(from) || !knownIds.has(to)) { push(`flows[${index}] from/to 须引用存在的系统 id 或 "ones"`); continue; }
    if (from === to) { push(`flows[${index}] from 与 to 相同`); continue; }
    if (from !== ARCHITECTURE_HUB_KEY && to !== ARCHITECTURE_HUB_KEY) {
      push(`flows[${index}] 每条流必须有一端是 "ones"（外部系统间直连拆成经 ONES 的两条流或省略）`);
    }
    const label = cleanText(entry.label) ?? '';
    if (!label || widthEm(label) > ARCHITECTURE_LIMITS.labelWidthEm) push(`flows[${index}].label 须为 1~${ARCHITECTURE_LIMITS.labelWidthEm} 字宽`);
    guarded(label, `flows[${index}].label`);
    const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
    if (!rawSteps.length) push(`flows[${index}].steps 至少 1 条`);
    const steps: ArchitectureFlowStep[] = [];
    for (const [stepIndex, step] of rawSteps.slice(0, ARCHITECTURE_LIMITS.steps).entries()) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) { push(`flows[${index}].steps[${stepIndex}] 不是对象`); continue; }
      const stepEntry = step as Record<string, unknown>;
      const text = cleanText(stepEntry.text) ?? '';
      if (!text || widthEm(text) > ARCHITECTURE_LIMITS.stepWidthEm) push(`flows[${index}].steps[${stepIndex}].text 须为 1~${ARCHITECTURE_LIMITS.stepWidthEm} 字宽`);
      guarded(text, `flows[${index}].steps[${stepIndex}].text`);
      const fields = (Array.isArray(stepEntry.fields) ? stepEntry.fields : []).map((field) => cleanText(field) ?? '').filter(Boolean);
      if (fields.length > ARCHITECTURE_LIMITS.fields) push(`flows[${index}].steps[${stepIndex}].fields 超过 ${ARCHITECTURE_LIMITS.fields} 个（请精选关键关联字段）`);
      fields.forEach((field, fieldIndex) => {
        if (widthEm(field) > ARCHITECTURE_LIMITS.fieldWidthEm) push(`flows[${index}].steps[${stepIndex}].fields[${fieldIndex}]「${field}」超过 ${ARCHITECTURE_LIMITS.fieldWidthEm} 字宽`);
        guarded(field, `flows[${index}].steps[${stepIndex}].fields[${fieldIndex}]`);
      });
      steps.push({ text, fields: fields.slice(0, ARCHITECTURE_LIMITS.fields) });
    }
    if (!steps.length) { push(`flows[${index}] 无合法 steps`); continue; }
    flows.push({ from, to, label, steps });
  }
  if (!flows.length) return { error: `flows 无合法条目（${errors[0] ?? '结构错误'}）` };
  if (errors.length) return { error: errors.join('；') };
  return { graph: { systems, hubModules: hubModules.slice(0, ARCHITECTURE_LIMITS.hubModules), flows } };
}

/* ---------------------------------- 渲染 ---------------------------------- */

/**
 * 系统集成图固定为 2:1 蓝图画布。外部系统上下分层，中央 ONES 是视觉重心，
 * 注释卡放在左右信息栏而不是挤在系统与枢纽之间的狭窄走廊。布局只由 graph 决定，
 * 因而同一 graph 每次都会得到相同的 SVG。
 */
const CANVAS_W = 1440;
const CANVAS_H = 720;
const MARGIN_X = 24;
const MARGIN_Y = 24;
const EXTERNAL_X0 = 340;
const EXTERNAL_X1 = 1100;
const HUB_X = 430;
const HUB_W = 580;
const HUB_MIN_H = 176;
const CARD_FILL = '#FFFFFF';
const CARD_STROKE = '#C8D9EE';
const CARD_TEXT = '#1F2329';
const LINE_GAP = 18;
const TRAILING_PUNCTUATION = new Set(['）', '」', '』', '、', '，', '。', '；', '：', '！', '？', '>']);

interface DensitySpec {
  cardH: number;
  cardGap: number;
  pad: number;
  titleH: number;
  hubCardH: number;
  hubGap: number;
  hubPad: number;
  hubTitleH: number;
}

const DENSITY_LEVELS: DensitySpec[] = [
  { cardH: 48, cardGap: 8, pad: 12, titleH: 48, hubCardH: 42, hubGap: 12, hubPad: 20, hubTitleH: 48 },
  { cardH: 44, cardGap: 7, pad: 10, titleH: 44, hubCardH: 38, hubGap: 10, hubPad: 16, hubTitleH: 44 },
  { cardH: 40, cardGap: 6, pad: 8, titleH: 40, hubCardH: 34, hubGap: 8, hubPad: 12, hubTitleH: 40 },
];

const esc = (text: string): string => text.replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] as string
));

function wrapMeasured(text: string, maxWidth: number, fontSize: number): string[] {
  const tokens: string[] = [];
  for (const char of text) {
    if (/[A-Za-z0-9_.%+-]/.test(char) && tokens.length && /[A-Za-z0-9_.%+-]/.test(tokens[tokens.length - 1].slice(-1))) {
      tokens[tokens.length - 1] += char;
    } else if (TRAILING_PUNCTUATION.has(char) && tokens.length) {
      tokens[tokens.length - 1] += char;
    } else if (char === '（' && tokens.length) {
      tokens.push('\n', char);
    } else {
      tokens.push(char);
    }
  }
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (token === '\n') { if (current) lines.push(current); current = ''; continue; }
    if (current && textWidth(current + token, fontSize) > maxWidth) { lines.push(current); current = token; }
    else current += token;
  }
  if (current) lines.push(current);
  if (lines.length > 1 && [...lines.at(-1) ?? ''].length <= 2 && [...lines.at(-2) ?? ''].length > 4) {
    const previous = [...lines[lines.length - 2]];
    const candidate = `${previous.pop() ?? ''}${lines.at(-1)}`;
    if (textWidth(candidate, fontSize) <= maxWidth) lines.splice(lines.length - 2, 2, previous.join(''), candidate);
  }
  return lines.length ? lines : [''];
}

interface Box { x: number; y: number; w: number; h: number; label: string }
interface LaidOutSystem { node: ArchitectureSystemNode; x: number; y: number; w: number; h: number; titleY: number; modules: Box[]; solid: boolean; row: 'top' | 'bottom'; }
interface FlowLane { index: number; flow: ArchitectureFlow; system: LaidOutSystem; side: 'left' | 'right'; sourceX: number; sourceY: number; hubX: number; hubY: number; routeY: number; }
interface Annotation { lane: FlowLane; x: number; y: number; w: number; h: number; titleLines: string[]; bodyLines: string[]; }
interface CanvasLayout { width: number; height: number; hub: { x: number; y: number; w: number; h: number; modules: Box[]; titleY: number; titleH: number }; systems: LaidOutSystem[]; lanes: FlowLane[]; annotations: Annotation[]; density: DensitySpec; }

function centeredBoxes(labels: string[], x: number, y: number, w: number, cardW: number, cardH: number, gap: number): Box[] {
  const rowW = labels.length * cardW + Math.max(0, labels.length - 1) * gap;
  const start = x + (w - rowW) / 2;
  return labels.map((label, index) => ({ x: start + index * (cardW + gap), y, w: cardW, h: cardH, label }));
}

function layoutSystem(node: ArchitectureSystemNode, x: number, y: number, w: number, d: DensitySpec, row: 'top' | 'bottom'): LaidOutSystem {
  if (!node.modules.length) return { node, x, y, w, h: d.titleH + 20, titleY: y + 10, modules: [], solid: true, row };
  const cardW = (w - 2 * d.pad - d.cardGap) / 2;
  const rows = Math.ceil(node.modules.length / 2);
  const modules: Box[] = [];
  for (let index = 0; index < rows; index += 1) {
    modules.push(...centeredBoxes(node.modules.slice(index * 2, index * 2 + 2), x + d.pad, y + d.pad + d.titleH + index * (d.cardH + d.cardGap), w - 2 * d.pad, cardW, d.cardH, d.cardGap));
  }
  return { node, x, y, w, h: 2 * d.pad + d.titleH + rows * d.cardH + (rows - 1) * d.cardGap, titleY: y + d.pad, modules, solid: false, row };
}

function layoutCanvas(graph: ArchitectureGraph, d: DensitySpec): CanvasLayout | null {
  const count = graph.systems.length;
  const topCount = Math.ceil(count / 2);
  const bottomCount = count - topCount;
  const gap = 16;
  const rowLayout = (nodes: ArchitectureSystemNode[], row: 'top' | 'bottom'): LaidOutSystem[] => {
    if (!nodes.length) return [];
    const available = EXTERNAL_X1 - EXTERNAL_X0;
    const w = Math.min(360, (available - (nodes.length - 1) * gap) / nodes.length);
    const start = EXTERNAL_X0 + (available - (nodes.length * w + (nodes.length - 1) * gap)) / 2;
    const heights = nodes.map((node) => layoutSystem(node, 0, 0, w, d, row).h);
    const maxH = Math.max(...heights);
    const y = row === 'top' ? MARGIN_Y : CANVAS_H - MARGIN_Y - maxH;
    return nodes.map((node, index) => layoutSystem(node, start + index * (w + gap), y, w, d, row));
  };
  const systems = [...rowLayout(graph.systems.slice(0, topCount), 'top'), ...rowLayout(graph.systems.slice(topCount), 'bottom')];
  const hubCols = graph.hubModules.length > 6 ? 4 : graph.hubModules.length > 3 ? 3 : 2;
  const hubCardW = (HUB_W - 2 * d.hubPad - (hubCols - 1) * d.hubGap) / hubCols;
  const hubRows = Math.ceil(graph.hubModules.length / hubCols);
  const hubH = Math.max(HUB_MIN_H, d.hubPad * 2 + d.hubTitleH + 12 + hubRows * d.hubCardH + Math.max(0, hubRows - 1) * d.hubGap);
  const hubY = Math.round((CANVAS_H - hubH) / 2);
  const hubModules: Box[] = [];
  for (let index = 0; index < hubRows; index += 1) {
    hubModules.push(...centeredBoxes(graph.hubModules.slice(index * hubCols, index * hubCols + hubCols), HUB_X + d.hubPad, hubY + d.hubPad + d.hubTitleH + 12 + index * (d.hubCardH + d.hubGap), HUB_W - 2 * d.hubPad, hubCardW, d.hubCardH, d.hubGap));
  }
  const maxSystemH = Math.max(...systems.map((system) => system.h));
  if (MARGIN_Y + maxSystemH >= hubY - 12 || CANVAS_H - MARGIN_Y - maxSystemH <= hubY + hubH + 12) return null;

  const perSystem = new Map<string, number>();
  const lanes: FlowLane[] = [];
  const flowSideCounts = { left: 0, right: 0 };
  for (const [index, flow] of graph.flows.entries()) {
    const id = flow.from === ARCHITECTURE_HUB_KEY ? flow.to : flow.from;
    const system = systems.find((item) => item.node.id === id);
    if (!system) continue;
    const seq = perSystem.get(id) ?? 0; perSystem.set(id, seq + 1);
    const desiredSide: 'left' | 'right' = system.x + system.w / 2 < CANVAS_W / 2 ? 'left' : 'right';
    const side = flowSideCounts[desiredSide] <= flowSideCounts[desiredSide === 'left' ? 'right' : 'left'] + 2 ? desiredSide : desiredSide === 'left' ? 'right' : 'left';
    flowSideCounts[side] += 1;
    const sourceX = Math.round(system.x + system.w / 2);
    const sourceY = system.row === 'top' ? Math.round(system.y + system.h) : Math.round(system.y);
    const hubYEdge = system.row === 'top' ? hubY : hubY + hubH;
    const hubX = Math.round(HUB_X + 46 + ((seq + index) % Math.max(1, Math.floor((HUB_W - 92) / 92))) * 92);
    lanes.push({ index, flow, system, side, sourceX, sourceY, hubX: Math.min(HUB_X + HUB_W - 32, hubX), hubY: hubYEdge, routeY: system.row === 'top' ? hubY - 18 : hubY + hubH + 18 });
  }

  const makeAnnotation = (lane: FlowLane): Annotation => {
    const x = lane.side === 'left' ? MARGIN_X : CANVAS_W - MARGIN_X - 300;
    const titleLines = wrapMeasured(`${lane.index + 1}、${lane.flow.label}`, 276, 15).slice(0, 2);
    const bodyLines: string[] = [];
    for (const step of lane.flow.steps) {
      bodyLines.push(...wrapMeasured(step.text, 276, 14));
      if (step.fields?.length) bodyLines.push(...wrapMeasured(`（关联字段：${step.fields.join('、')}）`, 276, 14));
    }
    const kept = bodyLines.length > 5 ? [...bodyLines.slice(0, 4), '…'] : bodyLines;
    return { lane, x, y: 0, w: 300, h: 18 + titleLines.length * 19 + 18 + 14 + kept.length * LINE_GAP, titleLines, bodyLines: kept };
  };
  const annotations = lanes.map(makeAnnotation);
  for (const side of ['left', 'right'] as const) {
    const entries = annotations.filter((item) => item.lane.side === side).sort((a, b) => a.lane.index - b.lane.index);
    let cursor = MARGIN_Y;
    for (const entry of entries) { entry.y = cursor; cursor += entry.h + 12; }
    if (cursor > CANVAS_H - MARGIN_Y) {
      let floor = CANVAS_H - MARGIN_Y;
      for (let index = entries.length - 1; index >= 0; index -= 1) { floor -= entries[index].h; entries[index].y = floor; floor -= 12; }
    }
  }
  return { width: CANVAS_W, height: CANVAS_H, hub: { x: HUB_X, y: hubY, w: HUB_W, h: hubH, modules: hubModules, titleY: hubY + d.hubPad, titleH: d.hubTitleH }, systems, lanes, annotations, density: d };
}

function textBlock(parts: string[], x: number, y: number, lines: string[], size: number, color: string, weight = 'normal', anchor = 'start', lineGap = LINE_GAP): void {
  if (!lines.length) return;
  if (lines.length === 1) { parts.push(`<text x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(lines[0])}</text>`); return; }
  const tspans = lines.map((line, index) => index === 0 ? `<tspan>${esc(line)}</tspan>` : `<tspan x="${r1(x)}" dy="${lineGap}">${esc(line)}</tspan>`).join('');
  parts.push(`<text x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${color}">${tspans}</text>`);
}

export function renderArchitectureSvg(graph: ArchitectureGraph): string | null {
  const clipped: ArchitectureGraph = { systems: graph.systems.slice(0, ARCHITECTURE_LIMITS.systems), hubModules: graph.hubModules.slice(0, ARCHITECTURE_LIMITS.hubModules), flows: graph.flows.slice(0, ARCHITECTURE_LIMITS.flows) };
  for (const density of DENSITY_LEVELS) {
    const canvas = layoutCanvas(clipped, density);
    if (canvas) return drawCanvas(canvas);
  }
  return null;
}

function drawCanvas(canvas: CanvasLayout): string {
  const parts: string[] = [];
  const allSystems = canvas.systems;
  const themeOf = (id: string) => id === ARCHITECTURE_HUB_KEY
    ? ARCHITECTURE_FIGURE_PALETTE.hub
    : ARCHITECTURE_FIGURE_PALETTE.externals[Math.max(0, allSystems.findIndex((item) => item.node.id === id)) % ARCHITECTURE_FIGURE_PALETTE.externals.length];
  const drawCard = (box: Box, size = 15): void => {
    const lines = wrapMeasured(box.label, box.w - 14, size).slice(0, 3);
    const lineHeight = 17;
    const startY = box.y + box.h / 2 - ((lines.length - 1) * lineHeight) / 2 + size * 0.36;
    parts.push(`<rect x="${r1(box.x)}" y="${r1(box.y)}" width="${r1(box.w)}" height="${r1(box.h)}" rx="5" fill="${CARD_FILL}" stroke="${CARD_STROKE}" stroke-width="1"/>`);
    textBlock(parts, box.x + box.w / 2, startY, lines, size, CARD_TEXT, 'normal', 'middle', lineHeight);
  };
  const drawTitle = (cx: number, y: number, label: string, color: string, maxW: number, h: number, size: number): void => {
    const lines = wrapMeasured(label, maxW - 24, size).slice(0, 2);
    const w = Math.min(maxW, Math.max(112, Math.max(...lines.map((line) => textWidth(line, size))) + 30));
    const x = cx - w / 2;
    parts.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="8" fill="${color}"/>`);
    const startY = y + h / 2 - ((lines.length - 1) * 18) / 2 + size * 0.36;
    textBlock(parts, cx, startY, lines, size, '#FFFFFF', 'bold', 'middle', 18);
  };

  parts.push(`<rect x="${canvas.hub.x}" y="${canvas.hub.y}" width="${canvas.hub.w}" height="${canvas.hub.h}" rx="14" fill="${ARCHITECTURE_FIGURE_PALETTE.hub.tint}" stroke="${ARCHITECTURE_FIGURE_PALETTE.hub.solid}" stroke-width="1" stroke-opacity="0.42"/>`);
  for (const box of canvas.hub.modules) drawCard(box, 15);
  drawTitle(canvas.hub.x + canvas.hub.w / 2, canvas.hub.titleY, 'ONES 平台', ARCHITECTURE_FIGURE_PALETTE.hub.solid, canvas.hub.w - 48, canvas.hub.titleH, 21);

  for (const system of allSystems) {
    const theme = themeOf(system.node.id);
    if (system.solid) {
      parts.push(`<rect x="${r1(system.x)}" y="${r1(system.y)}" width="${r1(system.w)}" height="${r1(system.h)}" rx="8" fill="${theme.solid}"/>`);
      textBlock(parts, system.x + system.w / 2, system.y + system.h / 2 + 6, wrapMeasured(system.node.name, system.w - 20, 20).slice(0, 2), 20, '#FFFFFF', 'bold', 'middle', 21);
    } else {
      parts.push(`<rect x="${r1(system.x)}" y="${r1(system.y)}" width="${r1(system.w)}" height="${r1(system.h)}" rx="12" fill="${theme.tint}" stroke="${theme.solid}" stroke-width="1" stroke-opacity="0.45"/>`);
      for (const box of system.modules) drawCard(box, 15);
      drawTitle(system.x + system.w / 2, system.titleY, system.node.name, theme.solid, system.w - 14, canvas.density.titleH, 20);
    }
  }

  const colors = [...new Set(canvas.lanes.map((lane) => themeOf(lane.flow.from).solid))];
  const defs = colors.map((color, index) => `<marker id="arch-arrow-${index}" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L11,5.5 L0,11 Z" fill="${color}"/></marker>`).join('');
  for (const lane of canvas.lanes) {
    const theme = themeOf(lane.flow.from);
    const fromSystem = lane.flow.from !== ARCHITECTURE_HUB_KEY;
    const startX = fromSystem ? lane.sourceX : lane.hubX;
    const endX = fromSystem ? lane.hubX : lane.sourceX;
    const startY = fromSystem ? lane.sourceY : lane.hubY;
    const endY = fromSystem ? lane.hubY : lane.sourceY;
    const path = `M ${startX},${startY} L ${startX},${lane.routeY} L ${endX},${lane.routeY} L ${endX},${endY}`;
    parts.push(`<path d="${path}" fill="none" stroke="${theme.solid}" stroke-width="2" stroke-linecap="round" marker-end="url(#arch-arrow-${colors.indexOf(theme.solid)})"/>`);
  }

  for (const annotation of canvas.annotations) {
    const theme = themeOf(annotation.lane.flow.from);
    parts.push(`<rect x="${r1(annotation.x)}" y="${r1(annotation.y)}" width="${r1(annotation.w)}" height="${r1(annotation.h)}" rx="6" fill="#FFFFFF" stroke="${theme.solid}" stroke-width="1.5"/>`);
    textBlock(parts, annotation.x + 12, annotation.y + 22, annotation.titleLines, 15, theme.solid, 'bold', 'start', 18);
    const direction = annotation.lane.flow.from === ARCHITECTURE_HUB_KEY ? `ONES → ${annotation.lane.system.node.name}` : `${annotation.lane.system.node.name} → ONES`;
    const directionY = annotation.y + 22 + (annotation.titleLines.length - 1) * 18 + 17;
    textBlock(parts, annotation.x + 12, directionY, [direction], 13, '#5B6675');
    textBlock(parts, annotation.x + 12, directionY + 19, annotation.bodyLines, 14, CARD_TEXT, 'normal', 'start', LINE_GAP);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}" font-family="PingFang SC, Microsoft YaHei, sans-serif">${defs ? `<defs>${defs}</defs>` : ''}<g>${parts.join('')}</g></svg>`;
}

const r1 = (value: number): number => Math.round(value * 10) / 10;
