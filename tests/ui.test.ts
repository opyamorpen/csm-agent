import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('private cloud instance cards omit event metadata and evidence ids', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/function renderBusinessRecords[\s\S]*?\n  }\n\n  function renderWorkhours/)?.[0];

  assert.ok(renderer, 'renderBusinessRecords source was not found');
  assert.match(renderer, /if \(sourceType !== 'private_cloud_instance'\) \{\s*item\.append\(el\('div', 'cell-sub'/);
  assert.match(renderer, /if \(sourceType !== 'private_cloud_instance'\) item\.append\(el\('div', 'evidence-id'/);
});

test('renewal risk dimensions use Chinese business labels', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const labels = source.match(/const RISK_DIMENSION_LABEL = \{[\s\S]*?\n  \};/)?.[0];
  const renderer = source.match(/function renderRisk[\s\S]*?\n  }\n\n  function renderTimeline/)?.[0];

  assert.ok(labels, 'risk dimension labels were not found');
  assert.match(labels, /renewal: '续约'/);
  assert.match(labels, /contract: '合同'/);
  assert.match(labels, /engagement: '互动'/);
  assert.match(labels, /delivery: '交付'/);
  assert.match(labels, /voice: '客户声音'/);
  assert.ok(renderer, 'renderRisk source was not found');
  assert.match(renderer, /RISK_DIMENSION_LABEL\[key\] \|\| key/);
});

test('draft inbox exposes regenerate control and operations label', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];

  assert.ok(renderer, 'loadDraftBatches source was not found');
  assert.match(renderer, /\['stale', 'partial', 'failed'\]\.includes\(batch\.status\)/);
  // 存在阻断性校验错误（如 ONES 客户信息未解析）的批次也允许重新生成。
  assert.match(renderer, /hasBlockingErrors/);
  assert.match(renderer, /item\.validationErrors\?\.length && !\['written', 'dismissed', 'stale'\]\.includes\(item\.status\)/);
  assert.match(renderer, /\/api\/draft-batches\/\$\{batch\.id\}\/regenerate/);
  assert.match(source, /operations: '运维工单'/);
});

test('draft inbox separates fully stale batches into a dedicated tab and exposes dismiss control', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.ok(renderer, 'loadDraftBatches source was not found');
  // 双 tab：待处理与纯已作废/已忽略批次分列，选中态跨重渲染保持，只渲染当前组。
  assert.match(renderer, /actionableItemCount/);
  assert.match(renderer, /activeDraftTab === 'archived' \? archived : actionable/);
  assert.match(renderer, /还没有已忽略\/已作废批次/);
  assert.match(renderer, /还没有待处理草稿/);
  assert.match(source, /let activeDraftTab = 'pending';/);
  // 已忽略/已作废批次的确认/忽略按钮不再渲染（条目全禁用，两按钮无意义）。
  assert.match(renderer, /if \(!archived\.includes\(batch\)\) \{\s*const confirmButton/);
  assert.match(renderer, /!archived\.includes\(batch\) && \(batch\.items \|\| \[\]\)\.some/);
  // tab 按钮：index.html 提供两个 data-draft-tab，JS 绑定点击切换并整表重渲染。
  assert.match(page, /data-draft-tab="pending"/);
  assert.match(page, /data-draft-tab="archived"/);
  assert.match(page, /id="draftTabPending" class="draft-subtab active"/);
  assert.match(renderer, /querySelectorAll\('\.draft-subtab'\)\) tab\.classList\.toggle\('active', tab\.dataset\.draftTab === activeDraftTab\)/);
  assert.match(source, /activeDraftTab = tab\.dataset\.draftTab;\s*void loadDraftBatches\(\);/);
  // 旧折叠方案彻底移除。
  assert.ok(!source.includes('draftArchivedExpanded'), 'draftArchivedExpanded should be gone');
  assert.ok(!source.includes('draft-archive-toggle'), 'draft-archive-toggle should be gone');
  // 忽略批次：软删除出口，已写入项不受影响。
  assert.match(renderer, /\/api\/draft-batches\/\$\{batch\.id\}\/dismiss/);
  assert.match(renderer, /忽略后未写入的草稿不再出现在待处理列表/);
  // 状态徽标用服务端中文标签（statusLabel），禁用卡片灰化增强。
  assert.match(renderer, /item\.statusLabel \|\| item\.status/);
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.draft-item-disabled \{ cursor: default; background: #f7f8fa; opacity: 0\.62; \}/);
  assert.match(styles, /\.draft-subtab \{/);
  assert.match(styles, /\.draft-subtab\.active \{[^}]*border-bottom-color: #2457c5/);
});

test('draft inbox renders persistent failed generation jobs with fragment details', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function renderDraftFailedJobs[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];

  assert.ok(renderer, 'renderDraftFailedJobs source was not found');
  // 失败任务列表来自 /api/draft-jobs?status=failed&kind=hemory：页面刷新后失败明细仍可见。
  assert.match(renderer, /\/api\/draft-jobs\?status=failed&kind=hemory/);
  // 卡片展示客户+日期+片段数、真实错误、片段明细（默认收起可展开）与重新生成入口。
  assert.match(renderer, /job\.fragments \|\| \[\]/);
  assert.match(renderer, /fragment\.topic/);
  assert.match(renderer, /draft-failed-fragments/);
  assert.match(renderer, /regenerateHemoryDrafts\(eventIds\)/);
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.draft-failed-card \{/);
  assert.match(styles, /\.draft-failed-fragment-row \{/);
});

test('draft cards render structured minimal required fields instead of a summary blob', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];

  assert.ok(renderer, 'loadDraftBatches source was not found');
  // displayFields 键值行取代整段摘要；无 displayFields 时才回退到 summary。
  assert.match(renderer, /if \(item\.displayFields\?\.length\)/);
  assert.match(renderer, /const fields = el\('div', 'draft-fields'\)/);
  assert.match(renderer, /fields\.append\(el\('div', 'draft-field-row', `\$\{field\.label\}：\$\{field\.value\}`\)\)/);
  assert.match(renderer, /else body\.append\(el\('p', null, item\.summary\)\)/);
  // 目标系统与工具的元信息行。
  assert.match(renderer, /目标: \$\{item\.targetObject\}/);
  // 待确认信息保留展示。
  assert.match(renderer, /待确认: \$\{item\.unknowns\.join\('、'\)\}/);

  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.draft-fields \{[^}]*display: grid/);
  assert.match(styles, /\.draft-field-row \{/);
});

