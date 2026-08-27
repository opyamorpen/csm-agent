import { createHash } from 'node:crypto';
import type { Runtime } from '../bootstrap.js';
import { argumentsHash } from '../approval.js';
import { extractText } from '../agent.js';
import type { McpHub } from '../mcp/index.js';
import { parseOnesManhourMode, shanghaiDateKey, shanghaiIsoOffset } from './sync.js';
import { WorkbenchDatabase } from './database.js';
import type { Customer, DraftBatch, DraftItem, DraftItemType, SourceEvent } from './types.js';

export const DRAFT_GENERATION_VERSION = 'hemory-drafts-v3-ones-required-fields';
const ONES_CUSTOMER_FIELD_ID = process.env.ONES_CUSTOMER_FIELD_ID ?? 'JrvswW8P';
export const ONES_DESK_PROJECT_ID = 'GL3ysesFPdnAQNIU';
export type OnesDeskDraftType = 'suggestion' | 'ticket' | 'operations';
export const ONES_DESK_ISSUE_TYPE_IDS: Record<OnesDeskDraftType, string> = { suggestion: 'A99xMfkg', ticket: '7sxvwZMY', operations: '943qpMX7' };
const ONES_DESK_TARGET_OBJECTS: Record<OnesDeskDraftType, string> = { suggestion: 'ONES Desk / 建议和反馈', ticket: 'ONES Desk / 工单', operations: 'ONES Desk / 运维工单' };

// ONES Desk 三类工作项除标题/项目/类型外的人工必填字段规格（2026-08-27 经 get_issue_fields 与
// search_for_issue_field_options 核实）。create_new_issue 的 schema 是 additionalProperties:false，
// 只有 title/projectID/issueTypeID 三个顶层参数，其余必填项一律走 fieldValues：
// 选项字段的 value 是选项 UUID，模块/产品（multi_reference）是对象 UUID，成员字段是用户 UUID。
// options 即 label→UUID 映射，供生成时翻译 AI 提案；预检会用实时字段表复核选项 UUID 是否仍有效。
export interface OnesDeskFieldSpec {
  uuid: string;
  label: string;
  /** label → 选项/对象 UUID；成员类字段无法穷举全表，只含默认成员。 */
  options?: Record<string, string>;
  /** 成员字段：允许 8 位用户 UUID 直填（CSM 手工编辑指定其他工程师）。 */
  member?: boolean;
  /** AI 未提案或无法映射时的兜底（零缺失保证：所有规格字段都有兜底；实例部署类型另被 CRM 使用版本确定性覆盖）。 */
  defaultValue?: string;
}

// 所属模块（建议和反馈）：必须用 search_for_modules 的 UUID（工具说明明确指定，且 2026-08-27 逐个
// 试写验证 50/50 全部有效）。search_for_issue_field_options 对 field054 的返回混入约 40 个无效 UUID
//（如 QVtmNu5r 会报 InvalidParameter invalidOption），不可采用。
const ONES_DESK_MODULE_OPTIONS: Record<string, string> = {
  '事件': 'HhvtUuNJ',
  '平台开放能力（OpenAPI、功能扩展、事件）': 'K21NYczY', '功能扩展': 'RbrMxh1n',
  '甘特图属性': 'HBCFxdSD', '甘特图性能问题': 'LiUTxk93', '导入导出': '7UrGLPKZ',
  '基线': 'Dd3YVhjo', '页面组分类': 'N3PEm4a4', '页面属性': 'J2pFBfU9',
  '模版管理': 'Pj5TM5ii', '搜索+筛选': 'QMKwmJLi', '移动端': 'FWMr6KX6',
  '页面通知': 'Rb6xGxRR', '附件管理': 'VQEN9ujx', '审批业务场景': '4PZG5h2H',
  '审批配置': 'EUDLYiHj', 'Wiki+Project': 'LcMQhTkj', '页面标签': '5mMbyUGz',
  '页面复制移动等操作': 'WXVm4nue', '页面导入': 'Y1mmnuBF', '页面导出': 'LUgM6TKk',
  '页面操作': 'RR4cBGRA', '权限配置': 'VeZfQC4e', '工时审批': '5ykWtsNF',
  '工作台-工时日历': 'DZwpkKqi', '燃尽图': '4iN3LVJg', '规划与跟踪': 'PuvUvoEA',
  '计算属性': 'VARew4eQ', '项目集管理': '5mzB3MTu',
  'Project 项目管理 -- 父子工作项（层级关系）': 'SjAPKztR', '甘特图列表和操作': 'KSjNJ3Zc',
  '前后置和排期规则': '4J5Twcvi', '里程碑和交付物': 'QSVA12xn', '甘特图配置': 'J6Bz1JBX',
  '模块组件': '8uWY6XbB', '表单详情': 'VoQt7sGp',
  'Project 项目管理 -- 瀑布组件（甘特图、里程碑...)': '5WswRWSv', '外部门户': '3mhZk41U',
  '表单组件': 'EiqH8C2x', 'OpenAPI': '4udPkSYK', '多数据中心': 'Uf6KenG1',
  '插件（标品插件不要选此项）': '9wUeS6tR', '资源管理配置（工时表单&登记规则&工时提醒）': 'D5d2rcK2',
  '工时报表': 'WsbzjX5T', '工时管理（登记工时&预估工时）': 'AC5rA1w8', '运行历史日志': '4nFayDF8',
  '管理自动化规则': 'ATcQ6cso', '新建自动化规则': 'RiDwmLXr', '条件判断': 'Ef4Bo8BC', '条件分支': 'SV5PSU14',
};

// 所属产品（工单）候选。
const ONES_DESK_PRODUCT_OPTIONS: Record<string, string> = {
  '审批管理': 'PmVnWRqCKtyzjQEh', 'ONES Assistant': 'FFpmuURA2QM2qhGa', 'ONES 运维工具箱': '9eTpLRF6Ux2eMoTc',
  '证书平台': '9eTpLRF6Q6gq859i', 'ONES Note': 'FFpmuURA9GHkpk9z', 'ONES Plan 项目集管理': 'FFpmuURAU2G2JQj1',
  'ONES Task 任务协作': 'FFpmuURA5fzbpGHD', 'ONES Resource 资源管理': 'FFpmuURAQi5L5oed', 'CN 信创': 'FFpmuURANcLJhUB7',
  '零号应用中心与 License 管理': 'FFpmuURA1pbys9vE', '插件': 'HAbxwpBCTwpYZCEC', '海外官网': 'FFpmuURATcQ8xPw5',
  'Automation 流程自动化': 'FFpmuURA8iWR2KZA', 'ONES Design 组件库': 'FFpmuURA9kqPRKBd', 'Desk 工单管理': 'FFpmuURAFJfgSqQ1',
  '基础设施（非业务需求）': 'FFpmuURA8m4XVNyb', 'Dashboard 仪表盘能力': 'FFpmuURAADS2Ybew', 'Jira&Confluence 数据导入': 'FFpmuURAARangPnQ',
  'CRM': 'FFpmuURAV1boyedW', 'Admin-订单中心': 'FFpmuURAXH3s9BYp', '帮助中心与产品手册': 'FFpmuURAVjqznD8G',
  'Admin-系统业务配置': 'FFpmuURAYVNA1Htj', 'Open 开放平台': 'KuZfE9scJNc8ShWY', 'Mobile 手机网页与客户端': 'UPYjaEgNG3ovVqEx',
  'Core 基础平台能力': 'KuZfE9scKYpijpKk', 'Performance 效能管理场景': 'KuZfE9scA5YrpqEX', 'CN Official Website 官网': 'UPYjaEgN17w216os',
  'Account 基础平台能力': 'UPYjaEgNXnPN4Jy6', 'Pipeline DevOps 场景': 'UPYjaEgNYYEBx2tf', 'TestCase 测试管理场景': 'UPYjaEgNQX1K9R3L',
  'Wiki 知识库管理场景': 'UPYjaEgN6cnLBfGR', 'Project 场景与平台': 'UPYjaEgNUpcFp3Av',
};

// 运维工程师默认成员（业务指定吴孟淋）；search_for_users 命中且唯一。
const ONES_DESK_MEMBER_DEFAULTS: Record<string, string> = { '吴孟淋': '5dP9HWdX' };

export const ONES_DESK_FIELD_SPECS: Record<OnesDeskDraftType, OnesDeskFieldSpec[]> = {
  suggestion: [
    { uuid: 'PYbGEZmN', label: '建议类型', defaultValue: '新需求', options: { '新需求': '5qUVAY7m', '产品缺陷': 'XgCJbGc6', '交互问题': 'Q1JBwNUt' } },
    { uuid: 'HS5u8PNB', label: '实例部署类型', defaultValue: '私有云', options: { '私有云': 'KFewLptQ', '公有云': 'Fzg8dBCT' } },
    { uuid: 'field054', label: '所属模块', defaultValue: '功能扩展', options: ONES_DESK_MODULE_OPTIONS },
    { uuid: 'field012', label: '优先级', defaultValue: 'P2', options: { 'P0': 'KhZpaAXJ', 'P1': '762U6awQ', 'P2': 'Lv5Tbmih', 'P3': 'A7UyroWi', 'P4': '5kbJ4VYT' } },
  ],
  ticket: [
    { uuid: 'CATNfrrF', label: '环境类型', defaultValue: 'PRD（生产环境）', options: { 'PRD（生产环境）': 'JuTTumjJ', 'UAT（用户验收环境）': 'SMti68WG', 'SIT（集成测试环境）': 'SmLA83rN', 'DEV（开发环境）': 'RT2kJk9i', 'POC（概念验证环境）': 'U58FbojT' } },
    { uuid: 'HS5u8PNB', label: '实例部署类型', defaultValue: '私有云', options: { '私有云': 'KFewLptQ', '公有云': 'Fzg8dBCT' } },
    { uuid: 'Su4v8xFs', label: '是否稳定复现', defaultValue: '偶现', options: { '稳定复现': 'M1eT99eW', '偶现': 'SyPTtJdW', '无法复现': '6v9NtC12' } },
    { uuid: 'field029', label: '所属产品', defaultValue: 'Core 基础平台能力', options: ONES_DESK_PRODUCT_OPTIONS },
  ],
  operations: [
    { uuid: 'KcwE8f1Y', label: '服务类目', defaultValue: '其他', options: {
      '数据备份与恢复': 'T5HrFS7o', '服务器环境迁移': 'CXALZFMb', '运维配置变更': '3Yn7VQLh', '客户定制操作': 'EHo9vBso',
      '客户技术咨询与会议交流': '4RHPPnhp', '售前响应': '82uArj3Y', '系统巡检': 'E8jFkZn6', '脚本编写': 'TohxYFhQ', '其他': 'PYmJmnwg' } },
    { uuid: 'M9vaUBPP', label: '是否客户付费', defaultValue: '否', options: { '是': 'PUd4Ea28', '否': 'LLiv2UfC' } },
    { uuid: 'TioFkeZn', label: '运维工程师', member: true, defaultValue: '吴孟淋', options: ONES_DESK_MEMBER_DEFAULTS },
  ],
};

