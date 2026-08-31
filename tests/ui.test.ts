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
  // v3 五维度：需求完成/工单解决/互动/客户声音/公开动态（续约、合同退出计分）。
  assert.match(labels, /suggestion: '需求完成'/);
  assert.match(labels, /ticket: '工单解决'/);
  assert.match(labels, /engagement: '互动'/);
  assert.match(labels, /voice: '客户声音'/);
  assert.match(labels, /web: '公开动态'/);
  assert.doesNotMatch(labels, /renewal:|contract:|delivery:/);
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

test('draft inbox marks regenerating batches with a badge and disables all actions', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  assert.ok(renderer, 'loadDraftBatches source was not found');
  // 服务端下发的 regenerating 标记驱动：头部角标 + 隐藏重新生成按钮。
  assert.match(renderer, /if \(batch\.regenerating\) title\.append\(el\('div', 'draft-regenerating', '重新生成中…'\)\)/);
  assert.match(renderer, /if \(!batch\.regenerating && \(\['stale', 'partial', 'failed'\]/);
  // 全部操作禁用：checkbox 勾选、确认/编辑/忽略、失败重试。
  assert.match(renderer, /selector\.disabled = batch\.regenerating \|\| \['written', 'dismissed', 'stale', 'writing'\]\.includes\(item\.status\)/);
  assert.match(renderer, /if \(!batch\.regenerating && !\['written', 'dismissed', 'stale', 'writing'\]\.includes\(item\.status\)\)/);
  assert.match(renderer, /if \(!batch\.regenerating && item\.status === 'failed'\)/);
  // 角标样式：spinner 动画复用 draft-spin。
  assert.match(styles, /\.draft-regenerating \{[^}]*color: var\(--accent-deep\)/);
  assert.match(styles, /\.draft-regenerating::before \{[^}]*animation: draft-spin/);
});

test('draft inbox separates archived items into a dedicated tab without batch-level buttons', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.ok(renderer, 'loadDraftBatches source was not found');
  // 双 tab：待处理与已忽略/已作废条目分列，选中态跨重渲染保持，只渲染当前组。
  assert.match(renderer, /actionableItemCount/);
  assert.match(renderer, /activeDraftTab === 'archived' \? archivedSections : actionable/);
  assert.match(renderer, /还没有已忽略\/已作废草稿/);
  assert.match(renderer, /还没有待处理草稿/);
  assert.match(source, /let activeDraftTab = 'pending';/);
  // 批次级「确认所选/忽略批次」已删除：确认/忽略由单卡按钮与底部浮动条承担，批次头部只留重新生成。
  assert.ok(!source.includes('confirmDraftBatch'), 'confirmDraftBatch should be gone');
  assert.ok(!renderer.includes("el('button', 'quiet-command small', '忽略批次')"), 'batch-level dismiss button should be gone');
  assert.ok(!renderer.includes('/api/draft-batches/${batch.id}/dismiss'), 'batch dismiss API call should be gone from web UI');
  // tab 按钮：index.html 提供两个 data-draft-tab，JS 绑定点击切换并整表重渲染。
  assert.match(page, /data-draft-tab="pending"/);
  assert.match(page, /data-draft-tab="archived"/);
  assert.match(page, /id="draftTabPending" class="draft-subtab active"/);
  assert.match(renderer, /querySelectorAll\('\.draft-subtab'\)\) tab\.classList\.toggle\('active', tab\.dataset\.draftTab === activeDraftTab\)/);
  assert.match(source, /activeDraftTab = tab\.dataset\.draftTab;\s*void loadDraftBatches\(\);/);
  // 旧折叠方案彻底移除。
  assert.ok(!source.includes('draftArchivedExpanded'), 'draftArchivedExpanded should be gone');
  assert.ok(!source.includes('draft-archive-toggle'), 'draft-archive-toggle should be gone');
  // 重新生成保留：作废/阻断批次找回内容的出口。
  assert.match(renderer, /\/api\/draft-batches\/\$\{batch\.id\}\/regenerate/);
  // 状态徽标用服务端中文标签（statusLabel），禁用卡片灰化增强。
  assert.match(renderer, /item\.statusLabel \|\| item\.status/);
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.draft-item-disabled \{ cursor: default; background: var\(--panel-2\); opacity: 0\.62; \}/);
  // tab 样式与行动页 subtab 并列复用（同一组选择器，草稿箱视觉不变）。
  assert.match(styles, /\.draft-subtab, \.action-subtab \{/);
  assert.match(styles, /\.draft-subtab\.active, \.action-subtab\.active \{[^}]*border-bottom-color: var\(--accent\)/);
});

test('draft subtab counts are item-level and share the pending badge source', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];

  assert.ok(renderer, 'loadDraftBatches source was not found');
  // 显示契约：待处理数字 = 可处理草稿条目数（一个批次含多条草稿，按批计数会和卡片数对不上）；
  // actionableCount helper 同时供分组（actionable/archived）与计数复用，服务端缺失时本地回退。
  assert.match(renderer, /const actionableCount = \(batch\) => batch\.actionableItemCount \?\? \(batch\.items \|\| \[\]\)\.filter\(\(item\) => !\['written', 'dismissed', 'stale'\]\.includes\(item\.status\)\)\.length/);
  assert.match(renderer, /const pending = actionable\.reduce\(\(sum, batch\) => sum \+ actionableCount\(batch\), 0\)/);
  // 顶部角标与二级 tab 计数同源（同一 pending 变量）。
  assert.match(renderer, /draftPendingCount\.textContent = pending \|\| '';/);
  assert.match(renderer, /draftTabPending\.textContent = pending \? `待处理（\$\{pending\}）` : '待处理';/);
  // 已忽略/已作废 tab 同一原则：数字 = 该 tab 里渲染的卡片（条目）数。
  assert.match(renderer, /const archivedCount = archivedSections\.reduce\(\(sum, batch\) => sum \+ archivedItemsOf\(batch\)\.length, 0\)/);
  assert.match(renderer, /draftTabArchived\.textContent = archivedCount \? `已忽略\/已作废（\$\{archivedCount\}）` : '已忽略\/已作废';/);
  // 旧的按批计数口径必须整体移除。
  assert.doesNotMatch(renderer, /actionable\.length \? `待处理/);
  assert.doesNotMatch(renderer, /archived\.length \? `已忽略/);
});

test('draft tabs render item-level so dismissed items leave the pending list', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/async function loadDraftBatches[\s\S]*?\n  }\n\n  async function showAgentMode/)?.[0];

  assert.ok(renderer, 'loadDraftBatches source was not found');
  // 忽略弹窗承诺「不再出现在待处理列表」：混合批次（仍有待处理兄弟条目）中被忽略/作废的条目
  // 也必须立即离开待处理 tab——分栏与批内渲染都按条目，不按批次。
  assert.match(renderer, /const archivedItemsOf = \(batch\) => \(batch\.items \|\| \[\]\)\.filter\(\(item\) => \['dismissed', 'stale'\]\.includes\(item\.status\)\)/);
  assert.match(renderer, /const archivedSections = batches\.filter\(\(batch\) => archivedItemsOf\(batch\)\.length > 0\)/);
  assert.match(renderer, /const items = activeDraftTab === 'archived' \? archivedItemsOf\(batch\)\s*\n\s*: \(batch\.items \|\| \[\]\)\.filter\(\(item\) => !\['dismissed', 'stale'\]\.includes\(item\.status\)\)/);
  assert.match(renderer, /for \(const item of items\) \{/);
  assert.ok(!renderer.includes('for (const item of batch.items || [])'), 'unfiltered in-batch item rendering should be gone');
  // 重新生成入口收敛到待处理 tab：在已忽略 tab 对混合批次整批重新生成会误作废待处理的兄弟条目。
  assert.match(renderer, /hasBlockingErrors \|\| activeDraftTab === 'pending'\)\) \{/);
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