test('stale service process surfaces a persistent banner via build id comparison', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // 构建戳先于 app.js 加载（前端 buildId 锚点），横幅容器在 body 顶部。
  const stampIndex = html.indexOf('/build-info.js');
  const appIndex = html.indexOf('/app.js');
  assert.ok(stampIndex > 0, 'index.html 必须引入 /build-info.js');
  assert.ok(appIndex > stampIndex, '/build-info.js 必须先于 /app.js 加载');
  assert.match(html, /id="buildStaleBanner"/);

  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const checker = source.match(/function startBuildVersionCheck[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(checker, 'startBuildVersionCheck source was not found');
  // 每 30s 比对前端 buildId 与 /api/version；stale 或端点缺失都要挂横幅，恢复一致消隐。
  assert.match(checker, /\/api\/version/);
  assert.match(checker, /window\.__CSM_BUILD__/);
  assert.match(checker, /setInterval\(\(\) => void check\(\), 30_000\)/);
  assert.match(checker, /服务进程仍在运行旧构建/);
  assert.match(checker, /banner\.classList\.remove\('hidden'\)/);
  assert.match(checker, /banner\.classList\.add\('hidden'\)/);
  assert.ok(source.includes('startBuildVersionCheck();'), 'init 必须启动版本比对');

  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.build-stale-banner \{/);
});

test('draft cards toggle selection from the whole card and enlarge the checkbox', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];

  assert.ok(renderer, 'loadDraftBatches source was not found');
  // 卡片整体是 label：点击卡片任意位置即切换勾选，不再只依赖小勾选框。
  assert.match(renderer, /el\('label', 'draft-item'\)/);
  // 勾选框禁用态（written/dismissed/stale/writing）卡片去掉手型提示。
  assert.match(renderer, /row\.classList\.add\('draft-item-disabled'\)/);
  // 卡内按钮须 type=button 并阻断 label 默认勾选与冒泡，避免点按钮误切换选择。
  assert.match(renderer, /edit\.type = 'button';/);
  assert.match(renderer, /retry\.type = 'button';/);
  assert.match(renderer, /open\.type = 'button';/);
  const guardedHandlers = renderer.match(/event\.preventDefault\(\); event\.stopPropagation\(\);/g) || [];
  // 单卡确认/忽略按钮加入后守卫句柄共 5 处（确认/编辑/忽略/重试/打开待办）。
  assert.strictEqual(guardedHandlers.length, 5);

  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.draft-item \{[^}]*cursor: pointer/);
  assert.match(styles, /\.draft-item:not\(\.draft-item-disabled\):hover \{[^}]*border-color/);
  assert.match(styles, /\.draft-item-disabled \{[^}]*cursor: default/);
  assert.match(styles, /\.draft-item > input \{[^}]*width: 16px/);
  assert.match(styles, /\.draft-item > input \{[^}]*height: 16px/);
  // Hemory 片段卡片勾选框保持同样尺寸，Agent 面板内两种卡片一致。
  assert.match(styles, /\.hemory-fragment input \{[^}]*width: 16px/);
});