/** 实例部署类型字段（建议和反馈/工单共用），按 CRM 使用版本确定性判定。 */
export const ONES_DESK_DEPLOYMENT_FIELD_ID = 'HS5u8PNB';

/**
 * 实例部署类型判定：CRM「使用版本」（field_Q2L6p__c）= 公有云版（value `option1`）→ 公有云，
 * 其余（私有部署两版 value `Hox1iRI04`/`E4H2tH6o4`、缺失、未知）→ 私有云。
 * CRM 返回该单选字段时给的是选项 value 而非 label，两种表示都接受。
 * CRM 是唯一依据，沟通证据不覆盖；返回选项 label。
 */
export function resolveDeploymentType(usageVersion: string | null | undefined): '公有云' | '私有云' {
  return usageVersion === '公有云版' || usageVersion === 'option1' ? '公有云' : '私有云';
}

/**
 * 沟通证据 → 所属模块/所属产品 的分类指引（按 ONES 产品模块层级组织，供 LLM 生成提示词与
 * get_ones_desk_required_fields 本地工具共用）。只指引「选最接近项」，兜底值在代码层兜底。
 */
export const ONES_DESK_CLASSIFICATION_HINTS: Record<'module' | 'product', string[]> = {
  module: [
    'Project 类：父子工作项（层级关系）、甘特图属性/配置/列表和操作/性能问题、瀑布组件（甘特图、里程碑...)、前后置和排期规则、里程碑和交付物、模块组件、表单详情、表单组件、基线、燃尽图、规划与跟踪、计算属性、项目集管理',
    'Wiki 类：页面操作、页面属性、页面组分类、页面导入、页面导出、页面复制移动等操作、页面标签、页面通知、附件管理、审批业务场景、审批配置、模版管理、搜索+筛选、移动端、Wiki+Project',
    '工时资源类：工时管理（登记工时&预估工时）、工时审批、工时报表、工作台-工时日历、资源管理配置（工时表单&登记规则&工时提醒）',
    '自动化类：管理自动化规则、新建自动化规则、条件判断、条件分支',
    '开放集成类：OpenAPI、功能扩展、事件、平台开放能力（OpenAPI、功能扩展、事件）、插件（标品插件不要选此项）、多数据中心、外部门户',
    '其他：导入导出、运行历史日志、事件',
  ],
  product: [
    'ONES Project（项目管理）：Project 场景与平台、Core 基础平台能力、Dashboard 仪表盘能力、Automation 流程自动化、Mobile 手机网页与客户端',
    'ONES Wiki（知识库）：Wiki 知识库管理场景、ONES Note',
    '测试：TestCase 测试管理场景',
    '效能与项目集：Performance 效能管理场景、ONES Plan 项目集管理、ONES Resource 资源管理、ONES Task 任务协作',
    '平台与账号：Account 基础平台能力、Admin-系统业务配置、Admin-订单中心、零号应用中心与 License 管理、证书平台、审批管理',
    '服务与支持：Desk 工单管理、ONES 运维工具箱、帮助中心与产品手册',
    '集成与开放：Open 开放平台、插件、Jira&Confluence 数据导入、ONES Assistant、ONES Design 组件库、CRM、CN 信创、基础设施（非业务需求）、海外官网、CN Official Website 官网',
  ],
};

// 描述字段落点：create_new_issue 无顶层 description 参数，Hemory 摘要写入 field016（rich_desc，
// 运维工单上为必填；建议/工单上选填但保持一致，便于 ONES 端阅读）。
const ONES_DESK_DESC_FIELD_ID = 'field016';

/**
 * label → 选项 UUID 解析（逐级放宽）：精确 → 大小写无关去空格 → 选项 label 包含提案或提案以选项开头
 *（近似 label 纠偏，如「工时管理」→「工时管理（登记工时&预估工时）」）→ UUID 直填。
 * 大小写无关与包含式匹配都要求命中唯一，防止「工时」同时命中多个工时类选项。
 */
function resolveOptionLabel(label: string, spec: OnesDeskFieldSpec): string | null {
  if (!label) return null;
  if (spec.options?.[label]) return spec.options[label];
  const normalized = label.trim().toLowerCase();
  const keys = Object.keys(spec.options ?? {});
  const caseInsensitive = keys.filter((key) => key.toLowerCase() === normalized);
  if (caseInsensitive.length === 1) return spec.options![caseInsensitive[0]];
  const partial = keys.filter((key) => key.includes(label) || label.includes(key));
  if (partial.length === 1) return spec.options![partial[0]];
  return null;
}

/** 把 AI 提案（字段名→选项名/成员名）映射成 fieldValues；带 defaultValue 的字段在缺省或映射失败时兜底。 */
export function mapOnesDeskRequiredFields(deskType: OnesDeskDraftType, proposed: Record<string, unknown> | undefined): Array<Record<string, string>> {
  const values: Array<Record<string, string>> = [];
  for (const spec of ONES_DESK_FIELD_SPECS[deskType]) {
    const label = typeof proposed?.[spec.label] === 'string' ? String(proposed[spec.label]).trim() : '';
    let uuid = '';
    if (label && spec.options?.[label]) uuid = spec.options[label];
    else if (label && spec.member && /^[A-Za-z0-9]{8}$/.test(label)) uuid = label; // 成员字段支持用户 UUID 直填
    else if (label && Object.values(spec.options ?? {}).includes(label)) uuid = label; // 选项字段 UUID 直填（CSM 手工编辑）
    else if (label) uuid = resolveOptionLabel(label, spec) ?? '';
    if (!uuid && spec.defaultValue) uuid = spec.options?.[spec.defaultValue] ?? '';
    if (uuid) values.push({ fieldID: spec.uuid, value: uuid });
  }
  return values;
}

/**
 * 实例部署类型确定性覆盖：CRM 使用版本是唯一依据（公有云版→公有云，其余→私有云），
 * 模型提案与兜底值都不参与。Hemory 自动草稿在 buildTarget 里调用；交互式草稿由
 * get_ones_desk_required_fields 返回解析值、批准门校验一致性。
 */
export function applyDeploymentTypeOverride(deskType: OnesDeskDraftType, usageVersion: string | null | undefined): Array<Record<string, string>> {
  if (deskType !== 'suggestion' && deskType !== 'ticket') return [];
  const label = resolveDeploymentType(usageVersion);
  const uuid = ONES_DESK_FIELD_SPECS[deskType].find((spec) => spec.uuid === ONES_DESK_DEPLOYMENT_FIELD_ID)?.options?.[label];
  return uuid ? [{ fieldID: ONES_DESK_DEPLOYMENT_FIELD_ID, value: uuid }] : [];
}

/** 批准门校验：fieldValues 必须覆盖目标类型规格表的全部字段（零缺失保证）。非 ONES Desk 类型返回空。 */
export function missingOnesDeskSpecFields(recordType: string, fieldValues: Array<Record<string, unknown>>): OnesDeskFieldSpec[] {
  const deskType = onesDeskTypeId(recordType as DraftItemType);
  if (!deskType) return [];
  const provided = new Set(fieldValues.filter((value) => value.value != null && value.value !== '').map((value) => String(value.fieldID)));
  return ONES_DESK_FIELD_SPECS[deskType].filter((spec) => !provided.has(spec.uuid));
}
// ONES 工时按实例配置的模式二选一写工具；宽松正则匹配曾把 create_new_issue（描述里带 manhour 字样）误当工时工具。
type OnesWorkhourMode = 'simple' | 'summary';
const ONES_WORKHOUR_TOOLS: Record<OnesWorkhourMode, string> = { simple: 'add_workhour_in_simple_mode', summary: 'add_workhour_in_summary_mode' };
// CRM 跟进记录（销售记录）必须关联的 CSM 售后客户对象；其 _id 是工作台唯一客户主键。
const CRM_AFTER_SALES_OBJECT = 'object_Umwnn__c';
const MAX_DRAFT_ITEMS = 12;

function onesDeskTypeId(type: DraftItemType): OnesDeskDraftType | null {
  return type === 'suggestion' || type === 'ticket' || type === 'operations' ? type : null;
}

// 生成与校验共用的客户 option 解析：本客户 confirmed 身份优先；
// 历史草稿可能绑在 AccountObj 旧行上，按名称唯一复用同名售后客户的身份（与 followup 的 afterSales 回退同构）。
function resolveOnesOption(db: WorkbenchDatabase, customer: Customer): { id: string; label: string } | undefined {
  const find = (id: string) => {
    const identity = db.listIdentities(id).find((item) => item.system === 'ones_customer_option' && item.status === 'confirmed');
    return identity?.external_id ? { id: String(identity.external_id), label: String(identity.label ?? '') } : undefined;
  };
  const own = find(customer.id);
  if (own) return own;
  const sameName = db.listCustomers().filter((item) => item.id !== customer.id && item.name === customer.name);
  return sameName.length === 1 ? find(sameName[0].id) : undefined;
}

interface DraftProposal {
  type: DraftItemType;
  title: string;
  summary: string;
  fields?: Record<string, unknown>;
  evidenceRefs?: string[];
  unknowns?: string[];
}

/** 工时草稿的工具绑定依据：实例工时模式；获取失败时以 error 降级为校验错误。 */
interface WorkhourToolBinding {
  mode: OnesWorkhourMode | null;
  error: string | null;
}

export interface OnesIssueField {
  uuid: string;
  name: string;
  required: boolean;
  builtIn: boolean;
  canBeCreated: boolean;
  fieldTypeUuid: string;
  options: Array<{ uuid: string; value: string }>;
}

