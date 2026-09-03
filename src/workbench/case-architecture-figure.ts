/**
 * 案例配图·系统集成架构图（architecture）——内容契约解析 + 服务端确定性模板渲染（case-v11）。
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

const CANVAS_W = 1800;
const CANVAS_H_MIN = 520;
const CANVAS_H_MAX = 920;
const TOP_MIN = 42;
const BOTTOM_MIN = 32;
const LINE_GAP = 15;
const CARD_FILL = '#FFFFFF';
const CARD_STROKE = '#D8D8D8';
const CARD_TEXT = '#1F2329';

/** 四档密度（正常→紧凑→极紧凑→密集）：列堆叠超出画布预算时逐档压缩，四档都装不下返回 null 触发逐图重试。 */
interface DensitySpec {
  cardH: number; cardGap: number; plateH: number; plateGap: number; pad: number; sysGap: number;
  hubCardH: number; hubPlateH: number; hubPad: number; hubPlateGap: number; hubRowGap: number;
}
const DENSITY_LEVELS: DensitySpec[] = [
  { cardH: 38, cardGap: 8, plateH: 46, plateGap: 11, pad: 14, sysGap: 22, hubCardH: 38, hubPlateH: 50, hubPad: 20, hubPlateGap: 13, hubRowGap: 10 },
  { cardH: 34, cardGap: 6, plateH: 42, plateGap: 9, pad: 11, sysGap: 15, hubCardH: 34, hubPlateH: 44, hubPad: 16, hubPlateGap: 10, hubRowGap: 7 },
  { cardH: 32, cardGap: 4, plateH: 38, plateGap: 7, pad: 9, sysGap: 10, hubCardH: 32, hubPlateH: 40, hubPad: 12, hubPlateGap: 8, hubRowGap: 5 },
  { cardH: 28, cardGap: 3, plateH: 34, plateGap: 5, pad: 7, sysGap: 8, hubCardH: 28, hubPlateH: 36, hubPad: 8, hubPlateGap: 6, hubRowGap: 4 },
];

const esc = (text: string): string => text.replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] as string
));

const TRAILING_PUNCTUATION = new Set(['）', '」', '』', '、', '，', '。', '；', '：', '！', '？', '>']);

/**
 * 按实测宽度换行：ASCII 词（ID/ERP/H5 等）不可拆、尾部标点粘连前行、全角左括号强制行首
 * （「（关联字段：…）」整段从新行开始，不再出现「…（关 / 联字段」拆词）、末行孤字回补。
 */
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
    if (token === '\n') {
      if (current) lines.push(current);
      current = '';
      continue;
    }
    if (current && textWidth(current + token, fontSize) > maxWidth) {
      lines.push(current);
      current = token;
    } else {
      current += token;
    }
  }
  if (current) lines.push(current);
  // 末行孤字（≤2 字符宽）回补：把前一行末 token 挪下来，避免「D）」「办」单字成行。
  if (lines.length > 1) {
    const last = lines[lines.length - 1];
    const previous = lines[lines.length - 2];
    const lastChars = [...last];
    if (lastChars.length <= 2 && [...previous].length > 4) {
      const previousChars = [...previous];
      const moved = previousChars.pop() as string;
      const candidate = moved + last;
      if (textWidth(candidate, fontSize) <= maxWidth) {
        lines.splice(lines.length - 2, 2, previousChars.join(''), candidate);
      }
    }
  }
  return lines.length ? lines : [''];
}

interface CardBox { x: number; y: number; w: number; h: number; label: string }

interface LaidOutSystem {
  node: ArchitectureSystemNode;
  x: number; y: number; w: number; h: number;
  plateY: number;
  solid: boolean;
  rows: CardBox[];
}

/** 单行卡片行内居中（不足整行时）。 */
function centeredRow(items: string[], x: number, y: number, containerW: number, cardW: number, cardH: number, gap: number): CardBox[] {
  const rowW = items.length * cardW + (items.length - 1) * gap;
  const startX = x + (containerW - rowW) / 2;
  return items.map((label, index) => ({ x: startX + index * (cardW + gap), y, w: cardW, h: cardH, label }));
}

/**
 * 系统容器内部布局：标题牌垂直居中，模块卡 2 张/行三明治夹牌（上半 floor(m/2)、下半其余；
 * 0 模块 = 实心系统级单块）。返回各行卡片（绝对坐标）、标题牌 y 与容器总高。
 */