test('customer overview summary grid drops product and contract status, shows aggregated last interaction', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const summary = source.match(/const summary = el\('div', 'definition-grid'\);[\s\S]*?customerOverview\.append\(summary\);/)?.[0];

  // 显示契约：概览摘要保留 5 项（含使用版本）；「最后互动」优先用服务端聚合时间（全量业务事件最晚时间），回退 CRM 原始字段。
  assert.ok(summary, 'customer overview summary grid source was not found');
  assert.doesNotMatch(summary, /definition\('产品'/);
  assert.doesNotMatch(summary, /definition\('合同状态'/);
  assert.match(summary, /definition\('续约日期', formatDate\(c\.renewalDate\)\)/);
  assert.match(summary, /definition\('使用版本', c\.usageVersion \|\| 'unknown'\)/);
  assert.match(summary, /definition\('最后互动', formatDate\(data\.lastInteractionAt \?\? c\.lastContactAt\)\)/);
  assert.match(summary, /definition\('数据同步', formatDateTime\(c\.syncedAt\)\)/);
  assert.equal((summary.match(/definition\(/g) ?? []).length, 5);

  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.definition-grid \{ display: grid; grid-template-columns: repeat\(5, minmax\(110px, 1fr\)\)/);
  // ≤980px 断点 5 项呈 2 列换行，避免错行。
  const narrow = styles.match(/@media \(max-width: 980px\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(narrow, '980px media block was not found');
  assert.match(narrow, /\.definition-grid \{ grid-template-columns: repeat\(2, 1fr\); \}/);
  assert.match(narrow, /\.definition:nth-child\(2n\) \{ border-right: 0; \}/);
});

test('customer detail tabs drop meetings and followups list CRM sales records by create time', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const tabStrip = source.match(/const overview = el\('div'\);[\s\S]*?tabs\[0\]\.button\.click\(\);/)?.[0];

  assert.ok(tabStrip, 'customer detail tab strip source was not found');
  assert.doesNotMatch(tabStrip, /addTab\('meetings'/);
  assert.doesNotMatch(source, /function renderMeetings/);
  assert.match(tabStrip, /addTab\('followup', '跟进记录', renderFollowups\(timeline\)/);

  const renderer = source.match(/function renderFollowups[\s\S]*?\n  }\n\n  async function startAgentDraft/)?.[0];
  assert.ok(renderer, 'renderFollowups source was not found');
  assert.match(renderer, /event\.sourceType === 'crm_followup'/);
  assert.match(renderer, /payload\?\.createTime/);
  assert.match(renderer, /createdAt\(right\) - createdAt\(left\)/);
  assert.doesNotMatch(renderer, /nextAction/);
});

test('app dialogs replace native confirm/alert/prompt for WKWebView compatibility', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // Mac 壳 WKWebView 未实现原生 JS 对话框面板，confirm/alert/prompt 会静默失败（曾导致草稿确认无反应）。
  // 显示契约：全部交互走页面内对话框，禁止直接调用原生版本。
  assert.doesNotMatch(source, /[^a-zA-Z.](confirm|alert|prompt)\(/, 'app.js 不得直接调用原生 confirm/alert/prompt');
  assert.match(source, /const confirmDialog = \(message\) => showAppDialog/);
  assert.match(source, /const alertDialog = \(message\) => showAppDialog/);
  assert.match(source, /const promptDialog = \(message, defaultValue = ''\) => showAppDialog/);
  // 单份与多份确认各自有文案；多份模板保留原措辞（逐项执行 + 不回滚语义）。
  assert.match(source, /'确认写入该草稿\？'/);
  assert.match(source, /确认逐项执行 \$\{preview\.items\.length\} 份草稿/);
  // 对话框 DOM 与输入框都在 index.html 内静态存在。
  assert.match(html, /id="appDialog"/);
  assert.match(html, /id="appDialogInput"/);
});

test('draft cards expose per-card confirm/ignore and a sticky selection bar with confirm-first ignore toggle', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 单卡确认/忽略：不必回到批次头部，也不必先勾选；确认复用批次 preview/confirm 链路（单份 itemIds）。
  assert.match(source, /async function confirmDraftItems\(batchId, itemIds, \{ skipConfirm \} = \{\}\)/);
  assert.match(source, /confirmDraftItems\(batch\.id, \[item\.id\]\)/);
  assert.match(source, /async function ignoreDraftItem\(item\)/);
  assert.match(source, /\/api\/draft-items\/\$\{item\.id\}\/dismiss/);
  // 浮动条静态节点：计数 + 模式切换 + 主按钮。
  assert.match(html, /id="draftSelectionBar"/);
  assert.match(html, /id="draftSelectedCount"/);
  assert.match(html, /id="draftBarModeToggle"/);
  assert.match(html, /id="draftBarPrimary"/);
  assert.match(html, />批量忽略…</);
  assert.match(html, />确认所选草稿</);
  // 勾选框带 batchId：跨批次勾选时按批次分组确认（确认 API 是批次级）。
  assert.match(source, /selector\.dataset\.batchId = batch\.id;/);
  assert.match(source, /function selectedDraftsByBatch\(\)/);
  // 委托监听勾选变化：条显隐随勾选实时联动；重渲染后隐藏并复位确认模式。
  assert.match(source, /draftBatchList\.addEventListener\('change', updateDraftSelectionBar\)/);
  assert.match(source, /function updateDraftSelectionBar\(\)/);
  assert.match(source, /draftBarIgnoreMode = false/);
  // 忽略与确认不平级：默认主按钮是批量确认，须手动切换一次才进入忽略模式（红色警示态）。
  assert.match(source, /function applyDraftBarMode\(\)/);
  assert.match(source, /draftBarPrimary\.textContent = '忽略所选草稿';/);
  assert.match(source, /draftBarPrimary\.classList\.add\('danger'\);/);
  assert.match(source, /忽略所选 \$\{total\} 份草稿/);
  assert.match(source, /confirmDraftItems\(batchId, itemIds, \{ skipConfirm: true \}\)/);
  // 样式：sticky 钉底浮动条 + 忽略模式红色主按钮。
  assert.match(styles, /\.draft-selection-bar \{[^}]*position: sticky; bottom: 0/);
  assert.match(styles, /\.primary-command\.danger \{/);
});

test('weekly actions view exposes card-click selection and a sticky bulk-complete toolbar (accept flow removed)', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 工具条：全选 + 已选计数 + 批量完成按钮（接受流程整体移除：草稿确认即视为接受）。
  assert.match(html, /id="actionSelectAll"/);
  assert.match(html, /id="actionSelectedCount"/);
  assert.match(html, /id="actionBulkComplete"/);
  assert.match(html, />批量完成</);
  assert.ok(!html.includes('actionBulkAccept'), 'bulk accept button should be removed');
  assert.ok(!source.includes('bulk-accept'), 'bulk accept API call should be removed');
  // 卡片勾选：仅可操作状态（new/in_progress）头插 checkbox，dataset 带 actionId，卡片加 selectable 类。
  const card = source.match(/function actionCard[\s\S]*?\n  }\n\n  function inputField/)?.[0];
  assert.ok(card, 'actionCard source was not found');
  assert.match(card, /selectable && \['new', 'in_progress'\]\.includes\(action\.status\)/);
  assert.match(card, /check\.dataset\.actionId = action\.id/);
  assert.match(card, /card\.classList\.add\('selectable'\)/);
  assert.doesNotMatch(card, /'接受'/);
  // 点卡片本体切换选中：委托监听排除按钮/勾选框等交互元素，无勾选框的卡片不响应。
  assert.match(source, /actionBoard\.addEventListener\('click'/);
  assert.match(source, /event\.target\.closest\('button, input, label, a'\)/);
  assert.match(source, /check\.checked = !check\.checked;/);
  // 批量接口与逐项语义：批量完成弹一次共用结果输入（取消中止、留空用默认）。
  assert.match(source, /\/api\/action-items\/bulk-complete/);
  assert.match(source, /记录实际结果（留空使用默认）/);
  // 勾选联动：全选跟随 + 已选 n/m 计数 + 整卡 selected 反馈 + 批量期间按钮禁用。
  assert.match(source, /function updateActionSelection\(\)/);
  assert.match(source, /已选 \$\{selected\}\/\$\{checks\.length\}/);
  assert.match(source, /classList\.toggle\('selected', input\.checked\)/);
  assert.match(source, /function setActionBulkBusy\(busy\)/);
  // 操作条样式：sticky 冻结在滚动容器顶 + selectable/selected 卡片态。
  assert.match(styles, /\.action-bulk-bar \{ position: sticky; top: 0; z-index: 8;/);
  assert.match(styles, /\.action-card\.selectable/);
  assert.match(styles, /\.action-card\.selected/);
  assert.match(styles, /\.action-head input\[type="checkbox"\]/);
});

test('hemory inbox exposes ignore and restore actions with incremental sync', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const renderer = source.match(/function renderHemoryFragmentRow[\s\S]*?\n  \}\n\n  \/\*\* 已归属视图的客户分组标题/)?.[0];
  const ignorer = source.match(/async function ignoreHemoryFragments[\s\S]*?\n  \}\n\n  \/\*\* 归属\/清除归属期间冻结归属栏操作/)?.[0];

  // 显示契约：忽略/恢复按钮、已忽略徽章、忽略走专用接口（行渲染器由收件箱与客户详情 tab 共用）。
  assert.ok(renderer, 'renderHemoryFragmentRow source was not found');
  assert.match(renderer, /'已忽略', 'muted'/);
  assert.match(renderer, /attributionStatus === 'ignored' \? badge\('已忽略', 'muted'\)/);
  assert.match(renderer, /const ignore = el\('button', 'quiet-command small', '忽略'\)/);
  assert.match(renderer, /const restore = el\('button', 'quiet-command small', '恢复'\)/);
  assert.ok(ignorer, 'ignoreHemoryFragments source was not found');
  assert.match(ignorer, /\/api\/hemory\/fragments\/ignore/);

  // 列表默认不把日期钉死为今天（待归属走服务端 7 天窗口）；「今天」只作为面板草稿的预填默认值。
  assert.doesNotMatch(source, /hemoryDate\.value = chinaDate\(\)/);

  // 同步按钮：增量同步；状态下拉已随筛选面板裁撤移除（忽略片段恢复走行内「恢复」按钮）。
  assert.match(html, /增量同步/);
  assert.doesNotMatch(html, /<option value="ignored">已忽略<\/option>/);
  assert.match(html, /id="hemoryIgnore"/);

  // 恢复走既有 attribution 接口（customerId=null 回到待归属）。
  assert.match(renderer, /eventIds: \[fragment\.id\], customerId: null/);
});

test('hemory inbox shows topic-part badges for recurring events', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const renderer = source.match(/function renderHemoryFragmentRow[\s\S]*?\n  \}\n\n  \/\*\* 已归属视图的客户分组标题/)?.[0];

  // v2 事件级切片：同一事件被打断后再次出现的片段共享话题组，收件箱显示「同话题 m/n」。
  assert.ok(renderer, 'renderHemoryFragmentRow source was not found');
  assert.match(renderer, /if \(fragment\.payload\?\.topicGroupId\)/);
  assert.match(renderer, /同话题 \$\{fragment\.payload\.topicPartIndex \?\? '\?'\}\/\$\{fragment\.payload\.topicPartCount \?\? '\?'\}/);
  assert.match(renderer, /fragment-topic-part/);
  assert.match(styles, /\.fragment-topic-part \{/);
  assert.match(styles, /\.fragment-topic-part \{[^}]*border: 1px dashed/);
});

