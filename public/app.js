(function () {
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const statusEl = document.getElementById('status');
  const form = document.getElementById('composer');
  const attachEl = document.getElementById('attach');
  const attachFileEl = document.getElementById('attachFile');
  const attachShell = document.querySelector('.input-shell');
  const attachmentChipsEl = document.getElementById('attachmentChips');
  const sessionListEl = document.getElementById('sessionList');
  const newSessionBtn = document.getElementById('newSession');
  const recordListEl = document.getElementById('recordList');
  const recordCountEl = document.getElementById('recordCount');
  const quickActions = document.getElementById('quickActions');

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsClose = document.getElementById('settingsClose');
  const settingsModal = document.getElementById('settingsModal');
  const serverList = document.getElementById('serverList');
  const addServerBtn = document.getElementById('addServer');
  const saveConfigBtn = document.getElementById('saveConfig');
  const configResult = document.getElementById('configResult');

  const llmProvider = document.getElementById('llmProvider');
  const llmModel = document.getElementById('llmModel');
  const llmKey = document.getElementById('llmKey');
  const llmProtocolRow = document.getElementById('llmProtocolRow');
  const llmProtocol = document.getElementById('llmProtocol');
  const llmBaseUrlRow = document.getElementById('llmBaseUrlRow');
  const llmBaseUrlLabel = document.getElementById('llmBaseUrlLabel');
  const llmBaseUrl = document.getElementById('llmBaseUrl');
  const llmVision = document.getElementById('llmVision');
  const llmVisionLabel = document.getElementById('llmVisionLabel');
  const searchKey = document.getElementById('searchKey');
  const searchMaxResults = document.getElementById('searchMaxResults');

  const recordModal = document.getElementById('recordModal');
  const recordClose = document.getElementById('recordClose');
  const recordModalTitle = document.getElementById('recordModalTitle');
  const recordMeta = document.getElementById('recordMeta');
  const recordFields = document.getElementById('recordFields');

  const customerCard = document.getElementById('customerCard');
  const ccName = document.getElementById('ccName');
  const ccHealth = document.getElementById('ccHealth');
  const ccIdentity = document.getElementById('ccIdentity');
  const ccFacts = document.getElementById('ccFacts');
  const ccSummary = document.getElementById('ccSummary');

  const workbench = document.getElementById('workbench');
  const chatView = document.getElementById('chat');
  const footerEl = document.querySelector('footer');
  const agentSessions = document.getElementById('agentSessions');
  // Agent 悬浮球与悬浮面板头（#chat.floating 态）：任何视图就地开对话。
  const chatFab = document.getElementById('chatFab');
  const chatFloatingNew = document.getElementById('chatFloatingNew');
  const chatFloatingExpand = document.getElementById('chatFloatingExpand');
  const chatFloatingClose = document.getElementById('chatFloatingClose');
  const agentConversation = document.getElementById('agentConversation');
  const scrollBottomBtn = document.getElementById('scrollBottomBtn');
  const hemoryInbox = document.getElementById('hemoryInbox');
  const agentDrafts = document.getElementById('agentDrafts');
  const recordsPanel = document.getElementById('records');
  const hemoryPendingCount = document.getElementById('hemoryPendingCount');
  const draftPendingCount = document.getElementById('draftPendingCount');
  const agentNavCount = document.getElementById('agentNavCount');
  const archivedToggle = document.getElementById('archivedToggle');
  const archivedListEl = document.getElementById('archivedList');
  const archivedCount = document.getElementById('archivedCount');
  const hemoryDate = document.getElementById('hemoryDate');
  const hemoryTimeFrom = document.getElementById('hemoryTimeFrom');
  const hemoryTimeTo = document.getElementById('hemoryTimeTo');
  const hemoryFilterPanel = document.getElementById('hemoryFilterPanel');
  const hemoryFilterToggle = document.getElementById('hemoryFilterToggle');
  const hemoryConfirmedToggle = document.getElementById('hemoryConfirmedToggle');
  const hemoryFilterChip = document.getElementById('hemoryFilterChip');
  const hemoryCustomerClear = document.getElementById('hemoryCustomerClear');
  const hemoryCustomer = document.getElementById('hemoryCustomer');
  const hemoryCustomerOptions = document.getElementById('hemoryCustomerOptions');
  const hemorySelectAll = document.getElementById('hemorySelectAll');
  const hemorySelectedCount = document.getElementById('hemorySelectedCount');
  const hemoryFragmentList = document.getElementById('hemoryFragmentList');
  const draftBatchList = document.getElementById('draftBatchList');
  const draftTabPending = document.getElementById('draftTabPending');
  const draftTabArchived = document.getElementById('draftTabArchived');
  const draftFailedJobs = document.getElementById('draftFailedJobs');
  const draftGenerationNotice = document.getElementById('draftGenerationNotice');
  const draftGenerationText = document.getElementById('draftGenerationText');
  // 底部浮动操作条：勾选草稿后钉在可视区底部，免于滚回批次头部；默认批量确认，手动切换才进入忽略模式。
  const draftSelectionBar = document.getElementById('draftSelectionBar');
  const draftSelectedCount = document.getElementById('draftSelectedCount');
  const draftBarPrimary = document.getElementById('draftBarPrimary');
  const draftBarModeToggle = document.getElementById('draftBarModeToggle');
  let draftBarIgnoreMode = false;
  const globalSync = document.getElementById('globalSync');
  const customerSearch = document.getElementById('customerSearch');
  const customerSort = document.getElementById('customerSort');
  const refreshPortfolio = document.getElementById('refreshPortfolio');
  const customerRows = document.getElementById('customerRows');
  const portfolioMetrics = document.getElementById('portfolioMetrics');
  const portfolioEmpty = document.getElementById('portfolioEmpty');
  const customerOverview = document.getElementById('customerOverview');
  const actionBoard = document.getElementById('actionBoard');
  const actionNavCount = document.getElementById('actionNavCount');
  const alertBoard = document.getElementById('alertBoard');
  const alertNavCount = document.getElementById('alertNavCount');
  const actionTabPending = document.getElementById('actionTabPending');
  const actionTabCompleted = document.getElementById('actionTabCompleted');
  const actionBulkBar = document.querySelector('#actionsView .action-bulk-bar');
  const actionSelectAll = document.getElementById('actionSelectAll');
  const actionSelectedCount = document.getElementById('actionSelectedCount');
  const actionBulkComplete = document.getElementById('actionBulkComplete');
  const caseList = document.getElementById('caseList');
  const workbenchModal = document.getElementById('workbenchModal');
  const workbenchModalTitle = document.getElementById('workbenchModalTitle');
  const workbenchModalBody = document.getElementById('workbenchModalBody');
  const workbenchModalClose = document.getElementById('workbenchModalClose');
  const viewSections = {
    portfolio: document.getElementById('portfolioView'),
    customer: document.getElementById('customerView'),
    actions: document.getElementById('actionsView'),
    alerts: document.getElementById('alertsView'),
    cases: document.getElementById('casesView'),
  };

  let activeView = 'portfolio';
  let activeAgentMode = 'conversation';
  // Agent 对话悬浮态：#chat 本体加 .floating 变 fixed 弹层，脱离 agent 视图也可用。
  let chatFloating = false;
  let activeCustomerId = null;
  let customersCache = [];

  let sessionId = null;
  let sessionCustomerId = null;
  let es = null;
  let busy = false;
  let maxSeq = 0;
  let mcpFailures = [];
  let archivedExpanded = false;
  let draftJobTracking = new Map();
  let draftJobTimer = null;
  let draftJobStartedAt = 0;
  let activeDraftTab = 'pending';
  let activeActionTab = 'pending';
  let activeAlertTab = 'pending';

  function setStatus(cls, text) {
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
    statusEl.lastChild.textContent = text;
    // 顶栏状态位窄窗口下按 ellipsis 截断，title 保留全文供悬停查看。
    statusEl.lastChild.title = text;
  }

  /**
   * 短暂提示后自动清除：清除前校验状态栏仍是这条文案（代际守卫），避免清掉用户触发的其他状态
   *（setStatus 是纯赋值无自动清除，warn 提示曾永久钉死在角落——「草稿生成仍在后台进行」卡死的根因之一）。
   */
  let transientStatusGeneration = 0;
  function setTransientStatus(cls, text, clearMs) {
    setStatus(cls, text);
    const generation = ++transientStatusGeneration;
    setTimeout(() => {
      if (generation !== transientStatusGeneration) return;
      if (statusEl.lastChild.textContent === text) setStatus('', '');
    }, clearMs);
  }

  /** 空闲态状态栏：MCP 部分未连接给 warn 摘要，否则「就绪」。 */
  function setIdleStatus() {
    setStatus(mcpFailures.length ? 'warn' : 'ok', mcpFailures.length ? '部分系统未连接: ' + mcpFailures.map(([n]) => n).join(', ') : '就绪');
  }

  /** 侧边栏 Agent 角标 = Hemory 待归属 + 草稿箱两个数字之和（与两个 tab 角标同源）。 */
  function updateAgentNavCount() {
    const total = Number(hemoryPendingCount.textContent || 0) + Number(draftPendingCount.textContent || 0);
    agentNavCount.textContent = total || '';
  }

  // 对话只在「贴底」时跟随流式输出：上滑读历史即暂停跟随（隐藏的回到底部按钮浮现），
  // 手动滚回底部自动恢复跟随；发送消息/切换会话视为明确意图，强制重新贴底。
  let stickToBottom = true;
  const SCROLL_BOTTOM_EDGE = 80; // px：距底不超过该值视为贴底

  function isNearBottom() {
    const panel = messagesEl.parentElement;
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight <= SCROLL_BOTTOM_EDGE;
  }

  messagesEl.parentElement.addEventListener('scroll', () => {
    stickToBottom = isNearBottom();
    scrollBottomBtn.classList.toggle('hidden', stickToBottom);
  }, { passive: true });

  function scrollDown() {
    if (!stickToBottom) return;
    messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
  }

  function pinToBottom() {
    stickToBottom = true;
    scrollBottomBtn.classList.add('hidden');
    scrollDown();
  }

  scrollBottomBtn.onclick = () => pinToBottom();

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
    return body;
  }

  function formatDate(value) {
    if (!value) return '未知';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleDateString('zh-CN');
  }

  function formatDateTime(value) {
    if (!value) return '未知';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12: false });
  }

  // 生成任务的 progress 现在是滚动多行日志（阶段行 + 末尾流式 tick）；单行展示位只取最后一行即当前状态。
  function progressTail(job, runningText) {
    return String(job.progress || '').split('\n').filter(Boolean).pop() || (job.status === 'running' ? runningText : '排队中');
  }

  function formatMoney(value) {
    if (value === null || value === undefined) return '未知';
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  const HEALTH_LABEL = { high: '高风险', medium: '中风险', low: '低风险', unknown: '待补数据' };
  const RISK_DIMENSION_LABEL = {
    suggestion: '需求完成',
    ticket: '工单解决',
    engagement: '互动',
    voice: '客户声音',
    web: '公开动态',
  };
  // 预警触发键 → 中文标签（与 CLI ALERT_TRIGGER_LABELS 同口径）。
  const ALERT_TRIGGER_LABEL = {
    engagement_inactivity: 'CRM 与 ONES 互动停滞',
    negative_public_signal: '公开负面动态',
  };
  const SOURCE_TYPE_LABEL = {
    customer_snapshot: 'CRM 客户资料',
    crm_followup: 'CRM 跟进记录',
    suggestion_feedback: '建议与反馈',
    support_ticket: '工单',
    operations_ticket: '运维工单',
    customer_manhour: '客户工时',
    private_cloud_instance: '私有云实例',
    ai_topic_segment: '会议话题片段',
    meeting_action_candidate: '会议待办候选',
    customer_option_candidate: '待确认客户映射',
  };
  const DRAFT_TARGETS = {
    suggestion_feedback: { label: '建议', recordType: 'suggestion', target: 'ONES Desk / 建议和反馈', projectId: 'GL3ysesFPdnAQNIU', issueTypeId: 'A99xMfkg' },
    support_ticket: { label: '工单', recordType: 'ticket', target: 'ONES Desk / 工单', projectId: 'GL3ysesFPdnAQNIU', issueTypeId: '7sxvwZMY' },
    operations_ticket: { label: '运维工单', recordType: 'operations', target: 'ONES Desk / 运维工单', projectId: 'GL3ysesFPdnAQNIU', issueTypeId: '943qpMX7' },
    customer_manhour: { label: '工时', recordType: 'workhour', target: '客户工时管理 / 售后客户' },
    private_cloud_instance: { label: '私有云实例', recordType: 'private_cloud_instance', target: '私有云实例管理 / 私有云实例', projectId: 'GL3ysesF59l5lRH9', issueTypeId: 'GvyPHeW5' },
    followup: { label: '跟进记录', recordType: 'followup', target: 'CRM / CSM 售后客户跟进' },
  };

  function badge(text, cls) {
    return el('span', `business-badge ${cls || ''}`.trim(), text);
  }

  function closeWorkbenchModal() {
    workbenchModal.classList.add('hidden');
    workbenchModalBody.innerHTML = '';
  }

  function openWorkbenchModal(title) {
    workbenchModalTitle.textContent = title;
    workbenchModal.classList.remove('hidden');
    workbenchModalBody.innerHTML = '';
  }

  workbenchModalClose.onclick = closeWorkbenchModal;
  workbenchModal.onclick = (event) => { if (event.target === workbenchModal) closeWorkbenchModal(); };

  // 页面内对话框：Mac 壳的 WKWebView 未实现原生 JS 对话框面板，confirm/alert/prompt 会静默失败，禁止直接调用原生版本。
  const appDialog = document.getElementById('appDialog');
  const appDialogMessage = document.getElementById('appDialogMessage');
  const appDialogInput = document.getElementById('appDialogInput');
  const appDialogOk = document.getElementById('appDialogOk');
  const appDialogCancel = document.getElementById('appDialogCancel');

  function showAppDialog({ message, okText = '确定', cancelText = '取消', withInput = false, defaultValue = '' }) {
    return new Promise((resolve) => {
      appDialogMessage.textContent = message;
      appDialogInput.classList.toggle('hidden', !withInput);
      if (withInput) { appDialogInput.value = defaultValue; }
      appDialogOk.textContent = okText;
      appDialogCancel.textContent = cancelText;
      appDialog.classList.remove('hidden');
      const done = (value) => { appDialog.classList.add('hidden'); appDialogOk.onclick = null; appDialogCancel.onclick = null; appDialogInput.onkeydown = null; appDialog.onclick = null; resolve(value); };
      appDialogOk.onclick = () => done(withInput ? appDialogInput.value : true);
      appDialogCancel.onclick = () => done(withInput ? null : false);
      appDialog.onclick = (event) => { if (event.target === appDialog) done(withInput ? null : false); };
      if (withInput) {
        appDialogInput.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); done(appDialogInput.value); } };
        appDialogInput.focus();
      } else appDialogOk.focus();
    });
  }

  const confirmDialog = (message) => showAppDialog({ message, cancelText: '取消' });
  const alertDialog = (message) => showAppDialog({ message, cancelText: '关闭' });
  const promptDialog = (message, defaultValue = '') => showAppDialog({ message, withInput: true, defaultValue });

  /** 异步按钮通用 loading：点击即禁用并显示进行中文案，结束（含失败）恢复，防止重复触发。 */
  function withLoading(button, busyText, fn) {
    button.onclick = async () => {
      if (button.disabled) return;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = busyText;
      try { return await fn(); }
      finally { button.disabled = false; button.textContent = original; }
    };
  }

  /** 立即执行型 loading：与 withLoading 同语义但不接管 onclick，供菜单项把加载态挂到触发按钮上（菜单已收起，项自身不可见）。 */
  async function runWithBusy(button, busyText, fn) {
    if (button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try { return await fn(); }
    finally { button.disabled = false; button.textContent = original; }
  }

  // ── 下拉命令菜单（首个此类组件）：启动期一次性注册委托关闭，openCustomer 整页重渲染不累积监听。 ──

  function closeAllCommandMenus() {
    for (const list of document.querySelectorAll('.command-menu-list')) {
      list.classList.add('hidden');
      list.setAttribute('aria-hidden', 'true');
    }
    for (const trigger of document.querySelectorAll('.command-menu > button[aria-expanded]')) trigger.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('.command-menu')) return;
    closeAllCommandMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllCommandMenus();
  });

  /**
   * 下拉命令菜单：触发按钮 + 右对齐浮层列表。items: [{ label, run }]，
   * 点项先收起菜单再执行动作；同一时刻只允许一个菜单展开。
   */
  function commandMenu(label, items) {
    const wrap = el('span', 'command-menu');
    const trigger = el('button', 'quiet-command', label);
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    const list = el('div', 'command-menu-list hidden');
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-hidden', 'true');
    const close = () => { closeAllCommandMenus(); };
    trigger.onclick = () => {
      const opening = list.classList.contains('hidden');
      closeAllCommandMenus();
      if (opening) {
        list.classList.remove('hidden');
        list.setAttribute('aria-hidden', 'false');
        trigger.setAttribute('aria-expanded', 'true');
      }
    };
    for (const item of items) {
      const itemButton = el('button', 'command-menu-item', item.label);
      itemButton.type = 'button';
      itemButton.setAttribute('role', 'menuitem');
      itemButton.onclick = async () => { close(); await item.run(); };
      list.append(itemButton);
    }
    wrap.append(trigger, list);
    return { wrap, trigger, list };
  }

  // ── ONES Wiki 发布位置选择器（空间 → 页面树，懒加载展开；案例发布与周报发布共用） ──

  /** 把平面页面列表组装成嵌套 <details> 树；初始只渲染根层，展开时挂子层。 */
  function buildWikiTree(pages, onPick) {
    const byParent = new Map();
    for (const page of pages) {
      if (!byParent.has(page.parentID)) byParent.set(page.parentID, []);
      byParent.get(page.parentID).push(page);
    }
    const knownIds = new Set(pages.map((page) => page.id));
    // 根 = parentID 为空，或 parentID 指向不存在的页面（删掉的父页，挂根层避免选不到）。
    const roots = [
      ...(byParent.get('') || []),
      ...pages.filter((page) => page.parentID && !knownIds.has(page.parentID)),
    ];
    const renderLevel = (list, container) => {
      for (const page of list) {
        const children = byParent.get(page.id) || [];
        const pick = el('button', 'quiet-command small', '选此页');
        pick.type = 'button';
        withLoading(pick, '选择中', async () => onPick(page));
        let node;
        if (children.length || page.canAttachChildPages) {
          // summary 必须是 details 的直接子元素（HTML 规范），按钮放在 summary 内保持同行。
          node = document.createElement('details');
          node.className = 'wiki-tree-node';
          const summary = el('summary', null, `${page.isArchived ? '[已归档] ' : ''}${page.title}`);
          summary.append(pick);
          node.append(summary);
          if (children.length) {
            const childContainer = el('div', 'wiki-tree-children');
            node.append(childContainer);
            let loaded = false;
            node.addEventListener('toggle', () => {
              if (node.open && !loaded) { loaded = true; renderLevel(children, childContainer); }
            });
          }
        } else {
          node = el('div', 'wiki-tree-node wiki-tree-leaf');
          const head = el('div', 'wiki-tree-head');
          head.append(el('span', 'wiki-tree-title', `${page.isArchived ? '[已归档] ' : ''}${page.title}`), pick);
          node.append(head);
        }
        container.append(node);
      }
    };
    const root = el('div', 'wiki-tree');
    renderLevel(roots, root);
    return root;
  }

  /**
   * ONES Wiki 发布位置选择器：先选空间（页面组），再在页面树中逐层展开选父页面。
   * 返回 Promise<{pageID, title} | null>；取消/关闭返回 null。
   */
  function pickWikiPage() {
    return new Promise((resolve) => {
      openWorkbenchModal('选择 ONES Wiki 发布位置');
      const done = (value) => { closeWorkbenchModal(); resolve(value); };
      const body = el('div', 'wiki-picker');
      const spaceSelect = document.createElement('select');
      spaceSelect.className = 'wiki-space-select';
      spaceSelect.append(el('option', null, '加载页面组中…'));
      const treeHost = el('div', 'wiki-tree-host');
      const hint = el('div', 'cell-sub', '选择页面组后展示页面树；展开层级并点「选此页」确定父页面。');
      const manual = el('button', 'quiet-command small', '直接输入页面 ID');
      manual.type = 'button';
      manual.onclick = async () => {
        const pageID = (await promptDialog('ONES Wiki 父页面 ID：', '')) ?? '';
        if (pageID) done({ pageID: pageID.trim(), title: pageID.trim() });
      };
      const cancel = el('button', 'quiet-command small', '取消');
      cancel.type = 'button';
      cancel.onclick = () => done(null);
      const actions = el('div', 'row-actions');
      actions.append(manual, cancel);
      const pick = (page) => done({ pageID: page.id, title: page.title });
      spaceSelect.onchange = async () => {
        treeHost.innerHTML = '';
        const spaceId = spaceSelect.value;
        if (!spaceId) return;
        treeHost.append(el('div', 'cell-sub', '加载页面树中…'));
        try {
          const data = await api(`/api/ones-wiki/pages?space_id=${encodeURIComponent(spaceId)}`);
          treeHost.innerHTML = '';
          const pages = data.pages || [];
          if (!pages.length) treeHost.append(el('div', 'workspace-empty', '该页面组没有可见页面'));
          else treeHost.append(buildWikiTree(pages, pick));
        } catch (error) {
          treeHost.innerHTML = '';
          treeHost.append(el('div', 'workspace-empty', error.message));
        }
      };
      body.append(hint, spaceSelect, treeHost, actions);
      workbenchModalBody.append(body);
      void (async () => {
        try {
          const data = await api('/api/ones-wiki/spaces');
          const spaces = data.spaces || [];
          spaceSelect.innerHTML = '';
          spaceSelect.append(el('option', null, spaces.length ? '选择页面组…' : '（无可见页面组）'));
          for (const space of spaces) {
            const option = el('option', null, space.name);
            option.value = space.id;
            spaceSelect.append(option);
          }
        } catch (error) {
          spaceSelect.innerHTML = '';
          spaceSelect.append(el('option', null, '页面组加载失败'));
          hint.textContent = `${error.message}；可直接输入页面 ID。`;
        }
      })();
    });
  }

  // ── chat rendering ─────────────────────────────────────────────

  function clearMessages() { messagesEl.innerHTML = ''; maxSeq = 0; renderCustomerCard(null); stickToBottom = true; scrollBottomBtn.classList.add('hidden'); }

  function renderCustomerCard(c) {
    const empty = customerCard.querySelector('.cc-empty');
    const body = customerCard.querySelector('.cc-body');
    if (!c || !c.customer_name && !c.crm_customer_id && !c.ones_project && !c.recording_subject_id) {
      customerCard.classList.add('empty');
      empty.classList.remove('hidden');
      body.classList.add('hidden');
      return;
    }
    customerCard.classList.remove('empty');
    empty.classList.add('hidden');
    body.classList.remove('hidden');

    ccName.textContent = c.customer_name || c.crm_customer_id || '(未命名客户)';

    const h = c.health;
    ccHealth.textContent = h ? ('健康度 ' + h) : '';
    ccHealth.className = 'cc-health' + (h === '绿' ? ' ok' : h === '黄' ? ' warn' : h === '红' ? ' danger' : '');

    ccIdentity.innerHTML = '';
    const tags = [
      c.crm_customer_id && ('CRM ' + c.crm_customer_id),
      c.ones_project && ('ONES ' + c.ones_project),
      c.recording_subject_id && ('录音 ' + c.recording_subject_id),
    ].filter(Boolean);
    for (const t of tags) { const s = el('span', 'tag', t); ccIdentity.appendChild(s); }

    ccFacts.innerHTML = '';
    const facts = [
      c.industry && ['行业', c.industry],
      c.usage_version && ['使用版本', c.usage_version],
      c.scale && ['规模', c.scale],
      c.stage && ['阶段', c.stage],
      c.renewal_status && ['续约', c.renewal_status],
      c.key_contacts && ['联系人', c.key_contacts],
    ].filter(Boolean);
    if (facts.length) {
      const wrap = document.createElement('span');
      facts.forEach(([k, v], i) => {
        if (i) wrap.append(' · ');
        const b = document.createElement('b'); b.textContent = k + ' ';
        wrap.append(b, v);
      });
      ccFacts.appendChild(wrap);
    }

    if (c.summary) { ccSummary.classList.remove('hidden'); ccSummary.textContent = c.summary; }
    else { ccSummary.classList.add('hidden'); }
  }

  function addMessage(cls, text) {
    const n = el('div', 'msg ' + cls, text);
    messagesEl.appendChild(n);
    scrollDown();
  }

  /** 用户消息：正文 + 附件（图片走会话附件路由预览，其余展示文件 chip；元信息随事件回放）。 */
  function addUserMessage(e) {
    const n = el('div', 'msg user');
    if (e.text) n.appendChild(el('div', null, e.text));
    const attachments = Array.isArray(e.attachments) ? e.attachments : [];
    if (attachments.length) {
      const list = el('div', 'attach-list');
      for (const a of attachments) {
        const href = `/api/sessions/${sessionId}/attachments/${a.id}`;
        if ((a.mimeType || '').startsWith('image/')) {
          const img = document.createElement('img');
          img.className = 'attach-image';
          img.src = href;
          img.alt = a.name || '图片附件';
          img.loading = 'lazy';
          list.appendChild(img);
        } else {
          const chip = el('span', 'attach-file', '📎 ' + (a.name || '附件'));
          chip.title = (a.name || '') + (a.size ? `（${(a.size / 1024).toFixed(0)}KB）` : '');
          list.appendChild(chip);
        }
      }
      n.appendChild(list);
    }
    messagesEl.appendChild(n);
    scrollDown();
  }

  function addToolLine(name, args) {
    const n = el('div', 'tool');
    const b = document.createElement('b');
    b.textContent = name;
    n.append('调用工具 ', b);
    if (args && Object.keys(args).length) n.append(' · ' + JSON.stringify(args).slice(0, 180));
    messagesEl.appendChild(n);
    scrollDown();
  }

  function addConfirmCard(draft, editContract) {
    const card = el('div', 'card');
    card.append(el('h3', null, '待确认草稿'), el('div', 'meta', `目标系统: ${draft.target_system} ｜ 工具: ${draft.target_tool}`));
    const actions = el('div', 'actions');
    const okBtn = el('button', 'approve', '批准写入');
    const noBtn = el('button', 'reject', '拒绝');
    // 有结构化编辑契约的类型渲染中文表单（批准只提交字段键→新值，服务端合并）；
    // 无契约（客户案例/客户档案等）保留原始 JSON 编辑器。
    if (editContract) {
      const form = renderDraftEditForm(editContract, card);
      const decide = async (approve) => {
        okBtn.disabled = noBtn.disabled = true;
        try {
          let payload = { approve: false };
          if (approve) {
            const collected = form.collect();
            if (collected.error) { okBtn.disabled = noBtn.disabled = false; return alertDialog(collected.error); }
            payload = { approve: true, edits: collected.edits };
          }
          const response = await fetch(`/api/sessions/${sessionId}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || `操作失败 (${response.status})`);
          actions.replaceWith(el('div', 'decided', approve ? '已批准，正在写入…' : '已拒绝'));
          loadRecords();
        } catch (err) {
          okBtn.disabled = noBtn.disabled = false;
          const previous = actions.querySelector('.decided');
          if (previous) previous.remove();
          actions.append(el('div', 'decided', '操作失败: ' + err.message));
        }
      };
      okBtn.onclick = () => decide(true);
      noBtn.onclick = () => decide(false);
      actions.append(okBtn, noBtn);
      card.append(actions);
      messagesEl.appendChild(card);
      scrollDown();
      return;
    }
    const title = inputField('标题', draft.title);
    const summary = inputField('摘要', draft.summary, 'textarea');
    const fields = inputField('业务字段（JSON）', JSON.stringify(draft.fields ?? {}, null, 2), 'textarea');
    const args = inputField('实际回写参数（JSON）', JSON.stringify(draft.target_arguments ?? {}, null, 2), 'textarea');
    fields.input.classList.add('json-editor');
    args.input.classList.add('json-editor');
    card.append(title.field, summary.field, fields.field, args.field);
    const decide = async (approve) => {
      okBtn.disabled = noBtn.disabled = true;
      try {
        let edited = draft;
        if (approve) {
          edited = { ...draft, title: title.input.value.trim(), summary: summary.input.value.trim(),
            fields: JSON.parse(fields.input.value), target_arguments: JSON.parse(args.input.value) };
        }
        const response = await fetch(`/api/sessions/${sessionId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve, draft: approve ? edited : undefined }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `操作失败 (${response.status})`);
        actions.replaceWith(el('div', 'decided', approve ? '已批准，正在写入…' : '已拒绝'));
        loadRecords();
      } catch (err) {
        okBtn.disabled = noBtn.disabled = false;
        const previous = actions.querySelector('.decided');
        if (previous) previous.remove();
        actions.append(el('div', 'decided', '操作失败: ' + err.message));
      }
    };
    okBtn.onclick = () => decide(true);
    noBtn.onclick = () => decide(false);
    actions.append(okBtn, noBtn);
    card.append(actions);
    messagesEl.appendChild(card);
    scrollDown();
  }

  function setThinking(on) {
    const existing = messagesEl.querySelector('.thinking');
    if (on && !existing) {
      messagesEl.appendChild(el('div', 'thinking', '思考中…'));
      scrollDown();
    } else if (!on && existing) {
      existing.remove();
    }
  }

  // ── streaming turn state ────────────────────────────────────────
  // 活动回复占位：delta 流入临时 div，收到整段持久 text 事件后整段重渲（顺序保证不重复）。
  let activeMsgEl = null;
  let activeThinkEl = null;
  let sessionTokens = 0;

  function startStreaming() {
    activeMsgEl = el('div', 'msg assistant streaming');
    activeThinkEl = null;
  }

  function endStreaming() {
    if (activeMsgEl) { activeMsgEl.remove(); activeMsgEl = null; }
    if (activeThinkEl) { activeThinkEl.remove(); activeThinkEl = null; }
  }

  function appendTextDelta(delta) {
    if (!activeMsgEl) startStreaming();
    if (!activeMsgEl.parentNode) messagesEl.appendChild(activeMsgEl);
    activeMsgEl.append(delta);
    scrollDown();
  }

  function appendThinkingDelta(delta) {
    if (!activeThinkEl) {
      activeThinkEl = el('div', 'think-block open');
      const head = el('div', 'think-head', '思考中…');
      const body = el('div', 'think-body');
      head.onclick = () => activeThinkEl && activeThinkEl.classList.toggle('open');
      activeThinkEl.append(head, body);
    }
    if (!activeThinkEl.parentNode) messagesEl.insertBefore(activeThinkEl, activeMsgEl && activeMsgEl.parentNode ? activeMsgEl : null);
    activeThinkEl.querySelector('.think-body').append(delta);
    scrollDown();
  }

  /** 折叠思考面板为一行摘要（本轮 thinking 流结束后调用）。 */
  function settleThinking() {
    if (!activeThinkEl) return;
    const text = activeThinkEl.querySelector('.think-body').textContent || '';
    const head = activeThinkEl.querySelector('.think-head');
    head.textContent = `已深度思考（${text.length} 字）`;
    activeThinkEl.classList.remove('open');
  }

  function addTokenUsage(usage) {
    if (!usage || typeof usage.total !== 'number') return;
    sessionTokens += usage.total;
    const line = el('div', 'msg system', `本轮 tokens：输入 ${usage.input} · 输出 ${usage.output}（本会话累计 ${sessionTokens}）`);
    messagesEl.appendChild(line);
    scrollDown();
  }

  /** 发送按钮双态：空闲=「发送」提交表单，对话进行中=红色「停止」可中断本轮。 */
  function setSendStopping(on) {
    sendEl.textContent = on ? '停止' : '发送';
    sendEl.classList.toggle('stopping', on);
    sendEl.disabled = false;
  }

  function handleEvent(e) {
    if (!e) return;
    switch (e.type) {
      case 'user': addUserMessage(e); break;
      case 'turn_start': busy = true; setThinking(true); startStreaming(); setSendStopping(true); syncChatFab(); break;
      case 'text_delta': appendTextDelta(e.delta); break;
      case 'thinking_delta': appendThinkingDelta(e.delta); break;
      case 'thinking': settleThinking(); break;
      case 'text': endStreaming(); addMessage('assistant', e.text); break;
      case 'tool_call': endStreaming(); settleThinking(); addToolLine(e.name, e.arguments); break;
      case 'tool_result':
        if (e.name !== 'confirm_write') {
          messagesEl.appendChild(el('div', 'tool', '← ' + e.name + ': ' + (e.result || '').slice(0, 220)));
          scrollDown();
        }
        break;
      case 'confirm': addConfirmCard(e.draft, e.editContract); loadRecords(); break;
      case 'customer_context': renderCustomerCard(e.context); break;
      case 'turn_end':
        busy = false;
        syncChatFab();
        setThinking(false);
        endStreaming();
        setSendStopping(false);
        inputEl.disabled = false;
        // 焦点只在对话界面在场时回填（完整视图或悬浮面板），后台轮次结束不抢其他页面输入框的焦点。
        if (activeView === 'agent' || chatFloating) inputEl.focus();
        // 停止会把挂起中的草稿自动按拒绝处理，旧确认卡不允许再交互。
        if (e.stopped === true) disablePendingConfirmCards();
        addTokenUsage(e.usage);
        loadSessions();
        loadRecords();
        // 「正在停止对话…」是纯赋值无自动清除：轮次结束时按文案守卫释放，别清掉其他面板置上的状态。
        if (statusEl.lastChild.textContent === '正在停止对话…') setIdleStatus();
        break;
    }
  }

  /** 停止后禁用消息流里仍未决策的确认卡按钮。 */
  function disablePendingConfirmCards() {
    for (const card of messagesEl.querySelectorAll('.card')) {
      for (const btn of card.querySelectorAll('button')) btn.disabled = true;
    }
  }

  // ── sessions ───────────────────────────────────────────────────

  async function loadSessions() {
    try {
      const [activeRes, allRes] = await Promise.all([fetch('/api/sessions'), fetch('/api/sessions?include=archived')]);
      const active = (await activeRes.json()).sessions || [];
      const all = (await allRes.json()).sessions || [];
      renderSessionList(active);
      renderArchivedList(all.filter((s) => s.archived === true));
    } catch (_) { /* ignore */ }
  }

  function renderSessionList(sessions) {
    sessionListEl.innerHTML = '';
    for (const s of sessions) {
      const item = el('div', 'session-item' + (s.id === sessionId ? ' active' : ''));
      const t = el('span', 't', s.title || '新对话');
      const ops = el('span', 'ops');
      const share = el('button', 'sh', '分享');
      share.title = '分享会话（复制全文）';
      const rename = el('button', 'ren', '✎');
      const archive = el('button', 'arc', '⤓');
      archive.title = '归档会话';
      const del = el('button', 'del', '✕');
      share.onclick = (ev) => { ev.stopPropagation(); shareSession(s.id, share); };
      rename.onclick = (ev) => { ev.stopPropagation(); renameSession(s.id, s.title); };
      archive.onclick = (ev) => { ev.stopPropagation(); archiveSession(s.id); };
      del.onclick = (ev) => { ev.stopPropagation(); deleteSession(s.id); };
      ops.append(share, rename, archive, del);
      item.append(t, ops);
      item.onclick = () => openSessionView(s.id);
      sessionListEl.appendChild(item);
    }
  }

  function renderArchivedList(archived) {
    archivedCount.textContent = archived.length || '';
    archivedToggle.classList.toggle('hidden', !archived.length);
    archivedListEl.classList.toggle('hidden', !archived.length || !archivedExpanded);
    archivedListEl.innerHTML = '';
    if (!archived.length || !archivedExpanded) return;
    for (const s of archived) {
      const item = el('div', 'session-item archived');
      const t = el('span', 't', s.title || '新对话');
      const ops = el('span', 'ops');
      const restore = el('button', 'ren', '恢复');
      restore.title = '恢复到会话列表';
      restore.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          await api(`/api/sessions/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false }) });
          await loadSessions();
        } catch (error) { await alertDialog(error.message); }
      };
      ops.append(restore);
      item.append(t, ops);
      archivedListEl.appendChild(item);
    }
  }

  function connectEvents(id) {
    if (es) es.close();
    es = new EventSource(`/api/sessions/${id}/events`);
    es.onmessage = (msg) => {
      try {
        const { seq, event } = JSON.parse(msg.data);
        if (seq <= maxSeq) return;
        maxSeq = seq;
        handleEvent(event);
      } catch (_) { /* ignore */ }
    };
    es.onerror = () => setStatus('warn', '连接中断，正在重连…');
    // 重连成功后释放断线提示（onerror 同样是纯赋值，没有 onopen 时文案会一直挂着）。
    es.onopen = () => { if (statusEl.lastChild.textContent === '连接中断，正在重连…') setIdleStatus(); };
  }

  async function switchSession(id) {
    sessionId = id;
    sessionCustomerId = null;
    clearMessages();
    connectEvents(id);
    const list = await (await fetch('/api/sessions')).json().then((d) => d.sessions);
    renderSessionList(list);
    const meta = list.find((s) => s.id === id);
    sessionCustomerId = meta?.customerId ?? null;
    setIdleStatus();
  }

  /** 会话列表点击：切会话并回到对话面板——侧栏列表在 Hemory 片段/草稿箱 tab 下仍可见，只 switchSession 会停留在原面板。 */
  async function openSessionView(id) {
    await switchSession(id);
    showView('agent');
    await showAgentMode('conversation');
  }

  /** Ensure the active agent session is bound to this customer; create one if not. */
  async function ensureCustomerSession(customer) {
    if (sessionId && sessionCustomerId === customer.id) return;
    const created = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: customer.id }) });
    await switchSession(created.id);
    renderCustomerCard(created.customer);
    loadSessions();
  }

  async function newSession() {
    const res = await fetch('/api/sessions', { method: 'POST' });
    const data = await res.json();
    await switchSession(data.id);
    loadSessions();
  }

  async function renameSession(id, oldTitle) {
    const title = await promptDialog('会话名称：', oldTitle || '');
    if (title === null || !title.trim()) return;
    await fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    loadSessions();
  }

  async function deleteSession(id) {
    if (!await confirmDialog('删除该会话？此操作不可恢复。')) return;
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (id === sessionId) {
      await newSession();
    } else {
      loadSessions();
    }
  }

  async function archiveSession(id) {
    if (!await confirmDialog('归档该会话？会话将从列表隐藏，可在「已归档」区恢复。')) return;
    try {
      await api(`/api/sessions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    } catch (error) { return alertDialog(error.message); }
    if (id === sessionId) {
      const list = await (await fetch('/api/sessions')).json().then((d) => d.sessions);
      if (list.length) await switchSession(list[0].id);
      else await newSession();
    }
    loadSessions();
  }

  /** 复制文本：优先 Clipboard API，失败回落 execCommand（WKWebView 兼容）。 */
  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through to execCommand */ }
    try {
      const holder = document.createElement('textarea');
      holder.value = text;
      holder.style.position = 'fixed';
      holder.style.opacity = '0';
      document.body.appendChild(holder);
      holder.select();
      const ok = document.execCommand('copy');
      holder.remove();
      return ok;
    } catch (_) { return false; }
  }

  async function shareSession(id, btn) {
    if (!id) return;
    let data;
    try {
      data = await api(`/api/sessions/${id}/export`);
    } catch (error) { return alertDialog(error.message); }
    if (!data.transcript?.trim()) return alertDialog('当前会话还没有内容');
    const ok = await copyText(data.transcript);
    if (!ok) return alertDialog('复制失败，请手动重试');
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }
  }

  // ── records ────────────────────────────────────────────────────

  const TYPE_LABEL = { followup: '跟进记录', profile: '客户档案', case: '客户案例' };
  const STATUS_LABEL = { draft: '草稿', approved: '已批准', written: '已回写', rejected: '已拒绝' };

  async function loadRecords() {
    try {
      const res = await fetch('/api/records');
      const data = await res.json();
      const records = data.records || [];
      recordCountEl.textContent = records.length ? `(${records.length})` : '';
      if (!records.length) {
        recordListEl.innerHTML = el('div', 'empty', 'Agent 生成的外部写入草稿（跟进/工单/工时等）及你的确认/拒绝记录会显示在这里').outerHTML;
        return;
      }
      recordListEl.innerHTML = '';
      for (const r of records) {
        const item = el('div', 'record-item');
        item.append(el('div', 'r-title', r.title || '(无标题)'));
        item.append(el('div', 'r-meta', (r.customer || '未指定客户') + ' → ' + (r.target === 'ones' ? 'ONES' : r.target === 'crm' ? 'CRM' : (r.target || '?'))));
        const badges = el('div', 'badges');
        badges.append(
          el('span', 'badge type', TYPE_LABEL[r.type] || r.type || '记录'),
          el('span', 'badge status-' + r.status, STATUS_LABEL[r.status] || r.status),
        );
        item.append(badges);
        item.onclick = () => showRecord(r);
        recordListEl.appendChild(item);
      }
    } catch (_) { /* ignore */ }
  }

  function showRecord(r) {
    recordModalTitle.textContent = r.title || '记录详情';
    recordMeta.textContent = `类型: ${TYPE_LABEL[r.type] || r.type} ｜ 客户: ${r.customer || '—'} ｜ 状态: ${STATUS_LABEL[r.status] || r.status} ｜ 目标: ${r.target || '—'}`;
    recordFields.textContent = JSON.stringify(r.fields ?? {}, null, 2);
    recordModal.classList.remove('hidden');
  }

  recordClose.addEventListener('click', () => recordModal.classList.add('hidden'));
  recordModal.addEventListener('click', (ev) => { if (ev.target === recordModal) recordModal.classList.add('hidden'); });

  // ── MCP 配置面板 ───────────────────────────────────────────────

  function field(labelText) { const w = el('div', 'field'); w.append(el('label', null, labelText)); return w; }
  function makeInput(cls, value, placeholder) {
    const i = document.createElement('input'); i.className = cls; i.value = value ?? '';
    if (placeholder) i.placeholder = placeholder; return i;
  }
  function makeSelect(cls, options, value) {
    const s = document.createElement('select'); s.className = cls;
    for (const o of options) { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; s.append(opt); }
    s.value = value; return s;
  }
  function makeTextarea(cls, value, placeholder) {
    const t = document.createElement('textarea'); t.className = cls; t.value = value ?? '';
    if (placeholder) t.placeholder = placeholder; return t;
  }

  // Three auth modes the UI supports:
  //  - bearer: streamable-http + Authorization: Bearer <token> (CRM/Hemory style)
  //  - custom: streamable-http + arbitrary header, e.g. X-ONES-MCP-Token
  //  - oauth:  stdio + npx mcp-remote <url> (browser OAuth flow)
  function normalizeServer(s) {
    const args = s.args ?? [];
    const isOAuth = s.transport === 'stdio' && s.command === 'npx' && args.some((a) => String(a).includes('mcp-remote'));
    if (isOAuth) {
      return { name: s.name ?? '', authType: 'oauth', url: String(args[args.length - 1] ?? ''), headerName: '', token: '' };
    }
    const headers = s.headers ?? {};
    const auth = headers.Authorization;
    if (auth && /^Bearer\s+/i.test(auth)) {
      return { name: s.name ?? '', authType: 'bearer', url: s.url ?? '', headerName: '', token: auth.replace(/^Bearer\s+/i, '') };
    }
    const customKey = Object.keys(headers).find((k) => k.toLowerCase() !== 'authorization');
    if (customKey) {
      return { name: s.name ?? '', authType: 'custom', url: s.url ?? '', headerName: customKey, token: headers[customKey] ?? '' };
    }
    if (auth) {
      return { name: s.name ?? '', authType: 'custom', url: s.url ?? '', headerName: 'Authorization', token: auth };
    }
    return { name: s.name ?? '', authType: 'bearer', url: s.url ?? '', headerName: '', token: '' };
  }

  function autoName(url) {
    try {
      const parts = new URL(url).hostname.split('.');
      const skip = new Set(['www', 'api', 'app', 'open', 'us', 'cn', 'com', 'net', 'org', 'pro', 'io', 'dev', 'cloud', 'my']);
      return parts.filter((p) => !skip.has(p.toLowerCase()))[0] || parts[0] || 'mcp';
    } catch {
      return 'mcp';
    }
  }

  function renderServerEditor(server, failures) {
    const box = el('div', 'server-editor');
    const head = el('div', 'ed-head');
    const title = el('div', 'title', server.name || '(新服务器)');
    const remove = el('button', 'remove', '删除');
    head.append(title, remove);
    box.append(head);

    const row1 = el('div', 'row');
    const nameF = field('名称（留空自动生成）'); nameF.append(makeInput('js-name', server.name, '如 crm / ones / recording'));
    const authF = field('连接方式'); authF.append(makeSelect('js-authType',
      [{ value: 'bearer', label: 'Token 鉴权' }, { value: 'custom', label: '自定义 Header' }, { value: 'oauth', label: 'OAuth 授权' }], server.authType));
    row1.append(nameF, authF);
    box.append(row1);

    const urlRow = el('div', 'row');
    const urlF = field('MCP 地址'); urlF.append(makeInput('js-url', server.url, 'https://.../mcp'));
    urlRow.append(urlF);
    box.append(urlRow);

    // bearer / custom 共用的 Token 行
    const tokenRow = el('div', 'row js-token-row');
    const tokenF = field('Token'); tokenF.append(makeInput('js-token', server.token, 'token 值，可用 ${ENV_VAR}'));
    tokenRow.append(tokenF);
    box.append(tokenRow);

    // 自定义 Header 的 header 名
    const headerRow = el('div', 'row js-header-row');
    const headerF = field('Header 名'); headerF.append(makeInput('js-header', server.headerName, '如 X-ONES-MCP-Token'));
    headerRow.append(headerF);
    box.append(headerRow);

    // OAuth 提示
    const oauthHint = el('div', 'oauth-hint hidden', 'OAuth 方式无需填 token，首次连接会自动打开浏览器授权。');
    box.append(oauthHint);

    const statusLine = el('div', 'status-line');
    const failure = failures.find(([n]) => n === server.name);
    if (failure) { statusLine.classList.add('fail'); statusLine.textContent = '未连接: ' + failure[1]; }
    else { statusLine.classList.add('ok'); statusLine.textContent = '已连接'; }
    box.append(statusLine);

    const sync = () => {
      const mode = authF.querySelector('select').value;
      tokenRow.style.display = (mode === 'bearer' || mode === 'custom') ? '' : 'none';
      headerRow.style.display = mode === 'custom' ? '' : 'none';
      oauthHint.classList.toggle('hidden', mode !== 'oauth');
      tokenF.querySelector('label').textContent = mode === 'custom' ? 'Token（header 的值）' : 'Token';
      const n = nameF.querySelector('input').value.trim();
      title.textContent = n || autoName(urlF.querySelector('input').value) || '(新服务器)';
    };
    authF.querySelector('select').addEventListener('change', sync);
    nameF.querySelector('input').addEventListener('input', sync);
    urlF.querySelector('input').addEventListener('input', sync);
    sync();
    remove.addEventListener('click', () => box.remove());
    return box;
  }

  function collectServers() {
    const out = [];
    for (const box of serverList.querySelectorAll('.server-editor')) {
      const url = box.querySelector('.js-url').value.trim();
      if (!url) continue;
      const name = box.querySelector('.js-name').value.trim() || autoName(url);
      const authType = box.querySelector('.js-authType').value;
      const token = box.querySelector('.js-token').value.trim();

      if (authType === 'oauth') {
        out.push({ name, transport: 'stdio', command: 'npx', args: ['-y', 'mcp-remote@0.1.18', url] });
      } else if (authType === 'custom') {
        const headerName = box.querySelector('.js-header').value.trim();
        const server = { name, transport: 'streamable-http', url };
        if (headerName && token) server.headers = { [headerName]: token };
        out.push(server);
      } else {
        const server = { name, transport: 'streamable-http', url };
        if (token) server.headers = { Authorization: token.startsWith('Bearer ') ? token : 'Bearer ' + token };
        out.push(server);
      }
    }
    return out;
  }

  async function loadMcpConfigUI() {
    try {
      const res = await fetch('/api/config/mcp');
      const data = await res.json();
      mcpFailures = data.failures || [];
      serverList.innerHTML = '';
      for (const s of data.servers) serverList.append(renderServerEditor(normalizeServer(s), mcpFailures));
      configResult.textContent = '';
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '加载失败: ' + err.message;
    }
  }

  // 「GLM Coding Plan（智谱）」预设：本质上仍是 provider=custom + OpenAI 兼容协议，
  // 只是选它时一键带出官方 Coding Plan 端点/模型/视觉开关；回读时按 baseUrl 识别回预设。
  const GLM_CODING_PRESET = {
    provider: 'glm-coding',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5.3-flash',
  };

  // 自定义（OpenAI/Anthropic 兼容）服务商需要协议 + Base URL 输入；
  // 视觉开关同理：内置服务商按模型目录自动判定（只读展示），自定义端点无法探测须手动声明。
  function updateLlmBaseUrlLabel() {
    const anthropic = llmProtocol.value === 'anthropic';
    llmBaseUrlLabel.textContent = anthropic
      ? 'Base URL（Anthropic 兼容端点，自动追加 /v1/messages，保存时验证连通）'
      : 'Base URL（OpenAI 兼容端点，自动追加 /chat/completions，保存时验证连通）';
    llmBaseUrl.placeholder = anthropic ? 'https://open.bigmodel.cn/api/anthropic' : 'https://relay.ones.pro/v1';
  }

  function syncLlmProviderUi() {
    const isCustom = llmProvider.value === 'custom' || llmProvider.value === GLM_CODING_PRESET.provider;
    llmBaseUrlRow.classList.toggle('hidden', !isCustom);
    // 预设固定走 OpenAI 兼容协议，协议下拉只在裸 custom 时出现。
    llmProtocolRow.classList.toggle('hidden', llmProvider.value !== 'custom');
    llmModel.placeholder = isCustom ? '例如 glm-5.3-flash / ucloud-qwen3.8-max' : '例如 deepseek-v4-flash';
    llmVision.disabled = !isCustom;
    llmVisionLabel.classList.toggle('disabled', !isCustom);
    updateLlmBaseUrlLabel();
  }
  llmProvider.addEventListener('change', () => {
    // 仅在用户主动选预设时填充（loadLlmConfigUI 走 syncLlmProviderUi，不得覆盖已加载值）。
    if (llmProvider.value === GLM_CODING_PRESET.provider) {
      llmBaseUrl.value = GLM_CODING_PRESET.baseUrl;
      if (!llmModel.value.trim()) llmModel.value = GLM_CODING_PRESET.model;
      llmVision.checked = true;
    }
    syncLlmProviderUi();
  });
  llmProtocol.addEventListener('change', updateLlmBaseUrlLabel);

  async function loadLlmConfigUI() {
    try {
      const res = await fetch('/api/config/llm');
      const data = await res.json();
      // custom + Coding Plan 官方端点 → 识别回 GLM 预设选项；其余按原样回填。
      const isGlmPreset = data.provider === 'custom' && (data.baseUrl || '').replace(/\/+$/, '') === GLM_CODING_PRESET.baseUrl;
      llmProvider.value = isGlmPreset ? GLM_CODING_PRESET.provider : (data.provider || 'deepseek');
      llmModel.value = data.model || '';
      llmBaseUrl.value = data.baseUrl || '';
      llmProtocol.value = data.protocol === 'anthropic' ? 'anthropic' : 'openai';
      llmKey.value = '';
      llmKey.placeholder = data.apiKeyConfigured
        ? '已设置（留空则不修改）'
        : 'sk-... 或用 ${ENV_VAR}';
      llmVision.checked = data.vision === true;
      visionSupported = data.vision === true;
      syncLlmProviderUi();
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '加载失败: ' + err.message;
    }
  }

  async function loadSearchConfigUI() {
    try {
      const res = await fetch('/api/config/search');
      const data = await res.json();
      searchKey.value = '';
      searchKey.placeholder = data.apiKeyConfigured ? '已设置（留空则不修改）' : 'tvly-...（可选，不填走免费匿名通道）';
      searchMaxResults.value = data.maxResults || 5;
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '联网搜索配置加载失败: ' + err.message;
    }
  }

  settingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    loadLlmConfigUI();
    loadSearchConfigUI();
    loadMcpConfigUI();
  });
  settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
  settingsModal.addEventListener('click', (ev) => { if (ev.target === settingsModal) settingsModal.classList.add('hidden'); });

  addServerBtn.addEventListener('click', () => serverList.append(renderServerEditor(normalizeServer({ transport: 'streamable-http' }), [])));

  saveConfigBtn.addEventListener('click', async () => {
    const servers = collectServers();
    const llmPayload = {
      // GLM Coding Plan 预设本质是 custom + 固定 OpenAI 协议端点。
      provider: llmProvider.value === GLM_CODING_PRESET.provider ? 'custom' : llmProvider.value,
      model: llmModel.value.trim(),
      apiKey: llmKey.value.trim(),
    };
    if (llmPayload.provider === 'custom') {
      llmPayload.baseUrl = llmBaseUrl.value.trim();
      llmPayload.vision = llmVision.checked;
      llmPayload.protocol = llmProvider.value === GLM_CODING_PRESET.provider ? 'openai' : llmProtocol.value;
    }
    saveConfigBtn.disabled = true;
    configResult.className = '';
    configResult.textContent = '保存中…';
    const results = [];
    try {
      // save LLM first (model switch may fail fast)
      const llmRes = await fetch('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(llmPayload),
      });
      const llmData = await llmRes.json();
      if (!llmRes.ok) {
        results.push('模型: ' + (llmData.error || llmRes.status));
      } else {
        results.push('模型: ' + llmData.provider + '/' + llmData.model + (llmData.baseUrl ? ` @ ${llmData.baseUrl}` : '') + ' 已生效');
        if (typeof llmData.vision === 'boolean') visionSupported = llmData.vision;
      }

      const searchPayload = { apiKey: searchKey.value.trim(), maxResults: Number(searchMaxResults.value) || 5 };
      const searchRes = await fetch('/api/config/search', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(searchPayload),
      });
      const searchData = await searchRes.json();
      if (!searchRes.ok) {
        results.push('联网搜索: ' + (searchData.error || searchRes.status));
      } else {
        results.push(searchData.apiKeyConfigured
          ? `联网搜索: Tavily 已配置（每次 ${searchData.maxResults} 条，严格时间窗）`
          : `联网搜索: 未配 key，走免费匿名通道（每次 ${searchData.maxResults} 条）`);
        searchKey.value = '';
        searchKey.placeholder = searchData.apiKeyConfigured ? '已设置（留空则不修改）' : 'tvly-...（可选）';
      }

      const mcpRes = await fetch('/api/config/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers }),
      });
      const mcpData = await mcpRes.json();
      if (!mcpRes.ok) {
        results.push('MCP: ' + (mcpData.error || mcpRes.status));
      } else {
        const fails = mcpData.failures || [];
        mcpFailures = fails;
        results.push(fails.length
          ? 'MCP 已保存；未连接: ' + fails.map(([n, e]) => `${n}(${e})`).join('; ')
          : 'MCP 已保存，全部连接成功');
        serverList.innerHTML = '';
        for (const s of mcpData.servers) serverList.append(renderServerEditor(normalizeServer(s), fails));
      }

      configResult.className = 'ok';
      configResult.textContent = results.join('；');
      setIdleStatus();
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '保存失败: ' + err.message;
    } finally {
      saveConfigBtn.disabled = false;
    }
  });

  // ── Agent Hemory workspace ─────────────────────────────────────

  /** 全量客户缓存（名称解析/归属候选的唯一数据源）：仅空时拉取，绝不被组合页搜索过滤子集覆盖。 */
  async function ensureCustomersCache() {
    if (!customersCache.length) customersCache = (await api('/api/customers')).customers || [];
    return customersCache;
  }

  async function ensureCustomerOptions() {
    await ensureCustomersCache();
    hemoryCustomerOptions.innerHTML = '';
    for (const customer of customersCache) {
      const option = document.createElement('option');
      option.value = `${customer.name} (${customer.id})`;
      hemoryCustomerOptions.append(option);
    }
  }

  /** 某个片段列表容器内已勾选的片段 ID；收件箱与客户详情 Hemory 片段 tab 共用。 */
  function selectedFragmentIds(listEl) {
    return [...listEl.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.dataset.eventId);
  }

  /**
   * 绑定一个片段列表的勾选联动：「已选 n/m」计数 + 全选态跟随列表勾选变化。
   * 列表重渲染后调用返回的 update 重新同步；listEl 每次重建后需重新调用绑定。
   */
  function bindFragmentSelection(listEl, countEl, selectAllEl) {
    const update = () => {
      const checks = [...listEl.querySelectorAll('input[type="checkbox"]')];
      const selected = checks.filter((input) => input.checked).length;
      countEl.textContent = checks.length ? `已选 ${selected}/${checks.length}` : '';
      selectAllEl.checked = checks.length > 0 && selected === checks.length;
    };
    listEl.addEventListener('change', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') update();
    });
    selectAllEl.onchange = () => {
      for (const input of listEl.querySelectorAll('input[type="checkbox"]')) input.checked = selectAllEl.checked;
      update();
    };
    return update;
  }

  /**
   * 单条片段行：话题 + 状态徽标 + 元信息 + 证据展开。
   * 默认（收件箱）：checkbox 整卡 label 点选 + 行内忽略/恢复（卡内按钮 type=button + 防冒泡）。
   * opts.readonly（客户详情）：纯展示，无勾选、无行内操作。
   */
  function renderHemoryFragmentRow(fragment, opts = {}) {
    const row = el(opts.readonly ? 'div' : 'label', opts.readonly ? 'hemory-fragment readonly' : 'hemory-fragment');
    if (!opts.readonly) {
      const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.eventId = fragment.id; check.dataset.payloadHash = fragment.payloadHash;
      check.dataset.attribution = fragment.attributionStatus || '';
      row.append(check);
    }
    const body = el('div', 'fragment-body');
    const head = el('div', 'fragment-head');
    const statusBadge = fragment.attributionStatus === 'confirmed' ? badge('已归属', 'success')
      : fragment.attributionStatus === 'ignored' ? badge('已忽略', 'muted')
      : badge('待归属', 'warning');
    head.append(el('strong', null, fragment.payload?.topic || fragment.title), statusBadge);
    // 消费台账徽标：该片段已被哪些类型的已写入草稿消费（如工单已写入），提示再生成不会重复产出该类型。
    if (Array.isArray(fragment.consumedBy) && fragment.consumedBy.length) {
      const typeLabels = { internal_todo: '待办', workhour: '工时', followup: '跟进', suggestion: '建议', ticket: '工单', operations: '运维' };
      const label = fragment.consumedBy.map((type) => typeLabels[type] ?? type).join('/');
      head.append(badge(`已写入·${label}`, 'muted'));
    }
    // 同一事件被打断后再次出现时共享话题组，徽标提示分段序号，方便合并归属。
    if (fragment.payload?.topicGroupId) {
      head.append(el('span', 'fragment-topic-part', `同话题 ${fragment.payload.topicPartIndex ?? '?'}/${fragment.payload.topicPartCount ?? '?'}`));
    }
    if (!opts.readonly) {
      const rowActions = el('div', 'row-actions');
      if (fragment.attributionStatus === 'ignored') {
        const restore = el('button', 'quiet-command small', '恢复');
        restore.type = 'button';
        restore.onclick = async (event) => {
          event.preventDefault(); event.stopPropagation();
          try { await api('/api/hemory/fragments/attribution', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventIds: [fragment.id], customerId: null, expectedHashes: { [fragment.id]: fragment.payloadHash } }) }); await (opts.reload || loadHemoryInbox)(); }
          catch (error) { await alertDialog(error.message); }
        };
        rowActions.append(restore);
      } else {
        const ignore = el('button', 'quiet-command small', '忽略');
        ignore.type = 'button';
        ignore.onclick = async (event) => {
          event.preventDefault(); event.stopPropagation();
          try { await api('/api/hemory/fragments/ignore', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventIds: [fragment.id], expectedHashes: { [fragment.id]: fragment.payloadHash } }) }); await (opts.reload || loadHemoryInbox)(); }
          catch (error) { await alertDialog(error.message); }
        };
        rowActions.append(ignore);
      }
      head.append(rowActions);
    }
    const evidence = document.createElement('details');
    evidence.className = 'fragment-evidence';
    evidence.append(el('summary', null, '查看原文证据'), el('pre', null, fragment.payload?.transcript || '无原文'));
    const speakers = Array.isArray(fragment.payload?.speakers) && fragment.payload.speakers.length ? fragment.payload.speakers.join('、') : '发言人未知';
    const customerLabel = fragment.customerId
      ? (customersCache.find((item) => item.id === fragment.customerId)?.name ?? `CRM ${fragment.customerId}`)
      : '未绑定客户';
    body.append(head, el('p', null, fragment.payload?.summary || fragment.title), evidence,
      el('div', 'cell-sub', `${formatDateTime(fragment.payload?.startAt || fragment.occurredAt)} - ${formatDateTime(fragment.payload?.endAt || fragment.occurredAt)} · ${speakers} · ${customerLabel} · ${fragment.id}`));
    row.append(body);
    return row;
  }

  /** 已归属视图的客户分组标题：客户名（customersCache 解析，失败回退 CRM id）。 */
  function fragmentCustomerLabel(customerId) {
    if (!customerId) return '未绑定客户';
    return customersCache.find((item) => item.id === customerId)?.name ?? `CRM ${customerId}`;
  }

  /**
   * 片段列表整列表渲染：按录音分组 + 逐行共享渲染器；收件箱与客户详情 tab 共用。
   * 已归属视图（opts.groupByCustomer）外层按客户分组——客户顺序跟随列表本身的时间倒序
   * （即最近有沟通的客户在前），组内仍按录音分节，方便跨录音阅读同一客户的沟通。
   * 客户组默认折叠（details 原生交互），点组标题展开/收起，折叠时只看客户名与条数。
   */
  function renderHemoryFragmentList(listEl, fragments, opts = {}) {
    listEl.innerHTML = '';
    if (!fragments.length) {
      listEl.append(el('div', 'workspace-empty', opts.emptyText || '没有符合条件的 Hemory 片段'));
      return;
    }
    const appendRows = (container, rows) => {
      let recording = '';
      for (const fragment of rows) {
        const recordingId = fragment.payload?.recordingId || 'unknown';
        if (recordingId !== recording) {
          recording = recordingId;
          container.append(el('div', 'fragment-group-title', `录音 ${recordingId}`));
        }
        container.append(renderHemoryFragmentRow(fragment, opts));
      }
    };
    if (!opts.groupByCustomer) return appendRows(listEl, fragments);
    const groups = new Map();
    for (const fragment of fragments) {
      const key = fragment.customerId || '';
      groups.set(key, [...(groups.get(key) ?? []), fragment]);
    }
    for (const [customerId, rows] of groups) {
      const group = document.createElement('details');
      group.className = 'customer-group';
      const summary = el('summary', 'customer-group-title', `${fragmentCustomerLabel(customerId)} · ${rows.length} 条`);
      group.append(summary);
      const body = el('div', 'customer-group-body');
      appendRows(body, rows);
      group.append(body);
      listEl.append(group);
    }
  }

  /** 已应用的筛选条件：默认 pending 全量（最近 7 天窗口由服务端控制）；面板只筛日期时间，状态走「已归属」切换、客户走归属栏；面板控件只是草稿，点「筛选」才生效。 */
  let hemoryFilter = { status: 'pending', date: '', from: '', to: '' };

  /** 上海时区今天的 YYYY-MM-DD（en-CA 的日期格式恰好是 ISO 形式）；每次打开面板实时计算，跨午夜不残留旧日期。 */
  function shanghaiToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  }

  /** 把已应用筛选同步到面板控件；无已应用日期时预填今天 00:00–23:59 真实默认值（点「筛选」即过滤该整天），已应用仅日期无时刻时补全整天边界。 */
  function syncHemoryFilterDrafts() {
    hemoryDate.value = hemoryFilter.date || shanghaiToday();
    hemoryTimeFrom.value = hemoryFilter.from || '00:00';
    hemoryTimeTo.value = hemoryFilter.to || '23:59';
  }

  /** 「已归属」一键切换按钮的激活态与文案跟随当前已应用状态：已归属视图下提示再点切回。 */
  function updateHemoryConfirmedToggle() {
    const active = hemoryFilter.status === 'confirmed';
    hemoryConfirmedToggle.classList.toggle('active', active);
    hemoryConfirmedToggle.textContent = active ? '看待归属' : '已归属';
  }

  /** 应用非默认日期筛选时在归属栏展示 chip（点击清除回到默认）。 */
  function updateHemoryFilterChip() {
    const { date, from, to } = hemoryFilter;
    const active = Boolean(date || from || to);
    hemoryFilterChip.classList.toggle('hidden', !active);
    if (!active) return;
    const parts = [date];
    if (from || to) parts.push(`${from || '00:00'}–${to || '23:59'}`);
    hemoryFilterChip.textContent = `✕ ${parts.filter(Boolean).join(' · ')}`;
  }

  /** 校验草稿并返回错误信息；通过则把草稿升级为已应用筛选。 */
  async function applyHemoryFilter() {
    const draft = { status: hemoryFilter.status, date: hemoryDate.value, from: hemoryTimeFrom.value, to: hemoryTimeTo.value };
    if ((draft.from || draft.to) && !draft.date) return alertDialog('时间段筛选需先选择日期');
    if (draft.from && draft.to && draft.from > draft.to) return alertDialog('开始时间不能晚于结束时间');
    hemoryFilter = draft;
    hemoryFilterPanel.classList.add('hidden');
    await loadHemoryInbox();
  }

  async function resetHemoryFilter() {
    hemoryFilter = { status: hemoryFilter.status, date: '', from: '', to: '' };
    syncHemoryFilterDrafts();
    hemoryFilterPanel.classList.add('hidden');
    await loadHemoryInbox();
  }

  async function loadHemoryInbox() {
    await ensureCustomerOptions();
    updateHemoryFilterChip();
    updateHemoryConfirmedToggle();
    const params = new URLSearchParams({ status: hemoryFilter.status, limit: '500' });
    // 只选日期走整天 date 参数；填了时刻则按上海时区组装 since/until 闭区间（只填一边为开区间）。
    if (hemoryFilter.date && !hemoryFilter.from && !hemoryFilter.to) params.set('date', hemoryFilter.date);
    if (hemoryFilter.date && (hemoryFilter.from || hemoryFilter.to)) {
      params.set('since', `${hemoryFilter.date}T${hemoryFilter.from || '00:00'}:00+08:00`);
      params.set('until', `${hemoryFilter.date}T${hemoryFilter.to || '23:59'}:59+08:00`);
    }
    const data = await api(`/api/hemory/fragments?${params}`);
    const fragments = data.fragments || [];
    if (hemoryFilter.status === 'pending') hemoryPendingCount.textContent = fragments.length || '';
    updateAgentNavCount();
    renderHemoryFragmentList(hemoryFragmentList, fragments,
      { groupByCustomer: hemoryFilter.status === 'confirmed',
        emptyText: hemoryFilter.status === 'pending' ? '当前没有待归属片段' : '没有符合条件的 Hemory 片段' });
    updateHemorySelection();
  }

  async function ignoreHemoryFragments(eventIds) {
    const expectedHashes = Object.fromEntries([...hemoryFragmentList.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => eventIds.includes(input.dataset.eventId))
      .map((input) => [input.dataset.eventId, input.dataset.payloadHash]));
    await api('/api/hemory/fragments/ignore', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventIds, expectedHashes }) });
    await loadHemoryInbox();
  }

  /** 归属/清除归属期间冻结归属栏操作，防止重复提交。 */
  function setAssignBarBusy(busy) {
    for (const id of ['hemoryAssign', 'hemoryClear', 'hemoryIgnore', 'hemoryRegenerate']) document.getElementById(id).disabled = busy;
  }

  /** 片段级草稿重生成：按天重建（选中片段只决定重建哪些「客户+日」），jobs 交给生成轮询跟踪。 */
  async function regenerateHemoryDrafts(eventIds) {
    const { jobs, days } = await api('/api/hemory/fragments/regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventIds }) });
    const dayList = days || [];
    setStatus('', dayList.length
      ? `已提交 ${dayList.length} 个生成日的草稿重生成（${dayList.map((day) => day.dateKey).join('、')}），完成后自动刷新草稿箱`
      : '没有需要重建的生成日');
    trackDraftGeneration(jobs || []);
  }

  async function updateHemoryAttribution(clear) {
    const eventIds = selectedFragmentIds(hemoryFragmentList);
    if (!eventIds.length) return alertDialog('请先选择片段');
    let customerId = null;
    if (!clear) {
      const input = hemoryCustomer.value.trim();
      const customer = customersCache.find((item) => input === `${item.name} (${item.id})` || input === item.id || input === item.name);
      if (!customer) return alertDialog('请选择一个唯一的 CRM 客户');
      customerId = customer.id;
    }
    const expectedHashes = Object.fromEntries([...hemoryFragmentList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => [input.dataset.eventId, input.dataset.payloadHash]));
    setAssignBarBusy(true);
    try {
      // 归属请求即触发后台草稿生成任务；响应里的 jobs 交给轮询跟踪，让「生成中」对用户可见。
      const { jobs } = await api('/api/hemory/fragments/attribution', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventIds, customerId, expectedHashes }) });
      await Promise.all([loadHemoryInbox(), loadDraftBatches()]);
      trackDraftGeneration(jobs || []);
    } catch (error) { await alertDialog(error.message); } finally { setAssignBarBusy(false); }
  }

  /**
   * 轮询草稿生成任务直到终态：进行中在草稿箱顶部横幅实时显示每个任务的阶段/模型输出进度
   *（与周报/案例同源的 progress 文案），全部结束后自动刷新草稿列表。
   * 失败任务不会创建批次，只能在这里感知；jobId 为空的幂等复用任务（草稿已存在）不轮询。
   * 孤儿 running（服务重启遗留、永不终结）由服务端装饰 stalled，按终态移出并提示重新生成。
   * 活轮询期间 re-seed（loadDraftBatches 恢复）只并入新任务并重置计时，不重启循环。
   */
  function trackDraftGeneration(jobs) {
    let added = false;
    for (const job of jobs || []) {
      if (job.jobId && !draftJobTracking.has(job.jobId)) { draftJobTracking.set(job.jobId, job.fingerprint); added = true; }
    }
    if (!draftJobTracking.size) return;
    if (added) draftJobStartedAt = Date.now();
    if (draftJobTimer) return;
    let attempt = 0;
    const tick = async () => {
      const runningJobs = [];
      const failed = [];
      const stalled = new Set();
      const finished = new Set();
      try {
        const ids = [...draftJobTracking.keys()];
        const { jobs: fresh } = await api(`/api/draft-jobs?ids=${encodeURIComponent(ids.join(','))}`);
        const byId = new Map((fresh || []).map((job) => [job.id, job]));
        for (const id of ids) {
          const job = byId.get(id);
          // 查不到的任务按终态处理，避免轮询空转；stalled（孤儿 running）同样按终态移出。
          if (!job || job.status === 'succeeded' || job.status === 'failed') {
            finished.add(id);
            if (job?.status === 'failed') failed.push(job.error || '未知原因');
          } else if (job.stalled) {
            finished.add(id);
            stalled.add(id);
          } else runningJobs.push(job);
        }
      } catch (error) { /* 轮询失败保持现状，下一轮重试 */ }
      if (runningJobs.length) {
        const elapsed = Math.round((Date.now() - draftJobStartedAt) / 1000);
        const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
        const slow = elapsed >= 180 ? '，耗时较长，仍在后台执行' : '';
        const customerNameOf = (customerId) => (customersCache.find((item) => item.id === customerId) || {}).name || customerId;
        // 每任务一行「客户 · 日期：阶段文案」；阶段优先取服务端 progress，缺失按状态兜底（与周报/案例同款）。
        const lines = runningJobs.map((job) => {
          const phase = progressTail(job, '正在处理');
          const where = `${customerNameOf(job.customerId)}${job.dateKey ? ` · ${job.dateKey}` : ''}`;
          return `${where}：${phase}`;
        });
        // 顶栏只放短摘要（完整明细在草稿箱横幅）：无约束的长文案曾把窄窗口顶栏各元素挤到折行错位。
        const head = `正在生成草稿（${runningJobs.length} 个任务${slow}，已进行 ${duration}）`;
        const summary = `${head}：${lines.join('；')}`;
        draftGenerationNotice.classList.remove('hidden');
        draftGenerationText.textContent = summary;
        setStatus('', head);
      } else {
        for (const id of finished) draftJobTracking.delete(id);
        draftJobTimer = null;
        draftGenerationNotice.classList.add('hidden');
        if (failed.length || stalled.size) {
          const parts = [];
          if (failed.length) parts.push(`草稿生成失败：${[...new Set(failed)].join('；').slice(0, 160)}`);
          if (stalled.size) parts.push('部分任务疑似中断（服务重启未恢复），请在草稿箱点「重新生成」');
          setStatus('warn', parts.join('；'));
        } else setStatus('', '草稿生成完成');
        void loadDraftBatches();
        return;
      }
      // 安全阀：超过 10 分钟（3 次模型重试 + 退避的最坏路径）停止轮询并自动清除提示——
      // 旧实现 180s 硬放弃时任务往往仍在正常跑，且 warn 文案无任何清除路径，永久钉死在角落。
      if (Date.now() - draftJobStartedAt > 600000) {
        draftJobTimer = null;
        draftGenerationNotice.classList.add('hidden');
        setTransientStatus('warn', '草稿生成仍在后台进行（耗时较长）——稍后点「刷新」查看；若长时间无变化，任务可能已中断，请在草稿箱点「重新生成」', 15000);
        return;
      }
      attempt++;
      draftJobTimer = setTimeout(() => void tick(), attempt < 90 ? 2000 : 5000);
    };
    draftJobTimer = setTimeout(() => void tick(), 1500);
  }

  function draftTypeLabel(type) {
    return { internal_todo: 'Agent 待办', workhour: '工时', followup: '沟通记录', suggestion: '需求', ticket: '工单', operations: '运维工单' }[type] || type;
  }

  /**
   * 结构化编辑契约的表单渲染器：草稿箱编辑弹窗与会话确认卡共用。
   * 按字段 type 渲染中文表单控件；锁定项与系统自动填写项只读展示；
   * collect() 只收集契约内字段，由服务端合并回参数（用户永远不接触原始 JSON）。
   */
  function renderDraftEditForm(contract, container) {
    const inputs = new Map();
    for (const field of contract.fields || []) {
      const span = el('span', null, field.label + (field.required ? ' *' : ''));
      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        input.className = 'draft-edit-select';
        for (const option of field.options || []) {
          const choice = document.createElement('option');
          choice.value = option.value; choice.textContent = option.label;
          if (option.value === field.value) choice.selected = true;
          input.append(choice);
        }
        if (field.value && ![...input.options].some((option) => option.value === field.value)) {
          const current = document.createElement('option');
          current.value = field.value; current.textContent = field.value;
          input.prepend(current); current.selected = true;
        }
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.value = field.value || '';
      } else {
        input = document.createElement('input');
        input.type = field.type === 'number' ? 'number' : field.type === 'datetime' ? 'datetime-local' : field.type === 'date' ? 'date' : 'text';
        if (field.type === 'number') { input.step = '0.1'; input.min = '0'; }
        input.value = field.value || '';
      }
      const fieldEl = el('label', 'form-field');
      fieldEl.append(span, input);
      if (field.hint) fieldEl.append(el('span', 'draft-edit-hint', field.hint));
      container.append(fieldEl);
      inputs.set(field.key, { field, input });
    }
    if (contract.locked?.length) {
      const locked = el('div', 'draft-edit-locked');
      locked.append(el('div', 'draft-edit-section-title', '以下信息已锁定'));
      for (const item of contract.locked) locked.append(el('div', 'draft-edit-row', `${item.label}：${item.value}`), el('div', 'draft-edit-locked-reason', item.reason));
      container.append(locked);
    }
    if (contract.readonly?.length) {
      const readonlyBox = el('div', 'draft-edit-readonly');
      readonlyBox.append(el('div', 'draft-edit-section-title', '以下信息由系统自动填写'));
      for (const item of contract.readonly) readonlyBox.append(el('div', 'draft-edit-row', `${item.label}：${item.value}`));
      container.append(readonlyBox);
    }
    return {
      /** 收集契约内字段值；必填项为空时返回错误消息（不发起请求）。 */
      collect() {
        const edits = {};
        for (const { field, input } of inputs.values()) {
          if (field.type === 'select') edits[field.key] = input.value;
          else edits[field.key] = String(input.value ?? '').trim();
          if (field.required && !String(edits[field.key]).trim()) return { error: `「${field.label}」为必填项` };
        }
        return { edits };
      },
    };
  }

  async function editableDraft(item) {
    openWorkbenchModal(`编辑${draftTypeLabel(item.type)}草稿`);
    // 优先结构化编辑契约（中文表单，服务端合并）；无契约类型回退原始 JSON 编辑器（诊断兜底）。
    let detail = null;
    try { detail = await api(`/api/draft-items/${item.id}`); } catch (_) { /* 契约拉取失败时回退 */ }
    if (detail?.editContract) {
      const form = renderDraftEditForm(detail.editContract, workbenchModalBody);
      const unknowns = inputField('待确认信息（每行一项）', (item.unknowns || []).join('\n'), 'textarea');
      workbenchModalBody.append(unknowns.field);
      const save = el('button', 'primary-command', '保存草稿');
      save.onclick = async () => {
        const collected = form.collect();
        if (collected.error) return alertDialog(collected.error);
        try {
          await api(`/api/draft-items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            version: detail.version, edits: collected.edits,
            unknowns: unknowns.input.value.split('\n').map((value) => value.trim()).filter(Boolean) }) });
          closeWorkbenchModal(); await loadDraftBatches();
        } catch (error) { await alertDialog(error.message); }
      };
      workbenchModalBody.append(save);
      return;
    }
    const title = inputField('标题', item.title);
    const summary = inputField('摘要', item.summary, 'textarea');
    const fields = inputField('业务字段 JSON', JSON.stringify(item.fields || {}, null, 2), 'textarea'); fields.input.classList.add('json-editor');
    const tool = inputField('目标工具', item.targetTool || '');
    const args = inputField('实际参数 JSON', JSON.stringify(item.targetArguments || {}, null, 2), 'textarea'); args.input.classList.add('json-editor');
    const unknowns = inputField('待确认信息（每行一项）', (item.unknowns || []).join('\n'), 'textarea');
    const save = el('button', 'primary-command', '保存草稿');
    save.onclick = async () => {
      try {
        await api(`/api/draft-items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          version: item.version, title: title.input.value.trim(), summary: summary.input.value.trim(), fields: JSON.parse(fields.input.value),
          targetTool: tool.input.value.trim() || null, targetArguments: JSON.parse(args.input.value),
          unknowns: unknowns.input.value.split('\n').map((value) => value.trim()).filter(Boolean), validationErrors: [],
        }) });
        closeWorkbenchModal(); await loadDraftBatches();
      } catch (error) { await alertDialog(error.message); }
    };
    workbenchModalBody.append(title.field, summary.field, fields.field, tool.field, args.field, unknowns.field, save);
  }

  /** 确认执行一组同批次草稿（单卡确认与批量确认共用）：preview → 校验 → 对话框 → confirm。 */
  async function confirmDraftItems(batchId, itemIds, { skipConfirm } = {}) {
    try {
      const preview = await api(`/api/draft-batches/${batchId}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds }) });
      const invalid = preview.items.filter((item) => item.validationErrors?.length);
      if (invalid.length) return alertDialog(invalid.map((item) => `${item.id}: ${item.validationErrors.join('；')}`).join('\n'));
      const message = preview.items.length === 1 ? '确认写入该草稿？'
        : `确认逐项执行 ${preview.items.length} 份草稿？成功项不会因其他项失败而回滚。`;
      if (!skipConfirm && !await confirmDialog(message)) return;
      await api(`/api/draft-batches/${batchId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        items: preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })),
      }) });
      return true;
    } catch (error) { alertDialog(error.message); }
  }

  /** 单卡忽略入口（浮动条批量忽略是独立内联循环，不经过这里）：确认后软删除，批次状态由服务端刷新。 */
  async function ignoreDraftItem(item) {
    if (!await confirmDialog(`忽略草稿「${item.title}」？忽略后不再出现在待处理列表（已写入项不受影响）。`)) return false;
    try { await api(`/api/draft-items/${item.id}/dismiss`, { method: 'POST' }); return true; }
    catch (error) { await alertDialog(error.message); return false; }
  }

  /** 勾选草稿按批次分组（确认 API 是批次级，跨批次勾选须逐批执行）。 */
  function selectedDraftsByBatch() {
    const groups = new Map();
    for (const input of draftBatchList.querySelectorAll('input[type="checkbox"]:checked')) {
      const batchId = input.dataset.batchId;
      if (!batchId) continue;
      if (!groups.has(batchId)) groups.set(batchId, []);
      groups.get(batchId).push(input.dataset.itemId);
    }
    return [...groups].map(([batchId, itemIds]) => ({ batchId, itemIds }));
  }

  /** 浮动条模式渲染：默认批量确认（主按钮蓝）；手动切换后才进入忽略模式（主按钮红）。 */
  function applyDraftBarMode() {
    if (draftBarIgnoreMode) {
      draftBarPrimary.textContent = '忽略所选草稿';
      draftBarPrimary.classList.add('danger');
      draftBarModeToggle.textContent = '切回确认';
    } else {
      draftBarPrimary.textContent = '确认所选草稿';
      draftBarPrimary.classList.remove('danger');
      draftBarModeToggle.textContent = '批量忽略…';
    }
  }

  function updateDraftSelectionBar() {
    const count = draftBatchList.querySelectorAll('input[type="checkbox"]:checked').length;
    draftSelectedCount.textContent = count ? `已选 ${count} 份草稿` : '';
    draftSelectionBar.classList.toggle('hidden', !count);
    // 勾选清零即退出忽略模式：忽略是刻意操作，不留跨会话的模式残留。
    if (!count && draftBarIgnoreMode) { draftBarIgnoreMode = false; applyDraftBarMode(); }
  }

  async function loadDraftBatches() {
    const data = await api('/api/draft-batches');
    // 恢复在途生成任务跟踪（幂等）：刷新/切 tab/页面重开后横幅与实时进度自动回来——
    // 旧实现里「稍后点刷新查看」的提示是死路（刷新既不清提示也不恢复跟踪）。
    void resumeDraftGenerationTracking();
    const batches = data.batches || [];
    // 待处理口径统一为草稿条目数（可处理卡片数）：一个批次（客户×天）含多条草稿，
    // 按批计数会让数字和卡片对不上；顶部角标、二级 tab、侧边栏 Agent 角标同一来源。
    const actionableCount = (batch) => batch.actionableItemCount ?? (batch.items || []).filter((item) => !['written', 'dismissed', 'stale'].includes(item.status)).length;
    // 两个 tab 都按条目渲染：待处理 tab 只显示可处理卡片（忽略/作废即从列表消失，数字=卡片数）；
    // 已忽略 tab 显示批内已忽略/已作废条目，混合批次在两个 tab 各出现一次、各渲染自己的子集。
    const archivedItemsOf = (batch) => (batch.items || []).filter((item) => ['dismissed', 'stale'].includes(item.status));
    const actionable = batches.filter((batch) => actionableCount(batch) > 0);
    const archivedSections = batches.filter((batch) => archivedItemsOf(batch).length > 0);
    const pending = actionable.reduce((sum, batch) => sum + actionableCount(batch), 0);
    draftPendingCount.textContent = pending || '';
    updateAgentNavCount();
    await renderDraftFailedJobs();
    draftBatchList.innerHTML = '';
    // 重渲染后勾选清零：浮动条随之隐藏并复位确认模式（忽略模式是临时态）。
    if (!draftSelectionBar.classList.contains('hidden')) { draftSelectionBar.classList.add('hidden'); if (draftBarIgnoreMode) { draftBarIgnoreMode = false; applyDraftBarMode(); } }
    for (const tab of document.querySelectorAll('.draft-subtab')) tab.classList.toggle('active', tab.dataset.draftTab === activeDraftTab);
    draftTabPending.textContent = pending ? `待处理（${pending}）` : '待处理';
    // 已忽略/已作废 tab 同一原则：数字 = 该 tab 里渲染的卡片（条目）数。
    const archivedCount = archivedSections.reduce((sum, batch) => sum + archivedItemsOf(batch).length, 0);
    draftTabArchived.textContent = archivedCount ? `已忽略/已作废（${archivedCount}）` : '已忽略/已作废';
    if (!batches.length) return draftBatchList.append(el('div', 'workspace-empty', '还没有 Hemory 草稿'));
    const visible = activeDraftTab === 'archived' ? archivedSections : actionable;
    if (!visible.length) return draftBatchList.append(el('div', 'workspace-empty', activeDraftTab === 'archived' ? '还没有已忽略/已作废草稿' : '还没有待处理草稿'));
    for (const batch of visible) {
      const section = el('section', 'draft-batch');
      const head = el('div', 'draft-batch-head');
      const customer = customersCache.find((item) => item.id === batch.customerId);
      const title = el('div'); title.append(el('strong', null, customer?.name || batch.customerId), el('div', 'cell-sub', `${formatDateTime(batch.updatedAt)} · ${batch.generator} · ${batch.status}`));
      // 重新生成中：服务端标记（同客户×上海日有进行中任务），角标取代重新生成按钮并禁用全部操作，
      // 防止确认/忽略一份即将被作废的草稿；生成失败自动恢复（旧草稿未被作废）。
      if (batch.regenerating) title.append(el('div', 'draft-regenerating', '重新生成中…'));
      const headActions = el('div', 'row-actions');
      // 批次级「确认所选/忽略批次」已由单卡按钮 + 底部浮动条承担（整批忽略走 CLI draft dismiss），头部只留重新生成。
      // 存在校验错误（如 ONES 客户信息未解析）的草稿批次无法确认，同样允许重新生成以在问题修复后重绑参数。
      const hasBlockingErrors = (batch.items || []).some((item) => item.validationErrors?.length && !['written', 'dismissed', 'stale'].includes(item.status));
      // 整批重新生成收敛到待处理 tab：已忽略 tab 展示的可能是混合批次的归档子集，
      // 从那里整批重新生成会误作废仍在待处理的兄弟条目（stale/partial/failed 或阻断批次仍保留该出口）。
      if (!batch.regenerating && (['stale', 'partial', 'failed'].includes(batch.status) || hasBlockingErrors || activeDraftTab === 'pending')) {
        const regenerate = el('button', 'quiet-command small', '重新生成');
        regenerate.type = 'button';
        regenerate.onclick = async () => {
          if (!await confirmDialog('重新生成将作废该批次未写入的草稿并按当前片段重新整理，继续？')) return;
          try {
            const { jobs } = await api(`/api/draft-batches/${batch.id}/regenerate`, { method: 'POST' });
            await loadDraftBatches();
            trackDraftGeneration(jobs || []);
          }
          catch (error) { alertDialog(error.message); }
        };
        headActions.append(regenerate);
      }
      head.append(title, headActions);
      section.append(head);
      // 条目级渲染：待处理 tab 剔除已忽略/作废卡片（忽略即从列表消失，兑现确认弹窗承诺），
      // 已忽略 tab 只渲染已忽略/作废卡片；written 条目已被服务端剔除（include=written 才下发）。
      const items = activeDraftTab === 'archived' ? archivedItemsOf(batch)
        : (batch.items || []).filter((item) => !['dismissed', 'stale'].includes(item.status));
      for (const item of items) {
        // 卡片整体是 label：点击任意位置即切换勾选；禁用态（written/dismissed/stale/writing 或批次重新生成中）点击无效，仅去掉手型提示。
        const row = el('label', 'draft-item');
        const selector = document.createElement('input'); selector.type = 'checkbox'; selector.dataset.itemId = item.id; selector.dataset.batchId = batch.id;
        selector.disabled = batch.regenerating || ['written', 'dismissed', 'stale', 'writing'].includes(item.status);
        if (selector.disabled) row.classList.add('draft-item-disabled');
        const body = el('div', 'draft-item-body');
        const itemHead = el('div', 'draft-item-head'); itemHead.append(badge(draftTypeLabel(item.type), 'accent'), el('strong', null, item.title), badge(item.statusLabel || item.status, item.status === 'written' ? 'success' : item.status === 'failed' ? 'risk-high' : item.status === 'stale' || item.status === 'dismissed' ? 'muted' : 'warning'));
        body.append(itemHead);
        // 最小必填项结构化展示（displayFields 由服务端按类型生成），取代原来的整段摘要。
        if (item.displayFields?.length) {
          const fields = el('div', 'draft-fields');
          for (const field of item.displayFields) fields.append(el('div', 'draft-field-row', `${field.label}：${field.value}`));
          body.append(fields);
        } else body.append(el('p', null, item.summary));
        if (item.targetObject) body.append(el('div', 'cell-sub', `目标: ${item.targetObject}${item.targetTool ? ` ｜ ${item.targetTool}` : ''}`));
        if (item.validationErrors?.length) body.append(el('div', 'draft-errors', item.validationErrors.join('；')));
        if (item.error) body.append(el('div', 'draft-errors', item.error));
        if (item.unknowns?.length) body.append(el('div', 'cell-sub', `待确认: ${item.unknowns.join('、')}`));
        const actions = el('div', 'row-actions');
        // 卡片是 label，按钮须 type=button 并阻断默认勾选与冒泡，避免点按钮误切换选择。
        if (!batch.regenerating && !['written', 'dismissed', 'stale', 'writing'].includes(item.status)) {
          // 单卡确认/忽略：不必回到批次头部，也不必先勾选再滚动到操作条。
          const confirmOne = el('button', 'primary-command small', '确认'); confirmOne.type = 'button';
          confirmOne.onclick = async (event) => {
            event.preventDefault(); event.stopPropagation();
            if (await confirmDraftItems(batch.id, [item.id])) await Promise.all([loadDraftBatches(), loadActions()]);
          };
          actions.append(confirmOne);
          const edit = el('button', 'quiet-command small', '编辑'); edit.type = 'button';
          edit.onclick = (event) => { event.preventDefault(); event.stopPropagation(); editableDraft(item); };
          actions.append(edit);
          const ignoreOne = el('button', 'quiet-command small', '忽略'); ignoreOne.type = 'button';
          ignoreOne.onclick = async (event) => {
            event.preventDefault(); event.stopPropagation();
            if (await ignoreDraftItem(item)) await loadDraftBatches();
          };
          actions.append(ignoreOne);
        }
        if (!batch.regenerating && item.status === 'failed') {
          const retry = el('button', 'quiet-command small', '重试'); retry.type = 'button';
          retry.onclick = async (event) => {
            event.preventDefault(); event.stopPropagation();
            try { await api(`/api/draft-items/${item.id}/retry`, { method: 'POST' }); await loadDraftBatches(); } catch (error) { await alertDialog(error.message); }
          };
          actions.append(retry);
        }
        if (item.result?.actionItemId) {
          const open = el('button', 'quiet-command small', '打开 Agent 待办'); open.type = 'button';
          open.onclick = (event) => { event.preventDefault(); event.stopPropagation(); showView('actions'); };
          actions.append(open);
        }
        body.append(actions); row.append(selector, body); section.append(row);
      }
      draftBatchList.append(section);
    }
  }

  /**
   * 页面重开/切 tab/点「刷新」后恢复草稿生成跟踪：拉全局在途 heretry 任务 re-seed 进轮询
   *（trackDraftGeneration 幂等：已跟踪的只保留，活轮询中只并入新任务并重置计时）。
   * stalled（孤儿 running）跳过——它们永不终结，收编会把横幅永久钉死；其恢复出口是草稿箱「重新生成」。
   */
  async function resumeDraftGenerationTracking() {
    try {
      const data = await api('/api/draft-jobs?status=active&kind=hemory');
      const jobs = (data.jobs || []).filter((job) => !job.stalled).map((job) => ({ jobId: job.id, fingerprint: job.fingerprint }));
      if (jobs.length) trackDraftGeneration(jobs);
    } catch (error) { /* 恢复失败不影响草稿箱主体展示 */ }
  }

  /**
   * 失败生成任务卡片：失败任务不建批次、轮询状态栏刷新即丢——这里是持久入口。
   * 展示客户+日期+真实错误+涉及片段明细（默认收起），并提供「重新生成」（按天重建，与收件箱同引擎）。
   */
  async function renderDraftFailedJobs() {
    let failed = [];
    try {
      const data = await api('/api/draft-jobs?status=failed&kind=hemory');
      failed = (data.jobs || []).filter((job) => job.status === 'failed');
    } catch (error) { /* 失败列表加载失败不打断草稿箱主体 */ }
    draftFailedJobs.innerHTML = '';
    if (!failed.length) { draftFailedJobs.classList.add('hidden'); return; }
    draftFailedJobs.classList.remove('hidden');
    const heading = el('div', 'draft-failed-head', `草稿生成失败（${failed.length} 个任务）`);
    draftFailedJobs.append(heading);
    for (const job of failed) {
      const customer = customersCache.find((item) => item.id === job.customerId);
      const card = el('div', 'draft-failed-card');
      const cardHead = el('div', 'draft-failed-card-head');
      cardHead.append(el('strong', null, `${customer?.name || job.customerId}${job.dateKey ? ` · ${job.dateKey}` : ''}（${(job.fragments || []).length} 个片段）`));
      const actions = el('div', 'row-actions');
      if ((job.fragments || []).length) {
        const details = el('button', 'quiet-command small', '片段明细');
        details.type = 'button';
        details.onclick = () => {
          const list = card.querySelector('.draft-failed-fragments');
          if (!list) return;
          const expanding = list.classList.contains('hidden');
          list.classList.toggle('hidden', !expanding);
          details.textContent = expanding ? '收起明细' : '片段明细';
        };
        actions.append(details);
      }
      const regenerate = el('button', 'primary-command small', '重新生成');
      regenerate.type = 'button';
      withLoading(regenerate, '重新生成中…', async () => {
        try {
          const eventIds = (job.fragments || []).map((fragment) => fragment.id);
          if (!eventIds.length) return alertDialog('该任务没有可用的片段明细，请在 Hemory 收件箱重新归属后生成');
          await regenerateHemoryDrafts(eventIds);
          await loadDraftBatches();
        } catch (error) { await alertDialog(error.message); }
      });
      actions.append(regenerate);
      cardHead.append(actions);
      card.append(cardHead);
      card.append(el('div', 'draft-errors', job.error || '未知原因'));
      const list = el('div', 'draft-failed-fragments hidden');
      for (const fragment of job.fragments || []) {
        list.append(el('div', 'draft-failed-fragment-row',
          `${formatDateTime(fragment.occurredAt)} · ${fragment.topic}${fragment.summary ? `：${fragment.summary}` : ''}`));
      }
      card.append(list);
      draftFailedJobs.append(card);
    }
  }

  async function showAgentMode(mode) {
    activeAgentMode = mode;
    agentConversation.classList.toggle('hidden', mode !== 'conversation');
    hemoryInbox.classList.toggle('hidden', mode !== 'hemory');
    agentDrafts.classList.toggle('hidden', mode !== 'drafts');
    recordsPanel.classList.toggle('hidden', activeView !== 'agent' || mode !== 'conversation');
    footerEl.classList.toggle('hidden', activeView !== 'agent' && !chatFloating || mode !== 'conversation');
    for (const tab of document.querySelectorAll('.agent-mode-tab')) tab.classList.toggle('active', tab.dataset.agentMode === mode);
    if (mode === 'hemory') await loadHemoryInbox();
    if (mode === 'drafts') await loadDraftBatches();
  }

  for (const tab of document.querySelectorAll('.agent-mode-tab')) tab.onclick = () => void showAgentMode(tab.dataset.agentMode);

  // ── Agent 悬浮球 / 悬浮对话面板 ─────────────────────────────────
  // 悬浮面板复用 #chat 本体（加 .floating 变 fixed 弹层）：SSE/消息渲染/滚动逻辑全在既有
  // 节点上零改动；显隐条件从「仅 agent 视图」放宽到「agent 视图或悬浮态」（见 showView/showAgentMode）。

  /** 悬浮球态同步：完整 Agent 视图内收起（入口重复）；对话进行中挂 busy 呼吸点。 */
  function syncChatFab() {
    chatFab.classList.toggle('hidden', activeView === 'agent');
    chatFab.classList.toggle('busy', busy);
  }

  async function openFloatingChat() {
    chatFloating = true;
    chatView.classList.add('floating');
    chatView.classList.remove('hidden');
    // 精简面板只承载对话：强制回对话 tab（Hemory 片段/草稿箱留在完整视图）。
    await showAgentMode('conversation');
    syncChatFab();
    // 打开即看最新输出（与发送消息/切换会话同口径：明确意图，强制贴底）。
    pinToBottom();
    inputEl.focus();
  }

  function closeFloatingChat() {
    chatFloating = false;
    chatView.classList.remove('floating');
    // 回到当前视图的正常显隐：非 agent 视图下 #chat 收回隐藏，输入条一并复位。
    chatView.classList.toggle('hidden', activeView !== 'agent');
    footerEl.classList.toggle('hidden', activeView !== 'agent' || activeAgentMode !== 'conversation');
    syncChatFab();
  }

  chatFab.onclick = () => void openFloatingChat();
  chatFloatingClose.onclick = () => closeFloatingChat();
  // 悬浮面板头「新对话」：悬浮态恒在对话 tab，无需再切面板；会话管理（切换/归档等）走完整视图。
  chatFloatingNew.onclick = () => void newSession();
  chatFloatingExpand.onclick = () => { closeFloatingChat(); showView('agent'); };

  // 草稿箱二级 tab：待处理 / 已忽略/已作废 分列；切换后整表重渲染（选中 tab 态跨重渲染保持）。
  for (const tab of document.querySelectorAll('.draft-subtab')) tab.onclick = () => {
    if (activeDraftTab === tab.dataset.draftTab) return;
    activeDraftTab = tab.dataset.draftTab;
    void loadDraftBatches();
  };
  // 筛选面板：打开时预填当前已应用筛选；草稿不实时生效，点「筛选」应用、点「重置」回默认。
  hemoryFilterToggle.onclick = () => {
    const opening = hemoryFilterPanel.classList.contains('hidden');
    if (opening) syncHemoryFilterDrafts();
    hemoryFilterPanel.classList.toggle('hidden', !opening);
  };
  document.getElementById('hemoryFilterApply').onclick = () => void applyHemoryFilter();
  document.getElementById('hemoryFilterReset').onclick = () => void resetHemoryFilter();
  hemoryFilterChip.onclick = () => void resetHemoryFilter();
  // 一键已归属：在待归属 ↔ 已归属间切换，其他已应用条件（日期）保留；再点切回待归属。
  hemoryConfirmedToggle.onclick = async () => {
    hemoryFilter.status = hemoryFilter.status === 'confirmed' ? 'pending' : 'confirmed';
    hemoryFilterPanel.classList.add('hidden');
    await loadHemoryInbox();
  };
  // 勾选联动：收件箱 DOM 静态存在，模块加载时绑定一次；重渲染后调用 update 同步计数。
  const updateHemorySelection = bindFragmentSelection(hemoryFragmentList, hemorySelectedCount, hemorySelectAll);
  document.getElementById('hemoryAssign').onclick = () => void updateHemoryAttribution(false);
  document.getElementById('hemoryClear').onclick = () => void updateHemoryAttribution(true);
  // ✕ 一键清除已选客户：只清输入（该值仅在点「归属所选片段」时消费，不影响已归属片段）；程序化赋值不触发 input 事件，需显式同步显隐。
  const syncHemoryCustomerClear = () => hemoryCustomerClear.classList.toggle('hidden', !hemoryCustomer.value);
  hemoryCustomerClear.onclick = () => { hemoryCustomer.value = ''; syncHemoryCustomerClear(); hemoryCustomer.focus(); };
  hemoryCustomer.addEventListener('input', syncHemoryCustomerClear);
  document.getElementById('hemoryIgnore').onclick = async () => {
    const eventIds = selectedFragmentIds(hemoryFragmentList);
    if (!eventIds.length) return alertDialog('请先选择片段');
    try { await ignoreHemoryFragments(eventIds); } catch (error) { await alertDialog(error.message); }
  };
  document.getElementById('hemoryRegenerate').onclick = async () => {
    const selected = [...hemoryFragmentList.querySelectorAll('input[type="checkbox"]:checked')];
    if (!selected.length) return alertDialog('请先选择片段');
    const notConfirmed = selected.filter((input) => input.dataset.attribution !== 'confirmed');
    if (notConfirmed.length) return alertDialog(`重生成草稿需要已归属片段，所选中有 ${notConfirmed.length} 条不是已归属状态`);
    setAssignBarBusy(true);
    try { await regenerateHemoryDrafts(selected.map((input) => input.dataset.eventId)); }
    catch (error) { await alertDialog(error.message); }
    finally { setAssignBarBusy(false); }
  };
  document.getElementById('refreshDrafts').onclick = () => void loadDraftBatches();
  // 浮动操作条：勾选变化实时联动；忽略与确认平级但默认收敛在确认，须手动切换一次才可批量忽略（防误触写操作的反向操作）。
  draftBatchList.addEventListener('change', updateDraftSelectionBar);
  draftBarModeToggle.onclick = () => { draftBarIgnoreMode = !draftBarIgnoreMode; applyDraftBarMode(); };
  draftBarPrimary.onclick = async () => {
    const groups = selectedDraftsByBatch();
    if (!groups.length) return;
    if (draftBarIgnoreMode) {
      const total = groups.reduce((sum, group) => sum + group.itemIds.length, 0);
      if (!await confirmDialog(`忽略所选 ${total} 份草稿？忽略后不再出现在待处理列表（已写入项不受影响）。`)) return;
      const failures = [];
      for (const { itemIds } of groups) {
        for (const itemId of itemIds) {
          try { await api(`/api/draft-items/${itemId}/dismiss`, { method: 'POST' }); }
          catch (error) { failures.push(`${itemId}: ${error.message}`); }
        }
      }
      if (failures.length) await alertDialog(failures.join('\n'));
      await loadDraftBatches();
      return;
    }
    const total = groups.reduce((sum, group) => sum + group.itemIds.length, 0);
    if (!await confirmDialog(`确认逐项执行 ${total} 份草稿？成功项不会因其他项失败而回滚。`)) return;
    for (const { batchId, itemIds } of groups) {
      // 某批校验失败即中止后续批次（ alertDialog 已逐条列明），避免半执行后继续放大。
      if (!await confirmDraftItems(batchId, itemIds, { skipConfirm: true })) break;
    }
    await Promise.all([loadDraftBatches(), loadActions()]);
  };
  document.getElementById('hemorySync').onclick = async () => {
    // 未选日期时为滚动增量同步（最近 7 天，去重后只补新片段）；选了日期则同步该自然日（取已应用筛选的日期）。
    try { const run = await api('/api/hemory/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: hemoryFilter.date || undefined }) }); const finished = await pollHemorySync(run.id); if (finished) await loadHemoryInbox(); }
    catch (error) { await alertDialog(error.message); }
  };

  // ── customer workbench ─────────────────────────────────────────

  function showView(view) {
    activeView = view;
    if (view !== 'customer') activeCustomerId = null;
    const agent = view === 'agent';
    // 完整 Agent 视图接管：先收悬浮面板（面板内容就是 #chat 本体，不能两处同时显示）。
    if (agent && chatFloating) closeFloatingChat();
    workbench.classList.toggle('hidden', agent);
    // 悬浮态下 #chat 与输入条跟随悬浮面板而非视图（面板浮在其他视图之上）。
    chatView.classList.toggle('hidden', !agent && !chatFloating);
    recordsPanel.classList.toggle('hidden', !agent || activeAgentMode !== 'conversation');
    footerEl.classList.toggle('hidden', !agent && !chatFloating || activeAgentMode !== 'conversation');
    agentSessions.classList.toggle('hidden', !agent);
    for (const [name, section] of Object.entries(viewSections)) section.classList.toggle('hidden', agent || name !== view);
    for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', item.dataset.view === view);
    syncChatFab();
    if (view === 'portfolio') void loadPortfolio();
    if (view === 'actions') void loadActions();
    if (view === 'alerts') void loadAlerts();
    if (view === 'cases') void loadCases();
    if (agent) void showAgentMode(activeAgentMode);
  }

  for (const item of document.querySelectorAll('.nav-item')) item.onclick = () => showView(item.dataset.view);
  document.getElementById('backToPortfolio').onclick = () => showView('portfolio');

  function metric(label, value, tone) {
    const item = el('div', 'metric-item');
    item.append(el('span', 'metric-label', label), el('strong', tone || '', String(value)));
    return item;
  }

  async function loadPortfolio() {
    const data = await api(`/api/customers?q=${encodeURIComponent(customerSearch.value.trim())}&sort=${encodeURIComponent(customerSort.value)}`);
    // 组合页只展示当前搜索视图，绝不写回 customersCache——搜索子集覆盖全量缓存曾致
    // Hemory/待办页客户名 join 不上而回退显示「CRM <十六进制id>」。
    const customers = data.customers || [];
    const high = customers.filter((c) => c.health === 'high').length;
    const renewal = customers.filter((c) => c.renewalWithin120Days).length;
    const opportunities = customers.reduce((sum, c) => sum + (c.opportunityCount || 0), 0);
    const candidates = customers.filter((c) => c.caseCandidate).length;
    portfolioMetrics.innerHTML = '';
    portfolioMetrics.append(metric('售后客户', customers.length), metric('120天内续约', renewal), metric('高风险', high, 'tone-danger'),
      metric('增购假设', opportunities), metric('案例候选', candidates));
    customerRows.innerHTML = '';
    portfolioEmpty.classList.toggle('hidden', customers.length > 0);
    for (const customer of customers) {
      const row = document.createElement('tr');
      const customerCell = document.createElement('td');
      const open = el('button', 'customer-link', customer.name);
      open.onclick = () => openCustomer(customer.id);
      customerCell.append(open, el('div', 'cell-sub', [customer.csmName, customer.industry].filter(Boolean).join(' · ') || '未分配 CSM'));
      const renewalCell = document.createElement('td');
      renewalCell.append(el('div', null, formatDate(customer.renewalDate)));
      if (customer.renewalWithin120Days) renewalCell.append(badge('续约窗口', 'warning'));
      const valueCell = el('td', null, formatMoney(customer.contractValue));
      if (customer.highValue) valueCell.append(badge('高价值', 'accent'));
      const healthCell = document.createElement('td');
      healthCell.append(badge(HEALTH_LABEL[customer.health] || customer.health, `risk-${customer.health}`));
      if (customer.risk?.score !== null && customer.risk?.score !== undefined) healthCell.append(el('div', 'cell-sub', `${customer.risk.score}分 · 覆盖${customer.risk.coverage}%`));
      const opportunityCell = el('td', null, customer.opportunityCount ? `${customer.opportunityCount} 个假设` : '—');
      const caseCell = document.createElement('td');
      caseCell.append(customer.caseCandidate ? badge('候选', 'success') : el('span', 'cell-muted', '—'));
      const nextCell = document.createElement('td');
      nextCell.append(el('div', 'next-action-cell', customer.nextAction || '待生成'));
      if (customer.nextActionDue) nextCell.append(el('div', 'cell-sub', formatDate(customer.nextActionDue)));
      const freshCell = document.createElement('td');
      freshCell.append(badge(customer.stale ? '需刷新' : '已同步', customer.stale ? 'warning' : 'success'));
      row.append(customerCell, renewalCell, valueCell, healthCell, opportunityCell, caseCell, nextCell, freshCell);
      customerRows.append(row);
    }
  }

  function definition(label, value) {
    const item = el('div', 'definition');
    item.append(el('span', null, label), el('strong', null, value || '未知'));
    return item;
  }

  function sectionBlock(title, content) {
    const section = el('section', 'detail-section');
    section.append(el('h2', null, title), content);
    return section;
  }

  function renderRisk(risk) {
    const wrap = el('div', 'risk-panel');
    if (!risk) return el('div', 'workspace-empty', '尚未生成风险评估');
    const top = el('div', 'risk-top');
    top.append(badge(HEALTH_LABEL[risk.level] || risk.level, `risk-${risk.level}`), el('strong', null, risk.score == null ? '分数未知' : `${risk.score} 分`),
      el('span', 'cell-muted', `数据覆盖 ${risk.coverage}% · ${risk.ruleVersion}`));
    wrap.append(top);
    const grid = el('div', 'risk-grid');
    for (const [key, item] of Object.entries(risk.dimensions || {})) {
      const card = el('div', `risk-dimension ${item.known ? '' : 'unknown'}`);
      card.append(el('span', null, RISK_DIMENSION_LABEL[key] || key), el('strong', null, item.known ? `${item.score}/${item.weight}` : 'unknown'), el('small', null, item.reason));
      grid.append(card);
    }
    wrap.append(grid);
    if (risk.unknowns?.length) wrap.append(el('div', 'unknown-line', `待补数据：${risk.unknowns.join('、')}`));
    return wrap;
  }

  function renderTimeline(events) {
    const list = el('div', 'timeline-list');
    if (!events.length) return el('div', 'workspace-empty', '暂无跨系统事件');
    for (const event of events) {
      const item = el('article', 'timeline-item');
      const mark = el('div', `source-mark source-${event.sourceSystem}`, event.sourceSystem.toUpperCase());
      const body = el('div', 'timeline-body');
      body.append(el('strong', null, event.title), el('div', 'cell-sub', `${formatDateTime(event.occurredAt)} · ${SOURCE_TYPE_LABEL[event.sourceType] || event.sourceType} · 置信度 ${Math.round((event.confidence || 0) * 100)}%`));
      if (event.url) { const link = el('a', 'source-link', '打开原始记录'); link.href = event.url; link.target = '_blank'; body.append(link); }
      item.append(mark, body);
      list.append(item);
    }
    return list;
  }

  function nestedName(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value.name || value.value || value.label || '';
  }

  /** 工作项状态类型（SELECT field005.category，已完成编码为 done）；旧同步数据没有 → null。 */
  function statusCategoryOf(event) {
    const status = event.payload?.field005;
    return status && typeof status === 'object' && !Array.isArray(status) && typeof status.category === 'string' && status.category ? status.category : null;
  }

  /**
   * 「数据概览」统计卡条：只给数量与比率，明细留在各自 tab。
   * 完成率/解决率用服务端全量口径（overview.completionRates，按状态类型 category==='done' 判定），
   * 与续约风险维度同源；服务端未返回时回退截断窗口本地计算（兼容旧 API）。
   * 旧数据缺 category → 待刷新，绝不拿状态名冒充类别（用户明确口径）。
   */
  function renderOverviewStats({ timeline, actions, fragments, workhours, completionRates }) {
    const byType = (type) => timeline.filter((event) => event.sourceSystem === 'ones' && event.sourceType === type);
    const rateOf = (events, serverRate) => {
      if (serverRate && serverRate.total) {
        return { done: serverRate.done, total: serverRate.total, pct: serverRate.pct, stale: !!serverRate.stale };
      }
      if (!events.length) return null;
      if (events.some((event) => statusCategoryOf(event) == null)) return 'stale';
      const done = events.filter((event) => statusCategoryOf(event) === 'done').length;
      return { done, total: events.length, pct: Math.round((done / events.length) * 100), stale: false };
    };
    const statCard = ({ label, value, sub, extra, rate, subClass, hint }) => {
      const card = el('article', 'stat-card');
      card.title = hint;
      card.append(el('div', 'stat-label', label), el('strong', 'stat-value', value));
      const subEl = el('div', 'stat-sub');
      subEl.textContent = sub;
      if (extra) subEl.append(extra);
      if (subClass) subEl.classList.add(subClass);
      card.append(subEl);
      if (rate) {
        const bar = el('div', `stat-bar${rate.pct === 100 ? ' full' : ''}`);
        const fill = el('i');
        fill.style.width = `${rate.pct}%`;
        bar.append(fill);
        card.append(bar);
      }
      return card;
    };
    const rateCard = (label, events, rateLabel, doneLabel, hint, serverRate) => {
      const rate = rateOf(events, serverRate);
      const total = rate && rate !== 'stale' ? rate.total : events.length;
      let sub = '暂无已归属记录';
      if (total) {
        sub = rate === 'stale' || (rate && rate !== 'stale' && rate.stale)
          ? `${rateLabel}待刷新（「刷新三套系统」后按状态类型出数）`
          : `${rateLabel} ${rate.pct}%（${doneLabel} ${rate.done}/${rate.total}）`;
      }
      return statCard({ label, value: `${total} 条`, sub, extra: null, rate: rate && rate !== 'stale' ? rate : null, hint });
    };

    const strip = el('div', 'stat-strip');
    const tickets = byType('support_ticket');
    const serverRates = completionRates || {};
    const ticketCard = rateCard('工单', tickets, '解决率', '已完成', '明细见「工单」tab', serverRates.support_ticket);
    if (tickets.length) {
      const blocked = tickets.filter((event) => /阻塞|挂起|blocked/i.test(nestedName(event.payload?.field005))).length;
      if (blocked) {
        const flag = el('span', 'stat-flag', ` · 阻塞 ${blocked}`);
        ticketCard.querySelector('.stat-sub').append(flag);
      }
    }
    strip.append(
      rateCard('需求', byType('suggestion_feedback'), '完成率', '已完成', '明细见「建议」tab', serverRates.suggestion_feedback),
      ticketCard,
      rateCard('运维', byType('operations_ticket'), '解决率', '已执行', '明细见「运维」tab', serverRates.operations_ticket),
    );

    const manhourIssue = timeline.find((event) => event.sourceSystem === 'ones' && event.sourceType === 'customer_manhour');
    const totalHours = workhours?.totalHours ?? (manhourIssue ? Number(manhourIssue.payload?.field019 || 0) / 100000 : null);
    const remainingHours = workhours?.remainingHours ?? (manhourIssue ? Number(manhourIssue.payload?.field020 || 0) / 100000 : null);
    const hoursText = (value) => (value == null || !Number.isFinite(Number(value)) ? '未知' : `${Number(value).toFixed(1)} 小时`);
    strip.append(statCard({
      label: '工时',
      value: hoursText(totalHours),
      sub: `已登记总工时 · 剩余 ${hoursText(remainingHours)}`,
      hint: '明细见「工时」tab',
    }));

    const all = actions || [];
    const open = all.filter((action) => action.status === 'new').length;
    strip.append(statCard({
      label: '待办',
      value: `${open} 项`,
      sub: !all.length ? '暂无待办事项' : open ? '未完成待办事项' : '全部完成',
      subClass: all.length && !open ? 'ok' : '',
      hint: '明细见「待办事项」tab',
    }));

    const cutoff = Date.now() - 30 * 86400000;
    const recent = (fragments || []).filter((fragment) => {
      const at = Date.parse(fragment.occurredAt || '');
      return !Number.isNaN(at) && at >= cutoff;
    });
    // 沟通场次按录音事件去重（一场长会切出的多个话题片段只算一场）。
    const sessions = new Set(recent.map((fragment) => String(fragment.payload?.recordingId ?? fragment.id))).size;
    strip.append(statCard({
      label: '沟通',
      value: `${sessions} 场`,
      sub: `近 30 天 · ${recent.length} 个片段`,
      hint: '明细见「Hemory 片段」tab',
    }));
    return strip;
  }

  function renderBusinessRecords(events, sourceType) {
    const records = events.filter((event) => event.sourceSystem === 'ones' && event.sourceType === sourceType);
    if (!records.length) return el('div', 'workspace-empty', `暂无${SOURCE_TYPE_LABEL[sourceType] || '相关'}记录`);
    const list = el('div', 'business-record-list');
    for (const event of records) {
      const item = el('article', 'business-record');
      const head = el('div', 'business-record-head');
      const title = event.url ? el('a', null, event.title) : el('strong', null, event.title);
      if (event.url) { title.href = event.url; title.target = '_blank'; title.rel = 'noopener'; }
      const status = nestedName(event.payload?.field005) || '状态未知';
      head.append(title, badge(status, /完成|关闭|解决/.test(status) ? 'success' : 'warning'));
      item.append(head);
      if (sourceType !== 'private_cloud_instance') {
        item.append(el('div', 'cell-sub', `发生 ${formatDateTime(event.occurredAt)} · 同步 ${formatDateTime(event.syncedAt)} · 置信度 ${Math.round((event.confidence || 0) * 100)}%`));
      }
      if (sourceType === 'customer_manhour') {
        const registered = Number(event.payload?.field019 || 0) / 100000;
        const remaining = Number(event.payload?.field020 || 0) / 100000;
        item.append(el('div', 'record-facts', `已登记 ${registered.toFixed(1)} 小时 · 剩余 ${remaining.toFixed(1)} 小时`));
      }
      if (sourceType !== 'private_cloud_instance') item.append(el('div', 'evidence-id', `证据 ${event.id}`));
      list.append(item);
    }
    return list;
  }

  function renderWorkhours(events, workhours) {
    const issue = events.find((event) => event.sourceSystem === 'ones' && event.sourceType === 'customer_manhour');
    const total = workhours?.totalHours ?? (issue ? Number(issue.payload?.field019 || 0) / 100000 : null);
    const remaining = workhours?.remainingHours ?? (issue ? Number(issue.payload?.field020 || 0) / 100000 : null);
    const records = [...(workhours?.records || [])].sort((left, right) => {
      const leftTime = new Date(left.startTime).getTime();
      const rightTime = new Date(right.startTime).getTime();
      return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime) || String(right.id || '').localeCompare(String(left.id || ''));
    });
    const wrap = el('div', 'workhour-panel');
    const summary = el('div', 'workhour-summary');
    summary.append(definition('已登记总工时', total == null || !Number.isFinite(Number(total)) ? '未知' : `${Number(total).toFixed(1)} 小时`),
      definition('剩余工时', remaining == null || !Number.isFinite(Number(remaining)) ? '未知' : `${Number(remaining).toFixed(1)} 小时`));
    wrap.append(summary);
    if (!records.length) {
      wrap.append(el('div', 'workspace-empty', issue ? '暂无工时登记详情' : '暂无客户工时记录'));
      return wrap;
    }
    const tableWrap = el('div', 'workhour-table-wrap');
    const table = el('table', 'workhour-table');
    table.setAttribute('aria-label', '工时登记详情');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['登记人', '工时日期', '登记小时', '工时描述']) {
      const cell = el('th', null, label);
      cell.scope = 'col';
      headRow.append(cell);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const record of records) {
      const owner = record.owner?.name || '未知';
      const row = document.createElement('tr');
      row.append(el('td', null, owner), el('td', null, formatDateTime(record.startTime)),
        el('td', 'workhour-hours', `${Number(record.hours || 0).toFixed(1)} 小时`),
        el('td', 'workhour-description', record.description || '无描述'));
      body.append(row);
    }
    table.append(head, body);
    tableWrap.append(table);
    wrap.append(tableWrap);
    return wrap;
  }

  function renderOnesWorkItems(events, sourceType) {
    const createdAt = (event) => event.payload?.field009 || event.occurredAt;
    const timestamp = (event) => {
      const value = new Date(createdAt(event)).getTime();
      return Number.isNaN(value) ? 0 : value;
    };
    const records = events
      .filter((event) => event.sourceSystem === 'ones' && event.sourceType === sourceType)
      .sort((left, right) => timestamp(right) - timestamp(left) || String(right.displayId || '').localeCompare(String(left.displayId || '')));
    if (!records.length) return el('div', 'workspace-empty', `暂无${SOURCE_TYPE_LABEL[sourceType] || '相关'}记录`);

    const wrap = el('div', 'ones-work-item-table-wrap');
    const table = el('table', 'ones-work-item-table');
    table.setAttribute('aria-label', `${SOURCE_TYPE_LABEL[sourceType] || 'ONES'}工作项`);
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['ID', '标题', '状态', '创建时间']) {
      const cell = el('th', null, label);
      cell.scope = 'col';
      headRow.append(cell);
    }
    head.append(headRow);

    const body = document.createElement('tbody');
    for (const event of records) {
      const row = document.createElement('tr');
      row.append(el('td', 'ones-work-item-id', event.displayId || '未知'));
      const titleCell = document.createElement('td');
      const title = event.url ? el('a', null, event.title) : el('span', null, event.title);
      if (event.url) { title.href = event.url; title.target = '_blank'; title.rel = 'noopener'; }
      titleCell.append(title);
      const statusCell = document.createElement('td');
      const status = nestedName(event.payload?.field005) || '状态未知';
      statusCell.append(badge(status, /完成|关闭|解决/.test(status) ? 'success' : 'warning'));
      row.append(titleCell, statusCell, el('td', null, formatDateTime(createdAt(event))));
      body.append(row);
    }
    table.append(head, body);
    wrap.append(table);
    return wrap;
  }

  /** 公开动态轮次报告（run 即报告）：按轮分组的只读列表（最新在前，条目带新增标记与来源链接）。
   * 检索动作不在此面板——走客户头部「刷新数据 ▾ → 仅刷新公开动态」，完成后重开客户页可见新轮次。 */
  function buildWebIntelPanel(customerId) {
    const container = el('div');
    container.append(el('div', 'workspace-empty', '正在加载公开动态轮次…'));
    void (async () => {
      try {
        const { rounds } = await api(`/api/customers/${encodeURIComponent(customerId)}/web-intel/rounds?limit=5`);
        container.replaceChildren();
        if (!rounds.length) {
          container.append(el('div', 'workspace-empty', '暂无轮次记录：该客户从未检索过（自动轮换每日 20:00–次日 08:00 推进，或用「刷新数据 ▾ → 仅刷新公开动态」立查）'));
          return;
        }
        const list = el('div', 'business-record-list');
        for (const round of rounds) {
          const summary = round.sourceStatus?.web_intelligence ?? {};
          const item = el('article', 'business-record');
          if (round.status === 'failed') {
            item.append(el('strong', null, `${formatDateTime(round.startedAt)} · 检索失败`));
            item.append(el('div', 'cell-sub', round.error || summary.error || '未知原因'));
            list.append(item);
            continue;
          }
          item.append(el('strong', null, `${formatDateTime(round.startedAt)} · 检索 ${summary.searched ?? 0} 个角度 · 新增 ${summary.count ?? 0} / 命中 ${summary.total ?? 0} 条`));
          for (const finding of summary.findings || []) {
            const line = el('div', 'cell-sub web-intel-finding');
            if (finding.is_new) line.append(el('span', 'web-intel-new', '新增'));
            const link = el('a', null, finding.label);
            link.href = finding.source_url;
            link.target = '_blank';
            link.rel = 'noopener';
            line.append(link, ` （${finding.occurred_at}）`);
            item.append(line);
          }
          if (!summary.findings?.length) item.append(el('div', 'cell-sub', '本轮无落库动态——未搜到不构成任何信号'));
          list.append(item);
        }
        container.append(list);
      } catch (error) {
        container.replaceChildren();
        container.append(el('div', 'workspace-empty', `公开动态轮次加载失败：${error.message}`));
      }
    })();
    return container;
  }

  function renderFollowups(events) {
    // 跟进记录 = CRM「csm售后客户」对象关联的销售记录（crm_followup），按销售记录创建时间倒序展示。
    const createdAt = (event) => {
      const value = new Date(event.payload?.createTime || event.occurredAt).getTime();
      return Number.isNaN(value) ? 0 : value;
    };
    const records = events
      .filter((event) => event.sourceSystem === 'crm' && event.sourceType === 'crm_followup')
      .sort((left, right) => createdAt(right) - createdAt(left) || String(right.externalId || '').localeCompare(String(left.externalId || '')));
    if (!records.length) return el('div', 'workspace-empty', '暂无已同步的销售记录');
    const list = el('div', 'business-record-list');
    for (const event of records) {
      const item = el('article', 'business-record');
      item.append(el('strong', null, event.title));
      const meta = [event.payload?.type, event.payload?.channel].filter(Boolean).map(nestedName).filter(Boolean).join(' · ');
      item.append(el('div', 'cell-sub', `创建 ${formatDateTime(event.payload?.createTime || event.occurredAt)}${meta ? ` · ${meta}` : ''}`));
      if (event.payload?.content && event.payload.content !== event.title) item.append(el('p', null, event.payload.content));
      list.append(item);
    }
    return list;
  }

  async function startAgentDraft(customer, targetKey, timeline, identities) {
    const target = DRAFT_TARGETS[targetKey];
    const option = (identities || []).find((item) => item.system === 'ones_customer_option' && item.status === 'confirmed');
    const manhour = timeline.find((event) => event.sourceType === 'customer_manhour');
    const meetings = timeline.filter((event) => event.sourceSystem === 'hemory' && event.sourceType === 'ai_topic_segment').slice(0, 12);
    const excerpts = meetings.length
      ? meetings.map((event) => `- ${formatDateTime(event.occurredAt)} [${event.title}] ${event.payload?.summary || ''}\n${event.payload?.transcript || ''}`).join('\n')
      : '- 当前工作台没有已确认归属的会议片段；请使用 Hemory MCP 按客户全称检索，无法唯一归属时停止。';
    const config = target.projectId
      ? `ONES projectID=${target.projectId}，issueTypeID=${target.issueTypeId}。新建前先调用本地工具 get_ones_desk_required_fields (record_type=${target.recordType}) 获取必填字段与完整选项 UUID 表；fieldValues 必须覆盖全部必填规格字段并包含 {"fieldID":"JrvswW8P","value":"${option?.external_id || ''}"}；实例部署类型按返回的当前客户解析值填写（CRM 使用版本=公有云版→公有云，其余→私有云）；证据不足的字段用兜底值。`
      : targetKey === 'customer_manhour'
        ? `只能向已绑定售后客户工作项 issueID=${manhour?.externalId || ''} 登记工时；先调用 get_manhour_mode，再选择对应写工具。`
        : `CRM 回写参数必须绑定 CSM 售后客户记录 _id=${customer.id}。`;
    const prompt = `请基于以下已确认归属的 Hemory 沟通证据，为客户生成“${target.label}”回写草稿，并完成 CSM 人工确认流程。\n\n`
      + `客户名称：${customer.name}\nCRM CSM售后客户ID：${customer.id}\nONES客户信息option ID：${option?.external_id || '未解析，禁止回写'}\n目标：${target.target}\n${config}\n\n`
      + `会议证据：\n${excerpts}\n\n`
      + `要求：只使用有证据的事实；缺失信息明确标注并先提问。confirm_write.record_type=${target.recordType}，fields 必须包含 customer_id="${customer.id}" 和 customer_name="${customer.name}"。展示完整业务字段和实际 target_arguments，等待我编辑并确认后再写入。`;
    const created = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: customer.id }) });
    await switchSession(created.id);
    renderCustomerCard(created.customer);
    showView('agent');
    await showAgentMode('conversation');
    inputEl.value = prompt;
    form.requestSubmit();
  }

  function draftCommand(customer, targetKey, timeline, identities) {
    const button = el('button', 'primary-command small', `从会议生成${DRAFT_TARGETS[targetKey].label}草稿`);
    button.onclick = () => startAgentDraft(customer, targetKey, timeline, identities).catch(async (error) => { await alertDialog(error.message); });
    return button;
  }

  /**
   * 案例对话精修：把黑盒生成的五段叙事草稿注入客户绑定的 Agent 会话，CSM 逐轮反馈打磨；
   * confirm_write 带 case_draft_id/case_version，服务端批准即写回本地草稿（不触碰外部写）。
   */
  async function startCaseRefine(customer, draft) {
    const fields = draft.fields || {};
    const isV8 = typeof fields.company_info === 'string';
    const narrative = isV8
      ? JSON.stringify({
        case_draft_id: draft.id, case_version: draft.version,
        customer_id: fields.customer_id, customer_name: fields.customer_name,
        company_info: fields.company_info ?? '', business_scope: fields.business_scope ?? '',
        competitive_strategy: fields.competitive_strategy ?? '', project_background: fields.project_background ?? '',
        business_status: fields.business_status ?? [], demands: fields.demands ?? [],
        solution_sections: fields.solution_sections ?? [], value_items: fields.value_items ?? [],
        lessons: fields.lessons ?? [], summary: fields.summary ?? '',
        system_usage: fields.system_usage ?? [], milestones: fields.milestones ?? [],
        unknowns: fields.unknowns ?? [],
      }, null, 2)
      : JSON.stringify({
        case_draft_id: draft.id, case_version: draft.version,
        customer_id: fields.customer_id, customer_name: fields.customer_name,
        background: fields.background ?? '', challenges: fields.challenges ?? fields.pain_points ?? [],
        requirements: fields.requirements ?? [], solution: fields.solution ?? '',
        value: fields.value ?? fields.results ?? [], unknowns: fields.unknowns ?? [],
      }, null, 2);
    const sectionContract = isV8
      ? `company_info/business_scope/competitive_strategy/project_background/business_status/demands/solution_sections（{title,text} 数组）/value_items/lessons/summary/system_usage/milestones`
      : `background/challenges/requirements/solution/value`;
    const prompt = `请对以下客户案例草稿进行对话精修。我会逐轮给出修改要求（支持整稿重写或只改某一章节）；未要求修改的章节必须原文保留。\n\n`
      + `客户名称：${customer.name}\nCRM CSM售后客户ID：${customer.id}\n\n`
      + `当前草稿（v${draft.version}）：\n${narrative}\n\n`
      + `要求：\n`
      + `- 先通读草稿并概述各章节现状与你发现的待改进点（如证据不足、叙事断裂、内部信息残留），等待我的修改意见。\n`
      + `- 修改时输出完整章节字段并调用 confirm_write（target_system=ones, record_type=case）：fields 必须原样保留 case_draft_id="${draft.id}" 和 case_version=${draft.version}，并包含 customer_id="${customer.id}"、customer_name="${customer.name}" 与完整章节字段（${sectionContract}）。\n`
      + `- 保持客户叙事视角与证据纪律：只写有证据的事实，价值与复盘不虚构数字，正文不出现内部系统名、风险评分、工时统计、联系人信息与合同金额。\n`
      + `- 本次会话只修改本地草稿，不得调用任何 CRM/ONES 外部写工具；发布到 ONES Wiki 由我在工作台完成。`;
    const created = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: customer.id }) });
    await switchSession(created.id);
    renderCustomerCard(created.customer);
    showView('agent');
    await showAgentMode('conversation');
    inputEl.value = prompt;
    form.requestSubmit();
  }

  /** 案例生成进度行：确保存在且可见，文本可选更新；锚点随客户视图重建而消失，切走即静默停止展示。 */
  function ensureCaseNotice(host, text) {
    let notice = host.querySelector('.generation-notice');
    if (!notice) {
      notice = el('div', 'generation-notice');
      host.insertBefore(notice, host.firstChild);
    }
    notice.classList.remove('hidden');
    if (text != null) notice.textContent = text;
    return notice;
  }

  /**
   * 案例生成轮询：展示服务端进度文案（阶段/检索角度/模型输出字数），锚点 DOM 存活期间
   * 一直跟踪（前 90 次 2s、之后降为 5s，无超时放弃）。终态移除进度行后按指纹定位新草稿并回调；
   * 孤儿 running（服务重启遗留、永不终结）由服务端装饰 stalled，按终态退出并引导重新生成。
   * 返回 { draft } 或 { error }；锚点被移除（切走客户/重开页面）返回 { detached: true }。
   */
  async function pollCaseJob(customerId, jobId, fingerprint, anchor) {
    const notice = anchor ? ensureCaseNotice(anchor, '案例生成中…（排队中）') : null;
    for (let attempt = 0; !anchor || anchor.isConnected; attempt++) {
      const data = await api(`/api/draft-jobs?ids=${encodeURIComponent(jobId)}`);
      const job = (data.jobs || [])[0];
      if (!job) { if (notice) notice.remove(); throw new Error('生成任务不存在'); }
      if (job.status === 'succeeded') {
        if (notice) notice.remove();
        const list = await api(`/api/case-drafts?customer_id=${encodeURIComponent(customerId)}`);
        const drafts = list.drafts || [];
        // job 指纹（重新生成时加盐）与草稿指纹（素材快照摘要）不同源，按指纹 find 必落空——
        // 改按「任务创建之后新落库的草稿」定位（created_at ≥ job.createdAt），最后才兜底列表第一条。
        const draft = drafts.find((item) => item.fingerprint === fingerprint)
          ?? drafts.find((item) => !job.createdAt || (item.createdAt && item.createdAt >= job.createdAt))
          ?? drafts[0];
        return draft ? { draft } : { error: '任务成功但未找到新草稿' };
      }
      if (job.status === 'failed') { if (notice) notice.remove(); return { error: job.error || '未知原因' }; }
      if (job.stalled) { if (notice) notice.remove(); return { error: '任务疑似因服务重启中断（未恢复），请重新生成' }; }
      if (notice) notice.textContent = `案例生成中…（${progressTail(job, '正在处理')}）`;
      await new Promise((resolve) => setTimeout(resolve, attempt < 90 ? 2000 : 5000));
    }
    return { detached: true };
  }

  /**
   * 单条待办卡。selectable（待办页）：未完成状态头插勾选框参与批量完成，
   * 点卡片本体也可切换选中；客户详情待办 tab 不传参，维持纯单条操作。
   * 状态两态（未完成 new / 已完成 completed），徽章中文化；已完成卡仅在 outcome 存在时展示实际结果（CLI --outcome 记录）。
   */
  function actionCard(action, customerMode, selectable = false) {
    const card = el('article', 'action-card');
    const head = el('div', 'action-head');
    if (selectable && action.status === 'new') {
      card.classList.add('selectable');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.actionId = action.id;
      head.append(check);
    }
    head.append(el('strong', null, action.title), badge(action.status === 'completed' ? '已完成' : '未完成', `status-${action.status}`));
    card.append(head, el('p', null, action.whyNow), el('div', 'action-meta', `${action.owner || '未分配'} · ${action.dueAt ? formatDateTime(action.dueAt) : '无截止时间'} · 置信度 ${Math.round((action.confidence || 0) * 100)}%`));
    if (action.status === 'completed' && action.outcome) card.append(el('p', null, `实际结果：${action.outcome}`));
    const buttons = el('div', 'row-actions');
    const edit = el('button', 'quiet-command small', '编辑'); edit.onclick = () => editAction(action); buttons.append(edit);
    if (action.status === 'new') {
      const complete = el('button', 'quiet-command small', '完成');
      // 一键直达完成：不弹确认、无需填写结果（CLI --outcome 仍可显式记录）。
      complete.onclick = async () => { await api(`/api/action-items/${action.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); customerMode ? openCustomer(action.customerId) : loadActions(); };
      buttons.append(complete);
    }
    card.append(buttons);
    return card;
  }

  function inputField(label, value, type) {
    const field = el('label', 'form-field');
    field.append(el('span', null, label));
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    if (type && type !== 'textarea') input.type = type;
    input.value = value || '';
    field.append(input);
    return { field, input };
  }

  function editAction(action) {
    openWorkbenchModal('编辑待办事项');
    const title = inputField('待办内容', action.title);
    const why = inputField('为什么现在做', action.whyNow, 'textarea');
    const owner = inputField('负责人', action.owner);
    const due = inputField('截止时间', action.dueAt ? new Date(action.dueAt).toISOString().slice(0, 16) : '', 'datetime-local');
    const outcome = inputField('预期结果', action.expectedOutcome, 'textarea');
    const save = el('button', 'primary-command', '保存');
    save.onclick = async () => {
      await api(`/api/action-items/${action.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title: title.input.value.trim(), whyNow: why.input.value.trim(), owner: owner.input.value.trim(),
        dueAt: due.input.value ? new Date(due.input.value).toISOString() : null, expectedOutcome: outcome.input.value.trim(),
      }) });
      closeWorkbenchModal();
      activeCustomerId ? openCustomer(activeCustomerId) : loadActions();
    };
    workbenchModalBody.append(title.field, why.field, owner.field, due.field, outcome.field, save);
  }

  /**
   * 客户详情的 Hemory 片段 tab：该客户全部已归属片段，纯展示（无勾选、无操作条）。
   * 行渲染器与收件箱共用，readonly 模式去掉 checkbox 与行内忽略/恢复。
   */
  function buildCustomerHemoryPanel(customer, fragments) {
    const panel = el('div');
    const list = el('div', 'hemory-fragment-list');
    renderHemoryFragmentList(list, fragments, { readonly: true, emptyText: '该客户当前没有已归属的 Hemory 片段' });
    panel.append(list);
    return panel;
  }

  // ── 实施周报 tab：周选择 → 生成（轮询）→ 展示/编辑/复制/发布 ──

  /** 任意日期对齐到所在周周一（上海时区）。 */
  function weekMondayOf(date) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.test(date) ? [Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))] : null;
    const at = parts ? new Date(Date.UTC(parts[0], parts[1], parts[2], 4)) : new Date(date);
    if (Number.isNaN(at.getTime())) return null;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
    const key = formatter.format(at);
    const noon = new Date(`${key}T12:00:00+08:00`);
    const back = (noon.getUTCDay() + 6) % 7;
    return formatter.format(new Date(noon.getTime() - back * 86_400_000));
  }

  function weeklyStatsLine(stats) {
    if (!stats) return '';
    const workhours = stats.workhours == null ? 'unknown' : `${Number(stats.workhours).toFixed(1)}h`;
    return `沟通 ${stats.communications} 场 · 新增建议 ${stats.newSuggestions}（解决 ${stats.resolvedSuggestions ?? 'unknown'}）· 新增工单 ${stats.newTickets}（解决 ${stats.resolvedTickets ?? 'unknown'}）· 新增运维 ${stats.newOperations}（解决 ${stats.resolvedOperations ?? 'unknown'}）· 工时 ${workhours}`;
  }

  /** 周报生成进度条：确保存在且可见（上次生成完成后 notice 会被移除，重新生成时必须重建）。 */
  function ensureWeeklyNotice(panel, text) {
    let notice = panel.querySelector('.weekly-notice');
    if (!notice) {
      notice = el('div', 'weekly-notice');
      panel.insertBefore(notice, panel.querySelector('.weekly-body'));
    }
    notice.classList.remove('hidden');
    if (text != null) notice.textContent = text;
    return notice;
  }

  /** 该周是否有生成任务在途（busyWeek 状态源：重新生成中标记/按钮禁用/防重入共用）。 */
  function isWeeklyBusy(panel, weekStart) {
    return panel.dataset.busyWeek === weekStart;
  }

  /** 当前面板正在查看的周（顶部日期选择器对齐周一；用于判断轮询终态时用户是否还在看该周）。 */
  function weeklyViewWeek(panel) {
    const input = panel.querySelector('.weekly-toolbar input[type="date"]');
    return weekMondayOf(input?.value || new Date().toISOString()) || weekMondayOf(new Date().toISOString());
  }

  function editWeeklyReport(customer, report, onUpdated) {
    openWorkbenchModal('编辑实施周报（客户版）');
    const content = report.content || {};
    const summary = inputField('一、本周工作概览（客户可见正文：2~4 句，项目阶段、推进重点与已确认结论，不含内部统计）', content.summary, 'textarea');
    const accomplishments = inputField('二、本周关键进展（每行一项：主题|日期|内容|内部依据，竖线分隔，可省略后两项；主题如 需求调研/方案与设计/部署与实施/联调与验证/培训与赋能/计划与协调/问题与支持/其他）', (content.accomplishments || []).map((item) => [item.category, item.date, item.text, item.source].filter(Boolean).join('|')).join('\n'), 'textarea');
    const plan = inputField('三、下周工作计划（每行一项：内容|内部依据，可省略依据；面向客户的计划，含时间节点与责任方）', (content.next_week_plan || []).map((item) => [item.text, item.source].filter(Boolean).join('|')).join('\n'), 'textarea');
    const risks = inputField('四、风险与待协调事项（每行一项：内容|内部依据；条目以【风险】【阻塞】【待确认】开头，客观、可行动、不隐藏真实风险）', (content.risks || []).map((item) => [item.text, item.source].filter(Boolean).join('|')).join('\n'), 'textarea');
    const actions = el('div', 'row-actions');
    const save = el('button', 'primary-command', '保存周报');
    withLoading(save, '保存中…', async () => {
      try {
        const parseAccomplishment = (line) => {
          const [category, date, ...rest] = line.split('|');
          const text = rest.length > 1 ? rest.slice(0, -1).join('|') : rest.join('|');
          const source = rest.length > 1 ? rest[rest.length - 1] : '';
          return { category: (category || '').trim() || '其他', date: (date || '').trim(), text: text.trim(), source: (source || '').trim() };
        };
        const parsePair = (line) => {
          const parts = line.split('|');
          const source = parts.length > 1 ? parts.pop().trim() : '';
          return { text: parts.join('|').trim(), source };
        };
        const nextContent = {
          summary: summary.input.value.trim(),
          accomplishments: accomplishments.input.value.split('\n').map((x) => x.trim()).filter(Boolean).map(parseAccomplishment),
          next_week_plan: plan.input.value.split('\n').map((x) => x.trim()).filter(Boolean).map(parsePair),
          risks: risks.input.value.split('\n').map((x) => x.trim()).filter(Boolean).map(parsePair),
        };
        const data = await api(`/api/weekly-reports/${report.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: report.version, content: nextContent }) });
        closeWorkbenchModal();
        onUpdated(data.report);
      } catch (error) { await alertDialog(error.message); }
    });
    actions.append(save);
    workbenchModalBody.append(summary.field, accomplishments.field, plan.field, risks.field, actions);
  }

  /**
   * 轮询周报生成任务到终态。进度条带周界文案，展示服务端下发的阶段/模型输出进度与已进行时长；
   * 不设轮询上限（面板存活期间一直跟踪，前 90 次 2s、之后降为 5s），面板被切走即静默退出
   * （任务由服务端继续，重开页面经 customer_id+status=active 恢复）。
   * 终态先清 busyWeek（「重新生成中」标记随之消失）再刷新；仅当用户仍查看该周时才动当前视图
   * （生成期间切走不打扰、不拉回）。返回最终 job（面板消失返回 null）。
   */
  async function pollWeeklyJob(panel, customer, weekStart, jobId) {
    const startedAt = Date.now();
    const notice = ensureWeeklyNotice(panel, `${weekStart.slice(5)} 周报生成中…（排队中）`);
    for (let attempt = 0; panel.isConnected; attempt++) {
      const data = await api(`/api/draft-jobs?ids=${encodeURIComponent(jobId)}`);
      const job = (data.jobs || [])[0];
      if (!job) throw new Error('生成任务不存在');
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const duration = `${minutes}:${String(elapsed % 60).padStart(2, '0')}`;
      const phase = progressTail(job, '模型撰写中');
      const slow = elapsed >= 180 ? '，耗时较长，仍在后台执行' : '';
      notice.textContent = `${weekStart.slice(5)} 周报生成中…（${phase}，已进行 ${duration}${slow}）`;
      const stillViewing = weeklyViewWeek(panel) === weekStart;
      if (job.status === 'succeeded') {
        notice.remove();
        delete panel.dataset.busyWeek;
        if (stillViewing) await refreshWeeklyPanel(panel, customer, weekStart);
        return job;
      }
      if (job.status === 'failed') {
        notice.remove();
        delete panel.dataset.busyWeek;
        if (stillViewing) {
          renderWeeklyFailure(panel, customer, weekStart, job);
          await alertDialog(`周报生成失败：${job.error || '未知原因'}\n\n可点击「再次生成」重试。`);
        }
        return job;
      }
      // 孤儿 running（服务重启遗留、永不终结）由服务端装饰 stalled：按终态退出，失败卡引导重新生成。
      if (job.stalled) {
        notice.remove();
        delete panel.dataset.busyWeek;
        if (stillViewing) {
          renderWeeklyFailure(panel, customer, weekStart, { ...job, error: '任务疑似因服务重启中断（未恢复）' });
          await alertDialog('周报生成疑似中断（服务重启未恢复），可点击「再次生成」重试。');
        }
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt < 90 ? 2000 : 5000));
    }
    return null;
  }

  function renderWeeklyFailure(panel, customer, weekStart, job) {
    const host = panel.querySelector('.weekly-body');
    host.innerHTML = '';
    const card = el('div', 'weekly-failure');
    card.append(el('strong', null, `${weekStart.slice(5)} 周报生成失败（${formatDateTime(job.updatedAt)}）`));
    card.append(el('p', null, job.error || '未知原因'));
    const buttons = el('div', 'row-actions');
    const retry = el('button', 'primary-command small', '再次生成');
    withLoading(retry, '重新生成中…', async () => {
      try {
        panel.dataset.busyWeek = weekStart;
        const result = await api(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekStart, force: true }) });
        if (!result.jobId) { delete panel.dataset.busyWeek; await refreshWeeklyPanel(panel, customer, weekStart); return; }
        renderWeeklyBody(panel, customer, weekStart);
        await pollWeeklyJob(panel, customer, weekStart, result.jobId);
      } catch (error) {
        delete panel.dataset.busyWeek;
        await alertDialog(error.message);
      }
    });
    buttons.append(retry);
    // 重新生成失败时旧版本周报仍在库里——一键回去看当前版本。
    const viewCurrent = el('button', 'quiet-command small', '查看当前周报');
    viewCurrent.onclick = () => refreshWeeklyPanel(panel, customer, weekStart);
    buttons.append(viewCurrent);
    card.append(buttons);
    host.append(card);
  }

  async function refreshWeeklyPanel(panel, customer, weekStart) {
    const host = panel.querySelector('.weekly-body');
    host.innerHTML = '';
    host.append(el('div', 'cell-sub', '加载周报中…'));
    try { await renderWeeklyReport(panel, customer, weekStart); }
    catch (error) { host.innerHTML = ''; host.append(el('div', 'workspace-empty', error.message)); }
  }

  /** 周下拉选择器：有周报的周倒序列出，选择即切换查看（并同步顶部日期选择器，两入口永远一致）。 */
  function buildWeeklyWeekSelect(panel, customer, reports, currentWeek) {
    const wrap = el('div', 'weekly-week-select');
    wrap.append(el('span', 'weekly-week-label', '切换周'));
    const select = document.createElement('select');
    for (const item of [...reports].sort((a, b) => b.weekStart.localeCompare(a.weekStart))) {
      const option = document.createElement('option');
      option.value = item.weekStart;
      const status = item.status === 'published' ? '已发布' : `草稿 v${item.version}`;
      option.textContent = `${item.weekStart} 周（${item.weekStart.slice(5)} ~ ${item.weekEnd.slice(5)}）· ${status}`;
      if (item.weekStart === currentWeek) option.selected = true;
      select.append(option);
    }
    select.onchange = () => {
      const weekInput = panel.querySelector('.weekly-toolbar input[type="date"]');
      if (weekInput) weekInput.value = select.value;
      renderWeeklyBody(panel, customer, select.value);
    };
    wrap.append(select);
    return wrap;
  }

  async function renderWeeklyReport(panel, customer, weekStart) {
    const data = await api(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`);
    const reports = data.reports || [];
    const report = reports.find((item) => item.weekStart === weekStart);
    const host = panel.querySelector('.weekly-body');
    host.innerHTML = '';
    if (reports.length) host.append(buildWeeklyWeekSelect(panel, customer, reports, weekStart));
    const regenerating = isWeeklyBusy(panel, weekStart);
    if (!report) {
      // 首次生成在途时不能显示误导性的「尚未生成周报」——生成完成后会自动刷新展示。
      host.append(el('div', 'workspace-empty', regenerating
        ? `${weekStart} 周报生成中…（完成后将自动展示）`
        : `${weekStart} 这一周尚未生成周报；点击「生成周报」基于该客户本周全部数据创建。`));
      return;
    }
    const statsLine = weeklyStatsLine(report.stats);
    const card = el('article', 'weekly-report-card');
    const head = el('div', 'weekly-report-head');
    const statusBadge = regenerating
      ? badge('重新生成中', 'warning')
      : report.status === 'published' ? badge('已发布', 'success') : badge(`草稿 v${report.version}`, 'warning');
    head.append(el('strong', null, `${report.weekStart} ~ ${report.weekEnd} 实施周报（客户版）`), statusBadge);
    card.append(head);
    if (statsLine) card.append(el('div', 'weekly-stats', `内部统计（不随客户版内容复制或发布）：${statsLine}`));
    card.append(sectionBlock('一、本周工作概览', el('p', 'weekly-section', report.content.summary || '（空）')));
    const accomplishments = el('ol', 'weekly-list');
    for (const item of report.content.accomplishments || []) {
      const li = el('li', 'weekly-item');
      li.append(el('span', 'weekly-item-text', item.text));
      const meta = [item.date, item.category, item.source].filter(Boolean).join(' · ');
      if (meta) li.append(el('span', 'weekly-evidence', `（内部依据：${meta}）`));
      accomplishments.append(li);
    }
    if (!(report.content.accomplishments || []).length) accomplishments.append(el('li', null, '（无条目）'));
    card.append(sectionBlock('二、本周关键进展', accomplishments));
    const plan = el('ol', 'weekly-list');
    for (const item of report.content.next_week_plan || []) {
      const li = el('li', 'weekly-item');
      li.append(el('span', 'weekly-item-text', item.text));
      if (item.source) li.append(el('span', 'weekly-evidence', `（内部依据：${item.source}）`));
      plan.append(li);
    }
    if (!(report.content.next_week_plan || []).length) plan.append(el('li', null, '（无条目）'));
    card.append(sectionBlock('三、下周工作计划', plan));
    const risks = el('ol', 'weekly-list');
    for (const item of report.content.risks || []) {
      const li = el('li', 'weekly-item');
      li.append(el('span', 'weekly-item-text', item.text));
      if (item.source) li.append(el('span', 'weekly-evidence', `（内部依据：${item.source}）`));
      risks.append(li);
    }
    if (!(report.content.risks || []).length) risks.append(el('li', null, '（无条目）'));
    card.append(sectionBlock('四、风险与待协调事项', risks));
    if (report.publishedPageId) card.append(el('div', 'cell-sub', `已发布到 ONES Wiki 页面 ${report.publishedPageId}`));
    const buttons = el('div', 'row-actions');
    if (report.status === 'draft') {
      const edit = el('button', 'quiet-command small', '编辑');
      edit.onclick = () => editWeeklyReport(customer, report, () => refreshWeeklyPanel(panel, customer, weekStart));
      buttons.append(edit);
    }
    const copy = el('button', 'quiet-command small', '复制 Markdown');
    copy.onclick = async () => {
      try {
        // 复制内容 = 服务端 renderWeeklyMarkdown 权威渲染的客户版正文（与 Wiki 发布正文同源），
        // 前端不再自行拼装第二份 Markdown；copyText 带 WKWebView execCommand 兜底。
        const detail = await api(`/api/weekly-reports/${report.id}`);
        const ok = await copyText(detail.markdown || '');
        if (!ok) throw new Error('剪贴板不可用');
        copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制 Markdown'; }, 1500);
      } catch (error) { await alertDialog(`复制失败：${error.message}`); }
    };
    if (report.status === 'draft') {
      const publish = el('button', 'primary-command small', '发布到 Wiki');
      withLoading(publish, '发布中…', async () => {
        try {
          const target = await pickWikiPage();
          if (!target) return;
          const preview = await api(`/api/weekly-reports/${report.id}/publish-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPageID: target.pageID }) });
          const warningText = (preview.warnings || []).length ? `⚠️ 内部信息提示（请先修正再发布）：\n${preview.warnings.join('\n')}\n\n` : '';
          if (!await confirmDialog(`确认将 ${report.weekStart} 周报发布到 ONES Wiki「${target.title}」下？\n\n${warningText}${preview.args.content.slice(0, 800)}`)) return;
          await api(`/api/weekly-reports/${report.id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: report.version, parentPageID: target.pageID, approvalHash: preview.approvalHash }) });
          await refreshWeeklyPanel(panel, customer, weekStart);
        } catch (error) { await alertDialog(error.message); }
      });
      buttons.append(publish);
      const regenerate = el('button', 'quiet-command small', '重新生成');
      withLoading(regenerate, '重新生成中…', async () => {
        if (isWeeklyBusy(panel, weekStart)) { await alertDialog('该周周报正在重新生成中，请稍候…'); return; }
        try {
          // busyWeek 先行：立即重渲染出「重新生成中」卡片（旧内容保留、全部按钮禁用），
          // loading 由持久进度条 + 卡片状态承载，不再依赖会被重渲染销毁的按钮置灰。
          panel.dataset.busyWeek = weekStart;
          const result = await api(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekStart, force: true }) });
          renderWeeklyBody(panel, customer, weekStart);
          if (result.jobId) await pollWeeklyJob(panel, customer, weekStart, result.jobId);
          else { delete panel.dataset.busyWeek; await refreshWeeklyPanel(panel, customer, weekStart); }
        } catch (error) {
          delete panel.dataset.busyWeek;
          await alertDialog(error.message);
        }
      });
      buttons.append(regenerate);
    }
    buttons.append(copy);
    card.append(buttons);
    if (regenerating) {
      card.append(el('div', 'cell-sub', '正在重新生成本周周报，完成后自动刷新…'));
      for (const button of buttons.querySelectorAll('button')) button.disabled = true;
    }
    host.append(card);
  }

  function renderWeeklyBody(panel, customer, weekStart) {
    const host = panel.querySelector('.weekly-body');
    host.innerHTML = '';
    host.append(el('div', 'cell-sub', '加载周报中…'));
    void renderWeeklyReport(panel, customer, weekStart).catch((error) => {
      host.innerHTML = '';
      host.append(el('div', 'workspace-empty', error.message));
    });
  }

  /** 实施周报 tab 面板：周选择（对齐周一）+ 生成按钮 + 已有周报列表 + 当前周展示。 */
  function buildWeeklyPanel(customer) {
    const panel = el('div', 'weekly-panel');
    const toolbar = el('div', 'weekly-toolbar');
    const weekLabel = el('label', 'weekly-week-label');
    weekLabel.append(el('span', null, '周（自动对齐周一）'));
    const weekInput = document.createElement('input');
    weekInput.type = 'date';
    const thisMonday = weekMondayOf(new Date().toISOString());
    weekInput.value = thisMonday;
    const apply = el('button', 'quiet-command small', '查看该周');
    const generate = el('button', 'primary-command small', '生成周报');
    const notice = el('div', 'weekly-notice hidden');
    toolbar.append(weekLabel, weekInput, apply, generate);
    const body = el('div', 'weekly-body');
    panel.append(toolbar, notice, body);
    const currentWeek = () => weekMondayOf(weekInput.value || thisMonday) || thisMonday;
    apply.onclick = () => renderWeeklyBody(panel, customer, currentWeek());
    weekInput.onchange = () => renderWeeklyBody(panel, customer, currentWeek());
    withLoading(generate, '生成中…', async () => {
      const weekStart = currentWeek();
      if (isWeeklyBusy(panel, weekStart)) { await alertDialog('该周周报正在生成中，请稍候…'); return; }
      try {
        panel.dataset.busyWeek = weekStart;
        ensureWeeklyNotice(panel, `${weekStart.slice(5)} 周报生成中…（排队中）`);
        const result = await api(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekStart }) });
        if (!result.jobId) {
          delete panel.dataset.busyWeek;
          (panel.querySelector('.weekly-notice') || {}).remove?.();
          await refreshWeeklyPanel(panel, customer, weekStart);
          return;
        }
        renderWeeklyBody(panel, customer, weekStart);
        await pollWeeklyJob(panel, customer, weekStart, result.jobId);
      } catch (error) {
        delete panel.dataset.busyWeek;
        const notice = panel.querySelector('.weekly-notice');
        if (notice) notice.remove();
        await alertDialog(error.message);
      }
    });
    renderWeeklyBody(panel, customer, currentWeek());
    // 面板重建（重开客户详情/切回 tab）时恢复当前周在途任务的进度展示与轮询；
    // 其他周的任务不打扰当前视图，仍由服务端继续执行；stalled（孤儿 running）跳过，不收编进 busyWeek。
    void (async () => {
      try {
        const { jobs } = await api(`/api/draft-jobs?customer_id=${encodeURIComponent(customer.id)}&status=active&kind=weekly_report`);
        const job = (jobs || []).find((item) => item.weekStart === currentWeek() && !item.stalled);
        if (job) {
          panel.dataset.busyWeek = currentWeek();
          renderWeeklyBody(panel, customer, currentWeek());
          await pollWeeklyJob(panel, customer, currentWeek(), job.id);
        }
      } catch { /* 恢复失败不影响页面；任务仍在服务端继续 */ }
    })();
    return panel;
  }


  async function openCustomer(customerId) {
    activeCustomerId = customerId;
    activeView = 'customer';
    workbench.classList.remove('hidden'); chatView.classList.add('hidden'); document.getElementById('records').classList.add('hidden'); footerEl.classList.add('hidden'); agentSessions.classList.add('hidden');
    for (const [name, section] of Object.entries(viewSections)) section.classList.toggle('hidden', name !== 'customer');
    const [data, timelineData, workhoursData, hemoryFragmentsData] = await Promise.all([
      api(`/api/customers/${encodeURIComponent(customerId)}/overview`),
      api(`/api/customers/${encodeURIComponent(customerId)}/timeline?limit=500`),
      api(`/api/customers/${encodeURIComponent(customerId)}/workhours`),
      api(`/api/hemory/fragments?customer_id=${encodeURIComponent(customerId)}&status=confirmed&limit=500`),
    ]);
    const c = data.customer;
    const timeline = timelineData.events || [];
    customerOverview.innerHTML = '';
    const head = el('div', 'customer-detail-head');
    const title = el('div'); title.append(el('h1', null, c.name), el('p', null, [c.shortName, c.industry, c.csmName && `CSM ${c.csmName}`].filter(Boolean).join(' · ')));
    const commands = el('div', 'row-actions');
    // 三个刷新类操作收进「刷新数据」菜单：首项是母操作（三套系统同步内部已强制跑公开动态并级联重算风险/机会），
    // 后两项是绕过门控的强制子集（公开动态 7 天节流门 / 机会指纹+时长门）；同步等待型的加载态挂到触发按钮上（菜单已收起）。
    const refreshMenu = commandMenu('刷新数据', [
      {
        label: '同步三套系统（含重算）',
        run: async () => { const run = await api(`/api/customers/${encodeURIComponent(customerId)}/refresh`, { method: 'POST' }); await pollSync(run.id); await openCustomer(customerId); },
      },
      {
        // 公开动态：强制检索（忽略 7 天节流门），落库后服务端已重算风险/机会，整页刷新可见。
        label: '仅刷新公开动态',
        run: () => runWithBusy(refreshMenu.trigger, '检索中…', async () => {
          try {
            const result = await api(`/api/customers/${encodeURIComponent(customerId)}/web-intel`, { method: 'POST' });
            await openCustomer(customerId);
            await alertDialog(result.saved
              ? `已落库 ${result.saved} 条最近三个月公开动态，续约风险与增购机会已重算。`
              : `检索了 ${result.searched} 个角度，未找到可落库的最近三个月公开动态（未搜到不构成任何正面或负面信号）。`);
          } catch (error) { await alertDialog(`公开动态检索失败：${error.message}`); }
        }),
      },
      {
        // 增购机会重新分析：强制（忽略指纹/时长门），从会议录音片段+公开动态证据重新产出假设，失败保留旧列表。
        label: '仅重新分析增购机会',
        run: () => runWithBusy(refreshMenu.trigger, '分析中…', async () => {
          try {
            const result = await api(`/api/customers/${encodeURIComponent(customerId)}/opportunities/refresh`, { method: 'POST' });
            await openCustomer(customerId);
            await alertDialog(result.status === 'succeeded'
              ? `已重新分析，识别到 ${result.generated} 条增购机会假设（按可信度展示前 5 条）。`
              : `未重新生成：${result.reason || result.status}（展示仍为最近一次分析结果）。`);
          } catch (error) { await alertDialog(`增购机会分析失败：${error.message}`); }
        }),
      },
    ]);
    const generate = el('button', 'primary-command case-generate-command', '生成案例');
    generate.onclick = async () => {
      try {
        generate.disabled = true;
        generate.textContent = '生成中…';
        const result = await api('/api/case-drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId }) });
        if (result.reused && result.draftId) {
          const detail = await api(`/api/case-drafts/${encodeURIComponent(result.draftId)}`);
          ensureCaseNotice(customerOverview, '素材与最近版本一致，已复用现有草稿；如需强制重写请用草稿卡上的「重新生成」');
          editCase(detail.draft);
          return;
        }
        // 任务真正启动（非复用）：已有案例卡（草稿或已发布）整卡置灰禁用——新稿落库会整体替换旧行。
        for (const item of customerOverview.querySelectorAll('.case-card-item')) setCaseCardGenerating(item, true);
        const outcome = await pollCaseJob(customerId, result.jobId, result.fingerprint, customerOverview);
        if (outcome.error) {
          await alertDialog(`案例生成失败：${outcome.error}`);
          for (const item of customerOverview.querySelectorAll('.case-card-item')) setCaseCardGenerating(item, false);
        }
        else if (outcome.draft) {
          // 新稿已落库：先重渲染客户页让卡片列表换新（否则关掉编辑弹窗仍停在生成前的旧列表），再打开新稿。
          await openCustomer(customerId);
          void loadCases();
          editCase(outcome.draft);
        }
        // outcome.detached：页面已重渲染（锚点失效），openCustomer 的在途任务恢复轮询会接管进度与刷新。
      } catch (error) { await alertDialog(error.message); }
      finally { generate.disabled = false; generate.textContent = '生成案例'; }
    };
    const ask = el('button', 'quiet-command', '询问 Agent');
    ask.onclick = async () => {
      try {
        await ensureCustomerSession(c);
      } catch (error) { await alertDialog(error.message); return; }
      // 就地弹悬浮对话面板：不离开客户详情页，边看资料边问（openFloatingChat 内部落回对话 tab）。
      await openFloatingChat();
      inputEl.value = `结合工作台已同步数据与最近三个月的公开动态，分析「${c.name}」的续约风险、增购机会和下一步行动`;
      inputEl.focus();
    };
    commands.append(refreshMenu.wrap, generate, ask); head.append(title, commands); customerOverview.append(head);

    // 预警横幅：该客户存在待处理预警时置顶展示（逐条原因 + 消除），消除后重开客户页。
    if ((data.alerts || []).length) {
      const banner = el('div', 'alert-banner');
      banner.append(el('strong', null, `风险预警（${data.alerts.length}）`));
      for (const alert of data.alerts) banner.append(alertCard(alert, true));
      customerOverview.append(banner);
    }

    const summary = el('div', 'definition-grid');
    summary.append(definition('续约日期', formatDate(c.renewalDate)), definition('合同价值', formatMoney(c.contractValue)),
      definition('使用版本', c.usageVersion || 'unknown'), definition('最后互动', formatDate(data.lastInteractionAt ?? c.lastContactAt)), definition('数据同步', formatDateTime(c.syncedAt)));
    customerOverview.append(summary);

    // 增购机会：有序列表（一句话简述 + 来源行），服务端已按可信度降序，展示取前 5。
    const opportunities = el('div');
    const oppTop = [...(data.opportunities || [])].sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 5);
    if (!oppTop.length) {
      opportunities.append(el('div', 'workspace-empty', '暂无识别到增购信号'));
    } else {
      const list = el('ol', 'opportunity-list');
      for (const item of oppTop) {
        const li = el('li', 'opportunity-item');
        li.append(el('div', 'opportunity-item-text', item.title));
        li.append(el('span', 'cell-sub', `置信度 ${Math.round((item.confidence || 0) * 100)}%`));
        const sources = item.sources || [];
        const line = el('div', 'opportunity-evidence', '来源：');
        if (!sources.length) line.append('unknown');
        sources.forEach((source, index) => {
          if (index) line.append(' · ');
          const day = (source.occurredAt || '').slice(0, 10);
          const name = source.sourceSystem === 'hemory' ? `会议录音（${day}）` : source.sourceSystem === 'web' ? `公开动态（${day}）` : (source.label || source.sourceSystem);
          if (source.sourceUrl) {
            const link = el('a', 'source-link', name);
            link.href = source.sourceUrl;
            link.target = '_blank';
            link.rel = 'noreferrer';
            line.append(link);
          } else line.append(name);
        });
        if ((item.sourceCount || 0) > sources.length) line.append(` · 等 ${item.sourceCount} 条来源`);
        li.append(line);
        list.append(li);
      }
      opportunities.append(list);
      const hidden = (data.opportunities || []).length - oppTop.length;
      if (hidden > 0) opportunities.append(el('div', 'cell-sub', `另有 ${hidden} 条较低可信度假设未展示`));
    }
    const actions = el('div', 'action-board');
    if (!(data.actions || []).length) actions.append(el('div', 'workspace-empty', '暂无待办事项'));
    for (const action of data.actions || []) actions.append(actionCard(action, true));

    const drafts = el('div', 'case-list');
    if (!(data.caseDrafts || []).length) drafts.append(el('div', 'workspace-empty', data.caseCandidate?.eligible ? '已识别为案例候选，尚未生成草稿' : '尚未满足案例候选条件'));
    for (const draft of data.caseDrafts || []) drafts.append(await caseCard(draft, true, customerId));

    const tabBar = el('div', 'customer-tabs');
    tabBar.setAttribute('role', 'tablist');
    const tabBody = el('div', 'customer-tab-body');
    const tabs = [];
    function addTab(key, label, content, command) {
      const button = el('button', 'customer-tab', label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.dataset.tab = key;
      const panel = el('section', 'customer-tab-panel hidden');
      panel.dataset.tab = key;
      if (command) { const tools = el('div', 'tab-tools'); tools.append(command); panel.append(tools); }
      panel.append(content);
      button.onclick = () => {
        for (const tab of tabs) {
          tab.button.classList.toggle('active', tab.key === key);
          tab.button.setAttribute('aria-selected', String(tab.key === key));
          tab.panel.classList.toggle('hidden', tab.key !== key);
        }
      };
      tabs.push({ key, button, panel });
      tabBar.append(button);
      tabBody.append(panel);
    }

    const overview = el('div');
    overview.append(sectionBlock('续约风险', renderRisk(data.risk)), sectionBlock('增购机会', opportunities),
      sectionBlock('数据概览', renderOverviewStats({ timeline: data.timeline, completionRates: data.completionRates, actions: data.actions || [], fragments: hemoryFragmentsData.fragments || [], workhours: workhoursData })));
    addTab('overview', '概览', overview);
    addTab('suggestion_feedback', '建议', renderOnesWorkItems(timeline, 'suggestion_feedback'), draftCommand(c, 'suggestion_feedback', timeline, data.identities));
    addTab('support_ticket', '工单', renderOnesWorkItems(timeline, 'support_ticket'), draftCommand(c, 'support_ticket', timeline, data.identities));
    addTab('operations_ticket', '运维', renderOnesWorkItems(timeline, 'operations_ticket'), draftCommand(c, 'operations_ticket', timeline, data.identities));
    addTab('customer_manhour', '工时', renderWorkhours(timeline, workhoursData), draftCommand(c, 'customer_manhour', timeline, data.identities));
    addTab('private_cloud_instance', '私有云实例', renderBusinessRecords(timeline, 'private_cloud_instance'), draftCommand(c, 'private_cloud_instance', timeline, data.identities));
    addTab('followup', '跟进记录', renderFollowups(timeline), draftCommand(c, 'followup', timeline, data.identities));
    addTab('web_intel', '公开动态', buildWebIntelPanel(c.id));
    addTab('hemory_fragments', 'Hemory 片段', buildCustomerHemoryPanel(c, hemoryFragmentsData.fragments || []));
    const casePanel = el('div');
    casePanel.append(drafts);
    addTab('cases', '客户案例', casePanel);
    addTab('weekly_report', '实施周报', buildWeeklyPanel(c));
    addTab('actions', '待办事项', actions);
    addTab('timeline', '统一时间线', renderTimeline(timeline));
    customerOverview.append(tabBar, tabBody);
    tabs[0].button.click();
    // 重开客户详情时恢复在途生成任务的进度展示（不自动弹编辑窗，成功后刷新当前视图即可）；
    // stalled（孤儿 running，服务重启遗留）跳过——收编会永久显示「案例生成中」，其出口是重新生成。
    void (async () => {
      try {
        const { jobs } = await api(`/api/draft-jobs?customer_id=${encodeURIComponent(customerId)}&status=active`);
        const caseJob = (jobs || []).find((job) => job.kind === 'case_report' && !job.stalled);
        if (caseJob) {
          // 在途生成期：旧稿整卡置灰禁用 + 锁住「生成案例」主按钮，与点击发起路径同一套展示契约。
          for (const item of customerOverview.querySelectorAll('.case-card-item')) setCaseCardGenerating(item, true);
          generate.disabled = true;
          const outcome = await pollCaseJob(customerId, caseJob.id, caseJob.fingerprint, customerOverview);
          if (outcome.draft && activeCustomerId === customerId) await openCustomer(customerId);
          else if (activeCustomerId === customerId) {
            for (const item of customerOverview.querySelectorAll('.case-card-item')) setCaseCardGenerating(item, false);
            generate.disabled = false;
          }
        }
      } catch { /* 恢复失败不影响页面；任务仍在服务端继续 */ }
    })();
  }

  /**
   * 待办页双 tab：未完成（status='new'，可勾选批量完成）/ 已完成（status='completed'，最近完成在前）。
   * 两个 tab 都按客户分组（details.customer-group 默认展开、点组标题可折叠，客户名经 customersCache 解析）；
   * 客户组顺序跟随列表序——未完成 tab 紧急客户（截止时间早）在前，已完成 tab 最近完成的客户在前。
   */
  async function loadActions() {
    const data = await api('/api/action-items');
    const actions = data.actions || [];
    await ensureCustomersCache();
    const pending = actions.filter((a) => a.status === 'new');
    const completed = actions.filter((a) => a.status === 'completed')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    actionNavCount.textContent = pending.length || '';
    actionTabPending.textContent = pending.length ? `未完成（${pending.length}）` : '未完成';
    actionTabCompleted.textContent = completed.length ? `已完成（${completed.length}）` : '已完成';
    actionBulkBar.classList.toggle('hidden', activeActionTab !== 'pending');
    // 选中 tab 态随重渲染同步（切 tab 后高亮跟随，不残留在初始按钮上）。
    for (const tab of document.querySelectorAll('.action-subtab')) tab.classList.toggle('active', tab.dataset.actionTab === activeActionTab);
    actionBoard.innerHTML = '';
    const visible = activeActionTab === 'pending' ? pending : completed;
    if (!visible.length) {
      actionBoard.append(el('div', 'workspace-empty', activeActionTab === 'pending' ? '暂无未完成待办' : '暂无已完成待办'));
    } else {
      const groups = new Map();
      for (const action of visible) groups.set(action.customerId, [...(groups.get(action.customerId) ?? []), action]);
      for (const [customerId, rows] of groups) {
        const group = document.createElement('details');
        group.className = 'customer-group';
        group.open = true;
        group.append(el('summary', 'customer-group-title', `${fragmentCustomerLabel(customerId)} · ${rows.length} 项`));
        const body = el('div', 'customer-group-body');
        for (const action of rows) body.append(actionCard(action, false, true));
        group.append(body);
        actionBoard.append(group);
      }
    }
    updateActionSelection();
  }

  // 待办二级 tab：未完成 / 已完成 分列；切换后整表重渲染（选中 tab 态跨重渲染保持）。
  for (const tab of document.querySelectorAll('.action-subtab')) tab.onclick = () => {
    if (activeActionTab === tab.dataset.actionTab) return;
    activeActionTab = tab.dataset.actionTab;
    void loadActions();
  };

  // ── 待办批量操作：勾选联动 + 批量完成（逐项处理，单项失败/跳过不影响其他项）──
  function selectedActionIds() {
    return [...actionBoard.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.dataset.actionId);
  }

  function updateActionSelection() {
    const checks = [...actionBoard.querySelectorAll('input[type="checkbox"]')];
    const selected = checks.filter((input) => input.checked).length;
    actionSelectedCount.textContent = checks.length ? `已选 ${selected}/${checks.length}` : '';
    actionSelectAll.checked = checks.length > 0 && selected === checks.length;
    for (const input of checks) input.closest('.action-card')?.classList.toggle('selected', input.checked);
  }

  function setActionBulkBusy(busy) {
    actionBulkComplete.disabled = busy;
  }

  function actionBulkSummary(label, items) {
    const counts = { completed: 0, skipped: 0, failed: 0 };
    for (const item of items) counts[item.result] = (counts[item.result] ?? 0) + 1;
    const parts = [];
    if (counts.completed) parts.push(`${counts.completed} 项完成`);
    if (counts.skipped) parts.push(`${counts.skipped} 项跳过`);
    if (counts.failed) parts.push(`${counts.failed} 项失败`);
    setStatus(counts.failed ? 'warn' : 'ok', `${label}：${parts.join('，')}`);
    if (counts.failed) {
      const detail = items.filter((item) => item.result === 'failed')
        .map((item) => `${item.title || item.id}：${item.error || item.reason || '失败'}`).join('\n');
      void alertDialog(`以下待办处理失败：\n${detail}`);
    }
  }

  actionBoard.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') updateActionSelection();
  });
  // 点卡片本体即切换选中（勾选框、按钮等交互元素自身处理，不冒泡重复翻转）；无勾选框的卡片不响应。
  actionBoard.addEventListener('click', (event) => {
    if (event.target.closest('button, input, label, a')) return;
    const check = event.target.closest('.action-card')?.querySelector('input[type="checkbox"]');
    if (!check) return;
    check.checked = !check.checked;
    updateActionSelection();
  });
  actionSelectAll.onchange = () => {
    for (const input of actionBoard.querySelectorAll('input[type="checkbox"]')) input.checked = actionSelectAll.checked;
    updateActionSelection();
  };
  actionBulkComplete.onclick = async () => {
    const ids = selectedActionIds();
    if (!ids.length) return alertDialog('请先选择待办');
    setActionBulkBusy(true);
    try {
      const data = await api('/api/action-items/bulk-complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      await loadActions();
      actionBulkSummary('批量完成', data.items || []);
    } catch (error) { await alertDialog(error.message); }
    finally { setActionBulkBusy(false); }
  };

  // ── 风险预警名单：待处理 / 已消除 双 tab；消除必须填写原因/动作（与待办双 tab 同款交互骨架）。──
  async function loadAlerts() {
    const data = await api(`/api/alerts?status=${activeAlertTab === 'pending' ? 'active' : 'resolved'}`);
    const alerts = data.alerts || [];
    alertNavCount.textContent = data.counts?.active || '';
    alertTabPendingEl().textContent = data.counts?.active ? `待处理（${data.counts.active}）` : '待处理';
    alertTabResolvedEl().textContent = data.counts?.resolved ? `已消除（${data.counts.resolved}）` : '已消除';
    for (const tab of document.querySelectorAll('[data-alert-tab]')) tab.classList.toggle('active', tab.dataset.alertTab === activeAlertTab);
    alertBoard.innerHTML = '';
    if (!alerts.length) {
      alertBoard.append(el('div', 'workspace-empty', activeAlertTab === 'pending' ? '暂无待处理预警' : '暂无已消除预警'));
      return;
    }
    for (const alert of alerts) alertBoard.append(alertCard(alert, false));
  }

  const alertTabPendingEl = () => document.getElementById('alertTabPending');
  const alertTabResolvedEl = () => document.getElementById('alertTabResolved');

  for (const tab of document.querySelectorAll('[data-alert-tab]')) tab.onclick = () => {
    if (activeAlertTab === tab.dataset.alertTab) return;
    activeAlertTab = tab.dataset.alertTab;
    void loadAlerts();
  };

  /**
   * 预警卡：触发标签 + 客户（全局视图可点进详情）+ 逐条原因 + 发现时间；
   * 已消除态展示消除人/时间/原因说明。customerMode（详情页横幅）不重复显示客户名。
   */
  function alertCard(alert, customerMode) {
    const card = el('article', 'alert-card');
    const head = el('div', 'alert-head');
    head.append(badge(ALERT_TRIGGER_LABEL[alert.triggerKey] || alert.triggerKey, alert.triggerKey === 'negative_public_signal' ? 'warning' : 'risk-high'));
    if (!customerMode) {
      const open = el('button', 'customer-link', alert.customerName || alert.customerId);
      open.onclick = () => openCustomer(alert.customerId);
      head.append(open);
    }
    head.append(el('span', 'cell-sub', `发现于 ${formatDate(alert.createdAt)}`));
    if (alert.status === 'resolved') {
      head.append(badge('已消除', 'success'));
      card.append(head);
      const note = el('div', 'alert-resolution');
      note.append(el('span', 'cell-sub', `${alert.resolvedBy || 'unknown'} 于 ${formatDateTime(alert.resolvedAt)} 消除`));
      note.append(el('div', 'alert-resolution-note', alert.resolutionNote || ''));
      card.append(note);
    } else {
      head.append(badge('待处理', 'risk-high'));
      card.append(head);
      const resolve = el('button', 'quiet-command', '消除风险');
      resolve.type = 'button';
      resolve.onclick = () => resolveAlertAction(alert, activeView === 'customer' ? () => openCustomer(alert.customerId) : loadAlerts);
      head.append(resolve);
    }
    const reasons = el('ul', 'alert-reasons');
    for (const reason of alert.reasons || []) reasons.append(el('li', null, reason));
    if ((alert.reasons || []).length) card.append(reasons);
    return card;
  }

  /** 消除预警：原因/动作必填（空输入重问，取消放弃），成功后刷新当前视图与导航角标。 */
  async function resolveAlertAction(alert, refresh) {
    let note = await promptDialog(`消除「${ALERT_TRIGGER_LABEL[alert.triggerKey] || alert.triggerKey}」预警的原因/动作：`, '');
    while (note !== null && !note.trim()) {
      await alertDialog('消除风险必须填写原因或动作');
      note = await promptDialog(`消除「${ALERT_TRIGGER_LABEL[alert.triggerKey] || alert.triggerKey}」预警的原因/动作：`, '');
    }
    if (note === null || !note.trim()) return;
    try {
      await api(`/api/alerts/${encodeURIComponent(alert.id)}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: note.trim() }) });
      setTransientStatus('ok', '预警已消除', 4000);
      await refresh();
    } catch (error) { await alertDialog(error.message); }
  }

  /**
   * 案例草稿卡。customerMode（客户详情）：草稿态附 编辑/对话精修/重新生成 三操作与
   * 数据更新徽章；全局案例库只读展示。contextStale 由详情接口实时比对指纹得出。
   */
  /** 配图渲染防御（纵深防御，非权威消毒——SVG 落库前已由服务端白名单消毒）：检出危险结构即整图不渲染。 */
  function sanitizeCaseSvgForRender(svg) {
    if (typeof svg !== 'string' || !svg.startsWith('<svg') || !svg.endsWith('</svg>')) return null;
    if (/<script|<foreignObject|<image|<!DOCTYPE|<!ENTITY/i.test(svg)) return null;
    if (/\son[a-zA-Z]+\s*=|javascript:|<\?xml-stylesheet/i.test(svg)) return null;
    return svg;
  }

  /**
   * blob 下载回退（showSaveFilePicker 不可用或失败时）：浏览器落默认下载目录；
   * Mac 壳 WKWebView 由 Swift 侧 WKDownloadDelegate 接管弹 NSSavePanel 选位置。
   * 故意不 revokeObjectURL：壳里保存面板可能开很久，WebKit 在选定目标后才读
   * blob 数据，提前 revoke 会让下载失败；文档卸载时 blob 自然释放。
   */
  function saveBlobViaAnchor(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
  }

  /**
   * 案例生成中置灰：卡片挂 case-generating 态并禁用全部操作按钮（编辑/精修/重新生成/复制/导出），
   * 案例全文保持只读可看；恢复时整排按钮重置为可用是安全的——渲染时本就全部可用，徽章是 div 不受影响。
   */
  function setCaseCardGenerating(card, generating) {
    card.classList.toggle('case-generating', generating);
    for (const button of card.querySelectorAll('.row-actions button')) button.disabled = generating;
  }

  async function caseCard(draft, customerMode = false, customerId = null) {
    const card = el('article', 'case-card-item');
    if (draft.customerId) card.dataset.customerId = draft.customerId;
    card.append(el('strong', null, draft.title), el('div', 'cell-sub', `${draft.status === 'published' ? '已发布' : `草稿 v${draft.version}`} · ${formatDateTime(draft.updatedAt)}`));
    const buttons = el('div', 'row-actions');
    let detail = null;
    if (draft.status === 'draft') {
      try {
        detail = await api(`/api/case-drafts/${encodeURIComponent(draft.id)}`);
        const warningCount = detail.qualityReview?.warnings?.length ?? detail.warnings?.length ?? 0;
        if (warningCount) buttons.append(badge(`公开检查 ${warningCount} 项`, 'warning'));
      } catch { /* 详情失败不阻塞卡片渲染 */ }
    }
    if (draft.status === 'draft') {
      const edit = el('button', 'quiet-command small', '编辑');
      edit.onclick = () => editCase(draft);
      buttons.append(edit);
      if (customerMode && customerId) {
        const refine = el('button', 'quiet-command small', '对话精修');
        refine.onclick = async () => {
          try {
            const cached = customersCache.find((item) => item.id === customerId)
              ?? (await api('/api/customers')).customers.find((item) => item.id === customerId);
            if (!cached) return alertDialog('未找到客户信息，无法发起精修');
            await startCaseRefine(cached, draft);
          } catch (error) { await alertDialog(error.message); }
        };
        buttons.append(refine);
        const regenerate = el('button', 'quiet-command small', '重新生成');
        regenerate.onclick = async () => {
          try {
            // 生成期旧稿整卡置灰禁用（新稿落库会整体替换旧行，编辑/导出随时可能被覆盖）；
            // 同时锁住头部「生成案例」主按钮，防止并发再起任务（后端无同客户互斥）。
            setCaseCardGenerating(card, true);
            const generateCommand = customerOverview.querySelector('.case-generate-command');
            if (generateCommand) generateCommand.disabled = true;
            regenerate.textContent = '重新生成中…';
            const result = await api(`/api/case-drafts/${encodeURIComponent(draft.id)}/regenerate`, { method: 'POST' });
            const outcome = await pollCaseJob(draft.customerId, result.jobId, result.fingerprint, card);
            if (outcome.error) await alertDialog(`重新生成失败：${outcome.error}`);
            else if (outcome.draft) {
              // 新稿已落库：先重渲染客户页让卡片列表换新，再打开新稿编辑（与「生成案例」路径同口径）。
              await openCustomer(draft.customerId);
              void loadCases();
              editCase(outcome.draft);
            }
            // outcome.detached：页面已重渲染，openCustomer 的在途任务恢复轮询会接管进度与刷新。
          } catch (error) { await alertDialog(error.message); }
          finally {
            // 成功路径 openCustomer 已重渲染（旧卡脱离 DOM）由恢复流程接管；失败/异常按存活态恢复。
            if (!card.isConnected) return;
            setCaseCardGenerating(card, false);
            regenerate.textContent = '重新生成';
            const generateCommand = customerOverview.querySelector('.case-generate-command');
            if (generateCommand) generateCommand.disabled = false;
          }
        };
        buttons.append(regenerate);
      }
      if (customerMode && customerId) {
        if (detail?.contextStale) buttons.append(badge('数据已更新', 'warning'));
      }
    }
    // 复制内容 = 服务端 renderCaseMarkdown 权威渲染（与 Wiki 发布正文同源），与周报卡复制按钮同款。
    const copy = el('button', 'quiet-command small', '复制 Markdown');
    copy.onclick = async () => {
      try {
        const current = draft.status === 'draft' && !detail
          ? await api(`/api/case-drafts/${encodeURIComponent(draft.id)}`)
          : detail || await api(`/api/case-drafts/${encodeURIComponent(draft.id)}`);
        const ok = await copyText(current.markdown || '');
        if (!ok) throw new Error('剪贴板不可用');
        copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制 Markdown'; }, 1500);
      } catch (error) { await alertDialog(`复制失败：${error.message}`); }
    };
    buttons.append(copy);
    // 导出 Word：与服务端 Markdown 同一内容口径的 docx 版式（目录/客户信息表/里程碑/配图）。
    const exportDocx = el('button', 'quiet-command small', '导出 Word');
    exportDocx.onclick = async () => {
      try {
        exportDocx.disabled = true;
        exportDocx.textContent = '导出中…';
        const response = await fetch(`/api/case-drafts/${encodeURIComponent(draft.id)}/export`);
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const name = decodeURIComponent((disposition.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || '客户成功案例.docx');
        // Chrome/Edge：File System Access API 弹保存位置选择由用户定路径；
        // WKWebView/Safari/Firefox 无此 API，回退 <a download>（Mac 壳由此走进 NSSavePanel）。
        if (window.showSaveFilePicker) {
          try {
            const handle = await window.showSaveFilePicker({ suggestedName: name });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
          } catch (pickerError) {
            if (pickerError && pickerError.name === 'AbortError') return; // 用户取消保存，静默
            saveBlobViaAnchor(blob, name); // 其他异常（如用户激活过期）回退默认下载
          }
        } else {
          saveBlobViaAnchor(blob, name);
        }
        exportDocx.textContent = '已导出'; setTimeout(() => { exportDocx.textContent = '导出 Word'; }, 1500);
      } catch (error) { await alertDialog(`导出失败：${error.message}`); }
      finally { exportDocx.disabled = false; exportDocx.textContent = '导出 Word'; }
    };
    buttons.append(exportDocx);
    if (draft.publishedPageId) buttons.append(badge(`ONES ${draft.publishedPageId}`, 'success'));
    card.append(buttons);
    // 案例全文只读视图：不进编辑即可看全文，配图按章节位置嵌入（与导出 Word、Markdown 占位同口径）。
    // 客户详情 tab 默认展开；全局案例库默认折叠，避免整页长文。
    const fulltext = document.createElement('details');
    fulltext.className = 'case-fulltext';
    if (customerMode) fulltext.open = true;
    fulltext.append(el('summary', 'case-fulltext-summary', '案例全文'));
    fulltext.append(renderCaseFullText(detail?.draft?.fields || draft.fields || {}, draft.title));
    card.append(fulltext);
    return card;
  }

  /**
   * 案例全文只读渲染：章节顺序对齐服务端 renderCaseMarkdown（唯一权威口径），配图按
   * section/kind 嵌入对应章节末尾（status→业务现状、demands→业务诉求、solution→业务解决方案、
   * value/milestone→服务里程碑、value/value_map→价值章末尾），不再在卡片底部单独排一排。
   * v8 四章深结构（company_info 键判定）+ 存量旧稿五段分支；渲染前配置图必须过 sanitizeCaseSvgForRender。
   */
  function renderCaseFullText(fields, title) {
    const doc = el('div', 'case-doc');
    const figures = Array.isArray(fields.figures) ? fields.figures : [];
    const figureBlocks = (section, kind) => {
      const blocks = [];
      for (const figure of figures) {
        if (figure.section !== section || (kind && figure.kind !== kind)) continue;
        const safe = sanitizeCaseSvgForRender(figure.svg);
        if (!safe) continue;
        const wrap = el('div', 'case-figure');
        const holder = el('div');
        holder.innerHTML = safe;
        wrap.append(holder, el('div', 'case-figure-caption', figure.caption || ''));
        blocks.push(wrap);
      }
      return blocks;
    };
    const str = (value) => (typeof value === 'string' ? value.trim() : '');
    const arr = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []);
    const h2 = (text) => el('div', 'case-doc-h2', text);
    const h3 = (text) => el('div', 'case-doc-h3', text);
    const h4 = (text) => el('div', 'case-doc-h4', text);
    const p = (text) => el('p', 'case-doc-p', text);
    const ol = (items) => {
      const list = el('ol', 'case-doc-list');
      for (const item of items) list.append(el('li', null, item));
      return list;
    };
    doc.append(el('div', 'case-doc-title', title || ''));
    if (typeof fields.company_info === 'string') {
      doc.append(h2('一、客户及背景介绍'), h3('（一）客户简介'));
      if (str(fields.company_info)) doc.append(h4('公司信息'), p(str(fields.company_info)));
      if (str(fields.business_scope)) doc.append(h4('核心业务范围'), p(str(fields.business_scope)));
      if (str(fields.competitive_strategy)) doc.append(h4('竞争优势与发展战略'), p(str(fields.competitive_strategy)));
      doc.append(h3('（二）项目背景'), p(str(fields.project_background)));
      const usage = Array.isArray(fields.system_usage) ? fields.system_usage.filter((row) => row && (row.item || row.content)) : [];
      if (usage.length) {
        const table = el('table', 'case-doc-table');
        const thead = el('thead');
        const head = el('tr');
        head.append(el('th', null, '项目'), el('th', null, '内容'));
        thead.append(head);
        table.append(thead);
        for (const row of usage) {
          const tr = el('tr');
          tr.append(el('td', null, row.item || ''), el('td', null, row.content || ''));
          table.append(tr);
        }
        doc.append(h3('（三）系统使用情况'), table);
      }
      doc.append(h2('二、场景及解决方案'));
      doc.append(h3('（一）业务现状'));
      for (const item of arr(fields.business_status)) doc.append(p(item));
      doc.append(...figureBlocks('status'));
      doc.append(h3('（二）业务诉求'), ol(arr(fields.demands)), ...figureBlocks('demands'));
      doc.append(h3('（三）业务解决方案'));
      const sections = Array.isArray(fields.solution_sections) ? fields.solution_sections.filter((section) => section && str(section.text)) : [];
      sections.forEach((section, index) => {
        doc.append(h4(`${index + 1}、${section.title || '方案举措'}`), p(str(section.text)));
      });
      doc.append(...figureBlocks('solution'));
      doc.append(h2('三、方案价值概述'));
      const milestones = Array.isArray(fields.milestones) ? fields.milestones.filter((item) => item && item.date && item.label) : [];
      if (milestones.length) {
        const milestoneList = el('ul', 'case-doc-list');
        for (const item of milestones) milestoneList.append(el('li', null, `${item.date} ${item.label}`));
        doc.append(h3('服务里程碑'), milestoneList, ...figureBlocks('value', 'milestone'));
      }
      doc.append(h3('价值成效'), ol(arr(fields.value_items)));
      if (arr(fields.lessons).length) doc.append(h3('经验复盘与沉淀'), ol(arr(fields.lessons)));
      // value_map（痛点-方案-价值全景图）是全案收束图，位置固定在价值章末尾、项目总结之前。
      doc.append(...figureBlocks('value', 'value_map'));
      doc.append(h2('四、项目总结'), p(str(fields.summary)));
      return doc;
    }
    // 存量旧稿五段分支：与 renderLegacyCaseMarkdown 同序，配图跟在各章正文后。
    const legacyList = (value, legacyKey) => {
      const source = Array.isArray(value) ? value : (Array.isArray(fields[legacyKey]) ? fields[legacyKey] : []);
      return source.map((item) => typeof item === 'string' ? item : `${item.metric || ''}: ${item.value || ''}`.trim()).filter(Boolean);
    };
    const legacySections = [
      { key: 'background', label: '客户背景', body: () => [p(str(fields.background))] },
      { key: 'challenges', label: '痛点、现状与挑战', body: () => [ol(legacyList(fields.challenges, 'pain_points'))] },
      { key: 'requirements', label: '需求与要求', body: () => [ol(legacyList(fields.requirements))] },
      { key: 'solution', label: '解决方案', body: () => [p(str(fields.solution))] },
      { key: 'value', label: '价值与成效', body: () => [ol(legacyList(fields.value, 'results'))] },
    ];
    legacySections.forEach((section, index) => {
      doc.append(h2(`${'一二三四五'[index]}、${section.label}`), ...section.body(), ...figureBlocks(section.key));
    });
    return doc;
  }

  async function loadCases() {
    const data = await api('/api/case-drafts');
    caseList.innerHTML = '';
    if (!(data.drafts || []).length) caseList.append(el('div', 'workspace-empty', '暂无案例草稿'));
    for (const draft of data.drafts || []) caseList.append(await caseCard(draft));
    // 生成中的客户：旧稿卡片置灰禁用并就地轮询（进度行显示在灰卡内），成功后刷新列表、失败恢复卡片。
    try {
      const { jobs } = await api('/api/draft-jobs?status=active&kind=case_report');
      const seen = new Set();
      for (const job of jobs || []) {
        if (job.stalled || seen.has(job.customerId)) continue;
        seen.add(job.customerId);
        const card = caseList.querySelector(`.case-card-item[data-customer-id="${CSS.escape(job.customerId)}"]`);
        if (!card) continue;
        setCaseCardGenerating(card, true);
        void pollCaseJob(job.customerId, job.id, job.fingerprint, card)
          .then(async (outcome) => {
            if (outcome.draft) await loadCases();
            else if (outcome.error && card.isConnected) setCaseCardGenerating(card, false);
          })
          .catch(async (error) => {
            if (card.isConnected) setCaseCardGenerating(card, false);
            await alertDialog(error.message);
          });
      }
    } catch { /* 状态查询失败不影响列表展示 */ }
  }

  /**
   * 案例编辑弹窗。v8 四章深结构（公司简介三小节/项目背景/系统使用情况表/业务现状/业务诉求/
   * 方案小节/价值与复盘/服务里程碑/项目总结）；存量旧稿（无 company_info 键）仍走五段表单。
   * 解决方案小节的文本格式：每节以「## 小节标题」行开头、后续行为该节正文。
   */
  function editCase(draft) {
    openWorkbenchModal('编辑客户案例');
    const fields = draft.fields || {};
    const isV8 = typeof fields.company_info === 'string';
    const title = inputField('案例标题', draft.title);
    const actions = el('div', 'row-actions');
    const save = el('button', 'primary-command', '保存草稿');
    const publish = el('button', 'quiet-command', '预览并发布');
    const lines = (input) => input.value.split('\n').map((x) => x.trim()).filter(Boolean);
    let buildFields;
    const inputs = [];
    const addField = (label, value, type = 'textarea') => {
      const field = inputField(label, value, type);
      inputs.push(field);
      return field.input;
    };

    if (isV8) {
      const companyInfo = addField('一（一）客户简介 · 公司信息（100~250 字，仅档案与可信公开信息）', fields.company_info || '');
      const businessScope = addField('一（一）客户简介 · 核心业务范围', fields.business_scope || '');
      const strategy = addField('一（一）客户简介 · 竞争优势与发展战略', fields.competitive_strategy || '');
      const projectBackground = addField('一（二）项目背景（200~500 字，合作动因与目标）', fields.project_background || '');
      const usage = addField('一（三）系统使用情况（每行「项目：内容」，派生表可补充账号数/有效期/使用部门）',
        (fields.system_usage || []).map((row) => `${row.item}：${row.content}`).join('\n'));
      const status = addField('二（一）业务现状（每行一段，2~4 段）', (fields.business_status || []).join('\n'));
      const demands = addField('二（二）业务诉求（每行一项）', (fields.demands || []).join('\n'));
      const solution = addField('二（三）业务解决方案（每节以「## 小节标题」行开头，随后为该节正文 250~600 字）',
        (fields.solution_sections || []).map((section) => `## ${section.title || ''}\n${section.text}`).join('\n\n'));
      const milestones = addField('三 · 服务里程碑（每行「YYYY-MM 事件」，服务端派生、可增删改）',
        (fields.milestones || []).map((milestone) => `${milestone.date} ${milestone.label}`).join('\n'));
      const valueItems = addField('三 · 价值成效（每行一项；量化优先，无量化写有据定性价值）', (fields.value_items || []).join('\n'));
      const lessons = addField('三 · 经验复盘与沉淀（每行一项，可空；只写有出处的复盘结论）', (fields.lessons || []).join('\n'));
      const summary = addField('四、项目总结（150~400 字收束）', fields.summary || '');
      buildFields = () => ({
        company_info: companyInfo.value.trim(),
        business_scope: businessScope.value.trim(),
        competitive_strategy: strategy.value.trim(),
        project_background: projectBackground.value.trim(),
        system_usage: lines(usage).map((line) => {
          const split = line.match(/^([^：:]+)[：:]\s*(.*)$/);
          return split ? { item: split[1].trim(), content: split[2].trim() } : null;
        }).filter(Boolean),
        business_status: lines(status),
        demands: lines(demands),
        solution_sections: (() => {
          const sections = [];
          for (const line of solution.value.split('\n')) {
            if (line.startsWith('## ')) sections.push({ title: line.slice(3).trim(), text: '' });
            else if (sections.length) sections[sections.length - 1].text += (sections[sections.length - 1].text ? '\n' : '') + line;
          }
          return sections.map((section) => ({ title: section.title.slice(0, 40), text: section.text.trim() })).filter((section) => section.text);
        })(),
        milestones: lines(milestones).map((line) => {
          const split = line.match(/^(\d{4}-\d{2}(?:-\d{2})?)\s+(.*)$/);
          return split ? { date: split[1], label: split[2].trim().slice(0, 80) } : null;
        }).filter(Boolean),
        value_items: lines(valueItems),
        lessons: lines(lessons),
        summary: summary.value.trim(),
      });
    } else {
      const asList = (value, legacy) => {
        const source = Array.isArray(value) ? value : (Array.isArray(legacy) ? legacy : []);
        return source.map((item) => typeof item === 'string' ? item : `${item.metric || ''}: ${item.value || ''}`.trim()).filter(Boolean).join('\n');
      };
      const background = addField('一、客户背景（行业、业务概况与合作起点的连贯叙述）', fields.background, );
      const challenges = addField('二、痛点、现状与挑战（每行一项）', asList(fields.challenges, fields.pain_points));
      const requirements = addField('三、需求与要求（每行一项）', asList(fields.requirements));
      const solution = addField('四、解决方案（仅写已完成或有明确完成确认的落地举措）', fields.solution);
      const value = addField('五、价值与成效（每行一项；量化优先，无量化写有据定性价值）', asList(fields.value, fields.results));
      buildFields = () => ({
        background: background.value.trim(), challenges: lines(challenges),
        requirements: lines(requirements), solution: solution.value.trim(), value: lines(value),
      });
    }
    async function saveDraft() {
      return api(`/api/case-drafts/${draft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        version: draft.version, title: title.input.value.trim(), fields: buildFields(),
      }) });
    }
    // 写回护栏（非阻断）：服务端对编辑结果做条目数/长度/内部残留检查，命中时弹窗提示复核。
    async function afterSave(updated) {
      if ((updated?.warnings || []).length) {
        await alertDialog(`已保存，但有 ${updated.warnings.length} 项编辑提醒：\n${updated.warnings.map((warning) => `- ${warning}`).join('\n')}`);
      }
      return updated;
    }
    save.onclick = async () => { draft = await afterSave(await saveDraft()); closeWorkbenchModal(); activeCustomerId ? openCustomer(activeCustomerId) : loadCases(); };
    publish.onclick = async () => {
      try {
        draft = await afterSave(await saveDraft());
        const target = await pickWikiPage();
        if (!target) return;
        const parentPageID = target.pageID;
        const preview = await api(`/api/case-drafts/${draft.id}/publish-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPageID }) });
        const warningText = (preview.warnings || []).length
          ? `\n\n公开检查提示（不阻断发布）：\n${(preview.warnings || []).map((warning) => `- ${warning}`).join('\n')}`
          : '';
        if (!await confirmDialog(`确认将“${draft.title}”发布到 ONES Wiki「${target.title}」下？${warningText}\n\n${preview.args.content.slice(0, 800)}`)) return;
        draft = await api(`/api/case-drafts/${draft.id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: draft.version, parentPageID, approvalHash: preview.approvalHash }) });
        closeWorkbenchModal(); activeCustomerId ? openCustomer(activeCustomerId) : loadCases();
      } catch (error) { await alertDialog(error.message); }
    };
    actions.append(save, publish);
    workbenchModalBody.append(title.field, ...inputs.map((field) => field.field), actions);
  }

  async function pollSync(id) {
    globalSync.disabled = true;
    try {
      for (let i = 0; i < 120; i++) {
        const run = await api(`/api/sync-runs/${id}`);
        setStatus(run.status === 'failed' ? 'warn' : '', run.status === 'running' ? '正在同步…' : `同步${run.status === 'succeeded' ? '完成' : '部分完成'}`);
        if (run.status !== 'running') return run;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('同步超时，任务仍在后台运行');
    } finally { globalSync.disabled = false; }
  }

  // Hemory 专用轮询：分段走 LLM、整轮含退避重试可达 20 分钟以上，必须等终态而不是 120s 就放弃。
  // 到终态（含 partial：部分录音分段失败、其余已入库）后由调用方刷新收件箱；到上限仍未终态只提示，不再报错吓人。
  async function pollHemorySync(id) {
    const button = document.getElementById('hemorySync');
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '同步中…'; }
    try {
      for (let i = 0; i < 900; i++) {
        const run = await api(`/api/sync-runs/${id}`);
        setStatus(run.status === 'failed' ? 'warn' : '', run.status === 'running' ? 'Hemory 同步中（含分段与重试，可能较久）…' : `Hemory 同步${run.status === 'succeeded' ? '完成' : run.status === 'partial' ? '部分完成' : '失败'}`);
        if (run.status !== 'running') return run;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      await alertDialog('Hemory 同步仍在后台运行（超过 30 分钟），完成后请手动刷新收件箱。');
      return null;
    } finally {
      if (button) { button.disabled = false; button.textContent = label; }
    }
  }

  async function startGlobalSync() {
    try {
      const run = await api('/api/sync', { method: 'POST' });
      await pollSync(run.id);
      await loadPortfolio();
    } catch (error) { setStatus('warn', error.message); }
  }

  globalSync.onclick = startGlobalSync;
  refreshPortfolio.onclick = loadPortfolio;
  customerSort.onchange = () => { void loadPortfolio(); };
  let searchTimer;
  customerSearch.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadPortfolio, 250); };

  // ── quick actions ──────────────────────────────────────────────

  for (const chip of quickActions.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      inputEl.value = chip.dataset.template;
      inputEl.focus();
    });
  }

  // ── 附件（「+」按钮 / 拖拽 / 粘贴三路汇入同一条管线；限制与服务端保持一致）──
  const ATTACH_MAX_COUNT = 5;
  const ATTACH_MAX_FILE = 8 * 1024 * 1024;
  const ATTACH_MAX_TOTAL = 15 * 1024 * 1024;
  let pendingAttachments = []; // [{name, mimeType, size, data(base64)}]
  // 视觉（图片输入）能力：GET /api/config/llm 下发，设置保存后同步刷新；无视觉时前端直接拦图片。
  let visionSupported = false;

  function renderAttachmentChips() {
    attachmentChipsEl.innerHTML = '';
    attachmentChipsEl.classList.toggle('hidden', pendingAttachments.length === 0);
    pendingAttachments.forEach((att, index) => {
      const chip = el('span', 'attach-chip');
      chip.title = `${att.name}（${(att.size / 1024).toFixed(0)}KB）`;
      chip.appendChild(el('span', 'n', '📎 ' + att.name));
      // 表单内按钮默认 submit：chips 删除钮必须显式 type=button 并阻断冒泡。
      const remove = el('button', 'x', '✕');
      remove.type = 'button';
      remove.title = '移除附件';
      remove.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        pendingAttachments.splice(index, 1);
        renderAttachmentChips();
      });
      chip.appendChild(remove);
      attachmentChipsEl.appendChild(chip);
    });
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取文件失败: ' + file.name));
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(file);
    });
  }

  async function addAttachmentFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    for (const file of files) {
      if (pendingAttachments.length >= ATTACH_MAX_COUNT) { await alertDialog(`一次最多附带 ${ATTACH_MAX_COUNT} 个附件`); break; }
      const isImage = (file.type || '').startsWith('image/');
      if (isImage && !visionSupported) {
        await alertDialog(`「${file.name}」是图片，但当前模型不支持图片输入（视觉模型）。请在设置中切换支持视觉的模型，或勾选「支持图片输入」。`);
        continue;
      }
      if (file.size > ATTACH_MAX_FILE) { await alertDialog(`「${file.name}」超过单文件大小上限 8MB`); continue; }
      if (pendingAttachments.reduce((sum, a) => sum + a.size, 0) + file.size > ATTACH_MAX_TOTAL) {
        await alertDialog('附件总大小超过 15MB 上限');
        break;
      }
      const data = await readFileAsBase64(file);
      pendingAttachments.push({ name: file.name || '未命名附件', mimeType: file.type || 'application/octet-stream', size: file.size, data });
    }
    renderAttachmentChips();
  }

  attachEl.addEventListener('click', () => attachFileEl.click());
  attachFileEl.addEventListener('change', () => {
    addAttachmentFiles(attachFileEl.files).catch(() => {});
    attachFileEl.value = ''; // 清空后再次选择同一文件仍能触发 change
  });
  // 粘贴截图与拖拽文件走同一管线（CSM 甩日志/贴截图是高频动作）。
  form.addEventListener('paste', (ev) => {
    const files = ev.clipboardData?.files;
    if (files && files.length) {
      ev.preventDefault();
      addAttachmentFiles(files).catch(() => {});
    }
  });
  footerEl.addEventListener('dragover', (ev) => { ev.preventDefault(); attachShell.classList.add('dragover'); });
  footerEl.addEventListener('dragleave', (ev) => { if (!footerEl.contains(ev.relatedTarget)) attachShell.classList.remove('dragover'); });
  footerEl.addEventListener('drop', (ev) => {
    ev.preventDefault();
    attachShell.classList.remove('dragover');
    addAttachmentFiles(ev.dataTransfer?.files).catch(() => {});
  });

  // ── composer ───────────────────────────────────────────────────

  /** 请求服务端停止本轮对话；失败且仍处于 busy 才提示（如恰好已 turn_end，事件流会自然复位）。 */
  async function stopTurn() {
    if (!busy || !sessionId) return;
    sendEl.disabled = true;
    // 文案先于停止请求置上：turn_end 可能先于本请求的响应到达，后置会错过 turn_end 的释放时机。
    setStatus('', '正在停止对话…');
    try {
      await api(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    } catch (error) {
      sendEl.disabled = false;
      // 停止没成（409/网络失败），不留无意义的停止文案。
      setIdleStatus();
      if (busy) await alertDialog(error.message);
    }
  }

  // 对话进行中发送按钮是「停止」：click 阶段拦截默认的表单提交，转投停止。
  sendEl.addEventListener('click', (ev) => {
    if (busy) {
      ev.preventDefault();
      stopTurn();
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = inputEl.value.trim();
    const attachments = pendingAttachments.map((a) => ({ ...a }));
    if ((!text && !attachments.length) || busy || !sessionId) return;
    inputEl.value = '';
    pendingAttachments = [];
    renderAttachmentChips();
    busy = true;
    inputEl.disabled = true;
    pinToBottom();
    setThinking(true);
    setSendStopping(true);
    syncChatFab();
    try {
      const res = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attachments.length ? { message: text, attachments } : { message: text }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `发送失败 (${res.status})`);
    } catch (err) {
      busy = false;
      syncChatFab();
      inputEl.disabled = false;
      setThinking(false);
      setSendStopping(false);
      // 发送被拒（视觉门/类型/大小）时把内容还给用户，避免白打白选。
      inputEl.value = text;
      pendingAttachments = attachments;
      renderAttachmentChips();
      addMessage('assistant', '发送失败: ' + err.message);
    }
  });

  // 新对话后须落回对话 tab（boot 的 init() 也调 newSession，故在绑定处导航而不动函数本身）。
  newSessionBtn.addEventListener('click', async () => { await newSession(); await showAgentMode('conversation'); });
  archivedToggle.addEventListener('click', () => {
    archivedExpanded = !archivedExpanded;
    archivedListEl.classList.toggle('hidden', !archivedExpanded);
    loadSessions();
  });

  // ── boot ───────────────────────────────────────────────────────

  const PROVIDERS = [
    ['deepseek', 'DeepSeek'],
    ['openai', 'OpenAI'],
    ['anthropic', 'Anthropic (Claude)'],
    ['moonshotai', 'Moonshot (Kimi)'],
    ['groq', 'Groq'],
    ['glm-coding', 'GLM Coding Plan（智谱）'],
    ['custom', '自定义（OpenAI / Anthropic 兼容）'],
  ];
  for (const [id, label] of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    llmProvider.appendChild(opt);
  }

  async function init() {
    const listRes = await fetch('/api/sessions');
    const listData = await listRes.json();
    const sessions = listData.sessions || [];
    if (sessions.length) {
      await switchSession(sessions[0].id);
    } else {
      await newSession();
    }
    loadRecords();
    await Promise.all([loadPortfolio(), loadActions(), loadAlerts(), loadCases(), loadHemoryInbox(), loadDraftBatches()]);
    // 视觉能力决定附件入口是否放行图片（设置页每次保存也会刷新同一状态）。
    fetch('/api/config/llm').then((r) => r.json()).then((d) => { visionSupported = d.vision === true; }).catch(() => {});
    showView('portfolio');
    startBuildVersionCheck();
  }

  /**
   * 旧进程检测：public/ 静态文件每次请求读磁盘（页面永远最新），而 API 路由在进程启动时
   * 加载进内存——构建后进程不重启就会出现「新 UI + 旧 API」分裂（新端点 404、新按钮失效）。
   * 每 30s 比对自己脚本的 buildId（/build-info.js，随构建更新）与 /api/version 的 buildId
   * （进程启动时定格）：不一致、或 /api/version 不存在（进程早于该机制）就挂红色横幅，
   * 恢复一致自动消隐。受监管实例（launchd/Mac App）会在检测到新构建后自动换新进程，横幅只闪现。
   */
  function startBuildVersionCheck() {
    const banner = document.getElementById('buildStaleBanner');
    if (!banner) return;
    const check = async () => {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) throw new Error('no-version-endpoint');
        const version = await res.json();
        const mine = (typeof window !== 'undefined' && window.__CSM_BUILD__) ? window.__CSM_BUILD__.buildId : null;
        if (version.stale || (mine && version.buildId && mine !== version.buildId)) {
          banner.textContent = `服务进程仍在运行旧构建（${version.buildId || '未知版本'}，启动于 ${formatDateTime(version.startedAt)}），新界面调用的功能可能不可用——请重启服务（csm-agent service restart）或等受监管实例自动换新`;
          banner.classList.remove('hidden');
        } else banner.classList.add('hidden');
      } catch (error) {
        // /api/version 404 = 进程版本早于构建戳机制，同样按旧进程警示（首次构建后老进程还活着的典型形态）。
        banner.textContent = '服务进程版本过旧（无 /api/version 端点），请重启服务后再使用新功能';
        banner.classList.remove('hidden');
      }
    };
    void check();
    setInterval(() => void check(), 30_000);
  }

  init().catch((err) => setStatus('warn', '启动失败: ' + err.message));
})();
