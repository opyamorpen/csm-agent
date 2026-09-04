/**
 * 案例配图·系统集成架构图（architecture）——内容契约解析 + 服务端确定性模板渲染（v17 重排）。
 *
 * 设计原则：模板固定「形态」（画布、主题色表、中心枢纽、左右两列夹峙布局、水平直线走线、
 * 系统就近注释卡、三级字号），客户间差异（外部系统数量/名称/模块/流向）全部由模型输出的
 * 内容 graph 吸收。v17 起 systems 必须与规划期提取的集成系统清单完全一致（requiredSystemNames
 * 校验，两图同源），上限 6 家。模型不再手绘 SVG，渲染产物仍过 sanitizeCaseSvg 兜底。
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
  /** v17：集成系统上限与规划期提取的集成清单对齐（≤6）。 */
  systems: 6,
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
export function parseArchitectureGraph(value: unknown, opts: { textGuard?: (text: string) => string | null; requiredSystemNames?: readonly string[] } = {}): ArchitectureGraphParse {
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
  // v17：systems 必须与规划期提取的集成系统清单完全一致（两图同源契约，名称逐字、数量相等）。
  if (opts.requiredSystemNames?.length) {
    const required = [...new Set(opts.requiredSystemNames)];
    const actual = systems.map((system) => system.name);
    const missing = required.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !required.includes(name));
    if (missing.length || extra.length) {
      const parts: string[] = [];
      if (missing.length) parts.push(`缺少 ${missing.join('、')}`);
      if (extra.length) parts.push(`多出 ${extra.join('、')}`);
      return { error: `systems 必须与集成系统清单完全一致（清单：${required.join('、')}；${parts.join('；')}）——名称逐字使用清单原文、数量相等、不得增删` };
    }
  }

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
 * 系统集成架构图固定为 2:1 蓝图画布（v17：1~6 系统按左右两列夹峙中心 ONES 枢纽的工程化布局）。
 * 外部系统按业务重要性左右轮转入列（1→右；2→左右各一；3→左2右1；4→2+2；5→3+2；6→3+3），
 * 每列按系统数分配模块卡与注释行预算（列内 1/2/3 家 → 模块 ≤6/≤4/≤2、注释 ≤8/≤6/≤4 行），
 * 三档密度兜底。走线为「系统卡侧缘 ↔ 枢纽侧缘」的水平直线（每系统一行、天然无交叉，同系统
 * 多条流以 ±8/±12px 平行错开；卡片中心落在枢纽纵向范围外时经走廊中点正交折转）；注释卡直接
 * 垫在所属系统卡下方（就近可读），不再使用左右独立注释栏。
 */
const CANVAS_W = 1440;
const CANVAS_H = 720;
const MARGIN_X = 24;
const MARGIN_Y = 24;
const COL_W = 320;
const LEFT_X = MARGIN_X;
const RIGHT_X = CANVAS_W - MARGIN_X - COL_W;
const HUB_W = 600;
const HUB_X = Math.round((CANVAS_W - HUB_W) / 2);
const HUB_MIN_H = 176;
const CARD_FILL = '#FFFFFF';
const CARD_STROKE = '#C8D9EE';
const CARD_TEXT = '#1F2329';
const LINE_GAP = 18;
const ANN_PAD = 10;
const ANN_LINE_H = 16;
const STACK_GAP = 10;
const SYSTEM_GAP = 16;
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

/** 每列系统数 → 模块卡预算与注释行预算（列越挤预算越紧，保证任何 1~6 系统都装得下 720 高画布）。 */
const COLUMN_BUDGETS: Record<number, { modules: number; annLines: number }> = {
  1: { modules: 6, annLines: 8 },
  2: { modules: 4, annLines: 6 },
  3: { modules: 2, annLines: 4 },
};

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
interface LaidOutSystem { node: ArchitectureSystemNode; x: number; y: number; w: number; h: number; titleY: number; modules: Box[]; side: 'left' | 'right' }
interface AnnotationCard { system: LaidOutSystem; x: number; y: number; w: number; h: number; header: string; lines: string[] }
/** 走线：卡片侧缘(卡片中心高) ⇄ 走廊中点(竖直折转) ⇄ 枢纽侧缘(laneY)。cardY≠laneY 时三段正交折线。 */
interface FlowLane { index: number; flow: ArchitectureFlow; system: LaidOutSystem; cardY: number; laneY: number; corridorX: number; cardX: number; hubX: number }
interface CanvasLayout { width: number; height: number; hub: { x: number; y: number; w: number; h: number; modules: Box[]; titleY: number; titleH: number }; systems: LaidOutSystem[]; lanes: FlowLane[]; annotations: AnnotationCard[]; density: DensitySpec }