// get_issue_fields 返回 {result:'SUCCESS', data:{list:[{uuid,name,required,built_in,can_be_created,field_type_uuid,options:[{uuid,value}]}]}}。
// 解析失败返回 null，调用方保持原有“只看 isError”的行为，不因形状变化阻断预检。
export function parseOnesIssueFields(text: string): OnesIssueField[] | null {
  const value = cleanJson(text) as { result?: unknown; data?: { list?: unknown } } | null;
  const list = Array.isArray(value?.data?.list) ? value.data.list : null;
  if (!list) return null;
  const fields: OnesIssueField[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const uuid = typeof item.uuid === 'string' ? item.uuid : null;
    const name = typeof item.name === 'string' ? item.name : null;
    if (!uuid || !name) return null;
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
        const entry = option && typeof option === 'object' && !Array.isArray(option) ? option as Record<string, unknown> : null;
        const optionUuid = typeof entry?.uuid === 'string' ? entry.uuid : null;
        const optionValue = typeof entry?.value === 'string' ? entry.value : null;
        return optionUuid && optionValue ? [{ uuid: optionUuid, value: optionValue }] : [];
      })
      : [];
    fields.push({ uuid, name, required: item.required === true, builtIn: item.built_in === true,
      canBeCreated: item.can_be_created !== false, fieldTypeUuid: typeof item.field_type_uuid === 'string' ? item.field_type_uuid : '', options });
  }
  return fields;
}

// 平台自动填充的字段（创建者/状态/负责人等）不必出现在写参数里。
const ONES_AUTOFILLED_FIELD_TYPES = new Set(['creator', 'status', 'assign']);
// 标题/所属项目/工作项类型由 create_new_issue 的顶层参数（title/projectID/issueTypeID）满足；
// 其余必填项（含描述 field016，schema 无顶层 description 参数）必须出现在 fieldValues 中。
const ONES_TOP_LEVEL_FIELD_UUIDS = new Set(['field001', 'field006', 'field007']);
// 建议和反馈等类型上标了 required 但 can_be_created=false 的展示字段（如反馈类型），实际由 ONES 内部规则处理，跳过。
export function missingOnesRequiredFields(fields: OnesIssueField[], fieldValues: Array<Record<string, unknown>>): OnesIssueField[] {
  const provided = new Set(fieldValues.filter((value) => value.value != null && value.value !== '').map((value) => String(value.fieldID)));
  return fields.filter((field) => field.required && field.canBeCreated
    && !ONES_AUTOFILLED_FIELD_TYPES.has(field.fieldTypeUuid)
    && !ONES_TOP_LEVEL_FIELD_UUIDS.has(field.uuid)
    && !provided.has(field.uuid));
}

/**
 * fieldValues 中带选项表的字段：值必须是该字段当前有效选项 UUID 之一（配置漂移防护）。
 * get_issue_fields 对大选项集字段（客户信息 100+ 选项）只返回前 30/50 条且不保证覆盖目标值，
 * 这类截断表（字段返回的 options 恰好达到截断上限）无法证伪，跳过校验；
 * 小选项集（服务类目/优先级等）返回完整，UUID 不在表内即可判定失效。
 */
export function invalidOnesOptionValues(fields: OnesIssueField[], fieldValues: Array<Record<string, unknown>>): string[] {
  // get_issue_fields 截断上限 30；达到该数即视为可能截断。
  const TRUNCATED_OPTION_COUNT = 30;
  const byId = new Map(fields.map((field) => [field.uuid, field]));
  const invalid: string[] = [];
  for (const value of fieldValues) {
    const field = byId.get(String(value.fieldID));
    if (!field || !field.options.length) continue;
    if (field.options.length >= TRUNCATED_OPTION_COUNT) continue;
    const option = String(value.value ?? '');
    if (!field.options.some((entry) => entry.uuid === option)) invalid.push(`${field.name}(${field.uuid})=${option}`);
  }
  return invalid;
}

export interface DraftPreview {
  batchId: string;
  items: Array<{ id: string; version: number; approvalHash: string; validationErrors: string[] }>;
}

export interface DraftDisplayField {
  key: string;
  label: string;
  value: string;
}

const ONES_DESK_PROJECT_LABEL = 'ONES Desk';
const ONES_DESK_TYPE_LABELS: Record<OnesDeskDraftType, string> = { suggestion: '建议和反馈', ticket: '工单', operations: '运维工单' };

/**
 * 草稿确认时的最小必填项展示：每种类型一组键值行，Web 卡片与 CLI 共用同一份结构。
 * ONES 工作项按“所属项目 / 工作项类型 / 标题 / 客户信息 / 必填项 / 描述”展示；必填项把选项 UUID 反解成名称。
 */
export function draftDisplayFields(db: WorkbenchDatabase, item: DraftItem, customer: Customer): DraftDisplayField[] {
  const unknown = (value: unknown) => value == null || value === '' || value === 'unknown' ? '待补充' : String(value);
  if (onesDeskTypeId(item.type)) {
    const deskType = onesDeskTypeId(item.type)!;
    const option = resolveOnesOption(db, customer);
    const values = Array.isArray(item.targetArguments.fieldValues) ? item.targetArguments.fieldValues as Array<Record<string, unknown>> : [];
    const valueOf = (uuid: string) => values.find((value) => value.fieldID === uuid)?.value;
    const requiredRows: DraftDisplayField[] = ONES_DESK_FIELD_SPECS[deskType].map((spec) => {
      const raw = valueOf(spec.uuid);
      const label = spec.options ? (Object.entries(spec.options).find(([, uuid]) => uuid === raw)?.[0] ?? (raw ? String(raw) : '')) : String(raw ?? '');
      return { key: spec.uuid, label: spec.label, value: label || '待补充' };
    });
    return [
      { key: 'project', label: '所属项目', value: `${ONES_DESK_PROJECT_LABEL}（${String(item.targetArguments.projectID ?? '')}）` },
      { key: 'issueType', label: '工作项类型', value: `${ONES_DESK_TYPE_LABELS[deskType]}（${String(item.targetArguments.issueTypeID ?? '')}）` },
      { key: 'title', label: '标题', value: item.title },
      { key: 'customer', label: '客户信息', value: option
        ? option.label && option.label !== customer.name ? `${customer.name} → ${option.label}` : (option.label || customer.name)
        : `${customer.name}（ONES 客户信息未解析）` },
      ...requiredRows,
      { key: 'description', label: '描述', value: String(values.find((value) => value.fieldID === ONES_DESK_DESC_FIELD_ID)?.value ?? item.summary) },
    ];
  }
  if (item.type === 'workhour') {
    return [
      { key: 'target', label: '目标工作项', value: item.targetArguments.issueID ? `客户工时管理 / 售后客户（${String(item.targetArguments.issueID)}）` : '客户工时管理 / 售后客户（未绑定）' },
      { key: 'hours', label: '工时时长', value: unknown(item.targetArguments.hours) },
      { key: 'startTime', label: '开始时间', value: String(item.targetArguments.startTime ?? '') },
      { key: 'description', label: '描述', value: String(item.targetArguments.description ?? item.summary) },
    ];
  }
  if (item.type === 'followup') {
    const objectData = item.targetArguments.object_data as Record<string, unknown> | undefined;
    const related = Array.isArray(objectData?.related_object_data) ? objectData.related_object_data as Array<Record<string, unknown>> : [];
    const bound = related.find((entry) => entry?.describe_api_name === CRM_AFTER_SALES_OBJECT);
    return [
      { key: 'target', label: '目标对象', value: 'CRM / 销售记录（跟进）' },
      { key: 'customer', label: '关联客户', value: bound ? `${String(bound.name ?? '')}（${String(bound.id ?? '')}）` : '未绑定 CRM 售后客户' },
      { key: 'title', label: '标题', value: item.title },
      { key: 'summary', label: '当日一句话', value: unknown(String(item.fields?.one_line_summary ?? '')) },
      { key: 'content', label: '跟进内容', value: String(objectData?.active_record_content ?? item.summary) },
    ];
  }
  return [
    { key: 'target', label: '目标', value: item.targetObject },
    { key: 'title', label: '标题', value: item.title },
    { key: 'owner', label: '负责人', value: unknown(item.targetArguments.owner) },
    { key: 'dueAt', label: '截止时间', value: unknown(item.targetArguments.dueAt) },
    { key: 'whyNow', label: '待办背景', value: String(item.targetArguments.whyNow ?? item.summary) },
  ];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function textOf(event: SourceEvent): string {
  return String(event.payload?.transcript ?? event.title);
}

/** 片段的分节正文：分段器摘要（措辞规整）优先，缺失时回退转写原文。 */
function segmentSummaryOf(event: SourceEvent): string {
  const summary = typeof event.payload?.summary === 'string' ? event.payload.summary.trim() : '';
  return summary || textOf(event);
}

function cleanJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* inspect embedded JSON below */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* invalid model output */ }
  }
  return null;
}

// ONES 工作项信号门控：LLM 语义提案之外，证据文本还必须命中该类型的业务信号才放行。
// 宁缺毋滥——方案/workaround 讨论、商务付费话题、客户内部流程、泛泛不满只进沟通记录，不建工作项。
// operations 最谨慎：请求标记必须与运维操作名词邻近出现（短语级合取，防止长转写里两个词各自孤立命中）。
const ONES_SIGNAL_PATTERNS: Record<OnesDeskDraftType, RegExp> = {
  suggestion: /还不满足|满足不了|还不支持|标品.{0,8}(不支持|没有|缺|做不到)|目前.{0,6}(不支持|没有|做不到)|暂时不支持|没有这个(功能|报表|能力|模块|选项)|缺少|缺失|反馈.{0,8}需求|提个?需求|新需求|核心需求|有个需求|希望.{0,24}(支持|增加|提供|开放|加上|实现|纳入|加到|加进)|建议.{0,12}(增加|支持|提供|开放|纳入)|(加入|放到?|放进?|纳入|整合到?).{0,6}标品|标品(里面|中|里)?(没有|不支持|缺|做不到)|能不能.{0,16}(支持|加|做|提供|开放)/i,
  // 转写口语噪声大（今晨 10K 字转写里 bug/故障几乎必有偶现命中）：ticket 信号只采标题、分段摘要与 focus，
  // 不扫转写原文——片段级兜底只求保守召回，误判代价比漏报高。
  ticket: /bug|缺陷|不符合预期|跟预期不一致|不正常|不对劲|算错|算不对|统计错|逻辑错|逻辑有问题|数据不对|数据错|数据不准|显示错|展示不对|无法使用|不可用|用不了|没法用|报错|出错|故障|白屏|卡死|崩溃|挂了/i,
  // operations 误判主因是「配置」：改报表筛选/插件配置是产品使用行为，不是运维操作，不纳入信号词。
  operations: /(需要|得|请|麻烦|帮忙|协助|能不能|可不可以|要不要|想|安排|提交|申请|要).{0,20}(环境重装|重装|数据迁移|迁移|备份|还原|恢复|搭建环境|搭环境|初始化|运维?配置|改配置|调整配置|证书|https?|域名|服务器|磁盘|扩容|巡检|重建索引|升级|部署)|(重装|迁移|备份|恢复|运维?配置|证书|域名|服务器|磁盘|扩容|巡检|索引|升级|部署).{0,12}(一下|需要|帮忙|协助|处理)/i,
};

