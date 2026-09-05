import { createHash } from 'node:crypto';

export const CASE_CONTENT_VERSION = 'case-content-v19';
export interface CasePractice { id: string; title: string; text: string; sources: string[] }
export interface CasePracticeLibrary { version: string; digest: string; items: CasePractice[] }

const docs = (page: string) => `https://docs.ones.cn/wiki/#/team/6mRWUuNv/space/U6fZtSYs/page/${page}`;
// Editorial methods grounded in product documentation, never customer delivery evidence.
const PRACTICES: CasePractice[] = [
  { id: 'intake-governance', title: '统一入口与准入治理', text: '面向多部门共同提报的场景，可先明确需求对象、最小信息集与归口责任，再用统一表单、工作项字段和状态流转承接提报、分派与反馈。复制这一做法的前提是业务部门对准入条件和处理责任达成一致；表单集中并不自动意味着决策集中，还需明确例外事项由谁处理、处理结论如何回到提出方。', sources: ['ONES V7 产品知识：Project 工作项、字段、工作流与 Desk 表单'] },
  { id: 'phased-adoption', title: '按业务闭环分期采用', text: '面向上线窗口紧、参与角色多的场景，可优先选择从输入到反馈能够闭合的业务链路开展试点，约定每个角色的操作责任与阶段验收标准，再逐步扩展业务范围。分期边界宜依据业务依赖确定，不能仅按功能菜单切分；进入下一阶段前，需要验证前一阶段的数据是否完整、责任是否落实、用户是否持续采用。', sources: ['ONES V7 产品知识：Project 项目模板、工作流与里程碑'] },
  { id: 'identity-lifecycle', title: '身份与组织生命周期协同', text: '面向已有统一身份体系的组织，可分别梳理登录验证、用户目录、组织关系与许可分配，再确定各自的权威数据源和同步责任。单点登录解决身份验证，目录同步解决账号与组织数据维护，两者需要配合设计。复制时应核对部署版本、字段匹配、同步范围及离职账号处理规则，并验证账号停用后历史记录的可追溯性。', sources: [docs('UEmDTYjf'), docs('7kSrModv'), docs('YS41qEnE')] },
  { id: 'migration-continuity', title: '存量数据与业务连续性', text: '面向历史台账迁移的场景，可先定义新旧业务对象、状态与人员的映射规则，区分继续推进、归档留存和需要人工核对的数据，再分批验证迁移结果。导入能力只是载体，复制时还需约定抽样核对、异常处理和新旧系统切换责任；不能仅凭导入成功就认定历史关联、统计口径与权限均已正确恢复。', sources: [docs('KqJQjqNg'), docs('X3d2mddN')] },
  { id: 'role-usability', title: '角色任务与业务语言对齐', text: '面向非研发角色共同使用的平台，可从每类人员日常需要完成的任务出发，统一业务术语、精简表单字段、配置角色权限与常用视图。复制时应保留管理必需的数据和控制点，通过代表性用户的实际任务检验入口、填写和反馈是否顺畅；界面调整的价值需要结合采用行为验证，不能直接等同于学习成本已经下降。', sources: ['ONES V7 产品知识：Project 字段、布局、角色权限与视图管理'] },
  { id: 'deployment-boundaries', title: '部署约束与验收责任', text: '面向有明确安全和技术路线要求的组织，可将部署环境、身份接入、数据访问、运维责任和验收依据纳入同一方案边界。复制时需按实际产品版本核对支持范围，把兼容性验证和业务验收分别落实到责任方；选用私有部署本身不能证明已经满足特定监管条款，也不能替代对数据库、接口或安全要求的逐项验证。', sources: ['ONES V7 产品知识：部署运维、账号与安全；能力适用范围需按版本核对'] },
  { id: 'operating-feedback', title: '运营反馈与价值验证', text: '面向需要持续推广的平台，可围绕业务目标确定数据对象、度量口径、观察周期与复核责任，再利用视图、报表和仪表盘支持日常检查。复制时应先建立可比较的基线，区分平台覆盖、实际采用、流程变化与业务结果，结合用户反馈解释变化原因；服务投入、上线数量或功能可用只能说明投入与交付，不能单独证明效率提升或投资回报。', sources: ['ONES V7 产品知识：Project 报表、效能管理与 Wiki 数据统计'] },
];

export function casePracticeLibrary(): CasePracticeLibrary {
  return { version: CASE_CONTENT_VERSION, digest: createHash('sha256').update(JSON.stringify(PRACTICES)).digest('hex'), items: structuredClone(PRACTICES) };
}