function centeredBoxes(labels: string[], x: number, y: number, w: number, cardW: number, cardH: number, gap: number): Box[] {
  const rowW = labels.length * cardW + Math.max(0, labels.length - 1) * gap;
  const start = x + (w - rowW) / 2;
  return labels.map((label, index) => ({ x: start + index * (cardW + gap), y, w: cardW, h: cardH, label }));
}

/** 系统块布局（y 一律先按 0 计算，列内堆叠定位后再整体平移 y/titleY/modules——vision 验收教训：
 * 只赋 system.y 不平移内部坐标会把标题牌与模块卡全部画到画布顶部）。无模块系统同样画
 * 「tint 容器 + 标题牌」的统一形态（不再画实心色块，跨客户视觉语言一致）。 */
function layoutSystem(node: ArchitectureSystemNode, x: number, y: number, w: number, d: DensitySpec, side: 'left' | 'right'): LaidOutSystem {
  if (!node.modules.length) return { node, x, y, w, h: d.pad + d.titleH + d.pad, titleY: y + d.pad, modules: [], side };
  const cardW = (w - 2 * d.pad - d.cardGap) / 2;
  const rows = Math.ceil(node.modules.length / 2);
  const modules: Box[] = [];
  for (let index = 0; index < rows; index += 1) {
    modules.push(...centeredBoxes(node.modules.slice(index * 2, index * 2 + 2), x + d.pad, y + d.pad + d.titleH + index * (d.cardH + d.cardGap), w - 2 * d.pad, cardW, d.cardH, d.cardGap));
  }
  return { node, x, y, w, h: 2 * d.pad + d.titleH + rows * d.cardH + (rows - 1) * d.cardGap, titleY: y + d.pad, modules, side };
}

/** 系统注释卡：该系统全部数据流收进一张卡（编号+方向+数据内容），行数按列预算钳制。 */
function buildAnnotation(system: LaidOutSystem, flows: Array<{ index: number; flow: ArchitectureFlow }>, annLines: number): AnnotationCard {
  const innerW = COL_W - ANN_PAD * 2 - 8;
  const lines: string[] = [];
  for (const entry of flows) {
    const direction = entry.flow.from === ARCHITECTURE_HUB_KEY ? `ONES → ${system.node.name}` : `${system.node.name} → ONES`;
    lines.push(...wrapMeasured(`${entry.index + 1}、${entry.flow.label}（${direction}）`, innerW, 13).slice(0, 1));
    const body = entry.flow.steps.map((step) => step.text + (step.fields?.length ? `（关联字段：${step.fields.join('、')}）` : '')).join('；');
    lines.push(...wrapMeasured(body, innerW, 13).slice(0, 2));
  }
  const kept = lines.length > annLines ? [...lines.slice(0, Math.max(1, annLines - 1)), '…'] : lines;
  return { system, x: system.x, y: 0, w: COL_W, h: ANN_PAD * 2 + 18 + kept.length * ANN_LINE_H + 4, header: system.node.name, lines: kept };
}