test('weekly actions view exposes two-state tabs, customer grouping and a sticky bulk-complete toolbar', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 双 tab：未完成 / 已完成 分列，计数写进按钮文案；切换后整表重渲染，active 态跨重渲染保持。
  assert.match(html, /data-action-tab="pending"/);
  assert.match(html, /data-action-tab="completed"/);
  assert.match(html, /id="actionTabPending"/);
  assert.match(html, /id="actionTabCompleted"/);
  assert.match(source, /let activeActionTab = 'pending';/);
  assert.match(source, /actionTabPending\.textContent = pending\.length \? `未完成（\$\{pending\.length\}）` : '未完成';/);
  assert.match(source, /actionTabCompleted\.textContent = completed\.length \? `已完成（\$\{completed\.length\}）` : '已完成';/);
  assert.match(source, /querySelectorAll\('\.action-subtab'\)/);
  assert.match(styles, /\.draft-subtab\.active, \.action-subtab\.active \{/);
  // 两态划分 + 客户分组渲染：未完成= status==='new'（后端 due_at 升序），已完成按 updatedAt 倒序；
  // 按 customerId 分桶为 details.customer-group（默认展开、点组标题可折叠，客户名经 customersCache 解析）。
  const loader = source.match(/async function loadActions[\s\S]*?\n  \}\n\n  \/\/ 本周行动二级 tab/)?.[0];
  assert.ok(loader, 'loadActions source was not found');
  assert.match(loader, /actions\.filter\(\(a\) => a\.status === 'new'\)/);
  assert.match(loader, /actions\.filter\(\(a\) => a\.status === 'completed'\)/);
  assert.match(loader, /Date\.parse\(b\.updatedAt\) - Date\.parse\(a\.updatedAt\)/);
  assert.match(loader, /groups\.set\(action\.customerId, \[\.\.\.\(groups\.get\(action\.customerId\) \?\? \[\]\), action\]\)/);
  assert.match(loader, /'customer-group'/);
  assert.match(loader, /group\.open = true;/);
  assert.match(loader, /fragmentCustomerLabel\(customerId\)\} · \$\{rows\.length\} 项/);
  // 客户名懒加载：进行动页时 customersCache 为空才请求 /api/customers。
  assert.match(loader, /if \(!customersCache\.length\) customersCache = \(await api\('\/api\/customers'\)\)\.customers \|\| \[\];/);
  // 选中 tab 态随重渲染同步：切 tab 后高亮跟随 activeActionTab，不残留在初始按钮上。
  assert.match(loader, /querySelectorAll\('\.action-subtab'\)\) tab\.classList\.toggle\('active', tab\.dataset\.actionTab === activeActionTab\)/);;
  // 导航角标与 tab 计数同源（未完成数）。
  assert.match(loader, /actionNavCount\.textContent = pending\.length \|\| '';/);
  // 已完成 tab 无可勾选卡片，隐藏批量操作条。
  assert.match(loader, /actionBulkBar\.classList\.toggle\('hidden', activeActionTab !== 'pending'\)/);
  // 空态分 tab 文案。
  assert.match(loader, /'暂无未完成行动' : '暂无已完成行动'/);
  // 工具条：全选 + 已选计数 + 批量完成按钮（接受流程整体移除：草稿确认即视为接受）。
  assert.match(html, /id="actionSelectAll"/);
  assert.match(html, /id="actionSelectedCount"/);
  assert.match(html, /id="actionBulkComplete"/);
  assert.match(html, />批量完成</);
  assert.ok(!html.includes('actionBulkAccept'), 'bulk accept button should be removed');
  assert.ok(!source.includes('bulk-accept'), 'bulk accept API call should be removed');
  assert.ok(!source.includes('in_progress'), 'in_progress dead status should be removed from the frontend');
  // 卡片勾选：仅未完成状态头插 checkbox，dataset 带 actionId，卡片加 selectable 类；状态徽章两态中文化，已完成展示 outcome。
  const card = source.match(/function actionCard[\s\S]*?\n  }\n\n  function inputField/)?.[0];
  assert.ok(card, 'actionCard source was not found');
  assert.match(card, /selectable && action\.status === 'new'/);
  assert.match(card, /check\.dataset\.actionId = action\.id/);
  assert.match(card, /card\.classList\.add\('selectable'\)/);
  assert.match(card, /action\.status === 'completed' \? '已完成' : '未完成'/);
  assert.match(card, /action\.status === 'completed' && action\.outcome/);
  assert.match(card, /实际结果：\$\{action\.outcome\}/);
  assert.match(card, /if \(action\.status === 'new'\) \{/);
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
  // 操作条样式：sticky 冻结在滚动容器顶 + selectable/selected 卡片态 + 客户组内卡片间距。
  assert.match(styles, /\.action-bulk-bar \{ position: sticky; top: 0; z-index: 8;/);
  assert.match(styles, /\.action-card\.selectable/);
  assert.match(styles, /\.action-card\.selected/);
  assert.match(styles, /\.action-head input\[type="checkbox"\]/);
  assert.match(styles, /\.customer-group-body \.action-card \+ \.action-card \{ margin-top: 8px; \}/);
  assert.ok(!styles.includes('status-in_progress'), 'status-in_progress badge style should be removed');
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
  assert.match(styles, /\.hemory-assign-bar \{[^}]*background: var\(--bar-bg\)/);
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
  assert.match(styles, /\.agent-work-head \.quiet-command\.active \{[^}]*background: var\(--accent-soft\)/);
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
  assert.match(styles, /\.customer-group \{[^}]*background: var\(--panel\)/);
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

test('sidebar scrollbar only appears on hover inside its own track pad', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 遮挡根因是 Mac 叠加滚动条盖内容：滚动容器自身垫 8px 轨道区（移动端 720px
  // 断点的 #sidebar { padding: 6px } 会覆盖外层 padding——垫区必须挂容器自己）。
  assert.match(css, /\.sidebar-top \{ flex: 1; overflow-y: auto; min-height: 0; scrollbar-width: none; padding-right: 8px; \}/);
  // hover 门控：width:none 常态隐藏 → hover 变 thin（约 6-8px，恰好落进 8px 垫区）。
  assert.match(css, /\.sidebar-top:hover \{ scrollbar-width: thin; scrollbar-color: var\(--scrollbar\) transparent; \}/);
  // 侧栏壳层不再承担轨道垫区（垫区归位 .sidebar-top 自身）。
  const sidebar = css.match(/^#sidebar \{[\s\S]*?\n\}/m)?.[0];
  assert.ok(sidebar, 'sidebar rule was not found');
  assert.doesNotMatch(sidebar, /padding-right: 8px/);
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

test('sidebar nav order puts Agent on top', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // 显示契约：Agent 恒为侧边栏导航第一项，其余依次为客户组合→本周行动→案例库；
  // 默认激活视图仍是客户组合（顺序调整不改变落地页）。
  const nav = html.match(/<nav class="product-nav"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(nav, 'product-nav block was not found');
  const order = [...nav.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['agent', 'portfolio', 'actions', 'cases']);
  assert.match(nav, /class="nav-item active" data-view="portfolio"/);
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
  assert.match(saver, /if \(llmPayload\.provider === 'custom'\) \{/);
  assert.match(saver, /llmPayload\.baseUrl = llmBaseUrl\.value\.trim\(\);/);
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
  const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  // Tab 注册：客户案例之后新增「实施周报」。
  assert.match(source, /addTab\('weekly_report', '实施周报', buildWeeklyPanel\(c\)\)/);

  // API 契约：周报详情接口下发服务端权威渲染的客户版 Markdown 与内部证据警告。
  assert.match(serverSource, /detailWithMarkdown\(reportId\)/);
  assert.match(serverSource, /markdown: detail\.markdown, warnings: detail\.warnings/);

  // 周选择对齐周一 + 生成入口。
  const panel = source.match(/function buildWeeklyPanel[\s\S]*?\n  \}\n+\n?  async function openCustomer/)?.[0]
    ?? source.match(/function buildWeeklyPanel[\s\S]*?async function openCustomer/)?.[0];
  assert.ok(panel, 'buildWeeklyPanel source was not found');
  assert.match(panel, /weekInput\.type = 'date'/);
  assert.match(panel, /weekMondayOf/);
  assert.match(panel, /'生成周报'/);
  assert.match(panel, /\/weekly-reports`/);
  // 首次生成同样有 busyWeek 防重入 + 进度条重建（notice 被移除后不再静默）。
  assert.match(panel, /isWeeklyBusy\(panel, weekStart\)\) \{ await alertDialog\('该周周报正在生成中/);
  assert.match(panel, /ensureWeeklyNotice\(panel/);

  // 生成轮询：进度条确保在场（ensureWeeklyNotice 重建）+ 周界文案；终态清 busyWeek；
  // 仅当用户仍查看该周时刷新/展示失败卡片（生成期间切周不打扰）。
  const poller = source.match(/async function pollWeeklyJob[\s\S]*?\n  \}\n\n  function renderWeeklyFailure/)?.[0];
  assert.ok(poller, 'pollWeeklyJob source was not found');
  assert.match(poller, /\/api\/draft-jobs\?ids=/);
  assert.match(poller, /ensureWeeklyNotice\(panel/);
  assert.match(poller, /周报生成中/);
  assert.match(poller, /weeklyViewWeek\(panel\) === weekStart/);
  assert.match(poller, /delete panel\.dataset\.busyWeek/);
  assert.match(poller, /job\.status === 'failed'/);
  assert.match(poller, /周报生成失败/);
  // 进度展示契约：消费服务端下发的 job.progress（阶段/模型输出字数）+ 已进行时长；轮询无 90 次上限（面板存活即跟踪）。
  assert.match(poller, /job\.progress \|\|/);
  assert.match(poller, /已进行/);
  assert.match(poller, /panel\.isConnected/);
  assert.match(poller, /attempt < 90 \? 2000 : 5000/);
  // 「生成超时」放弃文案整体移除（含案例侧弹窗）：长任务由进度行持续跟踪，不再超时劝退。
  assert.doesNotMatch(source, /生成超时，任务仍在后台运行/);
  const failure = source.match(/function renderWeeklyFailure[\s\S]*?\n  \}\n\n  async function refreshWeeklyPanel/)?.[0];
  assert.ok(failure, 'renderWeeklyFailure source was not found');
  assert.match(failure, /'再次生成'/);
  assert.match(failure, /force: true/);
  assert.match(failure, /panel\.dataset\.busyWeek = weekStart/);
  // 重新生成失败时旧版本仍在库——「查看当前周报」一键回去看。
  assert.match(failure, /'查看当前周报'/);

  // 周下拉切换：有周报的周倒序列出，选择即切换并同步顶部日期选择器。
  const weekSelect = source.match(/function buildWeeklyWeekSelect[\s\S]*?\n  \}\n\n  async function renderWeeklyReport/)?.[0];
  assert.ok(weekSelect, 'buildWeeklyWeekSelect source was not found');
  assert.match(weekSelect, /b\.weekStart\.localeCompare\(a\.weekStart\)/);
  assert.match(weekSelect, /草稿 v\$\{item\.version\}/);
  assert.match(weekSelect, /'已发布'/);
  assert.match(weekSelect, /weekInput\.value = select\.value/);
  assert.match(weekSelect, /renderWeeklyBody\(panel, customer, select\.value\)/);

  // 展示四章节（客户版）+ 内部统计标记 + 内部依据弱化 + 操作（编辑/复制 Markdown/发布到 Wiki/重新生成）。
  const renderer = source.match(/async function renderWeeklyReport[\s\S]*?\n  \}\n\n  function renderWeeklyBody/)?.[0];
  assert.ok(renderer, 'renderWeeklyReport source was not found');
  // 显示契约：章节标题用中文数字（一、二、三、四），条目章节统一有序列表（ol，不用 ul 圆点）。
  for (const section of ['一、本周工作概览', '二、本周关键进展', '三、下周工作计划', '四、风险与待协调事项']) {
    assert.match(renderer, new RegExp(section));
  }
  assert.doesNotMatch(renderer, /[①②③④]/);
  assert.ok((renderer.match(/el\('ol', 'weekly-list'\)/g) ?? []).length >= 3, '三个条目章节必须都是有序列表');
  assert.doesNotMatch(renderer, /el\('ul', 'weekly-list'\)/);
  // 重新生成中状态：徽标 + 全部按钮禁用 + 卡片提示；首次生成在途时空态显示生成中文案。
  assert.match(renderer, /buildWeeklyWeekSelect\(panel, customer, reports, weekStart\)/);
  assert.match(renderer, /isWeeklyBusy\(panel, weekStart\)/);
  assert.match(renderer, /badge\('重新生成中', 'warning'\)/);
  assert.match(renderer, /正在重新生成本周周报，完成后自动刷新…/);
  assert.match(renderer, /周报生成中…（完成后将自动展示）/);
  assert.match(renderer, /for \(const button of buttons\.querySelectorAll\('button'\)\) button\.disabled = true/);
  // 重新生成按钮：busyWeek 防重入 + 状态先行（重渲染出带标记卡片，loading 不再依赖会被销毁的按钮）。
  assert.match(renderer, /isWeeklyBusy\(panel, weekStart\)\) \{ await alertDialog\('该周周报正在重新生成中/);
  assert.match(renderer, /panel\.dataset\.busyWeek = weekStart/);
  assert.match(renderer, /weeklyStatsLine/);
  assert.match(renderer, /内部统计（不随客户版内容复制或发布）/);
  assert.match(renderer, /内部依据：/);
  assert.match(renderer, /weekly-evidence/);
  assert.match(renderer, /'编辑'/);
  assert.match(renderer, /'复制 Markdown'/);
  assert.match(renderer, /'发布到 Wiki'/);
  assert.match(renderer, /'重新生成'/);
  // 显示契约：复制内容 = 服务端权威渲染的客户版 Markdown（前端不再自行拼装第二份 Markdown）。
  assert.match(renderer, /api\(`\/api\/weekly-reports\/\$\{report\.id\}`\)/);
  assert.match(renderer, /detail\.markdown/);
  assert.match(renderer, /copyText\(/);
  assert.doesNotMatch(renderer, /navigator\.clipboard\.writeText/);
  assert.match(renderer, /publish-preview/);
  // 发布确认弹窗前置内部信息警告。
  assert.match(renderer, /preview\.warnings/);

  // 全部异步按钮走 withLoading loading 契约（禁用 + 进行中文案）。
  assert.match(source, /function withLoading\(button, busyText, fn\)/);
  assert.match(source, /button\.disabled = true;\n      button\.textContent = busyText;/);

  // 编辑弹窗：新章节字段名（中文数字）+ 客户版帮助文字（内部依据仅审核用、风险条目前缀提示）。
  const editor = source.match(/function editWeeklyReport[\s\S]*?\n  \}\n\n  \/\*\*\n   \* 轮询周报生成任务/)?.[0];
  assert.ok(editor, 'editWeeklyReport source was not found');
  assert.match(editor, /编辑实施周报（客户版）/);
  assert.match(editor, /一、本周工作概览（客户可见正文/);
  assert.match(editor, /二、本周关键进展/);
  assert.match(editor, /三、下周工作计划/);
  assert.match(editor, /四、风险与待协调事项/);
  assert.doesNotMatch(editor, /[①②③④]/);
  assert.match(editor, /内部依据，可省略/);
  assert.match(editor, /【风险】【阻塞】【待确认】/);

  // 周报样式：统计条、错误卡片、周选择工具条、周下拉、内部依据弱化。
  assert.match(styles, /\.weekly-report-card \{/);
  assert.match(styles, /\.weekly-stats \{/);
  assert.match(styles, /\.weekly-failure \{/);
  assert.match(styles, /\.weekly-toolbar \{/);
  assert.match(styles, /\.weekly-week-select \{/);
  assert.match(styles, /\.weekly-evidence \{/);
  // 有序列表序号可见契约：条目 li 必须恢复 list-item 显示（grid/块化会吞掉序号），保持 5px 间距，空占位不编号。
  assert.match(styles, /\.weekly-list \{ margin: 4px 0; padding-left: 24px; font-size: 13\.5px; \}/);
  assert.match(styles, /\.weekly-item \{ display: list-item; \}/);
  assert.doesNotMatch(styles, /\.weekly-item \{ display: block; \}/);
  assert.doesNotMatch(styles, /\.weekly-list \{[^}]*display: grid/);
  assert.match(styles, /\.weekly-list > li:not\(\.weekly-item\)/);
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

test('draft edit renders the structured contract form instead of raw JSON textareas', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/function renderDraftEditForm[\s\S]*?\n  \}\n\n  async function editableDraft/)?.[0];
  assert.ok(renderer, 'renderDraftEditForm source was not found');
  // 按契约 type 渲染控件：select 下拉（含未知当前值兜底项）、datetime-local、number；锁定/只读区块中文标题。
  assert.match(renderer, /field\.type === 'select'/);
  assert.match(renderer, /document\.createElement\('select'\)/);
  assert.match(renderer, /field\.type === 'datetime' \? 'datetime-local'/);
  assert.match(renderer, /field\.type === 'number' \? 'number'/);
  assert.match(renderer, /以下信息已锁定/);
  assert.match(renderer, /以下信息由系统自动填写/);
  assert.match(renderer, /item\.reason/);
  // collect() 只收集契约内字段，必填项为空时给出中文错误。
  assert.match(renderer, /edits\[field\.key\] = input\.value/);
  assert.match(renderer, /`「\$\{field\.label\}」为必填项`/);

  const editor = source.match(/async function editableDraft[\s\S]*?\n  \}\n\n  \/\*\* 确认执行一组同批次草稿/)?.[0];
  assert.ok(editor, 'editableDraft source was not found');
  // 编辑弹窗优先走契约：GET /api/draft-items/:id 拉契约，PATCH 只提交 edits（服务端权威合并）。
  assert.match(editor, /api\(`\/api\/draft-items\/\$\{item\.id\}`\)/);
  assert.match(editor, /detail\?\.editContract/);
  assert.match(editor, /edits: collected\.edits/);
  // 无契约类型回退原始 JSON 编辑器（诊断兜底），保留 json-editor。
  assert.match(editor, /json-editor/);

  // 会话确认卡带 editContract 参数：契约路径提交 edits，无契约保留 JSON 兜底。
  const confirmCard = source.match(/function addConfirmCard[\s\S]*?\n  \}\n\n  function setThinking/)?.[0];
  assert.ok(confirmCard, 'addConfirmCard source was not found');
  assert.match(confirmCard, /function addConfirmCard\(draft, editContract\)/);
  assert.match(confirmCard, /renderDraftEditForm\(editContract, card\)/);
  assert.match(confirmCard, /edits: collected\.edits/);
  assert.match(confirmCard, /draft: approve \? edited : undefined/);
  // SSE confirm 事件把契约传入确认卡。
  assert.match(source, /case 'confirm': addConfirmCard\(e\.draft, e\.editContract\)/);

  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.draft-edit-select \{/);
  assert.match(styles, /\.draft-edit-locked \{/);
  assert.match(styles, /\.draft-edit-readonly \{/);
  assert.match(styles, /\.draft-edit-hint \{/);
});

test('dual theme tokens stay in sync and the theme switch is wired', () => {
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // 显示契约：浅色为默认主题（:root 兜底 + 显式 light 块），深色「科技版」为完整第二套。
  assert.match(styles, /:root, \[data-theme="light"\] \{/);
  assert.match(styles, /\[data-theme="dark"\] \{/);
  // 两套主题必须定义同名变量全集：漏一个变量，深色下该处就会透出浅色值。
  const lightBlock = styles.match(/\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1];
  const darkBlock = styles.match(/\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(lightBlock, 'light theme token block was not found');
  assert.ok(darkBlock, 'dark theme token block was not found');
  const tokenNames = (block) => [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
  assert.deepEqual(tokenNames(darkBlock), tokenNames(lightBlock));
  // 组件只允许引用两主题都定义过的变量（防 typo 变量名静默失效）。
  const defined = new Set(tokenNames(lightBlock));
  for (const used of styles.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
    assert.ok(defined.has(used[1]), `未定义的 CSS 变量被引用: ${used[1]}`);
  }

  // index.html：首帧前 boot 脚本落 data-theme（本地记忆 > 系统偏好），顶栏有切换按钮并挂事件。
  assert.match(html, /localStorage\.getItem\('csm-theme'\)/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /document\.documentElement\.dataset\.theme/);
  assert.match(html, /id="themeToggle"/);
  assert.match(html, /localStorage\.setItem\('csm-theme', next\)/);
});

test('system background aurora layer loops in both themes behind translucent shell bars', () => {
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 显示契约：两套主题都提供双层光晕渐变与半透明审批栏令牌（同名全集由双主题契约测试守护）。
  const lightBlock = styles.match(/\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1];
  const darkBlock = styles.match(/\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1];
  for (const block of [lightBlock, darkBlock]) {
    assert.match(block, /--body-aurora-a: radial-gradient/);
    assert.match(block, /--body-aurora-b: radial-gradient/);
    assert.match(block, /--records-bg: rgba\(/);
  }
  // 深色基础底不再内嵌静态光晕（已迁入动效层，防双层叠加过亮）。
  assert.doesNotMatch(darkBlock, /--body-bg: radial-gradient/);

  // ::before/::after 双层反向漂移+错相呼吸：刚性整体平移柔和色洗不可感知，双层相对运动才让色相流动可见。
  const shared = styles.match(/body::before, body::after \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(shared, 'shared body::before/::after aurora base rule was not found');
  assert.match(shared, /position: fixed/);
  assert.match(shared, /pointer-events: none/);
  assert.match(shared, /z-index: -1/);
  const layerA = styles.match(/^body::before \{([\s\S]*?)\n\}/m)?.[1];
  const layerB = styles.match(/^body::after \{([\s\S]*?)\n\}/m)?.[1];
  assert.match(layerA, /background: var\(--body-aurora-a\)/);
  assert.match(layerB, /background: var\(--body-aurora-b\)/);
  assert.match(layerA, /bg-aurora-drift \d+s ease-in-out infinite alternate/);
  assert.match(layerB, /bg-aurora-drift-b \d+s ease-in-out infinite alternate/);
  for (const name of ['bg-aurora-drift', 'bg-aurora-drift-b', 'bg-aurora-breathe', 'bg-aurora-breathe-b']) {
    assert.match(styles, new RegExp(`@keyframes ${name} \\{`));
  }
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);

  // 外壳三栏（顶栏/侧栏/右栏）半透明毛玻璃双主题一致生效，透出漂移光晕。
  assert.match(styles, /#records \{[^}]*background: var\(--records-bg\)/);
  assert.match(styles, /header, #sidebar, #records \{[^}]*backdrop-filter:/);
  assert.doesNotMatch(styles, /\[data-theme="dark"\] header/);
});

test('customer overview data section renders count-only stat cards with status-category rates', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const sync = readFileSync(new URL('../src/workbench/sync.ts', import.meta.url), 'utf8');
  const database = readFileSync(new URL('../src/workbench/database.ts', import.meta.url), 'utf8');

  // 显示契约：「数据概览」是统一节奏统计卡（需求/工单/运维/工时/待办/沟通），只给数量与比率，明细留在各自 tab。
  const renderer = source.match(/function renderOverviewStats[\s\S]*?\n  \}\n\n  function renderBusinessRecords/)?.[0];
  assert.ok(renderer, 'renderOverviewStats source was not found');
  for (const label of ['需求', '工单', '运维', '工时', '待办', '沟通']) {
    assert.match(renderer, new RegExp(`'${label}'`));
  }
  // 完成率用服务端全量口径（overview.completionRates，与风险维度同源）；本地只作旧 API 回退。
  assert.match(renderer, /completionRates/);
  assert.match(renderer, /serverRates\.support_ticket/);
  assert.match(renderer, /serverRates\.suggestion_feedback/);
  assert.match(renderer, /serverRates\.operations_ticket/);
  // 完成判定只认状态类型（category === 'done'），不用状态名猜；旧数据缺 category → 待刷新。
  assert.match(renderer, /statusCategoryOf\(event\) === 'done'/);
  assert.match(renderer, /return 'stale'/);
  assert.match(renderer, /待刷新/);
  assert.match(source, /function statusCategoryOf/);
  assert.match(source, /status\.category/);
  // 明细列表整体移除：不再有卡内记录行/旧容器类。
  assert.doesNotMatch(source, /function renderOnesSources/);
  assert.doesNotMatch(source, /source-summary|source-record/);
  assert.doesNotMatch(styles, /\.source-summary|\.source-record/);
  // 调用点带齐数据源（ONES 时间线 + 行动 + Hemory 片段 + 工时 + 服务端全量完成率）。
  assert.match(source, /renderOverviewStats\(\{ timeline: data\.timeline, completionRates: data\.completionRates, actions: data\.actions \|\| \[\], fragments: hemoryFragmentsData\.fragments \|\| \[\], workhours: workhoursData \}\)/);
  // 服务端全量口径：database.onesCompletionRates 按 category==='done' 判定、缺 category 标 stale。
  assert.match(database, /onesCompletionRates/);
  assert.match(database, /category === 'done'/);
  // 同步层取回状态类型：ONESQL SELECT 含 field005.category，支撑统计 category 优先。
  assert.match(sync, /field005\.category/);
  assert.match(sync, /onesStatusCategory/);
  assert.match(sync, /category \? category === 'done'/);
  // 进度条按百分比渲染，统计卡容器与样式存在。
  assert.match(renderer, /fill\.style\.width = `\$\{rate\.pct\}%`/);
  assert.match(renderer, /'stat-strip'/);
  assert.match(styles, /\.stat-strip \{/);
  assert.match(styles, /\.stat-card \{/);
  assert.match(styles, /\.stat-bar \{/);
  assert.match(styles, /\.stat-bar i \{/);
});

test('customer page exposes web intelligence refresh next to full sync', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  // 展示契约：客户头部命令行有「刷新公开动态」，强制检索后整页刷新；未搜到是 unknown 话术，不是健康信号。
  assert.match(source, /'刷新公开动态'/);
  assert.match(source, /\/web-intel/, '前端应调用 /web-intel 端点');
  assert.match(source, /未搜到不构成任何正面或负面信号/);
  assert.match(server, /sub === '\/web-intel'/);
  assert.match(server, /runWebIntelForCustomer\(customerId, \{ force: true \}\)/);
});

test('send button doubles as stop control while a turn is running', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 发送/停止是同一个按钮：独立停止按钮已移除，composer 只剩 input + #send。
  assert.doesNotMatch(html, /id="stop"/);
  assert.match(html, /<button id="send" type="submit">发送<\/button>/);
  // busy 时点击 #send 拦截表单提交，转投停止端点。
  const click = app.match(/sendEl\.addEventListener\('click'[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(click, 'send click interceptor was not found');
  assert.match(click, /if \(busy\) \{/);
  assert.match(click, /ev\.preventDefault\(\)/);
  assert.match(click, /stopTurn\(\)/);
  const stopper = app.match(/async function stopTurn[\s\S]*?\n  \}\n\n  \/\/ 对话进行中发送按钮是「停止」/)?.[0];
  assert.ok(stopper, 'stopTurn source was not found');
  assert.match(stopper, /\/api\/sessions\/\$\{sessionId\}\/stop/);
  // 双态切换：文案 发送↔停止 + stopping class；submit 路径不再禁用 sendEl（busy 时它就是停止入口）。
  const toggler = app.match(/function setSendStopping[\s\S]*?\n  \}/)?.[0];
  assert.ok(toggler, 'setSendStopping source was not found');
  assert.match(toggler, /sendEl\.textContent = on \? '停止' : '发送'/);
  assert.match(toggler, /sendEl\.classList\.toggle\('stopping', on\)/);
  // turn_start 进入停止态、turn_end 复位：SSE 回放历史事件后刷新页面也能恢复出正确状态。
  assert.match(app, /startStreaming\(\); setSendStopping\(true\)/);
  assert.match(app, /setSendStopping\(false\)/);
  // 停止后旧确认卡按钮禁用（服务端已按拒绝处理）。
  assert.match(app, /disablePendingConfirmCards\(\)/);
  // 停止态样式仅用主题 token（双主题契约）；透明 border 占位防尺寸跳动。
  assert.doesNotMatch(css, /#stop /);
  assert.match(css, /#send\.stopping \{ background: var\(--danger-btn\); border-color: var\(--danger-btn-border\); \}/);
  assert.match(css, /#send\.stopping:hover \{ background: var\(--danger-btn-hover\); filter: none; \}/);
});

test('composer lives inside the chat column and aligns with the conversation list', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 结构契约：footer 在 #chat 中栏内部（对话页=左中右三块竖向区域，输入条属于中栏底部，
  // 不再有横贯全窗的底栏）；.layout 直接子级只剩侧栏/两个 main/记录面板。
  const chatHtml = html.match(/<main id="chat"[\s\S]*?<\/main>/)?.[0];
  assert.ok(chatHtml, '#chat block was not found');
  assert.match(chatHtml, /<footer class="hidden">[\s\S]*?<form id="composer">/);
  // footer 必须在 #chat 内部：body 直下不允许出现（旧通栏底栏结构已废除）。
  const bodyLevel = html.match(/\n  <footer[\s\S]*?\n  <\/footer>/);
  assert.ok(!bodyLevel, 'footer must not be a body-level element');
  // 中栏 flex 列：tab 条不滚、面板滚动、footer 钉底；#chat 清零 padding 让 tabs/输入条铺满。
  assert.match(css, /#chat \{ display: flex; flex-direction: column; overflow: hidden; padding: 0; \}/);
  assert.match(css, /#chat \.agent-mode-panel \{ flex: 1 1 auto; overflow-y: auto; min-height: 0; padding: 14px 18px; \}/);
  const footerRule = css.match(/^footer \{[^}]*\}/m)?.[0];
  assert.ok(footerRule, 'footer rule was not found');
  assert.match(footerRule, /flex: 0 0 auto/);
  assert.match(footerRule, /background: var\(--panel\)/);
  assert.doesNotMatch(footerRule, /linear-gradient|padding: 12px 298px/);
  // 对话列与输入区共用 --chat-width（两块主题都定义），左右边缘严格对齐。
  const lightTokens = css.match(/:root, \[data-theme="light"\] \{[\s\S]*?\n\}/)?.[0];
  const darkTokens = css.match(/\[data-theme="dark"\] \{[\s\S]*?\n\}/)?.[0];
  assert.ok(lightTokens && darkTokens, 'theme token blocks were not found');
  assert.match(lightTokens, /--chat-width: 860px/);
  assert.match(darkTokens, /--chat-width: 860px/);
  assert.match(css, /#messages \{ max-width: var\(--chat-width\)/);
  assert.match(css, /#composer \{ width: 100%; max-width: var\(--chat-width\)/);
  assert.doesNotMatch(css, /#messages[^\n]*860px/);
  assert.doesNotMatch(css, /#composer[^\n]*860px/);
});

test('records panel explains itself as the external-write approval ledger', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  // 面板头从「产出记录」改为「写入审批」；空态说明写的是什么、何时出现。
  assert.match(html, /<div class="panel-head">写入审批 <span id="recordCount"/);
  assert.doesNotMatch(html, /产出记录/);
  assert.match(app, /Agent 生成的外部写入草稿（跟进\/工单\/工时等）及你的确认\/拒绝记录会显示在这里/);
  assert.doesNotMatch(app, /暂无产出/);
});

test('agent replies stream as deltas and thinking collapses into a fold', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  const dispatch = app.match(/function handleEvent[\s\S]*?\n  \}\n\n  \/\*\* 停止后禁用/)?.[0];
  assert.ok(dispatch, 'handleEvent source was not found');
  assert.match(dispatch, /case 'text_delta': appendTextDelta\(e\.delta\)/);
  assert.match(dispatch, /case 'thinking_delta': appendThinkingDelta\(e\.delta\)/);
  assert.match(dispatch, /case 'text': endStreaming\(\); addMessage\('assistant', e\.text\)/);
  assert.match(dispatch, /case 'turn_end':[\s\S]*?addTokenUsage\(e\.usage\)/);
  const streaming = app.match(/function startStreaming[\s\S]*?\n  function setSendStopping/)?.[0];
  assert.ok(streaming, 'streaming helpers were not found');
  assert.match(streaming, /function appendTextDelta/);
  assert.match(streaming, /function appendThinkingDelta/);
  assert.match(streaming, /已深度思考（\$\{text\.length\} 字）`;/);
  assert.match(streaming, /本轮 tokens：输入 \$\{usage\.input\} · 输出 \$\{usage\.output\}（本会话累计 \$\{sessionTokens\}\）/);
  // 思考折叠面板样式只引用既有 token。
  assert.match(css, /\.think-block \{/);
  assert.match(css, /\.think-block\.open \.think-body \{ display: block; \}/);
  assert.match(css, /\.think-block\.open \.think-head::before \{ content: '▾ '; \}/);
});

test('case narrative generation contract: five-section editor, refine entry, single generation path', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  // 五段叙事编辑弹窗：五章节标签 + 每行一项列表段；读取旧键回退（pain_points/results）。
  const editCase = source.match(/function editCase[\s\S]*?\n  \}\n\n  async function pollSync/)?.[0];
  assert.ok(editCase, 'editCase source was not found');
  assert.match(editCase, /一、客户背景/);
  assert.match(editCase, /二、痛点、现状与挑战（每行一项）/);
  assert.match(editCase, /三、需求与要求（每行一项）/);
  assert.match(editCase, /四、解决方案/);
  assert.match(editCase, /五、价值与成效（每行一项/);
  assert.match(editCase, /仅写已完成或有明确完成确认的落地举措/);
  assert.match(editCase, /fields\.pain_points/);
  assert.match(editCase, /fields\.results/);
  assert.doesNotMatch(editCase, /fields: \{ \.\.\.fields,/);
  assert.match(editCase, /fields: \{\s*background:/);
  // 旧字段编辑入口不再出现（客户原话/可复用经验/脱敏检查/实施过程）。
  assert.doesNotMatch(editCase, /客户原话/);
  assert.doesNotMatch(editCase, /可复用经验/);
  assert.doesNotMatch(editCase, /脱敏检查/);
  assert.doesNotMatch(editCase, /实施过程/);
  // 发布确认透出 warnings。
  assert.match(editCase, /preview\.warnings/);

  // 生成入口收敛：头部「生成案例」异步任务式（202 + draft-jobs 轮询），旧的同步直开弹窗与
  // 案例 tab 双按钮（draftCommand + 生成结构化案例草稿）移除。
  assert.match(source, /'生成案例'/);
  assert.doesNotMatch(source, /生成案例草稿/);
  assert.doesNotMatch(source, /生成结构化案例草稿/);
  const caseTab = source.match(/const casePanel = el\('div'\);[\s\S]*?addTab\('cases', '客户案例', casePanel\);/)?.[0];
  assert.ok(caseTab, 'case panel source was not found');
  assert.doesNotMatch(caseTab, /draftCommand/);
  // DRAFT_TARGETS 不再有 case 项（会话生成入口收敛到其他业务类型）。
  const targets = source.match(/const DRAFT_TARGETS = \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(targets, 'DRAFT_TARGETS source was not found');
  assert.doesNotMatch(targets, /case:/);

  // 轮询与定位：draft-jobs 轮询 + 指纹定位新草稿。
  const pollCase = source.match(/async function pollCaseJob[\s\S]*?\n  \}\n\n/)?.[0];
  assert.ok(pollCase, 'pollCaseJob source was not found');
  assert.match(pollCase, /\/api\/draft-jobs\?ids=/);
  assert.match(pollCase, /item\.fingerprint === fingerprint/);
  // 进度展示契约：案例轮询消费 job.progress（阶段/检索角度/模型输出字数），锚点存活期间无超时放弃。
  assert.match(pollCase, /job\.progress \|\|/);
  assert.match(pollCase, /ensureCaseNotice/);
  assert.match(pollCase, /anchor\.isConnected/);
  assert.match(pollCase, /attempt < 90 \? 2000 : 5000/);
  assert.doesNotMatch(pollCase, /timeout/);
  // 案例进度行组件：app.js 建行 + style.css 供样式（与周报 notice 同一视觉契约）。
  assert.match(source, /function ensureCaseNotice/);
  assert.match(source, /\.generation-notice/);
  assert.match(styles, /\.generation-notice/);
  // 重开页面恢复：openCustomer / buildWeeklyPanel 经 customer_id+status=active 恢复在途任务轮询。
  assert.match(source, /\/api\/draft-jobs\?customer_id=\$\{encodeURIComponent\(customerId\)\}&status=active/);
  assert.match(source, /\/api\/draft-jobs\?customer_id=\$\{encodeURIComponent\(customer\.id\)\}&status=active&kind=weekly_report/);

  // 对话精修入口：草稿卡按钮 + 种子消息契约（case_draft_id/case_version 注入 + 禁外部写）。
  const refine = source.match(/async function startCaseRefine[\s\S]*?\n  \}\n\n/)?.[0];
  assert.ok(refine, 'startCaseRefine source was not found');
  assert.match(refine, /case_draft_id: draft\.id/);
  assert.match(refine, /case_version: draft\.version/);
  assert.match(refine, /record_type=case/);
  assert.match(refine, /不得调用任何 CRM\/ONES 外部写工具/);
  assert.match(refine, /未要求修改的章节必须原文保留/);
  const caseCard = source.match(/async function caseCard[\s\S]*?\n  \}\n\n  async function loadCases/)?.[0];
  assert.ok(caseCard, 'caseCard source was not found');
  assert.match(caseCard, /'对话精修'/);
  assert.match(caseCard, /'重新生成'/);
  assert.match(caseCard, /contextStale/);
  assert.match(caseCard, /'数据已更新'/);
  assert.match(caseCard, /qualityReview\?\.warnings\?\.length/);
  assert.match(caseCard, /公开检查 \$\{warningCount\} 项/);
  // 复制 Markdown：与周报卡同款（服务端权威渲染，带 WKWebView execCommand 兜底）。
  assert.match(caseCard, /'复制 Markdown'/);
  assert.match(caseCard, /copyText\(current\.markdown/);
  // 编辑写回护栏：保存/PATCH 响应的 warnings 以弹窗提示（非阻断）。
  const editCaseSource = source.match(/function editCase[\s\S]*?\n  \}\n\n  async function pollSync/)?.[0];
  assert.ok(editCaseSource, 'editCase source was not found');
  assert.match(editCaseSource, /async function afterSave/);
  assert.match(editCaseSource, /updated\?\.warnings/);
});

test('cursor ripple fx: theme tokens, silky wake guards, header toggle and load order', () => {
  const fx = readFileSync(new URL('../public/cursor-effects.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // 双主题涟漪取色 token（同名全集由双主题契约测试守护，这里锁字面量）。
  const lightBlock = styles.match(/\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1];
  const darkBlock = styles.match(/\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(lightBlock, 'light theme token block was not found');
  assert.ok(darkBlock, 'dark theme token block was not found');
  assert.match(lightBlock, /--fx-wake: #2457c5;/);
  assert.match(lightBlock, /--fx-ring: #3d85f8;/);
  assert.match(darkBlock, /--fx-wake: #22d3ee;/);
  assert.match(darkBlock, /--fx-ring: #4f8cff;/);

  // index.html：顶栏开关（复刻 themeToggle 模式：localStorage 记忆 + 文案提示点击后果），脚本先于开关接线与 app.js 挂载。
  assert.match(html, /id="cursorFxToggle"/);
  assert.match(html, /localStorage\.setItem\('csm-cursor-fx', next \? 'on' : 'off'\)/);
  assert.match(html, /window\.csmCursorFx\.setEnabled\(next\)/);
  const fxIndex = html.indexOf('src="/cursor-effects.js"');
  const fxWiringIndex = html.indexOf("getElementById('cursorFxToggle')");
  const appIndex = html.indexOf('src="/app.js"');
  assert.ok(fxIndex > 0, 'index.html 必须引入 /cursor-effects.js');
  assert.ok(fxIndex < fxWiringIndex && fxWiringIndex < appIndex, 'cursor-effects.js 必须先于开关接线与 app.js');

  // 丝滑契约：拖尾=单条中点二次贝塞尔曲线 + 尾→头整体线性渐变三趟描边（分段描边=点阵感的根因，禁回退）；
  // 波动场 ImageData/Float32Array 路线已退役，不得复活。
  assert.match(fx, /quadraticCurveTo\(trail\[i\]\.x, trail\[i\]\.y, midX, midY\)/);
  assert.match(fx, /createLinearGradient\(first\.x, first\.y, last\.x, last\.y\)/);
  assert.doesNotMatch(fx, /Float32Array/);
  assert.doesNotMatch(fx, /putImageData/);
  assert.match(fx, /dark \? 'lighter' : 'source-over'/);
  assert.match(fx, /getPropertyValue\('--fx-wake'\)/);
  assert.match(fx, /getPropertyValue\('--fx-ring'\)/);
  assert.match(fx, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(fx, /localStorage\.getItem\('csm-cursor-fx'\) !== 'off'/);
  assert.match(fx, /window\.addEventListener\('pointermove'/);
  assert.match(fx, /window\.addEventListener\('pointerdown'/);
  assert.match(fx, /window\.csmCursorFx = \{/);
  // 画布不挡交互：pointer-events:none 且压在模态框（z-index 50）之上。
  assert.match(fx, /pointer-events:none;z-index:60/);
});

// ── 对话附件显示契约（纯 UI 改动必须有自动化契约检查，AGENTS.md）──

test('composer exposes the attachment entry embedded inside the input box', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // 嵌入式结构（ZCode/Codex 风）：#input 外包 .input-shell，「+」钉在输入框内部左缘（#input 之前）。
  const shell = page.match(/<div class="input-shell">[\s\S]*?<\/div>/)?.[0];
  assert.ok(shell, '.input-shell wrapper was not found');
  const attachIdx = shell.indexOf('id="attach"');
  const inputIdx = shell.indexOf('id="input"');
  assert.ok(attachIdx > -1 && inputIdx > -1 && attachIdx < inputIdx, '「+」按钮必须在 .input-shell 内、#input 之前');
  assert.match(shell, /<button id="attach" type="button" title="添加附件（文本 \/ Office（docx\/xlsx\/pptx）\/ PDF \/ 图片，也可拖拽或粘贴截图）">＋<\/button>/);
  assert.match(shell, /<input id="attachFile" type="file" multiple class="hidden" \/>/);
  assert.match(page, /<div id="attachmentChips" class="hidden" aria-live="polite"><\/div>/);
});

test('attachment intake: click / paste / drop all feed addAttachmentFiles with limits and vision gate', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // 三条入口汇入同一管线。
  assert.match(source, /attachEl\.addEventListener\('click', \(\) => attachFileEl\.click\(\)\);/);
  assert.match(source, /form\.addEventListener\('paste', \(ev\) => \{\s*const files = ev\.clipboardData\?\.files;/);
  assert.match(source, /footerEl\.addEventListener\('drop', \(ev\) => \{/);
  assert.match(source, /attachShell\.classList\.add\('dragover'\)/);
  // 限制与服务端一致：5 个 / 单文件 8MB / 合计 15MB。
  assert.match(source, /const ATTACH_MAX_COUNT = 5;/);
  assert.match(source, /const ATTACH_MAX_FILE = 8 \* 1024 \* 1024;/);
  assert.match(source, /const ATTACH_MAX_TOTAL = 15 \* 1024 \* 1024;/);
  // 视觉门：无视觉能力时前端直接拦图片并给指引。
  assert.match(source, /if \(isImage && !visionSupported\)/);
  assert.match(source, /当前模型不支持图片输入（视觉模型）/);
  // chips 删除钮 type=button + 阻断冒泡（表单内按钮默认 submit 的坑）。
  assert.match(source, /remove\.type = 'button';/);
  assert.match(source, /ev\.stopPropagation\(\);/);
  // 提交时附件随消息发送；空文本+有附件允许发送。
  assert.match(source, /attachments\.length \? \{ message: text, attachments \} : \{ message: text \}/);
  assert.match(source, /if \(\(!text && !attachments\.length\) \|\| busy \|\| !sessionId\) return;/);
  // 失败回滚：被拒（视觉门/类型/大小）时把内容与附件还给用户。
  assert.match(source, /if \(!res\.ok\) throw new Error\(result\.error/);
  assert.match(source, /pendingAttachments = attachments;/);
});

test('user messages render attachments: image preview via session route, others as file chips', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = source.match(/function addUserMessage[\s\S]*?\n  }\n/gs);
  assert.ok(renderer, 'addUserMessage source was not found');
  assert.match(source, /case 'user': addUserMessage\(e\); break;/);
  assert.match(renderer[0], /img\.className = 'attach-image';/);
  assert.match(renderer[0], /img\.src = href;/);
  assert.match(renderer[0], /`\/api\/sessions\/\$\{sessionId\}\/attachments\/\$\{a\.id\}`/);
  assert.match(renderer[0], /el\('span', 'attach-file', '📎 ' \+ \(a\.name \|\| '附件'\)\)/);
  const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // 嵌入式契约：绝对定位钉在输入框内左缘、透明底（hover 才显色）、#input 左内边距让位。
  assert.match(styles, /#attach \{[^}]*position: absolute;/s);
  assert.match(styles, /#attach \{[^}]*background: transparent;/s);
  assert.match(styles, /#attach:hover \{ background: var\(--panel-2\); color: var\(--text\); \}/);
  assert.match(styles, /#input \{[^}]*padding: 10px 14px 10px 42px;/s);
  assert.match(styles, /\.input-shell \{ position: relative; flex: 1; display: flex; \}/);
  assert.match(styles, /\.input-shell\.dragover #input \{ outline: 2px dashed var\(--accent\)/);
  assert.match(styles, /\.msg img\.attach-image \{[^}]*border: 1px solid var\(--border\)/);
  assert.match(styles, /#attachmentChips \{/);
  assert.match(styles, /\.attach-chip \{/);
});

test('llm settings expose a vision toggle: editable for custom, auto-detected read-only for builtins', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(page, /<input id="llmVision" type="checkbox" \/>/);
  assert.match(page, /id="llmVisionLabel"/);
  // 内置服务商按模型目录自动判定（disabled 展示），custom 手动声明并随保存提交。
  assert.match(source, /llmVision\.disabled = !isCustom;/);
  assert.match(source, /llmPayload\.vision = llmVision\.checked;/);
  assert.match(source, /visionSupported = data\.vision === true;/);
});

test('mac app shell implements the WKWebView open-panel delegate (file inputs would be dead without it)', () => {
  const swift = readFileSync(new URL('../scripts/mac-app/main.swift', import.meta.url), 'utf8');
  // WKWebView 的 <input type="file"> 点击完全依赖宿主 App 实现 runOpenPanelWith：
  // 缺了它点击静默无反应（无任何控制台报错），与 confirm/alert 面板缺失是同一类坑。
  assert.match(swift, /func webView\(_ webView: WKWebView,\s*runOpenPanelWith parameters: WKOpenPanelParameters,/);
  assert.match(swift, /panel\.allowsMultipleSelection = parameters\.allowsMultipleSelection/);
  assert.match(swift, /panel\.canChooseFiles = true/);
  // 三件套 JS 面板代理仍在（历史回归守护）。
  assert.match(swift, /runJavaScriptAlertPanelWithMessage/);
  assert.match(swift, /runJavaScriptConfirmPanelWithMessage/);
});

test('static shell assets are served no-store so a restarted app never runs a stale front-end', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  // 磁盘即真相：主文档与 app.js/style.css 不落中间层缓存（图标这类稳定资源除外），
  // 否则 WKWebView/浏览器内核的启发式缓存会让「改完样式看不到」。
  const indexRoute = server.match(/if \(req\.method === 'GET' && \(path === '\/' \|\| path === '\/index\.html'\)\) \{[\s\S]*?\n      \}/)?.[0];
  assert.ok(indexRoute, 'index route was not found');
  assert.match(indexRoute, /'Cache-Control': 'no-store'/);
  const staticRoute = server.match(/if \(req\.method === 'GET' && \['\/app\.js', '\/style\.css'[\s\S]*?\n      \}/)?.[0];
  assert.ok(staticRoute, 'static asset route was not found');
  assert.match(staticRoute, /if \(path !== '\/app-icon\.svg'\) headers\['Cache-Control'\] = 'no-store';/);
});