/** 信号检测的文本范围：标题 + 分段摘要 + focus（分段摘要措辞更规整，弥补口语转写噪声）；ticket 不扫转写。 */
function onesSignalText(events: SourceEvent[], includeTranscript = true): string {
  return events.map((event) => [event.title, event.payload?.summary, event.payload?.focus,
    includeTranscript ? textOf(event) : ''].filter((part) => typeof part === 'string' && part.trim()).join('\n')).join('\n');
}

function hasOnesDraftSignal(type: OnesDeskDraftType, events: SourceEvent[]): boolean {
  return ONES_SIGNAL_PATTERNS[type].test(onesSignalText(events, type !== 'ticket'));
}

export function classifyDraftTypes(events: SourceEvent[]): DraftItemType[] {
  const text = events.map(textOf).join('\n');
  const types = new Set<DraftItemType>(['followup']);
  if (/(待办|需要|请.{0,12}(负责|跟进|准备|确认)|下周|月底|之前.{0,12}(完成|给到)|action\s*item|todo)/i.test(text)) types.add('internal_todo');
  if (/(工时|小时|人天|投入.{0,8}(时间|天)|耗时|花了.{0,8}(小时|天))/i.test(text)) types.add('workhour');
  // suggestion/ticket/operations 与信号门控共用同一套判定，规则兜底与 LLM 门控口径一致。
  for (const type of Object.keys(ONES_SIGNAL_PATTERNS) as OnesDeskDraftType[]) {
    if (hasOnesDraftSignal(type, events)) types.add(type);
  }
  return [...types];
}

function defaultProposal(type: DraftItemType, customer: Customer, events: SourceEvent[]): DraftProposal {
  const quote = events.map(textOf).join('；').slice(0, 1200);
  const first = events[0];
  const dateKey = events.length ? shanghaiEventDate(events[0]) : shanghaiDateKey();
  const base = { evidence_quotes: events.map(textOf), occurred_at: first?.occurredAt ?? new Date().toISOString() };
  const topics = events.map((event) => event.title);
  const speakers = [...new Set(events.flatMap((event) => (Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : []).filter(Boolean)))];
  if (type === 'internal_todo') return { type, title: first?.title.slice(0, 100) || `跟进 ${customer.name}`,
    summary: quote, fields: { ...base, owner: 'unknown', due_at: 'unknown', expected_outcome: 'unknown' }, unknowns: ['负责人', '截止时间'] };
  if (type === 'workhour') return { type, title: `${customer.name} ${dateKey} 客户沟通工时`, summary: quote,
    fields: { ...base, hours: 'unknown', description: quote, date_key: dateKey }, unknowns: ['工时时长'] };
  if (type === 'suggestion') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户需求`, summary: quote,
    fields: { ...base, description: quote }, unknowns: [] };
  if (type === 'ticket') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户工单`, summary: quote,
    fields: { ...base, description: quote, severity: 'unknown' }, unknowns: ['严重程度'] };
  if (type === 'operations') return { type, title: first?.title.slice(0, 100) || `${customer.name}客户运维事项`, summary: quote,
    fields: { ...base, description: quote, severity: 'unknown' }, unknowns: ['严重程度'] };
  // followup：天粒度合并——全天片段按【话题】分节汇总，标题带日期；分节正文优先片段自带分段摘要。
  return { type, title: `${customer.name} ${dateKey} 沟通记录`,
    summary: events.map((event) => `【${event.title}】\n${segmentSummaryOf(event)}`).join('\n\n').slice(0, 3000),
    fields: { ...base, date_key: dateKey, method: '会议', participants: speakers, key_topics: topics,
      one_line_summary: `与${customer.name}就${topics.slice(0, 3).join('、')}等进行沟通`, next_steps: 'unknown' }, unknowns: ['下一步计划'] };
}

async function proposeWithModel(runtime: Runtime, customer: Customer, events: SourceEvent[], unpublishedEvents: SourceEvent[]): Promise<DraftProposal[]> {
  const unpublished = new Set(unpublishedEvents.map((event) => event.id));
  const evidence = events.map((event) => ({ id: event.id, occurred_at: event.occurredAt,
    published: !unpublished.has(event.id),
    speakers: Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : [], text: textOf(event) }));
  const requiredGuide = (Object.keys(ONES_DESK_FIELD_SPECS) as OnesDeskDraftType[])
    .map((type) => `- ${type}：${ONES_DESK_FIELD_SPECS[type].map((spec) => `${spec.label}（${spec.options ? Object.keys(spec.options).join('|') : '成员名'}）`).join('、')}`)
    .join('\n');
  const classificationGuide = `所属模块分类指引（按 ONES 产品模块层级，选最接近的一项）：\n${ONES_DESK_CLASSIFICATION_HINTS.module.map((line) => `- ${line}`).join('\n')}\n`
    + `所属产品分类指引（按 ONES 产品线，选最接近的一项）：\n${ONES_DESK_CLASSIFICATION_HINTS.product.map((line) => `- ${line}`).join('\n')}\n`;
  const prompt = `为客户当天的全部沟通片段生成结构化草稿。只允许类型 internal_todo、workhour、followup、suggestion、ticket、operations。\n`
    + `followup（沟通记录）必须且只能输出一条：合并当天全部 published=false 的片段；其 fields 必须包含 one_line_summary（一句话总结当天沟通）和 sections 数组——published=false 的每个片段恰好一项 {"evidence_id":"片段id","summary":"该片段的摘要"}。每段 summary 2~4 句，忠于该片段自己的转写，写明该话题的关键结论、决定与后续行动，不得与其他片段的 summary 雷同、不得写成全天综述。sections 必须覆盖全部 published=false 片段，不得遗漏。published=true 的片段已写入 CRM，禁止纳入 followup。\n`
    + `workhour 不必输出（系统按录音时长自动计算并连带生成）。internal_todo 可以输出多条，每条对应独立的行动；只返回有证据支持的草稿。\n`
    + `suggestion/ticket/operations 是要写入 ONES 的工作项，宁缺毋滥：必须严格满足以下判定标准，沟通证据不足以判定就不输出该草稿（相关内容仍会保留在沟通记录里）。\n`
    + `- suggestion（建议和反馈）：客户明确表达产品能力不满足——如“现在还满足不了我们的需求”“标品还不支持这个”“这个需求我反馈一下”“希望以后支持/增加某功能”。方案讨论、workaround、客户内部流程、商务与付费话题、对交付节奏的不满都不算。\n`
    + `- ticket（工单）：客户明确指认产品缺陷——如“这是个 bug”“这不符合预期”“行为不正常”“数据算错了”。单纯的疑问、配置咨询、使用方法讨论、性能慢的抱怨不算。\n`
    + `- operations（运维工单）：客户明确提出需要运维服务操作——如环境重装、数据迁移、配置变更、证书/域名/服务器/备份等基础设施操作请求。只在客户明确提出操作请求时才输出，三者中最谨慎；一般的系统问题反馈、索引慢查询、插件交付都不算。\n`
    + `suggestion/ticket/operations 的 fields 必须包含 ones_required 对象（键=字段名，值=选项名，从选项列表中选）。这些是 ONES 必填字段，你要根据沟通证据理解后给出提案，不得留空、不得写 unknown：\n`
    + `${requiredGuide}\n`
    + `ones_required 证据不足时的保守默认：服务类目→其他、是否客户付费→否、运维工程师→吴孟淋、优先级→P2、实例部署类型→私有云、环境类型→PRD（生产环境）、是否稳定复现→偶现、建议类型→新需求；所属模块/所属产品必须按下方分类指引选最接近的一项，不得留空。\n`
    + `${classificationGuide}\n`
    + `每条草稿的 evidence_refs 必须列出它依据的证据 id。不得猜测负责人、日期、时长或事实，缺失值写 "unknown" 并列入 unknowns（ones_required 除外，按上面的保守默认给值）。\n`
    + `只输出 JSON：{"drafts":[{"type":"...","title":"...","summary":"...","fields":{},"evidence_refs":["..."],"unknowns":[]}]}。\n`
    + `客户：${customer.name}（CRM ${customer.id}${customer.usageVersion ? `，使用版本 ${customer.usageVersion}` : ''}）\n证据：${JSON.stringify(evidence)}`;
  const response = await runtime.models.complete(runtime.model, {
    systemPrompt: '你是 CSM 草稿分类器。你只能整理用户提供的证据，不执行任何工具或外部写入。',
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    tools: [],
  });
  const value = cleanJson(extractText(response.content)) as { drafts?: unknown[] } | null;
  if (!Array.isArray(value?.drafts)) throw new Error('模型未返回 drafts 数组');
  const allowed = new Set<DraftItemType>(['internal_todo', 'workhour', 'followup', 'suggestion', 'ticket', 'operations']);
  return value.drafts.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    if (!allowed.has(item.type as DraftItemType) || typeof item.title !== 'string' || typeof item.summary !== 'string') return [];
    return [{ type: item.type as DraftItemType, title: item.title, summary: item.summary,
      fields: item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields) ? item.fields as Record<string, unknown> : {},
      evidenceRefs: Array.isArray(item.evidence_refs) ? item.evidence_refs.map(String) : undefined,
      unknowns: Array.isArray(item.unknowns) ? item.unknowns.map(String) : [] }];
  });
}