function systemLayout(node: ArchitectureSystemNode, x: number, y: number, w: number, d: DensitySpec): { rows: CardBox[]; plateY: number; height: number } {
  if (!node.modules.length) {
    return { rows: [], plateY: y, height: d.plateH + 8 };
  }
  const cardW = (w - 2 * d.pad - d.cardGap) / 2;
  const above = Math.floor(node.modules.length / 2);
  const below = node.modules.length - above;
  const rowsAbove = Math.ceil(above / 2);
  const rowsBelow = Math.ceil(below / 2);
  const height = 2 * d.pad
    + (rowsAbove ? rowsAbove * d.cardH + (rowsAbove - 1) * d.cardGap + d.plateGap : 0)
    + d.plateH
    + (rowsBelow ? d.plateGap + rowsBelow * d.cardH + (rowsBelow - 1) * d.cardGap : 0);
  const plateY = y + d.pad + (rowsAbove ? rowsAbove * d.cardH + (rowsAbove - 1) * d.cardGap + d.plateGap : 0);
  const rows: CardBox[] = [];
  let cursorY = y + d.pad;
  for (let rowIndex = 0; rowIndex < rowsAbove; rowIndex += 1) {
    const items = node.modules.slice(Math.min(rowIndex * 2, above), Math.min(rowIndex * 2 + 2, above));
    rows.push(...centeredRow(items, x, cursorY, w, cardW, d.cardH, d.cardGap));
    cursorY += d.cardH + d.cardGap;
  }
  cursorY = plateY + d.plateH + d.plateGap;
  for (let rowIndex = 0; rowIndex < rowsBelow; rowIndex += 1) {
    const items = node.modules.slice(above + rowIndex * 2, above + rowIndex * 2 + 2);
    rows.push(...centeredRow(items, x, cursorY, w, cardW, d.cardH, d.cardGap));
    cursorY += d.cardH + d.cardGap;
  }
  return { rows, plateY, height };
}

interface CanvasLayout {
  width: number;
  height: number;
  hub: { x: number; y: number; w: number; h: number; plateY: number; plateH: number; rows: CardBox[] };
  left: LaidOutSystem[];
  right: LaidOutSystem[];
  corridors: { left: { x0: number; x1: number }; right: { x0: number; x1: number } };
  hubXRange: { left: number; right: number };
  lanes: Array<{ index: number; flow: ArchitectureFlow; side: 'left' | 'right'; y1: number; y2: number; elbowX: number }>;
  density: DensitySpec;
}