test('hemory inbox filters via an explicit panel: drafts apply on submit only', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const loader = source.match(/async function loadHemoryInbox[\s\S]*?\n  }\n\n  async function ignoreHemoryFragments/)?.[0];
  const apply = source.match(/async function applyHemoryFilter[\s\S]*?\n  \}\n\n  async function resetHemoryFilter/)?.[0] ?? source.match(/async function applyHemoryFilter[\s\S]*?\n  \}\n\n  async function resetHemoryFilter/)?.[0] ?? source.match(/async function applyHemoryFilter[\s\S]*?\}\n\n  async function resetHemoryFilter/)?.[0];
  const state = source.match(/let hemoryFilter = \{[\s\S]*?\};/)?.[0];

  // 显示契约：默认无筛选（pending 全量）；头部是「筛选」按钮，条件在面板里编辑为草稿，点「筛选」才应用。
  assert.match(html, /id="hemoryFilterToggle"[^>]*>筛选</);
  assert.match(html, /id="hemoryFilterPanel" class="hemory-filter-panel hidden"/);
  assert.match(html, /id="hemoryFilterApply"[^>]*>筛选</);
  assert.match(html, /id="hemoryFilterReset"[^>]*>重置</);
  assert.ok(state, 'hemoryFilter state was not found');
  assert.match(state, /status: 'pending', date: '', from: '', to: ''/);
  assert.ok(apply, 'applyHemoryFilter source was not found');
  assert.match(apply, /时间段筛选需先选择日期/);
  assert.match(apply, /开始时间不能晚于结束时间/);
  // 面板只保留日期时间筛选：客户与状态下拉控件必须整体移除（客户走归属栏、状态走「已归属」切换）。
  assert.doesNotMatch(html, /id="hemoryFilterCustomer"/);
  assert.doesNotMatch(html, /id="hemoryStatus"/);
  assert.match(html, /id="hemoryFilterPanel"[\s\S]*?id="hemoryDate" type="date"/);
  assert.doesNotMatch(source, /hemoryStatus/);
  assert.doesNotMatch(source, /hemoryFilterCustomer/);
  // 面板打开时预填真实默认值：今天（上海时区实时计算）+ 00:00–23:59，点「筛选」即按该整天实际过滤；
  // 已应用过筛选则回填已应用值（仅日期无时刻时补全整天边界）。WebKit 空框的灰色假默认值因预填而不复存在。
  assert.match(source, /function shanghaiToday\(\)[\s\S]*?Asia\/Shanghai/);
  assert.match(source, /hemoryDate\.value = hemoryFilter\.date \|\| shanghaiToday\(\)/);
  assert.match(source, /hemoryTimeFrom\.value = hemoryFilter\.from \|\| '00:00'/);
  assert.match(source, /hemoryTimeTo\.value = hemoryFilter\.to \|\| '23:59'/);
  const filterPanel = html.match(/<div id="hemoryFilterPanel"[\s\S]*?<\/div>/)?.[0];
  assert.ok(filterPanel, 'hemoryFilterPanel markup was not found');
  assert.match(filterPanel, /id="hemoryDate" type="date"/);
  assert.doesNotMatch(filterPanel, /required/);
  // 应用 = 校验草稿 → 拷入已应用状态 → 收起面板 → 重载；重置清日期但保留当前状态视图。
  assert.match(apply, /hemoryFilter = draft/);
  assert.match(apply, /hemoryFilterPanel\.classList\.add\('hidden'\)/);
  assert.ok(loader, 'loadHemoryInbox source was not found');
  // 列表只读已应用状态（hemoryFilter），面板草稿不实时生效；控件 onchange 自动重载必须移除。
  assert.match(loader, /status: hemoryFilter\.status/);
  assert.doesNotMatch(loader, /customer_id/);
  assert.match(loader, /`\$\{hemoryFilter\.date\}T\$\{hemoryFilter\.from \|\| '00:00'\}:00\+08:00`/);
  assert.match(loader, /`\$\{hemoryFilter\.date\}T\$\{hemoryFilter\.to \|\| '23:59'\}:59\+08:00`/);
  assert.doesNotMatch(source, /hemoryStatus\.onchange/);
  assert.doesNotMatch(source, /hemoryDate\.onchange/);
  assert.doesNotMatch(source, /hemoryTimeFrom\.onchange/);
  assert.doesNotMatch(source, /hemoryTimeTo\.onchange/);
  // 打开面板时预填当前已应用值；同步按钮用已应用筛选的日期而非草稿。
  assert.match(source, /syncHemoryFilterDrafts\(\)/);
  assert.match(source, /date: hemoryFilter\.date \|\| undefined/);
  // 激活筛选时归属栏出现可点击清除的 chip。
  assert.match(source, /function updateHemoryFilterChip/);
  assert.match(source, /hemoryFilterChip\.onclick = \(\) => void resetHemoryFilter\(\)/);
});