/** 片段所属上海自然日；occurred_at 无效时按当前日期兜底。 */
export function shanghaiEventDate(event: SourceEvent): string {
  const at = new Date(event.occurredAt);
  return shanghaiDateKey(Number.isNaN(at.getTime()) ? new Date() : at);
}

/** 天粒度指纹：同客户同日同片段集合（含内容 hash）复用同一批次，新增/变化片段自然换指纹重建。 */
export function draftFingerprint(customerId: string, dateKey: string, events: SourceEvent[]): string {
  const sources = [...events].sort((a, b) => a.id.localeCompare(b.id)).map((event) => `${event.id}:${event.payloadHash}`);
  return hash(`${DRAFT_GENERATION_VERSION}:${customerId}:${dateKey}:${sources.join('|')}`);
}

export function sortedDraftEvents(events: SourceEvent[]): SourceEvent[] {
  return [...events].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 从片段自带的录音时间计算当天沟通工时：按录音聚合该客户片段的首尾时刻求跨度，跨录音求和（小时，1 位小数）。
 * 任一录音缺 recordingId/时间数据或跨度为零时返回 null，交由“请补充工时时长”校验路径人工处理。
 */
export function computeWorkhours(events: SourceEvent[]): number | null {
  const spans = new Map<string, { start: number; end: number }>();
  for (const event of events) {
    const recordingId = String(event.payload?.recordingId ?? '');
    if (!recordingId) return null;
    const start = new Date(String(event.payload?.startAt ?? event.occurredAt)).getTime();
    const end = new Date(String(event.payload?.endAt ?? event.occurredAt)).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const current = spans.get(recordingId);
    spans.set(recordingId, current ? { start: Math.min(current.start, start), end: Math.max(current.end, end) } : { start, end });
  }
  if (!spans.size) return null;
  let total = 0;
  for (const span of spans.values()) {
    if (span.end <= span.start) return null;
    total += span.end - span.start;
  }
  const hours = Math.round((total / 3_600_000) * 10) / 10;
  return hours > 0 ? hours : null;
}

export class HemoryDraftService {
  private processing = new Set<string>();

  constructor(private readonly db: WorkbenchDatabase, private readonly mcp: McpHub, private readonly runtime?: Runtime) {}

  /** 按客户 + 上海自然日入队：跨天归属每天一个批次；返回当天（各天）的生成任务。 */
  enqueue(customerId: string, eventIds: string[]): Array<{ jobId: string; fingerprint: string }> {
    const events = this.confirmedSegments(customerId, eventIds);
    if (!events.length) return [];
    const days = [...new Set(events.map((event) => shanghaiEventDate(event)))];
    return days.map((dateKey) => this.generateForDay(customerId, dateKey, false))
      .filter((job): job is { jobId: string; fingerprint: string } => !!job);
  }

  regenerate(batchId: string): Array<{ jobId: string; fingerprint: string }> {
    const batch = this.db.getDraftBatch(batchId);
    if (!batch) throw new Error('draft batch not found');
    const days = new Set<string>();
    for (const id of batch.sourceEventIds) {
      const event = this.db.getSourceEvent(id);
      if (event && event.customerId === batch.customerId) days.add(shanghaiEventDate(event));
    }
    if (!days.size) throw new Error('批次没有仍归属于该客户的 Hemory 片段');
    return [...days].map((dateKey) => this.generateForDay(batch.customerId, dateKey, true))
      .filter((job): job is { jobId: string; fingerprint: string } => !!job);
  }

  private confirmedSegments(customerId: string, eventIds: string[]): SourceEvent[] {
    // 停用片段不得再生草稿：重切后被取代的 v1 片段即使仍是 confirmed 也已经不属于当前代际。
    return [...new Set(eventIds)].map((id) => this.db.getSourceEvent(id)).filter((event): event is SourceEvent =>
      !!event && event.customerId === customerId && event.attributionStatus === 'confirmed'
      && event.sourceSystem === 'hemory' && event.sourceType === 'ai_topic_segment' && this.db.isHemoryFragmentActive(event.id));
  }

  // 天粒度批次：同客户同日一条合并沟通记录 + 一条连带工时；旧录音级批次会被同日重建自然取代。
  private generateForDay(customerId: string, dateKey: string, force: boolean): { jobId: string; fingerprint: string } | null {
    const events = this.db.listConfirmedHemorySegmentsForDay(customerId, dateKey);
    if (!events.length) return null;
    const fingerprint = draftFingerprint(customerId, dateKey, events);
    const existing = this.db.findDraftBatchByFingerprint(fingerprint);
    if (existing && !force && existing.status !== 'stale') {
      // 同一天片段集合已有可用批次时保持幂等，直接复用原任务；只有批次已作废才需要换盐重新生成。
      return { jobId: this.db.findDraftJobByFingerprint(fingerprint)?.id ?? '', fingerprint };
    }
    this.db.markDraftsStaleForEvents(events.map((event) => event.id));
    const finalFingerprint = existing || force
      ? hash(`${fingerprint}:regenerate:${Date.now()}:${Math.random()}`)
      : fingerprint;
    return this.createGenerationJob(customerId, events, finalFingerprint);
  }

  private createGenerationJob(customerId: string, events: SourceEvent[], fingerprint: string): { jobId: string; fingerprint: string } {
    const job = this.db.createDraftJob(customerId, fingerprint, events.map((event) => event.id));
    if (job.status !== 'succeeded') void this.process(job.id);
    return { jobId: job.id, fingerprint };
  }

  resumePending(): void {
    for (const job of this.db.listPendingDraftJobs()) if (job.attempts < 3) void this.process(job.id);
  }

  private async process(jobId: string): Promise<void> {
    if (this.processing.has(jobId)) return;
    const job = this.db.getDraftJob(jobId);
    if (!job || job.status === 'succeeded') return;
    this.processing.add(jobId);
    this.db.updateDraftJob(jobId, 'running');
    try {
      const customer = this.db.getCustomer(job.customerId);
      if (!customer) throw new Error('customer not found');
      const seeded = job.sourceEventIds.map((id) => this.db.getSourceEvent(id))
        .filter((event): event is SourceEvent => !!event && event.customerId === customer.id);
      if (!seeded.length) throw new Error('没有仍归属于该客户的 Hemory 片段');
      // 以任务种子推导上海日后取当天全部已确认活跃片段：任务排队期间新归属的同日片段也会并入。
      const dateKey = shanghaiEventDate(seeded[0]);
      const events = this.db.listConfirmedHemorySegmentsForDay(customer.id, dateKey);
      if (!events.length) throw new Error('没有仍归属于该客户的 Hemory 片段');
      // 发布豁免：当天已写入 CRM 的沟通（工作台确认的草稿或 CRM 已有跟进记录）之后才算新沟通。
      const cutoff = this.db.followupPublishedCutoff(customer.id, dateKey);
      const followupEvents = cutoff
        ? events.filter((event) => new Date(event.occurredAt).getTime() > new Date(cutoff).getTime())
        : events;
      let ai: DraftProposal[] = [];
      let generator = 'rules';
      if (this.runtime) {
        try { ai = await proposeWithModel(this.runtime, customer, events, followupEvents); generator = `${this.runtime.llm.provider}/${this.runtime.llm.model}`; }
        catch (error) { generator = `rules-fallback: ${(error as Error).message}`.slice(0, 160); }
      }
      const proposals = this.buildProposals(ai, customer, events, followupEvents, dateKey);
      // 工时草稿的写工具按 ONES 实例工时模式绑定；模式获取失败只降级为该草稿的校验错误，不拖垮整个生成任务。
      let workhourBinding: WorkhourToolBinding = { mode: null, error: null };
      if (proposals.some((proposal) => proposal.type === 'workhour')) {
        const issue = this.db.listTimeline(customer.id, 500).find((event) => event.sourceSystem === 'ones' && event.sourceType === 'customer_manhour');
        if (issue) {
          try { workhourBinding = { mode: await this.fetchWorkhourMode(issue.externalId), error: null }; }
          catch (error) {
            workhourBinding = { mode: null, error: `无法获取 ONES 工时模式: ${(error as Error).message.slice(0, 160)}` };
          }
        }
      }
      const batch = this.db.createDraftBatch({ customerId: customer.id, fingerprint: job.fingerprint,
        sourceEventIds: events.map((event) => event.id), generationVersion: DRAFT_GENERATION_VERSION, generator });
      // 同客户同日只保留一个活跃批次：临创建前作废包含当天片段的其他批次（含并发任务先建者），已写入项不受影响。
      this.db.markDraftsStaleForEvents(events.map((event) => event.id), batch.id);
      if (!batch.items?.length) {
        for (const proposal of proposals) this.createItem(batch, customer, events, proposal, workhourBinding);
      }
      this.db.refreshDraftBatchStatus(batch.id);
      this.db.updateDraftJob(jobId, 'succeeded');
      this.db.audit('agent', 'generate_hemory_drafts', 'draft_batch', batch.id, { customerId: customer.id, sourceEventIds: batch.sourceEventIds, generator, dateKey, followupEventIds: followupEvents.map((event) => event.id) });
    } catch (error) {
      this.db.updateDraftJob(jobId, 'failed', (error as Error).message);
    } finally {
      this.processing.delete(jobId);
    }
  }

  /**
   * 最终提案集合：followup 恒为一条（合并当天全部未发布沟通），有 followup 就连带一条 workhour（录音时长 + 一句话描述）；
   * 其余类型沿用 LLM 提案与关键词兜底，可多条。
   */
  private buildProposals(ai: DraftProposal[], customer: Customer, events: SourceEvent[], followupEvents: SourceEvent[], dateKey: string): DraftProposal[] {
    const proposals: DraftProposal[] = [];
    if (followupEvents.length) {
      const followup = this.mergedFollowupProposal(ai, customer, followupEvents, dateKey);
      proposals.push(followup, this.workhourProposal(customer, followupEvents, dateKey, followup));
    }
    const seen = new Set<string>();
    const byId = new Map(events.map((event) => [event.id, event]));
    for (const proposal of ai) {
      if (proposal.type === 'followup' || proposal.type === 'workhour') continue; // 这两类结构化生成，不信任模型多条输出
      const key = `${proposal.type}::${proposal.title}`;
      if (seen.has(key) || proposals.length >= MAX_DRAFT_ITEMS) continue;
      // ONES 工作项宁缺毋滥：LLM 语义判定之外，其证据片段文本还必须命中该类型的业务信号；
      // 无信号即丢弃（内容仍保留在沟通记录里），证据引用缺失时按整批事件判定。
      const deskType = onesDeskTypeId(proposal.type);
      if (deskType) {
        const referenced = (proposal.evidenceRefs ?? []).flatMap((id) => { const event = byId.get(id); return event ? [event] : []; });
        if (!hasOnesDraftSignal(deskType, referenced.length ? referenced : events)) continue;
      }
      seen.add(key);
      proposals.push(proposal);
    }
    const covered = new Set(proposals.map((proposal) => proposal.type));
    for (const type of classifyDraftTypes(events)) {
      if (type === 'followup' || type === 'workhour') continue;
      if (covered.has(type) || proposals.length >= MAX_DRAFT_ITEMS) continue;
      proposals.push(defaultProposal(type, customer, events));
      covered.add(type);
    }
    return proposals;
  }

  private mergedFollowupProposal(ai: DraftProposal[], customer: Customer, followupEvents: SourceEvent[], dateKey: string): DraftProposal {
    const ids = new Set(followupEvents.map((event) => event.id));
    // 只采信证据仍落在未发布范围内的 LLM 提案，已发布内容绝不重复汇总。
    const valid = ai.filter((proposal) => proposal.type === 'followup'
      && (proposal.evidenceRefs ?? []).some((id) => ids.has(id)));
    const oneLine = valid.map((proposal) => String(proposal.fields?.one_line_summary ?? '')).find(Boolean)
      ?? `与${customer.name}就${followupEvents.map((event) => event.title).slice(0, 3).join('、')}等进行沟通`;
    // 每个片段一节，回退链：LLM 对该片段的分节摘要 → 分段器摘要 → 转写原文，保证全天覆盖无遗漏且节节有实义。
    const sectionSummaries = new Map<string, string>();
    for (const proposal of valid) {
      const sections = Array.isArray(proposal.fields?.sections) ? proposal.fields.sections : [];
      for (const raw of sections) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const entry = raw as Record<string, unknown>;
        const evidenceId = typeof entry.evidence_id === 'string' ? entry.evidence_id : '';
        const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
        // 只收当天未发布片段的条目；LLM 综述句对全部片段重复一次就够，绝不当分节正文。
        if (!ids.has(evidenceId) || !summary) continue;
        if (!sectionSummaries.has(evidenceId)) sectionSummaries.set(evidenceId, summary);
      }
    }
    const sections = followupEvents.map((event) => {
      const own = sectionSummaries.get(event.id);
      return `【${event.title}】\n${own ?? segmentSummaryOf(event)}`;
    });
    const speakers = [...new Set(followupEvents.flatMap((event) =>
      (Array.isArray(event.payload?.speakers) ? event.payload.speakers.map(String) : []).filter(Boolean)))];
    return { type: 'followup', title: `${customer.name} ${dateKey} 沟通记录`, summary: sections.join('\n\n').slice(0, 3000),
      fields: { date_key: dateKey, method: '会议', participants: speakers,
        key_topics: followupEvents.map((event) => event.title), one_line_summary: oneLine, next_steps: 'unknown' },
      evidenceRefs: followupEvents.map((event) => event.id), unknowns: ['下一步计划'] };
  }

  private workhourProposal(customer: Customer, followupEvents: SourceEvent[], dateKey: string, followup: DraftProposal): DraftProposal {
    const hours = computeWorkhours(followupEvents);
    const description = String(followup.fields?.one_line_summary ?? followup.summary).slice(0, 300);
    return { type: 'workhour', title: `${customer.name} ${dateKey} 客户沟通工时`, summary: description,
      fields: { date_key: dateKey, hours: hours == null ? 'unknown' : hours, description },
      evidenceRefs: followupEvents.map((event) => event.id),
      unknowns: hours == null ? ['工时时长（录音时间缺失，请人工补充）'] : [] };
  }

  private createItem(batch: DraftBatch, customer: Customer, events: SourceEvent[], proposal: DraftProposal, workhourBinding?: WorkhourToolBinding): DraftItem {
    const available = new Map(events.map((event) => [event.id, event]));
    const itemEvents = (proposal.evidenceRefs ?? []).flatMap((id) => {
      const event = available.get(id);
      return event ? [event] : [];
    });
    // 证据引用缺失或不合法时回退到整批事件，避免草稿失去 evidence_refs。
    const evidence = itemEvents.length ? [...itemEvents].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) : events;
    const evidenceRefs = evidence.map((event) => event.id);
    const fields = { ...(proposal.fields ?? {}), customer_id: customer.id, customer_name: customer.name,
      evidence_refs: evidenceRefs, evidence_quotes: evidence.map(textOf), occurred_at: evidence[0]?.occurredAt ?? new Date().toISOString() };
    const target = this.buildTarget(proposal.type, customer, evidence, proposal, fields, workhourBinding);
    return this.db.createDraftItem({ batchId: batch.id, customerId: customer.id, type: proposal.type,
      status: target.validationErrors.length ? 'draft' : 'ready', title: proposal.title.slice(0, 160), summary: proposal.summary,
      fields, targetSystem: target.system, targetObject: target.object, targetTool: target.tool,
      targetArguments: target.arguments, evidenceRefs, unknowns: proposal.unknowns ?? [], validationErrors: target.validationErrors });
  }

  /** rawName 精确匹配已连接工具；工时/跟进等强契约写入不允许宽松正则误绑。 */
  private exactTool(server: string, rawName: string): string | null {
    return this.mcp.listTools().find((tool) => tool.server === server && tool.rawName === rawName)?.publicName ?? null;
  }

  private findWriteTool(serverHint: string, pattern: RegExp): string | null {
    const candidates = this.mcp.listTools().filter((tool) => (tool.server.toLowerCase().includes(serverHint) || tool.publicName.toLowerCase().includes(serverHint))
      && pattern.test(`${tool.rawName} ${tool.description}`) && this.mcp.isWrite(tool.server, tool.rawName)
      // describe/query 类工具名字里可能带 create（如 get-create-form），只描述表单不写数据，必须排除。
      && !/^(data_)?(describe|query|get|search|list|approval)/i.test(tool.rawName));
    return candidates[0]?.publicName ?? null;
  }

  private findReadTool(serverHint: string, pattern: RegExp): string | null {
    const candidates = this.mcp.listTools().filter((tool) => (tool.server.toLowerCase().includes(serverHint) || tool.publicName.toLowerCase().includes(serverHint))
      && pattern.test(`${tool.rawName} ${tool.description}`) && !this.mcp.isWrite(tool.server, tool.rawName));
    return candidates[0]?.publicName ?? null;
  }

  /** 查询 ONES 实例工时模式；工具缺失、调用报错或返回无法识别时抛错，由调用方降级为该草稿的校验错误。 */
  private async fetchWorkhourMode(issueId: string): Promise<OnesWorkhourMode> {
    // 工具按 rawName 精确绑定：get_issue_fields 的描述文本含 "manhour mode" 字样，宽松正则会误选它
    // （返回 issueTypeID cannot be empty），与 create_new_issue 误绑工时工具是同款事故。
    const exact = this.exactTool('ones', 'get_manhour_mode');
    const tool = exact ?? this.findReadTool('ones', /^(get_)?manhour_mode$/i);
    if (!tool) throw new Error('未找到 ONES 工时模式查询工具');
    const response = await this.mcp.call(tool, { issueID: issueId });
    if (response.isError) throw new Error(response.text.slice(0, 300));
    // ONES 返回状态信封（result=SUCCESS、模式值嵌在 data 里），必须用宽容解析而非只读顶层 result。
    const mode = parseOnesManhourMode(response.text);
    if (!mode) throw new Error(`无法解析 ONES 工时模式返回: ${response.text.slice(0, 120)}`);
    return mode;
  }

  private buildTarget(type: DraftItemType, customer: Customer, events: SourceEvent[], proposal: DraftProposal, fields: Record<string, unknown>, workhourBinding?: WorkhourToolBinding) {
    const validationErrors: string[] = [];
    if (type === 'internal_todo') return { system: 'local' as const, object: 'CSM Agent / 待办', tool: 'local__create_action_item',
      arguments: { title: proposal.title, whyNow: proposal.summary, owner: fields.owner === 'unknown' ? null : fields.owner ?? null,
        dueAt: fields.due_at === 'unknown' ? null : fields.due_at, expectedOutcome: fields.expected_outcome === 'unknown' ? null : fields.expected_outcome ?? null,
        evidenceRefs: events.map((event) => event.id), sourceMeetingId: events[0]?.payload?.recordingId ?? null }, validationErrors };
    if (type === 'followup') {
      // CRM 跟进记录的真实写路径是通用记录创建工具 data_record_create（执行标识 CreateRecordsByData），
      // 写入销售记录对象 ActiveRecordObj；关联业务对象必须是 CSM 售后客户（object_Umwnn__c）。
      const exact = this.exactTool('crm', 'data_record_create');
      const tool = exact ?? this.findWriteTool('crm', /(record.*create|create.*record|跟进)/i);
      if (!tool) validationErrors.push('未找到 CRM 跟进记录写工具');
      // 客户主键就是售后客户对象的 _id；历史客户可能来自 AccountObj，按名称唯一解析同名售后客户后使用其 _id。
      let afterSales: { id: string; name: string } | undefined
        = customer.sourceObject === CRM_AFTER_SALES_OBJECT ? { id: customer.id, name: customer.name } : undefined;
      if (!afterSales) {
        // listCustomers 只返回售后客户对象（object_Umwnn__c）且已排除流失；同名唯一时复用其 _id。
        const matches = this.db.listCustomers().filter((item) => item.id !== customer.id && item.name === customer.name);
        if (matches.length === 1) afterSales = { id: matches[0].id, name: matches[0].name };
      }
      if (!afterSales) validationErrors.push('客户未解析到 CRM 售后客户（object_Umwnn__c）记录，无法绑定跟进关联');
      // ActiveRecordObj 必填：服务开始/结束时间（覆盖片段首尾时刻）、渠道（线上）、关联业务对象、跟进类型（常规客情维护）。
      const times = events.map((event) => new Date(event.occurredAt).getTime()).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      const startAt = times.length ? new Date(times[0]).toISOString() : new Date().toISOString();
      const endAt = times.length ? new Date(times.at(-1)!).toISOString() : startAt;
      const objectData: Record<string, unknown> = {
        active_record_content: `${proposal.title}\n${proposal.summary}`,
        field_oUaZx__c: startAt,
        field_wYlhw__c: endAt,
        field_MIe19__c: 'option1',
        related_api_names: [CRM_AFTER_SALES_OBJECT],
        active_record_type: '1cbaf4b4110c4a9d836867492e833d9e',
        related_object_data: afterSales ? [{ describe_api_name: CRM_AFTER_SALES_OBJECT, id: afterSales.id, name: afterSales.name }] : [],
      };
      if (fields.next_steps && fields.next_steps !== 'unknown') objectData.field_9qb16__c = String(fields.next_steps);
      return { system: 'crm' as const, object: 'CRM / 销售记录（跟进）', tool,
        arguments: { apiName: 'CreateRecordsByData', object_api_name: 'ActiveRecordObj', object_data: objectData }, validationErrors };
    }
    if (type === 'workhour') {
      const manhour = this.db.listTimeline(customer.id, 500).find((event) => event.sourceSystem === 'ones' && event.sourceType === 'customer_manhour');
      // 工具按实例模式 rawName 精确绑定：宽松正则曾把描述里带 manhour 字样的 create_new_issue 误当工时工具。
      const tool = workhourBinding?.mode ? this.exactTool('ones', ONES_WORKHOUR_TOOLS[workhourBinding.mode]) : null;
      if (!manhour) validationErrors.push('客户未绑定“客户工时管理 / 售后客户”工作项');
      else {
        if (workhourBinding?.error) validationErrors.push(workhourBinding.error);
        if (!tool) validationErrors.push('未找到 ONES 工时登记写工具');
      }
      if (fields.hours === 'unknown' || fields.hours == null) validationErrors.push('请补充工时时长');
      // ONES 工时登记要求 startTime 为带时区偏移的 ISO 8601（如 2026-08-26T14:30:00+08:00），取当天未发布沟通的最早时刻。
      const startAt = new Date(String(fields.occurred_at ?? (events.length ? events[0].occurredAt : new Date().toISOString())));
      return { system: 'ones' as const, object: '客户工时管理 / 售后客户', tool,
        arguments: { issueID: manhour?.externalId ?? '', hours: fields.hours,
          startTime: shanghaiIsoOffset(Number.isNaN(startAt.getTime()) ? new Date() : startAt),
          description: String(fields.description ?? proposal.summary) }, validationErrors };
    }
    const deskType = onesDeskTypeId(type);
    if (!deskType) throw new Error(`未知的草稿目标类型: ${type}`);
    const option = resolveOnesOption(this.db, customer);
    const tool = this.findWriteTool('ones', /(create.*issue|issue.*create|新建.*工作项)/i);
    if (!option) {
      const hint = this.db.listSourceEvents('ones', 'customer_option_candidate', customer.id).length
        ? 'ONES 已有待确认的客户选项，请刷新客户同步以按关联主体名重新解析'
        : '未在 ONES 客户信息选项中找到与客户名或关联主体名精确唯一的匹配，请刷新客户同步';
      validationErrors.push(`客户缺少已确认的 ONES 客户信息 option ID（${hint}）`);
    }
    if (!tool) validationErrors.push('未找到 ONES 新建工作项写工具');
    // create_new_issue 的 schema 为 additionalProperties:false：标题只能走顶层 title（旧代码传 summary
    // 曾导致「FAIL: InvalidParameter issue title empty」），描述与人工必填项（服务类目/优先级等）全部走 fieldValues。
    // 实例部署类型以 CRM 使用版本为准（公有云版→公有云，其余→私有云）：确定性覆盖，模型提案不参与。
    const override = applyDeploymentTypeOverride(deskType, customer.usageVersion);
    const overridden = new Set(override.map((entry) => entry.fieldID));
    const mapped = mapOnesDeskRequiredFields(deskType, proposal.fields?.ones_required as Record<string, unknown> | undefined);
    const fieldValues: Array<Record<string, string>> = option ? [{ fieldID: ONES_CUSTOMER_FIELD_ID, value: option.id }] : [];
    fieldValues.push(...mapped.filter((entry) => !overridden.has(entry.fieldID)), ...override);
    fieldValues.push({ fieldID: ONES_DESK_DESC_FIELD_ID, value: proposal.summary });
    return { system: 'ones' as const, object: ONES_DESK_TARGET_OBJECTS[deskType], tool,
      arguments: { projectID: ONES_DESK_PROJECT_ID, issueTypeID: ONES_DESK_ISSUE_TYPE_IDS[deskType], title: proposal.title, fieldValues }, validationErrors };
  }

  private validate(item: DraftItem): string[] {
    const errors: string[] = [];
    const customer = this.db.getCustomer(item.customerId);
    if (!customer) return ['customer not found'];
    if (item.fields.customer_id !== customer.id || item.fields.customer_name !== customer.name) errors.push('草稿客户身份与绑定客户不一致');
    if (item.targetSystem === 'local') {
      if (item.type !== 'internal_todo' || item.targetTool !== 'local__create_action_item') errors.push('本地待办目标无效');
      return errors;
    }
    if (!item.targetTool) errors.push('缺少目标写工具');
    else {
      const target = this.mcp.resolve(item.targetTool);
      if (!target || !this.mcp.isWrite(target.server, target.rawName)) errors.push('目标工具不是当前已连接的写工具');
    }
    if (item.type === 'followup') {
      const objectData = item.targetArguments.object_data as Record<string, unknown> | undefined;
      const related = Array.isArray(objectData?.related_object_data) ? objectData.related_object_data as Array<Record<string, unknown>> : [];
      const binding = related.find((entry) => entry?.describe_api_name === CRM_AFTER_SALES_OBJECT);
      const boundCustomer = binding ? this.db.getCustomer(String(binding.id)) : undefined;
      if (!binding || !boundCustomer || boundCustomer.sourceObject !== CRM_AFTER_SALES_OBJECT || boundCustomer.name !== customer.name) {
        errors.push('CRM 回写必须关联当前客户的 CRM 售后客户（object_Umwnn__c）记录');
      }
    }
    if (item.type === 'workhour') {
      const issue = this.db.listTimeline(customer.id, 500).find((event) => event.sourceSystem === 'ones' && event.sourceType === 'customer_manhour');
      if (!issue || item.targetArguments.issueID !== issue.externalId) errors.push('工时参数未绑定当前客户售后工时工作项');
      if (item.targetArguments.hours === 'unknown' || item.targetArguments.hours == null) errors.push('请补充工时时长');
      // 历史草稿曾误绑 create_new_issue：只有两个模式化工时工具是合法写目标。
      const rawName = item.targetTool ? this.mcp.resolve(item.targetTool)?.rawName : null;
      if (rawName !== ONES_WORKHOUR_TOOLS.simple && rawName !== ONES_WORKHOUR_TOOLS.summary) {
        errors.push('工时草稿未绑定 ONES 工时登记工具（add_workhour_in_*_mode），请编辑修正或重新生成');
      }
      if (!item.targetArguments.startTime) errors.push('缺少工时开始时间（startTime，ISO 8601 带时区）');
    }
    if (item.type === 'suggestion' || item.type === 'ticket' || item.type === 'operations') {
      const option = resolveOnesOption(this.db, customer);
      const values = Array.isArray(item.targetArguments.fieldValues) ? item.targetArguments.fieldValues as Array<Record<string, unknown>> : [];
      if (!option || !values.some((value) => value.fieldID === ONES_CUSTOMER_FIELD_ID && value.value === option.id)) errors.push(`ONES 工作项必须包含当前客户字段 ${ONES_CUSTOMER_FIELD_ID}`);
    }
    return errors;
  }

  private async preflight(item: DraftItem, errors: string[]): Promise<void> {
    if (item.type === 'suggestion' || item.type === 'ticket' || item.type === 'operations') {
      const tool = this.findReadTool('ones', /(get.*issue.*fields|issue.*fields|工作项.*字段)/i);
      if (!tool) errors.push('未找到 ONES 工作项字段查询工具');
      else {
        // issueTypeID 必须传类型 UUID：旧代码传类型名字符串，get_issue_fields 返回 404 业务错误
        //（isError=false），解析失败后静默跳过必填项检查，草稿带病写入才在 ONES 端报错。
        const response = await this.mcp.call(tool, { projectID: ONES_DESK_PROJECT_ID, issueTypeID: ONES_DESK_ISSUE_TYPE_IDS[onesDeskTypeId(item.type)!] });
        if (response.isError) errors.push(`ONES 字段预检失败: ${response.text.slice(0, 300)}`);
        else {
          const fields = parseOnesIssueFields(response.text);
          if (!fields) errors.push(`ONES 字段预检失败: 无法解析字段表（${response.text.slice(0, 120)}）`);
          else {
            const values = Array.isArray(item.targetArguments.fieldValues) ? item.targetArguments.fieldValues as Array<Record<string, unknown>> : [];
            const missing = missingOnesRequiredFields(fields, values);
            if (missing.length) errors.push(`ONES 必填字段未填写: ${missing.map((field) => `${field.name}(${field.uuid})`).join('、')}`);
            // 选项字段的 UUID 可能随 ONES 配置变化：实时校验草稿携带的选项 UUID 仍有效。
            const invalid = invalidOnesOptionValues(fields, values);
            if (invalid.length) errors.push(`ONES 字段值无效（选项 UUID 已失效，请重新生成）: ${invalid.join('、')}`);
          }
        }
      }
    }
    if (item.type === 'workhour') {
      const exact = this.exactTool('ones', 'get_manhour_mode');
      const tool = exact ?? this.findReadTool('ones', /^(get_)?manhour_mode$/i);
      if (!tool) errors.push('未找到 ONES 工时模式查询工具');
      else {
        const response = await this.mcp.call(tool, { issueID: item.targetArguments.issueID });
        if (response.isError) errors.push(`ONES 工时模式预检失败: ${response.text.slice(0, 300)}`);
        else {
          // 绑定工具必须与实例当前模式一致（simple/summary 各有专属写工具），不一致宁可拒绝也不让 ONES 端报错。
          // 模式返回无法识别（含 FAIL 信封）时静默跳过一致性检查，保持原有降级行为。
          const mode = parseOnesManhourMode(response.text);
          const rawName = item.targetTool ? this.mcp.resolve(item.targetTool)?.rawName : null;
          if (mode && rawName && rawName !== ONES_WORKHOUR_TOOLS[mode]) {
            errors.push(`ONES 工时模式（${mode}）与草稿绑定工具不一致，请重新生成`);
          }
        }
      }
    }
  }

  /**
   * ONES Desk 必填字段契约（只读规则可见口）：返回三类工作项的规格表 + 实例部署类型判定规则；
   * verify=true 时经 get_issue_fields 实时核对每个规格字段仍存在、必填、且内置选项 UUID 未失效。
   * 大选项集（≥30 截断）无法证伪，只核对该字段存在与必填。
   */
  async deskFieldContract(verify = false): Promise<Record<string, unknown>> {
    const contract = {
      projectID: ONES_DESK_PROJECT_ID,
      issueTypeIDs: ONES_DESK_ISSUE_TYPE_IDS,
      deployment_rule: { field: '实例部署类型', rule: 'CRM 使用版本=公有云版→公有云，其余（含缺失）→私有云', source: 'CRM object_Umwnn__c.field_Q2L6p__c（使用版本）' },
      classification_hints: ONES_DESK_CLASSIFICATION_HINTS,
      types: Object.fromEntries((Object.keys(ONES_DESK_FIELD_SPECS) as OnesDeskDraftType[]).map((type) => [type, {
        label: ONES_DESK_TYPE_LABELS[type],
        fields: ONES_DESK_FIELD_SPECS[type].map((spec) => ({ fieldID: spec.uuid, label: spec.label, defaultValue: spec.defaultValue ?? null,
          member: spec.member === true, options: spec.options ?? null })),
      }])),
    };
    if (!verify) return { ...contract, verification: { skipped: true } };
    const tool = this.findReadTool('ones', /(get.*issue.*fields|issue.*fields|工作项.*字段)/i);
    if (!tool) return { ...contract, verification: { error: '未找到 ONES 工作项字段查询工具（ONES MCP 未连接）' } };
    const verification: Record<string, unknown> = {};
    for (const type of Object.keys(ONES_DESK_FIELD_SPECS) as OnesDeskDraftType[]) {
      const response = await this.mcp.call(tool, { projectID: ONES_DESK_PROJECT_ID, issueTypeID: ONES_DESK_ISSUE_TYPE_IDS[type] });
      const fields = response.isError ? null : parseOnesIssueFields(response.text);
      if (!fields) {
        verification[type] = { error: response.isError ? response.text.slice(0, 200) : '无法解析字段表' };
        continue;
      }
      const byId = new Map(fields.map((field) => [field.uuid, field]));
      const problems: string[] = [];
      for (const spec of ONES_DESK_FIELD_SPECS[type]) {
        const live = byId.get(spec.uuid);
        if (!live) { problems.push(`${spec.label}(${spec.uuid}) 不在当前字段表中`); continue; }
        if (!live.required) problems.push(`${spec.label}(${spec.uuid}) 在 ONES 端已不是必填`);
        // 截断选项表（≥30）无法证伪；小选项集逐一核对内置 UUID 仍有效。
        if (live.options.length && live.options.length < 30) {
          const valid = new Set(live.options.map((option) => option.uuid));
          const invalid = Object.entries(spec.options ?? {}).filter(([, uuid]) => !valid.has(uuid));
          if (invalid.length) problems.push(`${spec.label}(${spec.uuid}) 内置选项 UUID 已失效: ${invalid.map(([label]) => label).join('、')}`);
        }
      }
      verification[type] = problems.length ? { problems } : { ok: true };
    }
    return { ...contract, verification };
  }

  async preview(batchId: string, itemIds: string[]): Promise<DraftPreview> {
    const batch = this.db.getDraftBatch(batchId);
    if (!batch) throw new Error('draft batch not found');
    const selected = new Set(itemIds);
    const items = (batch.items ?? []).filter((item) => selected.has(item.id));
    if (!items.length) throw new Error('未选择可确认草稿');
    const previews: DraftPreview['items'] = [];
    for (const item of items) {
      const validationErrors = this.validate(item);
      if (!validationErrors.length && item.targetSystem === 'ones') await this.preflight(item, validationErrors);
      previews.push({ id: item.id, version: item.version,
        approvalHash: argumentsHash({ draftId: item.id, version: item.version, targetTool: item.targetTool, targetArguments: item.targetArguments }),
        validationErrors });
    }
    return { batchId, items: previews };
  }

  async confirm(batchId: string, approvals: Array<{ id: string; version: number; approvalHash: string }>): Promise<{ items: DraftItem[] }> {
    const preview = await this.preview(batchId, approvals.map((item) => item.id));
    const byId = new Map(approvals.map((item) => [item.id, item]));
    for (const item of preview.items) {
      const supplied = byId.get(item.id);
      if (!supplied || supplied.version !== item.version || supplied.approvalHash !== item.approvalHash) throw new Error(`草稿 ${item.id} 已变化，请重新预览`);
      if (item.validationErrors.length) throw new Error(`草稿 ${item.id} 不可写入: ${item.validationErrors.join('；')}`);
    }
    const results: DraftItem[] = [];
    for (const approved of approvals) results.push(await this.execute(approved.id, approved.approvalHash));
    return { items: results };
  }

  async retry(itemId: string): Promise<DraftItem> {
    const item = this.db.getDraftItem(itemId);
    if (!item || item.status !== 'failed' || !item.approvalHash) throw new Error('只有参数未变化的失败草稿可以重试');
    const expected = argumentsHash({ draftId: item.id, version: item.version, targetTool: item.targetTool, targetArguments: item.targetArguments });
    if (expected !== item.approvalHash) throw new Error('草稿已变化，请重新预览并批准');
    return this.execute(item.id, item.approvalHash);
  }

  private async execute(itemId: string, approvalHash: string): Promise<DraftItem> {
    const item = this.db.getDraftItem(itemId);
    if (!item) throw new Error('draft item not found');
    const expected = argumentsHash({ draftId: item.id, version: item.version, targetTool: item.targetTool, targetArguments: item.targetArguments });
    if (expected !== approvalHash) throw new Error('批准哈希与当前草稿不一致');
    const errors = this.validate(item);
    if (errors.length) throw new Error(errors.join('；'));
    this.db.setDraftItemExecution(item.id, 'writing', { approvalHash });
    try {
      let result: Record<string, unknown>;
      if (item.targetSystem === 'local') {
        const args = item.targetArguments;
        const action = this.db.createAction({ id: `draft-${item.id}`, customerId: item.customerId, title: String(args.title ?? item.title),
          whyNow: String(args.whyNow ?? item.summary), owner: typeof args.owner === 'string' ? args.owner : null,
          dueAt: typeof args.dueAt === 'string' ? args.dueAt : null, expectedOutcome: typeof args.expectedOutcome === 'string' ? args.expectedOutcome : null,
          evidenceRefs: item.evidenceRefs, sourceMeetingId: typeof args.sourceMeetingId === 'string' ? args.sourceMeetingId : null, confidence: 0.75 });
        result = { actionItemId: action.id };
      } else {
        const response = await this.mcp.call(item.targetTool!, item.targetArguments);
        if (response.isError) throw new Error(response.text);
        // ONES 的 MCP 层同样不把业务失败标为 isError，{"result":"FAIL",...} 以正常内容返回；
        // 曾导致工时登记失败仍被标为 written，且不可重试。result 字符串非 SUCCESS 即业务失败。
        if (item.targetSystem === 'ones') {
          const parsed = cleanJson(response.text) as { result?: unknown; errorCode?: unknown; errorMsg?: unknown } | null;
          if (typeof parsed?.result === 'string' && parsed.result !== 'SUCCESS') {
            throw new Error(`ONES 回写业务失败 ${parsed.result}: ${String(parsed.errorMsg ?? parsed.errorCode ?? '').slice(0, 200)}`);
          }
        }
        // CRM 的 MCP 层不把业务失败标为 isError，resultCode/save_status 藏在 payload 里
        //（如 USER_TOOL_NOT_EXIST、VALIDATION_BLOCKED 且 write_db=false）。
        if (item.targetSystem === 'crm') {
          const parsed = cleanJson(response.text) as { resultCode?: unknown; data?: { message?: unknown; error?: unknown; save_status?: unknown; failure_reason?: unknown; feedback?: { items?: Array<{ message?: unknown; code?: unknown }> } } } | null;
          if (parsed?.resultCode && parsed.resultCode !== 'SUCCESS') {
            throw new Error(`CRM 回写业务失败 ${parsed.resultCode}: ${String(parsed.data?.message ?? parsed.data?.error ?? '').slice(0, 200)}`);
          }
          // SAVED 表示已落库（feedback 里可能带 FIELD_NOT_IN_LAYOUT 等非阻断警告）；只有明确未写库的失败态才报错。
          const data = parsed?.data;
          const saveStatus = data?.save_status;
          if (saveStatus && saveStatus !== 'SUCCESS' && saveStatus !== 'SAVED') {
            const fieldErrors = (data?.feedback?.items ?? [])
              .filter((entry) => entry.code !== 'FIELD_NOT_IN_LAYOUT')
              .map((entry) => `${entry.code}: ${entry.message ?? ''}`).join('；');
            throw new Error(`CRM 校验未通过（${saveStatus}，${data?.failure_reason ?? ''}）${fieldErrors.slice(0, 300)}`);
          }
        }
        result = { response: response.text.slice(0, 2000) };
      }
      this.db.audit('csm', 'execute_hemory_draft', 'draft_item', item.id, { approvalHash, targetSystem: item.targetSystem, targetTool: item.targetTool, result });
      return this.db.setDraftItemExecution(item.id, 'written', { approvalHash, result })!;
    } catch (error) {
      return this.db.setDraftItemExecution(item.id, 'failed', { approvalHash, error: (error as Error).message })!;
    }
  }
}