function layoutCanvas(graph: ArchitectureGraph, colW: number, corridorW: number, hubW: number, d: DensitySpec): CanvasLayout | null {
  const solo = graph.systems.length === 1;
  const externals = graph.systems;
  const leftNodes = externals.slice(0, Math.ceil(externals.length / 2));
  const rightNodes = externals.slice(Math.ceil(externals.length / 2));

  // 横向五段：左列 | 走廊 | 枢纽 | 走廊 | 右列。N≥2 铺满 1800；单系统整组收窄居中（防空旷）。
  const width = solo ? colW + corridorW + hubW + 2 * 56 : CANVAS_W;
  const leftX = solo ? 56 : 20;
  const hubX = leftX + colW + corridorW;
  const rightX = hubX + hubW + corridorW;

  const leftHeights = leftNodes.map((node) => systemLayout(node, leftX, 0, colW, d).height);
  const rightHeights = rightNodes.map((node) => systemLayout(node, rightX, 0, colW, d).height);
  const stackTotal = (heights: number[], gap: number) =>
    heights.reduce((sum, h) => sum + h, 0) + (heights.length > 1 ? (heights.length - 1) * gap : 0);
  const maxStack = Math.max(stackTotal(leftHeights, d.sysGap), stackTotal(rightHeights, d.sysGap));
  if (maxStack > CANVAS_H_MAX - TOP_MIN - BOTTOM_MIN) return null;

  // 枢纽内容高（≤4 个 2 列、>4 个 3 列；上/下三明治夹牌）。
  const hubCols = graph.hubModules.length <= 4 ? 2 : 3;
  const hubCardW = (hubW - 2 * d.hubPad - (hubCols - 1) * d.hubRowGap) / hubCols;
  const aboveCount = Math.ceil(graph.hubModules.length / 2);
  const aboveRows = Math.ceil(aboveCount / hubCols);
  const belowRows = Math.ceil((graph.hubModules.length - aboveCount) / hubCols);
  const aboveH = aboveRows * d.hubCardH + (aboveRows - 1) * d.hubRowGap + d.hubPlateGap;
  const belowH = belowRows * d.hubCardH + (belowRows - 1) * d.hubRowGap + d.hubPlateGap;
  const hubContentH = 2 * d.hubPad + aboveH + d.hubPlateH + belowH;
  if (hubContentH > CANVAS_H_MAX - TOP_MIN - BOTTOM_MIN) return null;
  // 视觉评审教训：枢纽容器禁止拉伸到与侧列等高（内容少时上下大片空洞「空壳化」）——
  // 只允许有限撑高（+90）增强存在感，行块分别锚容器顶/底、牌垂直居中（夹在合法区间）。
  // 下限必须是内容高：侧列比内容还矮时 min 会把容器压塌、行块溢出压牌（单测抓回）。
  const hubH = Math.round(Math.max(hubContentH, Math.min(maxStack, hubContentH + 90)));

  const height = Math.round(Math.min(CANVAS_H_MAX, Math.max(CANVAS_H_MIN, Math.max(maxStack, hubH) + TOP_MIN + BOTTOM_MIN)));
  const hubY = Math.round((height - hubH) / 2);

  const layColumn = (nodes: ArchitectureSystemNode[], x: number): LaidOutSystem[] => {
    if (!nodes.length) return [];
    const heights = nodes.map((node) => systemLayout(node, x, 0, colW, d).height);
    const sum = heights.reduce((acc, h) => acc + h, 0);
    const gap = nodes.length > 1 ? Math.min(150, Math.max(d.sysGap, (height - TOP_MIN - BOTTOM_MIN - sum) / (nodes.length - 1))) : 0;
    let y = Math.round((height - (sum + (nodes.length - 1) * gap)) / 2);
    return nodes.map((node, index) => {
      const inner = systemLayout(node, x, y, colW, d);
      const laid: LaidOutSystem = inner.rows.length
        ? { node, x, y, w: colW, h: heights[index], plateY: inner.plateY, solid: false, rows: inner.rows }
        : { node, x, y, w: colW, h: heights[index], plateY: y, solid: true, rows: [] };
      y += heights[index] + gap;
      return laid;
    });
  };
  const left = layColumn(leftNodes, leftX);
  const right = layColumn(rightNodes, rightX);

  // 枢纽行/牌几何：上块自容器顶向下铺、下块自容器底向上铺；牌优先垂直居中、
  // 夹在 [上块底, 下块顶-牌高] 区间内（上下行数不对称且拉伸余量小时居中会压块）。
  const hubRows: CardBox[] = [];
  const hubPlateY = Math.round(Math.min(
    hubY + hubH - d.hubPad - belowH - d.hubPlateH,
    Math.max(hubY + d.hubPad + aboveH, hubY + hubH / 2 - d.hubPlateH / 2),
  ));
  {
    const aboveLabels = graph.hubModules.slice(0, aboveCount);
    const belowLabels = graph.hubModules.slice(aboveCount);
    let cursor = hubY + d.hubPad;
    for (let rowIndex = 0; rowIndex < aboveRows; rowIndex += 1) {
      hubRows.push(...centeredRow(aboveLabels.slice(rowIndex * hubCols, rowIndex * hubCols + hubCols), hubX, Math.round(cursor), hubW, hubCardW, d.hubCardH, d.hubRowGap));
      cursor += d.hubCardH + d.hubRowGap;
    }
    let belowTop = hubY + hubH - d.hubPad - belowRows * d.hubCardH - (belowRows - 1) * d.hubRowGap;
    for (let rowIndex = 0; rowIndex < belowRows; rowIndex += 1) {
      hubRows.push(...centeredRow(belowLabels.slice(rowIndex * hubCols, rowIndex * hubCols + hubCols), hubX, Math.round(belowTop), hubW, hubCardW, d.hubCardH, d.hubRowGap));
      belowTop += d.hubCardH + d.hubRowGap;
    }
  }

  // 流走线：系统侧出入点在本系统纵向范围内按序错开（±30）；枢纽侧同 y 直线、
  // 超出枢纽纵向范围时在走廊内正交折入（elbowX 贴走廊外缘，避开注释框主体）。
  const perSystemSeq = new Map<string, number>();
  const perSystemTotal = new Map<string, number>();
  for (const flow of graph.flows) {
    const systemId = flow.from === ARCHITECTURE_HUB_KEY ? flow.to : flow.from;
    perSystemTotal.set(systemId, (perSystemTotal.get(systemId) ?? 0) + 1);
  }
  const lanes: CanvasLayout['lanes'] = [];
  for (const [index, flow] of graph.flows.entries()) {
    const systemId = flow.from === ARCHITECTURE_HUB_KEY ? flow.to : flow.from;
    const side: 'left' | 'right' = leftNodes.some((node) => node.id === systemId) ? 'left' : 'right';
    const system = (side === 'left' ? left : right).find((item) => item.node.id === systemId);
    if (!system) continue;
    const seq = perSystemSeq.get(systemId) ?? 0;
    perSystemSeq.set(systemId, seq + 1);
    const count = perSystemTotal.get(systemId) ?? 1;
    const center = system.solid ? system.y + system.h / 2 : system.plateY + d.plateH / 2;
    const y1 = Math.round(Math.min(system.y + system.h - 16, Math.max(system.y + 16, center + (seq - (count - 1) / 2) * 30)));
    const y2 = Math.round(Math.min(hubY + hubH - 26, Math.max(hubY + 26, y1)));
    const corridorX0 = side === 'left' ? hubX - corridorW : hubX + hubW;
    // 竖向折线段贴走廊外缘、注释框列整体右移让出净距（视觉评审：5px 贴边不可读）。
    const elbowX = Math.round(side === 'left' ? corridorX0 + 6 : corridorX0 + corridorW - 6);
    lanes.push({ index, flow, side, y1, y2, elbowX });
  }

  return {
    width: Math.round(width),
    height,
    hub: { x: hubX, y: hubY, w: hubW, h: hubH, plateY: hubPlateY, plateH: d.hubPlateH, rows: hubRows },
    left, right,
    corridors: { left: { x0: hubX - corridorW, x1: hubX }, right: { x0: hubX + hubW, x1: hubX + hubW + corridorW } },
    hubXRange: { left: hubX, right: hubX + hubW },
    lanes,
    density: d,
  };
}