test('hemory assign bar aligns controls on one centered row with select-all and count', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const loader = source.match(/async function loadHemoryInbox[\s\S]*?\n  }\n\n  async function ignoreHemoryFragments/)?.[0];
  const updater = source.match(/function bindFragmentSelection[\s\S]*?\n  \}\n\n  \/\*\*\n   \* 单条片段行/)?.[0] ?? source.match(/function bindFragmentSelection[\s\S]*?\n  \}\n/)?.[0];

  // 显示契约：归属栏是单行 flex 垂直居中的操作条（统一 34px 控件高、13px 辅助文字），sticky 冻结在 tab 条下。
  assert.match(styles, /\.hemory-assign-bar \{[^}]*display: flex/);
  assert.match(styles, /\.hemory-assign-bar \{[^}]*align-items: center/);
  assert.match(styles, /\.hemory-assign-bar \{[^}]*position: sticky/);
  assert.match(styles, /\.hemory-assign-bar \{[^}]*z-index: 7/);
  assert.match(styles, /\.hemory-assign-bar \{[^}]*background: #f7f8fa/);
  // 全选 checkbox 保持 16px、不再被输入框规则拉伸；输入框选择器收窄为 input[list]。
  assert.match(styles, /\.hemory-assign-bar input\[list\] \{[^}]*min-height: 34px/);
  assert.match(styles, /\.hemory-select-all input \{[^}]*width: 16px/);
  assert.match(styles, /\.hemory-select-all input \{[^}]*height: 16px/);
  assert.match(styles, /\.hemory-select-all \{[^}]*font-size: 13px/);
  assert.match(styles, /\.hemory-selected-count \{[^}]*font-size: 13px/);
  // 状态筛选已移入面板；归属栏只剩归属操作（客户输入 + 全选 + 计数 + 四个按钮，含重新生成草稿）。
  const assignBar = html.match(/<div class="hemory-assign-bar">[\s\S]*?<\/div>/)?.[0];
  assert.ok(assignBar, 'hemory-assign-bar markup was not found');
  assert.doesNotMatch(assignBar, /hemoryStatus/);
  assert.doesNotMatch(html, /<select id="hemoryStatus"/);
  assert.match(html, /placeholder="归属客户：搜索 CRM 客户"/);
  // ✕ 一键清除已选客户：按钮在输入框容器内、有值才显示；点按清空输入并聚焦回去，input 事件同步显隐。
  const customerBox = html.match(/<div class="hemory-customer-box">[\s\S]*?<\/div>/)?.[0];
  assert.ok(customerBox, 'hemory-customer-box markup was not found');
  assert.match(customerBox, /id="hemoryCustomer"/);
  assert.match(customerBox, /id="hemoryCustomerClear"[^>]*type="button"[^>]*title="清除已选客户"/);
  assert.match(source, /hemoryCustomerClear\.onclick = \(\) => \{ hemoryCustomer\.value = ''; syncHemoryCustomerClear\(\); hemoryCustomer\.focus\(\); \}/);
  assert.match(source, /hemoryCustomer\.addEventListener\('input', syncHemoryCustomerClear\)/);
  assert.match(styles, /\.hemory-customer-box \{[^}]*position: relative/);
  assert.match(styles, /\.hemory-customer-clear \{[^}]*position: absolute/);
  assert.match(html, /id="hemorySelectAll"/);
  assert.match(html, /id="hemorySelectedCount"/);
  assert.match(html, /id="hemoryRegenerate"[^>]*>重新生成草稿</);
  // 全选当前筛选结果的全部片段 + 已选计数（m/n），列表 change 委托更新，重渲染后由 loadHemoryInbox 收尾刷新。
  assert.ok(updater, 'bindFragmentSelection source was not found');
  assert.match(updater, /已选 \$\{selected\}\/\$\{checks\.length\}/);
  assert.match(updater, /selectAllEl\.checked = checks\.length > 0 && selected === checks\.length/);
  assert.match(updater, /listEl\.addEventListener\('change'/);
  assert.match(loader, /updateHemorySelection\(\)/);
  assert.match(updater, /selectAllEl\.onchange/);
});

test('hemory regenerate action is fragment-scoped and per-day in the inbox; customer tab is read-only', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const regenerator = source.match(/async function regenerateHemoryDrafts[\s\S]*?\n  }\n\n  async function updateHemoryAttribution/)?.[0];

  // 显示契约：重新生成走片段级端点，jobs 复用生成轮询（横幅在草稿箱）；选中必须是已归属片段。
  assert.ok(regenerator, 'regenerateHemoryDrafts source was not found');
  assert.match(regenerator, /\/api\/hemory\/fragments\/regenerate/);
  assert.match(regenerator, /trackDraftGeneration\(jobs \|\| \[\]\)/);
  assert.match(source, /dataset\.attribution !== 'confirmed'/);
  assert.match(source, /重生成草稿需要已归属片段/);
  // 客户详情 Hemory 片段 tab：纯展示——按客户过滤已归属片段（取数在 openCustomer 的并行请求里），readonly 渲染，无勾选/操作条/重生成。
  const panel = source.match(/function buildCustomerHemoryPanel[\s\S]*?\n  }\n+  async function openCustomer/)?.[0];
  assert.ok(panel, 'buildCustomerHemoryPanel source was not found');
  assert.match(source, /customer_id=\$\{encodeURIComponent\(customerId\)\}&status=confirmed&limit=500/);
  assert.match(panel, /readonly: true/);
  assert.doesNotMatch(panel, /bindFragmentSelection/);
  assert.doesNotMatch(panel, /'重新生成草稿'/);
  assert.match(source, /addTab\('hemory_fragments', 'Hemory 片段'/);
  // 行渲染器 readonly 分支：div 而非 label、无 checkbox、无行内忽略/恢复。
  const row = source.match(/function renderHemoryFragmentRow[\s\S]*?\n  \}\n\n  \/\*\* 已归属视图的客户分组标题/)?.[0];
  assert.match(row, /opts\.readonly \? 'div' : 'label'/);
  assert.match(row, /if \(!opts\.readonly\) \{\n      const check = document\.createElement\('input'\)/);
  // 行尾客户显示用名称解析（customersCache），失败回退 CRM id。
  assert.match(row, /customersCache\.find\(\(item\) => item\.id === fragment\.customerId\)\?\.name \?\? `CRM \$\{fragment\.customerId\}`/);
  // readonly 行样式：单列布局、无点选手势。
  assert.match(styles, /\.hemory-fragment\.readonly \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.hemory-fragment\.readonly \{[^}]*cursor: default/);
});