export function validatePracticeIds(value: unknown, allowed = PRACTICES): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2 || value.some((id) => typeof id !== 'string' || !allowed.some((item) => item.id === id))) {
    throw new Error('practice_ids 必须为至多两个已知实践 ID');
  }
  if (new Set(value).size !== value.length) throw new Error('practice_ids 不得重复');
  return value as string[];
}

export function casePracticesFor(fields: Record<string, unknown>, section: { practice_ids?: string[] }): CasePractice[] {
  const library = fields.practice_library as CasePracticeLibrary | undefined;
  if (!library || !Array.isArray(library.items)) return [];
  return (section.practice_ids ?? []).flatMap((id) => library.items.find((item) => item.id === id) ?? []);
}

export function caseLessonsLabel(fields: Record<string, unknown>): string {
  return fields.content_version === CASE_CONTENT_VERSION ? '可复制实践' : '经验复盘与沉淀';
}

export const CASE_CONTENT_DIMENSIONS = [
  { key: 'decision', label: '决策背景', pattern: /选型|选择|决策|评标|启动|动因|驱动|优先|时间窗口/ },
  { key: 'constraints', label: '行业与组织约束', pattern: /监管|合规|制度|安全|跨部门|分支|集团|多团队|组织架构/ },
  { key: 'operating_model', label: '目标运营模式', pattern: /闭环|准入|流转|统一管理|归口|全流程|生命周期|目标流程/ },
  { key: 'governance', label: '关键角色与治理', pattern: /审批人|负责人|责任|角色|部门领导|会签|权限|评审/ },
  { key: 'mechanism', label: '方案机制', pattern: /配置|映射|同步|字段|工作流|关联|分派|自动化/ },
  { key: 'adoption', label: '采用变化', pattern: /开始使用|正式使用|用起来|用上了|持续使用|采用|改为|替代|不再|从.{1,30}转[为向]/ },
  { key: 'replication', label: '可复制实践', pattern: /适用|前提|复制|复用|沉淀|边界|先.{1,40}再/ },
] as const;

interface ContentSource { id: string; title: string; excerpt: string; speaker_lines?: Array<{ text: string }> }
export interface CaseContentReview {
  dimensions: Array<{ key: string; label: string; status: 'covered' | 'available' | 'missing'; source_refs: string[] }>;
  characters: number;
  target: { min: number; max: number };
  practiceCount: number;
  warnings: string[];
}

export function caseContentReview(fields: Record<string, unknown>, sources: ContentSource[]): CaseContentReview {
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [];
  const sections = Array.isArray(fields.solution_sections) ? fields.solution_sections as Array<{ text: string; practice_ids?: string[] }> : [];
  const texts = ['company_info', 'business_scope', 'competitive_strategy', 'project_background', 'business_status', 'demands', 'value_items', 'lessons', 'summary'].flatMap((key) => strings(fields[key])).concat(sections.flatMap((section) => strings(section.text)));
  const mappings = Array.isArray(fields.claim_evidence) ? fields.claim_evidence as Array<{ claim: string; excerpt?: string; source_refs: string[] }> : [];
  const sourceText = (source: ContentSource) => [source.title, source.excerpt, ...(source.speaker_lines ?? []).map((line) => line.text)].join('\n');
  const practices = sections.flatMap((section) => casePracticesFor(fields, section));
  const dimensions = CASE_CONTENT_DIMENSIONS.map(({ key, label, pattern }) => {
    const available = sources.filter((source) => pattern.test(sourceText(source)));
    const covered = texts.some((text) => pattern.test(text) && mappings.some((mapping) => mapping.claim === text && mapping.excerpt
      && available.some((source) => mapping.source_refs.includes(source.id) && sourceText(source).includes(mapping.excerpt!))));
    return { key, label, status: (covered || (key === 'replication' && practices.length) ? 'covered' : available.length ? 'available' : 'missing') as 'covered' | 'available' | 'missing', source_refs: available.map((source) => source.id) };
  });
  const characters = [...texts, ...practices.map((item) => item.text)].join('').replace(/\s/g, '').length;
  const warnings = dimensions.filter((item) => item.status !== 'covered').map((item) => `${item.label}：${item.status === 'available' ? '素材有线索，正文尚未充分展开' : '未识别到有据内容，需人工复核素材'}`);
  if (characters < 5000 || characters > 8000) warnings.push(`正文 ${characters} 字，目标 5000-8000 字；素材不足时允许收缩，不为凑字数补写`);
  return { dimensions, characters, target: { min: 5000, max: 8000 }, practiceCount: practices.length, warnings };
}