/**
 * 确定性渲染：内容 graph → 示例图骨架 SVG（分区浅色底 + 实色主题牌 + 白卡三明治 +
 * 源系统色正交走线 + 编号注释框）。返回自包含 `<svg>`（调用方再过 sanitizeCaseSvg 兜底）；
 * 几何超限（三档密度都装不下）返回 null。
 */
export function renderArchitectureSvg(graph: ArchitectureGraph): string | null {
  const clipped: ArchitectureGraph = {
    systems: graph.systems.slice(0, ARCHITECTURE_LIMITS.systems),
    hubModules: graph.hubModules.slice(0, ARCHITECTURE_LIMITS.hubModules),
    flows: graph.flows.slice(0, ARCHITECTURE_LIMITS.flows),
  };
  const solo = clipped.systems.length === 1;
  const colW = solo ? 420 : 400;
  const corridorW = solo ? 250 : 230;
  const hubW = solo ? 640 : 500;
  for (const density of DENSITY_LEVELS) {
    const canvas = layoutCanvas(clipped, colW, corridorW, hubW, density);
    if (canvas) return drawCanvas(canvas, solo);
  }
  return null;
}

function drawCanvas(canvas: CanvasLayout, solo: boolean): string {
  const d = canvas.density;
  const externals = [...canvas.left, ...canvas.right];
  const themeOf = (id: string) => (id === ARCHITECTURE_HUB_KEY
    ? ARCHITECTURE_FIGURE_PALETTE.hub
    : ARCHITECTURE_FIGURE_PALETTE.externals[Math.max(0, externals.findIndex((item) => item.node.id === id)) % ARCHITECTURE_FIGURE_PALETTE.externals.length]);

  const parts: string[] = [];
  const card = (box: CardBox): void => {
    // 卡片文字超宽自动降字号（14→13→12，下限 12 保可读）：字宽制放开后英文长词靠字号适配卡片宽。
    const fontSize = [14, 13, 12].find((size) => textWidth(box.label, size) <= box.w - 10) ?? 12;
    parts.push(`<rect x="${r1(box.x)}" y="${r1(box.y)}" width="${r1(box.w)}" height="${box.h}" rx="5" fill="${CARD_FILL}" stroke="${CARD_STROKE}" stroke-width="1"/>`);
    parts.push(`<text x="${r1(box.x + box.w / 2)}" y="${Math.round(box.y + box.h / 2 + fontSize * 0.36)}" text-anchor="middle" font-size="${fontSize}" fill="${CARD_TEXT}">${esc(box.label)}</text>`);
  };
  const plate = (cx: number, y: number, text: string, color: string, fontSize: number, height: number, maxW: number): void => {
    const w = Math.round(Math.min(maxW, Math.max(110, textWidth(text, fontSize) + 34)));
    parts.push(`<rect x="${Math.round(cx - w / 2)}" y="${Math.round(y)}" width="${w}" height="${height}" rx="8" fill="${color}"/>`);
    parts.push(`<text x="${Math.round(cx)}" y="${Math.round(y + height / 2 + fontSize * 0.36)}" text-anchor="middle" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF">${esc(text)}</text>`);
  };

  // 枢纽（浅蓝分区底 + 深蓝牌 + 三明治模块网格）与外部系统（主题色浅底 + 实色牌 + 白卡）。
  parts.push(`<rect x="${canvas.hub.x}" y="${canvas.hub.y}" width="${canvas.hub.w}" height="${canvas.hub.h}" rx="14" fill="${ARCHITECTURE_FIGURE_PALETTE.hub.tint}" stroke="${ARCHITECTURE_FIGURE_PALETTE.hub.solid}" stroke-width="1" stroke-opacity="0.35"/>`);
  for (const box of canvas.hub.rows) card(box);
  plate(canvas.hub.x + canvas.hub.w / 2, canvas.hub.plateY, 'ONES 平台', ARCHITECTURE_FIGURE_PALETTE.hub.solid, solo ? 20 : 19, canvas.hub.plateH, canvas.hub.w - 48);

  for (const system of externals) {
    const theme = themeOf(system.node.id);
    if (system.solid) {
      parts.push(`<rect x="${system.x}" y="${system.y}" width="${system.w}" height="${system.h}" rx="8" fill="${theme.solid}"/>`);
      parts.push(`<text x="${Math.round(system.x + system.w / 2)}" y="${Math.round(system.y + system.h / 2 + 5.5)}" text-anchor="middle" font-size="15" font-weight="bold" fill="#FFFFFF">${esc(system.node.name)}</text>`);
      continue;
    }
    parts.push(`<rect x="${system.x}" y="${system.y}" width="${system.w}" height="${system.h}" rx="12" fill="${theme.tint}" stroke="${theme.solid}" stroke-width="1" stroke-opacity="0.4"/>`);
    for (const box of system.rows) card(box);
    plate(system.x + system.w / 2, system.plateY, system.node.name, theme.solid, 17, d.plateH, system.w - 28);
  }

  // 连线：正交折线 + 同色箭头（marker-end 落在数据接收方），线色 = 数据发出方主题色。
  const usedColors = [...new Set(canvas.lanes.map(({ flow }) => themeOf(flow.from).solid))];
  const defs = usedColors.map((color, index) => `<marker id="arch-arrow-${index}" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L11,5.5 L0,11 Z" fill="${color}"/></marker>`).join('');
  for (const lane of canvas.lanes) {
    const theme = themeOf(lane.flow.from);
    const system = externals.find((item) => item.node.id === (lane.flow.from === ARCHITECTURE_HUB_KEY ? lane.flow.to : lane.flow.from))!;
    const sysEdgeX = lane.side === 'left' ? system.x + system.w : system.x;
    const hubEdgeX = lane.side === 'left' ? canvas.hubXRange.left : canvas.hubXRange.right;
    const fromSystem = lane.flow.from !== ARCHITECTURE_HUB_KEY;
    const path = lane.y1 === lane.y2
      ? `M ${fromSystem ? sysEdgeX : hubEdgeX},${lane.y1} L ${fromSystem ? hubEdgeX : sysEdgeX},${lane.y1}`
      : (fromSystem
        ? `M ${sysEdgeX},${lane.y1} L ${lane.elbowX},${lane.y1} L ${lane.elbowX},${lane.y2} L ${hubEdgeX},${lane.y2}`
        : `M ${hubEdgeX},${lane.y2} L ${lane.elbowX},${lane.y2} L ${lane.elbowX},${lane.y1} L ${sysEdgeX},${lane.y1}`);
    parts.push(`<path d="${path}" fill="none" stroke="${theme.solid}" stroke-width="2" marker-end="url(#arch-arrow-${usedColors.indexOf(theme.solid)})"/>`);
  }

  // 编号注释框：首行「N、label」（发出方主题色粗体），正文 steps（含关联字段）按实测宽度换行
  //（ASCII 词不拆、孤字回补）；框挂所属连线的走线走廊、按 y 一维防重叠下推，绘制在连线之后（框压线）。
  for (const side of ['left', 'right'] as const) {
    const corridor = canvas.corridors[side];
    if (side === 'right' && !canvas.right.length) continue;
    const boxW = corridor.x1 - corridor.x0 - 32;
    const textBudget = boxW - 28;
    const boxX = Math.round(corridor.x0 + 20);
    const entries = canvas.lanes.filter((lane) => lane.side === side)
      .map((lane) => {
        const bodyLines: string[] = [];
        for (const step of lane.flow.steps) {
          const full = step.fields?.length ? `${step.text}（关联字段：${step.fields.join('、')}）` : step.text;
          bodyLines.push(...wrapMeasured(full, textBudget, 12));
        }
        return { lane, bodyLines, h: 12 + 16 + bodyLines.length * LINE_GAP + 9 };
      })
      .sort((a, b) => a.lane.y1 - b.lane.y1);
    let prevBottom = TOP_MIN - 10;
    const bottoms: number[] = [];
    // 正向下推（贴所属连线的期望位 → 不低于上一框底+间距 → 不高于画布顶）。
    // 真实验收教训：底部 clamp 不能无条件覆盖下推结果——同系统多条流期望位相近时会把后框
    // 拉回压在前框上（框对框完全叠画）；溢出底部时应反向上收（自底向上贴边界回推）。
    for (const entry of entries) {
      const top = Math.max(entry.lane.y1 - entry.h / 2, prevBottom + 14, TOP_MIN);
      bottoms.push(top);
      prevBottom = top + entry.h;
    }
    const floor = canvas.height - BOTTOM_MIN;
    if (entries.length && bottoms[entries.length - 1] + entries[entries.length - 1].h > floor) {
      bottoms[entries.length - 1] = floor - entries[entries.length - 1].h;
      for (let index = entries.length - 2; index >= 0; index -= 1) {
        bottoms[index] = Math.min(bottoms[index], bottoms[index + 1] - 14 - entries[index].h);
      }
    }
    for (const [index, entry] of entries.entries()) {
      const top = Math.max(TOP_MIN, Math.round(bottoms[index]));
      const theme = themeOf(entry.lane.flow.from);
      parts.push(`<rect x="${boxX}" y="${Math.round(top)}" width="${Math.round(boxW)}" height="${Math.round(entry.h)}" rx="6" fill="#FFFFFF" stroke="${theme.solid}" stroke-width="1.5"/>`);
      parts.push(`<text x="${boxX + 11}" y="${Math.round(top + 24)}" font-size="13" font-weight="bold" fill="${theme.solid}">${esc(`${entry.lane.index + 1}、${entry.lane.flow.label}`)}</text>`);
      if (entry.bodyLines.length) {
        // 真实验收三连败根因：tspan 不带 x 时从上一行「末尾」续排（SVG 续排语义），每行向右
        // 阶梯位移溢出框外——坐标估算器按「每行从 text x 起算」三次误判无溢出，vision 三次全对。
        // 多行文本从第 2 行起必须带 x 回行首 + dy 进行距（模型手绘图天然每行带 x，同款写法）。
        const tspans = entry.bodyLines.map((line, index) => (index === 0
          ? `<tspan>${esc(line)}</tspan>`
          : `<tspan x="${boxX + 11}" dy="${LINE_GAP}">${esc(line)}</tspan>`)).join('');
        parts.push(`<text x="${boxX + 11}" y="${Math.round(top + 24 + LINE_GAP)}" font-size="12" fill="${CARD_TEXT}">${tspans}</text>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}" font-family="PingFang SC, Microsoft YaHei, sans-serif">`
    + (defs ? `<defs>${defs}</defs>` : '')
    + `<g>${parts.join('')}</g></svg>`;
}

const r1 = (value: number): number => Math.round(value * 10) / 10;