test('hemory tab exposes one-click attributed view toggle', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 显示契约：tab 与标题不再叫「待归属」（已归属也是该 tab 的内容），头部有一键「已归属」按钮。
  assert.match(html, /data-agent-mode="hemory">Hemory 片段 <span id="hemoryPendingCount"/);
  assert.match(html, /<h1>Hemory 片段<\/h1>/);
  assert.doesNotMatch(html, /Hemory 待归属/);
  assert.match(html, /id="hemoryConfirmedToggle"[^>]*>已归属</);
  // 切换语义：confirmed ↔ pending，其他已应用条件保留；激活态文案跟随（已归属视图下变「看待归属」）。
  const toggle = source.match(/hemoryConfirmedToggle\.onclick = async \(\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(toggle, 'hemoryConfirmedToggle handler was not found');
  assert.match(toggle, /hemoryFilter\.status = hemoryFilter\.status === 'confirmed' \? 'pending' : 'confirmed'/);
  assert.match(toggle, /hemoryFilterPanel\.classList\.add\('hidden'\)/);
  const toggleState = source.match(/function updateHemoryConfirmedToggle[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(toggleState, 'updateHemoryConfirmedToggle source was not found');
  assert.match(toggleState, /hemoryFilter\.status === 'confirmed'/);
  assert.match(toggleState, /'看待归属' : '已归属'/);
  assert.match(source, /updateHemoryConfirmedToggle\(\)/);
  // 激活态样式：头部 quiet-command.active 高亮。
  assert.match(styles, /\.agent-work-head \.quiet-command\.active \{[^}]*background: #eaf0fa/);
});

test('hemory attributed view groups fragments by customer with collapsed folds', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const loader = source.match(/async function loadHemoryInbox[\s\S]*?\n  \}\n\n  async function ignoreHemoryFragments/)?.[0];
  const renderer = source.match(/function renderHemoryFragmentList[\s\S]*?\n  \}\n\n  \/\*\* 已应用的筛选条件/)?.[0];

  // 显示契约：已归属视图外层按客户分组（客户名 + 片段数），组内仍按录音分节；客户顺序跟随时间倒序（最近沟通的客户在前）。
  assert.ok(renderer, 'renderHemoryFragmentList source was not found');
  assert.match(renderer, /if \(!opts\.groupByCustomer\) return appendRows\(listEl, fragments\)/);
  assert.match(renderer, /const key = fragment\.customerId \|\| ''/);
  assert.match(renderer, /const appendRows = \(container, rows\) =>/);
  assert.ok(loader, 'loadHemoryInbox source was not found');
  assert.match(loader, /groupByCustomer: hemoryFilter\.status === 'confirmed'/);
  // 折叠交互：客户组用 details/summary 原生折叠，默认收起（无 open 属性），点标题展开。
  assert.match(renderer, /document\.createElement\('details'\)/);
  assert.match(renderer, /group\.className = 'customer-group'/);
  assert.match(renderer, /const summary = el\('summary', 'customer-group-title', `\$\{fragmentCustomerLabel\(customerId\)\} · \$\{rows\.length\} 条`\)/);
  assert.doesNotMatch(renderer, /group\.open\s*=\s*true/);
  // 客户名解析：customersCache 优先，失败回退 CRM id；未绑定客户单列一组。
  const label = source.match(/function fragmentCustomerLabel[\s\S]*?\n  \}/)?.[0];
  assert.ok(label, 'fragmentCustomerLabel source was not found');
  assert.match(label, /if \(!customerId\) return '未绑定客户'/);
  assert.match(label, /customersCache\.find\(\(item\) => item\.id === customerId\)\?\.name \?\? `CRM \$\{customerId\}`/);
  // 折叠态样式：summary 可点击带 ▸ 指示（展开旋转 90°），隐藏原生 marker；组为白底卡片。
  assert.match(styles, /\.customer-group \{[^}]*background: #fff/);
  assert.match(styles, /\.customer-group-title \{[^}]*cursor: pointer/);
  assert.match(styles, /\.customer-group-title \{[^}]*list-style: none/);
  assert.match(styles, /\.customer-group-title::-webkit-details-marker \{ display: none/);
  assert.match(styles, /\.customer-group-title::before \{ content: '▸'/);
  assert.match(styles, /\.customer-group\[open\] > \.customer-group-title::before \{ transform: rotate\(90deg\)/);
});

test('ask-agent button creates a customer-bound session instead of reusing the active one', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // 显示契约：「询问 Agent」必须复用/新建绑定当前客户的会话（ensureCustomerSession），
  // 不得直接把消息发进当前激活会话（曾导致把问题发进绑定别的客户的旧会话）。
  const ask = source.match(/const ask = el\('button', 'quiet-command', '询问 Agent'\);[\s\S]*?\n    };/)?.[0];
  assert.ok(ask, 'ask agent button source was not found');
  assert.match(ask, /await ensureCustomerSession\(c\)/);
  assert.match(ask, /最近三个月的公开动态/);
  const ensure = source.match(/async function ensureCustomerSession[\s\S]*?\n  }\n/)?.[0];
  assert.ok(ensure, 'ensureCustomerSession source was not found');
  assert.match(ensure, /sessionCustomerId === customer\.id/);
  assert.match(ensure, /JSON\.stringify\(\{ customerId: customer\.id \}\)/);
  // 会话切换要回填绑定客户，供按钮判断是否可复用。
  const switchFn = source.match(/async function switchSession[\s\S]*?\n  }\n\n  async function newSession/)?.[0];
  assert.ok(switchFn, 'switchSession source was not found');
  assert.match(switchFn, /sessionCustomerId = meta\?\.customerId \?\? null/);
});

test('session list supports share, archive and an archived fold with restore', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // 显示契约：会话操作含归档按钮（PATCH archived:true），列表默认不含归档项（不带 include=archived）。
  const renderer = source.match(/async function loadSessions[\s\S]*?\n  }\n\n  function renderSessionList/)?.[0];
  assert.ok(renderer, 'loadSessions source was not found');
  assert.match(renderer, /fetch\('\/api\/sessions'\)/);
  assert.match(renderer, /fetch\('\/api\/sessions\?include=archived'\)/);
  assert.match(renderer, /renderArchivedList\(all\.filter\(\(s\) => s\.archived === true\)\)/);
  const listRenderer = source.match(/function renderSessionList[\s\S]*?\n  }\n\n  function renderArchivedList/)?.[0];
  assert.ok(listRenderer, 'renderSessionList source was not found');
  assert.match(listRenderer, /archiveSession\(s\.id\)/);
  const archivedRenderer = source.match(/function renderArchivedList[\s\S]*?\n  }\n\n  function connectEvents/)?.[0];
  assert.ok(archivedRenderer, 'renderArchivedList source was not found');
  assert.match(archivedRenderer, /JSON\.stringify\(\{ archived: false \}\)/);

  // 归档当前会话后切换到剩余第一个或新建。
  const archiver = source.match(/async function archiveSession[\s\S]*?\n  }\n\n  \/\*\* 复制文本/)?.[0];
  assert.ok(archiver, 'archiveSession source was not found');
  assert.match(archiver, /JSON\.stringify\(\{ archived: true \}\)/);
  assert.match(archiver, /归档该会话/);
  assert.match(archiver, /list\[0\]\.id/);

  // 分享按钮挂在每个会话行（会话名称旁），导出接口 + 剪贴板 API 优先、execCommand 回落（WKWebView 兼容）。
  const listRenderer2 = source.match(/function renderSessionList[\s\S]*?\n  }\n\n  function renderArchivedList/)?.[0];
  assert.ok(listRenderer2, 'renderSessionList source was not found');
  assert.match(listRenderer2, /const share = el\('button', 'sh', '分享'\)/);
  assert.match(listRenderer2, /shareSession\(s\.id, share\)/);
  const sharer = source.match(/async function shareSession[\s\S]*?\n  }\n/)?.[0];
  assert.ok(sharer, 'shareSession source was not found');
  assert.match(sharer, /\/api\/sessions\/\$\{id\}\/export/);
  assert.match(sharer, /copyText\(data\.transcript\)/);
  assert.match(sharer, /已复制/);
  const copier = source.match(/async function copyText[\s\S]*?\n  }\n\n  async function shareSession/)?.[0];
  assert.ok(copier, 'copyText source was not found');
  assert.match(copier, /navigator\.clipboard\?\.writeText/);
  assert.match(copier, /document\.execCommand\('copy'\)/);
  assert.match(html, /id="archivedToggle"/);
  assert.match(html, /id="archivedList"/);
});