function layoutCanvas(graph: ArchitectureGraph, d: DensitySpec): CanvasLayout | null {
  const count = graph.systems.length;
  if (count < 1 || count > ARCHITECTURE_LIMITS.systems) return null;
  // 枢纽（恒居中）。
  const hubCols = graph.hubModules.length > 6 ? 4 : graph.hubModules.length > 3 ? 3 : 2;
  const hubCardW = (HUB_W - 2 * d.hubPad - (hubCols - 1) * d.hubGap) / hubCols;
  const hubRows = Math.ceil(graph.hubModules.length / hubCols);
  const hubH = Math.max(HUB_MIN_H, d.hubPad * 2 + d.hubTitleH + 12 + hubRows * d.hubCardH + Math.max(0, hubRows - 1) * d.hubGap);
  const hubY = Math.round((CANVAS_H - hubH) / 2);
  const hubModules: Box[] = [];
  for (let index = 0; index < hubRows; index += 1) {
    hubModules.push(...centeredBoxes(graph.hubModules.slice(index * hubCols, index * hubCols + hubCols), HUB_X + d.hubPad, hubY + d.hubPad + d.hubTitleH + 12 + index * (d.hubCardH + d.hubGap), HUB_W - 2 * d.hubPad, hubCardW, d.hubCardH, d.hubGap));
  }

  // 数据流按系统归组（保持 graph 顺序，编号即注释卡里的序号）。
  const flowsBySystem = new Map<string, Array<{ index: number; flow: ArchitectureFlow }>>();
  for (const [index, flow] of graph.flows.entries()) {
    const id = flow.from === ARCHITECTURE_HUB_KEY ? flow.to : flow.from;
    const bucket = flowsBySystem.get(id) ?? [];
    bucket.push({ index, flow });
    flowsBySystem.set(id, bucket);
  }

  // 左右轮转入列：重要者先占左列上位（1 家时只占右列）。预算按【最终列内数量】统一切块——
  // 若按推送时的列内序号取预算，先入列的系统会按 k=1 的宽松预算带满 6 模块，列总高必然超限。
  const columnOf = (index: number): 'left' | 'right' => (count === 1 ? 'right' : index % 2 === 0 ? 'left' : 'right');
  const columns: Record<'left' | 'right', LaidOutSystem[]> = { left: [], right: [] };
  const annotations: AnnotationCard[] = [];
  const columnCounts = { left: graph.systems.filter((_item, seat) => columnOf(seat) === 'left').length, right: graph.systems.filter((_item, seat) => columnOf(seat) === 'right').length };
  for (const [index, node] of graph.systems.entries()) {
    const side = columnOf(index);
    const budget = COLUMN_BUDGETS[Math.min(3, columnCounts[side])];
    columns[side].push(layoutSystem({ ...node, modules: node.modules.slice(0, budget.modules) }, side === 'left' ? LEFT_X : RIGHT_X, 0, COL_W, d, side));
  }

  const lanes: FlowLane[] = [];
  const systems: LaidOutSystem[] = [];
  for (const side of ['left', 'right'] as const) {
    const laid = columns[side];
    if (!laid.length) continue;
    const budget = COLUMN_BUDGETS[laid.length];
    const anns = laid.map((system) => buildAnnotation(system, flowsBySystem.get(system.node.id) ?? [], budget.annLines));
    const total = laid.reduce((sum, system, index) => sum + system.h + STACK_GAP + anns[index].h, 0) + (laid.length - 1) * SYSTEM_GAP;
    if (total > CANVAS_H - MARGIN_Y * 2) return null; // 该档密度装不下 → 降档重排
    let y = Math.round((CANVAS_H - total) / 2);
    for (const [index, system] of laid.entries()) {
      // 列内定位后整体平移内部坐标（titleY/modules 均按 y=0 布局计算）。
      system.titleY += y;
      for (const box of system.modules) box.y += y;
      system.y = y;
      anns[index].y = y + system.h + STACK_GAP;
      y += system.h + STACK_GAP + anns[index].h + SYSTEM_GAP;
    }
    systems.push(...laid);
    annotations.push(...anns);
    // 走线锚点：卡片侧缘取卡片中心（同系统多流 ±8/±12 平行错开）；枢纽侧缘 laneY 也按流序
    // 错开（同系统双向对线不共用锚点，防末段共线压箭头），撞点向枢纽内逐级错开防共线重叠；
    // 竖直折转段走走廊中点附近。
    const usedLaneY = new Set<number>();
    for (const system of laid) {
      const sysFlows = flowsBySystem.get(system.node.id) ?? [];
      const cardX = system.side === 'left' ? system.x + system.w : system.x;
      const hubEdgeX = system.side === 'left' ? HUB_X : HUB_X + HUB_W;
      const corridorBase = Math.round((cardX + hubEdgeX) / 2);
      const cardCenter = Math.round(system.y + system.h / 2);
      const laneBase = Math.min(Math.max(cardCenter, hubY + 24), hubY + hubH - 24);
      for (const [ordinal, entry] of sysFlows.entries()) {
        const offset = sysFlows.length === 1 ? 0 : sysFlows.length === 2 ? (ordinal === 0 ? -8 : 8) : [-12, 0, 12][ordinal % 3];
        const cardY = cardCenter + offset;
        const clampLane = (value: number) => Math.min(Math.max(value, hubY + 20), hubY + hubH - 20);
        let laneY = sysFlows.length > 1 ? clampLane(laneBase + (ordinal % 2 === 0 ? -7 : 7)) : laneBase;
        // 同侧任意已用锚点距离 <10px 即继续下移（箭头三角高 11px，靠太近会咬合）。
        while ([...usedLaneY].some((used) => Math.abs(used - laneY) < 10) && laneY < hubY + hubH - 20) laneY += 12;
        usedLaneY.add(laneY);
        const corridorX = corridorBase + (sysFlows.length === 1 ? 0 : ordinal % 2 === 0 ? -14 : 14);
        lanes.push({ index: entry.index, flow: entry.flow, system, cardY, laneY, corridorX, cardX, hubX: hubEdgeX });
      }
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
    parts.push(`<rect x="${r1(system.x)}" y="${r1(system.y)}" width="${r1(system.w)}" height="${r1(system.h)}" rx="12" fill="${theme.tint}" stroke="${theme.solid}" stroke-width="1" stroke-opacity="0.45"/>`);
    for (const box of system.modules) drawCard(box, 15);
    drawTitle(system.x + system.w / 2, system.titleY, system.node.name, theme.solid, system.w - 14, canvas.density.titleH, 20);
  }

  // 走线：卡片中心落在枢纽纵向范围内时水平直连；否则经走廊中点三段正交折转
  // （起终点分别精确锚在卡片侧缘中心与枢纽侧缘，杜绝悬空起点/箭头扎进注释卡）。
  const colors = [...new Set(canvas.lanes.map((lane) => themeOf(lane.flow.from).solid))];
  const defs = colors.map((color, index) => `<marker id="arch-arrow-${index}" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L11,5.5 L0,11 Z" fill="${color}"/></marker>`).join('');
  for (const lane of canvas.lanes) {
    const theme = themeOf(lane.flow.from);
    const fromSystem = lane.flow.from !== ARCHITECTURE_HUB_KEY;
    // 近水平（|Δy|≤4）时强制两端同 y——严格水平线，杜绝细斜线与端点错位。
    const cardY = Math.abs(lane.laneY - lane.cardY) <= 4 ? lane.laneY : lane.cardY;
    const straight = cardY === lane.laneY;
    const path = straight
      ? (fromSystem
        ? `M ${lane.cardX},${cardY} L ${lane.hubX},${lane.laneY}`
        : `M ${lane.hubX},${lane.laneY} L ${lane.cardX},${cardY}`)
      : (fromSystem
        ? `M ${lane.cardX},${cardY} L ${lane.corridorX},${cardY} L ${lane.corridorX},${lane.laneY} L ${lane.hubX},${lane.laneY}`
        : `M ${lane.hubX},${lane.laneY} L ${lane.corridorX},${lane.laneY} L ${lane.corridorX},${cardY} L ${lane.cardX},${cardY}`);
    parts.push(`<path d="${path}" fill="none" stroke="${theme.solid}" stroke-width="2" stroke-linecap="round" marker-end="url(#arch-arrow-${colors.indexOf(theme.solid)})"/>`);
  }

  for (const annotation of canvas.annotations) {
    const theme = themeOf(annotation.system.node.id);
    parts.push(`<rect x="${r1(annotation.x)}" y="${r1(annotation.y)}" width="${r1(annotation.w)}" height="${r1(annotation.h)}" rx="6" fill="#FFFFFF" stroke="${theme.solid}" stroke-width="1.5"/>`);
    textBlock(parts, annotation.x + ANN_PAD + 4, annotation.y + ANN_PAD + 14, [annotation.header], 14, theme.solid, 'bold', 'start', 0);
    if (annotation.lines.length) {
      textBlock(parts, annotation.x + ANN_PAD + 4, annotation.y + ANN_PAD + 32, annotation.lines, 13, CARD_TEXT, 'normal', 'start', ANN_LINE_H);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}" font-family="PingFang SC, Microsoft YaHei, sans-serif">${defs ? `<defs>${defs}</defs>` : ''}<g>${parts.join('')}</g></svg>`;
}

const r1 = (value: number): number => Math.round(value * 10) / 10;