test('agent nav item shows the sum of hemory pending and draft counts', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // 显示契约：侧边栏 Agent 角标 = Hemory 待归属 + 草稿箱待处理之和，与两个 tab 角标同源、同刷新时机。
  assert.match(html, /data-view="agent">Agent <span id="agentNavCount" class="nav-count"><\/span>/);
  const updater = source.match(/function updateAgentNavCount[\s\S]*?\n  }\n/)?.[0];
  assert.ok(updater, 'updateAgentNavCount source was not found');
  assert.match(updater, /hemoryPendingCount\.textContent \|\| 0/);
  assert.match(updater, /draftPendingCount\.textContent \|\| 0/);
  const hemoryLoader = source.match(/async function loadHemoryInbox[\s\S]*?\n  }\n\n  async function ignoreHemoryFragments/)?.[0];
  assert.ok(hemoryLoader, 'loadHemoryInbox source was not found');
  assert.match(hemoryLoader, /updateAgentNavCount\(\)/);
  const draftsLoader = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];
  assert.ok(draftsLoader, 'loadDraftBatches source was not found');
  assert.match(draftsLoader, /updateAgentNavCount\(\)/);
});

test('settings modal exposes Tavily web search configuration', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // 显示契约：设置页有联网搜索分区（key + 返回条数），保存走 /api/config/search，key 不回显。
  assert.match(html, /id="searchKey"/);
  assert.match(html, /id="searchMaxResults"/);
  assert.match(html, /不填 Key 自动走免费匿名通道/);
  assert.match(source, /async function loadSearchConfigUI/);
  assert.match(source, /\/api\/config\/search/);
  assert.ok(source.includes("searchKey.placeholder = data.apiKeyConfigured ? '已设置（留空则不修改）' : 'tvly-...（可选，不填走免费匿名通道）'"));
});

test('settings modal exposes custom OpenAI-compatible endpoint configuration', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // 显示契约：设置页支持自定义 OpenAI 兼容端点（Base URL 输入框仅 custom 服务商可见，
  // 加载回填 baseUrl，保存 payload 只在 custom 时携带 baseUrl）。
  assert.match(html, /id="llmBaseUrlRow"/);
  assert.match(html, /id="llmBaseUrl"/);
  assert.match(html, /OpenAI 兼容端点/);
  const boot = source.match(/const PROVIDERS = \[[\s\S]*?\n  \];/)?.[0];
  assert.ok(boot, 'PROVIDERS list was not found');
  assert.match(boot, /\['custom', '自定义（OpenAI 兼容）'\]/);
  const sync = source.match(/function syncLlmProviderUi[\s\S]*?\n  }\n/)?.[0];
  assert.ok(sync, 'syncLlmProviderUi source was not found');
  assert.match(sync, /llmProvider\.value === 'custom'/);
  assert.match(sync, /llmBaseUrlRow\.classList\.toggle\('hidden', !isCustom\)/);
  const loader = source.match(/async function loadLlmConfigUI[\s\S]*?\n  }\n\n  async function loadSearchConfigUI/)?.[0];
  assert.ok(loader, 'loadLlmConfigUI source was not found');
  assert.match(loader, /llmBaseUrl\.value = data\.baseUrl \|\| ''/);
  const saver = source.match(/saveConfigBtn\.addEventListener\('click'[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(saver, 'saveConfigBtn handler was not found');
  assert.match(saver, /if \(llmPayload\.provider === 'custom'\) llmPayload\.baseUrl = llmBaseUrl\.value\.trim\(\)/);
});

test('draft generation shows a loading banner and polls job status after attribution', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // 显示契约：归属确认即触发后台草稿生成（秒到几十秒），必须对用户可见——
  // 草稿箱顶部 spinner 横幅 + 顶部状态栏文案 + 终态后自动刷新列表。
  const updater = source.match(/async function updateHemoryAttribution[\s\S]*?\n  }\n\n  \/\*\*\n   \* 轮询草稿生成任务/)?.[0];
  assert.ok(updater, 'updateHemoryAttribution source was not found');
  // 归属请求读取响应里的 jobs 并交给轮询跟踪；失败必须弹窗（曾静默 unhandled rejection）。
  assert.match(updater, /const \{ jobs \} = await api\('\/api\/hemory\/fragments\/attribution'/);
  assert.match(updater, /trackDraftGeneration\(jobs \|\| \[\]\)/);
  assert.match(updater, /catch \(error\) \{ await alertDialog\(error\.message\); \}/);
  // 归属请求进行中冻结归属栏三个按钮，防止重复提交。
  assert.match(source, /function setAssignBarBusy\(busy\)/);
  assert.match(updater, /setAssignBarBusy\(true\)/);
  assert.match(updater, /finally \{ setAssignBarBusy\(false\); \}/);

  const tracker = source.match(/function trackDraftGeneration\(jobs\) \{[\s\S]*?\n  \}\n\n  async function showAgentMode/)?.[0];
  assert.ok(tracker, 'trackDraftGeneration source was not found');
  assert.match(tracker, /\/api\/draft-jobs\?ids=/);
  assert.match(tracker, /正在生成草稿（\$\{running\} 个任务）…/);
  assert.match(tracker, /draftGenerationNotice\.classList\.remove\('hidden'\)/);
  assert.match(tracker, /draftGenerationText\.textContent/);
  // 失败任务不创建批次，只能靠任务状态感知；终态后刷新草稿列表与角标。
  assert.match(tracker, /草稿生成失败/);
  assert.match(tracker, /void loadDraftBatches\(\)/);
  assert.match(tracker, /180000/);
  // 重新生成同样接入轮询（响应同样返回 jobs）。
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];
  assert.ok(renderer, 'loadDraftBatches source was not found');
  assert.match(renderer, /const \{ jobs \} = await api\(`\/api\/draft-batches\/\$\{batch\.id\}\/regenerate`/);
  assert.match(renderer, /trackDraftGeneration\(jobs \|\| \[\]\)/);

  // 横幅 DOM 与 spinner 样式（纯 CSS 动画，WKWebView 安全）。
  assert.match(html, /id="draftGenerationNotice" class="draft-generation-notice hidden"/);
  assert.match(html, /id="draftGenerationText"/);
  assert.match(styles, /\.draft-generation-notice \{[^}]*display: flex/);
  assert.match(styles, /\.draft-generation-notice \.spinner \{[^}]*animation: draft-spin/);
  assert.match(styles, /@keyframes draft-spin/);
});

test('customer detail exposes the weekly report tab with generation, failure retry and wiki publish', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // Tab 注册：客户案例之后新增「实施周报」。
  assert.match(source, /addTab\('weekly_report', '实施周报', buildWeeklyPanel\(c\)\)/);

  // 周选择对齐周一 + 生成入口。
  const panel = source.match(/function buildWeeklyPanel[\s\S]*?\n  \}\n+\n?  async function openCustomer/)?.[0]
    ?? source.match(/function buildWeeklyPanel[\s\S]*?async function openCustomer/)?.[0];
  assert.ok(panel, 'buildWeeklyPanel source was not found');
  assert.match(panel, /weekInput\.type = 'date'/);
  assert.match(panel, /weekMondayOf/);
  assert.match(panel, /'生成周报'/);
  assert.match(panel, /\/weekly-reports`/);

  // 生成轮询：draft-jobs 复用 + 进行中提示条；失败 → 错误卡片 + 弹窗 + 再次生成（force）。
  const poller = source.match(/async function pollWeeklyJob[\s\S]*?\n  \}\n\n  function renderWeeklyFailure/)?.[0];
  assert.ok(poller, 'pollWeeklyJob source was not found');
  assert.match(poller, /\/api\/draft-jobs\?ids=/);
  assert.match(poller, /周报生成中/);
  assert.match(poller, /job\.status === 'failed'/);
  assert.match(poller, /周报生成失败/);
  const failure = source.match(/function renderWeeklyFailure[\s\S]*?\n  \}\n\n  async function refreshWeeklyPanel/)?.[0];
  assert.ok(failure, 'renderWeeklyFailure source was not found');
  assert.match(failure, /'再次生成'/);
  assert.match(failure, /force: true/);

  // 展示四章节 + 统计条 + 操作（编辑/复制 Markdown/发布到 Wiki/重新生成）。
  const renderer = source.match(/async function renderWeeklyReport[\s\S]*?\n  \}\n\n  function renderWeeklyBody/)?.[0];
  assert.ok(renderer, 'renderWeeklyReport source was not found');
  for (const section of ['本周执行摘要', '本周完成情况', '下周工作计划', '问题风险与阻塞']) {
    assert.match(renderer, new RegExp(section));
  }
  assert.match(renderer, /weeklyStatsLine/);
  assert.match(renderer, /'编辑'/);
  assert.match(renderer, /'复制 Markdown'/);
  assert.match(renderer, /'发布到 Wiki'/);
  assert.match(renderer, /'重新生成'/);
  assert.match(renderer, /navigator\.clipboard\.writeText/);
  assert.match(renderer, /publish-preview/);

  // 全部异步按钮走 withLoading loading 契约（禁用 + 进行中文案）。
  assert.match(source, /function withLoading\(button, busyText, fn\)/);
  assert.match(source, /button\.disabled = true;\n      button\.textContent = busyText;/);

  // 周报样式：统计条、错误卡片、周选择工具条。
  assert.match(styles, /\.weekly-report-card \{/);
  assert.match(styles, /\.weekly-stats \{/);
  assert.match(styles, /\.weekly-failure \{/);
  assert.match(styles, /\.weekly-toolbar \{/);
});

test('wiki page picker replaces manual page id input for case and weekly publishing', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 共享选择器：空间下拉 + 懒加载页面树 + 「选此页」，返回 Promise<pageID|null>。
  const picker = source.match(/function pickWikiPage[\s\S]*?\n  \}\n\n  \/\*\* 实施周报 tab/)?.[0]
    ?? source.match(/function pickWikiPage\(\)[\s\S]*?\n  \}\n\n/)?.[0];
  assert.ok(picker, 'pickWikiPage source was not found');
  assert.match(picker, /\/api\/ones-wiki\/spaces/);
  assert.match(picker, /\/api\/ones-wiki\/pages\?space_id=/);
  assert.match(picker, /buildWikiTree/);
  // 手填 ID 保留为兜底（「直接输入页面 ID」），不再是唯一入口。
  assert.match(picker, /'直接输入页面 ID'/);
  const tree = source.match(/function buildWikiTree[\s\S]*?\n  \}\n\n  \/\*\*\n   \* ONES Wiki 发布位置选择器/)?.[0];
  assert.ok(tree, 'buildWikiTree source was not found');
  assert.match(tree, /details/);
  assert.match(tree, /addEventListener\('toggle'/);
  assert.match(tree, /'选此页'/);

  // 案例发布与周报发布都改用 pickWikiPage；旧的「ONES 案例库父页面 ID」promptDialog 手填入口移除。
  const casePublish = source.match(/function editCase[\s\S]*?\n  \}\n\n  async function pollSync/)?.[0];
  assert.ok(casePublish, 'editCase source was not found');
  assert.match(casePublish, /pickWikiPage\(\)/);
  assert.doesNotMatch(casePublish, /ONES 案例库父页面 ID/);
  assert.doesNotMatch(source, /promptDialog\('ONES 案例库父页面 ID/);
  // 选择器样式。
  assert.match(styles, /\.wiki-picker \{/);
  assert.match(styles, /\.wiki-tree-host \{/);
  assert.match(styles, /\.wiki-tree-node \{/);
});

test('hemory inbox shows consumption badges for fragments written to business systems', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/function renderHemoryFragmentRow[\s\S]*?\n  \}\n\n  \/\*\* 已归属视图的客户分组标题/)?.[0];

  // 显示契约：片段卡片显示「已写入·工单/跟进」消费徽标，类型映射为中文短标签。
  assert.ok(renderer, 'renderHemoryFragmentRow source was not found');
  assert.match(renderer, /Array\.isArray\(fragment\.consumedBy\) && fragment\.consumedBy\.length/);
  assert.match(renderer, /const typeLabels = \{ internal_todo: '行动', workhour: '工时', followup: '跟进', suggestion: '建议', ticket: '工单', operations: '运维' \}/);
  assert.match(renderer, /已写入·\$\{label\}/);
});

test('action cards no longer offer WeCom todo sync', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 显示契约：行动卡片只保留 编辑/完成（接受已随流程移除），「同步企微待办」入口与编辑表单的企微 UserId 字段整体移除。
  assert.doesNotMatch(app, /同步企微待办|已关联企微|wecom-todo-intents|ownerWecomUserid/);
  const editor = app.match(/function editAction[\s\S]*?\n  \}\n\n  \/\*\*\n   \* 客户详情的 Hemory 片段 tab/)?.[0];
  assert.ok(editor, 'editAction source was not found');
  assert.match(editor, /inputField\('负责人', action\.owner\)/);
  assert.doesNotMatch(editor, /企业微信 UserId/);
  // H5 确认页专用样式同步移除。
  assert.doesNotMatch(styles, /wecom-page|wecom-shell|todo-preview|todo-meta|form-status/);
});
