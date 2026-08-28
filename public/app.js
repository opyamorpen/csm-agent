(function () {
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const statusEl = document.getElementById('status');
  const form = document.getElementById('composer');
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
  const llmBaseUrlRow = document.getElementById('llmBaseUrlRow');
  const llmBaseUrl = document.getElementById('llmBaseUrl');
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
  const agentConversation = document.getElementById('agentConversation');
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
  const hemoryCustomer = document.getElementById('hemoryCustomer');
  const hemoryCustomerOptions = document.getElementById('hemoryCustomerOptions');
  const hemorySelectAll = document.getElementById('hemorySelectAll');
  const hemorySelectedCount = document.getElementById('hemorySelectedCount');
  const hemoryFragmentList = document.getElementById('hemoryFragmentList');
  const draftBatchList = document.getElementById('draftBatchList');
  const draftGenerationNotice = document.getElementById('draftGenerationNotice');
  const draftGenerationText = document.getElementById('draftGenerationText');
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
  const caseList = document.getElementById('caseList');
  const workbenchModal = document.getElementById('workbenchModal');
  const workbenchModalTitle = document.getElementById('workbenchModalTitle');
  const workbenchModalBody = document.getElementById('workbenchModalBody');
  const workbenchModalClose = document.getElementById('workbenchModalClose');
  const viewSections = {
    portfolio: document.getElementById('portfolioView'),
    customer: document.getElementById('customerView'),
    actions: document.getElementById('actionsView'),
    cases: document.getElementById('casesView'),
  };

  let activeView = 'portfolio';
  let activeAgentMode = 'conversation';
  let activeCustomerId = null;
  let customersCache = [];

  let sessionId = null;
  let sessionCustomerId = null;
  let es = null;
  let busy = false;
  let maxSeq = 0;
  let mcpFailures = [];
  let archivedExpanded = false;
  const draftJobTracking = new Map();
  let draftJobTimer = null;

  function setStatus(cls, text) {
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
    statusEl.lastChild.textContent = text;
  }

  /** 侧边栏 Agent 角标 = Hemory 待归属 + 草稿箱两个数字之和（与两个 tab 角标同源）。 */
  function updateAgentNavCount() {
    const total = Number(hemoryPendingCount.textContent || 0) + Number(draftPendingCount.textContent || 0);
    agentNavCount.textContent = total || '';
  }

  function scrollDown() {
    messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
  }

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

  function formatMoney(value) {
    if (value === null || value === undefined) return '未知';
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  const HEALTH_LABEL = { high: '高风险', medium: '中风险', low: '低风险', unknown: '待补数据' };
  const RISK_DIMENSION_LABEL = {
    renewal: '续约',
    contract: '合同',
    engagement: '互动',
    delivery: '交付',
    voice: '客户声音',
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
    case: { label: '客户案例', recordType: 'case', target: 'ONES Wiki / 客户案例库' },
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

  function clearMessages() { messagesEl.innerHTML = ''; maxSeq = 0; renderCustomerCard(null); }

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

  function addToolLine(name, args) {
    const n = el('div', 'tool');
    const b = document.createElement('b');
    b.textContent = name;
    n.append('调用工具 ', b);
    if (args && Object.keys(args).length) n.append(' · ' + JSON.stringify(args).slice(0, 180));
    messagesEl.appendChild(n);
    scrollDown();
  }

  function addConfirmCard(draft) {
    const card = el('div', 'card');
    card.append(el('h3', null, '待确认草稿'), el('div', 'meta', `目标系统: ${draft.target_system} ｜ 工具: ${draft.target_tool}`));
    const title = inputField('标题', draft.title);
    const summary = inputField('摘要', draft.summary, 'textarea');
    const fields = inputField('业务字段（JSON）', JSON.stringify(draft.fields ?? {}, null, 2), 'textarea');
    const args = inputField('实际回写参数（JSON）', JSON.stringify(draft.target_arguments ?? {}, null, 2), 'textarea');
    fields.input.classList.add('json-editor');
    args.input.classList.add('json-editor');
    card.append(title.field, summary.field, fields.field, args.field);
    const actions = el('div', 'actions');
    const okBtn = el('button', 'approve', '批准写入');
    const noBtn = el('button', 'reject', '拒绝');
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

  function handleEvent(e) {
    if (!e) return;
    switch (e.type) {
      case 'user': addMessage('user', e.text); break;
      case 'turn_start': busy = true; setThinking(true); break;
      case 'text': addMessage('assistant', e.text); break;
      case 'tool_call': addToolLine(e.name, e.arguments); break;
      case 'tool_result':
        if (e.name !== 'confirm_write') {
          messagesEl.appendChild(el('div', 'tool', '← ' + e.name + ': ' + (e.result || '').slice(0, 220)));
          scrollDown();
        }
        break;
      case 'confirm': addConfirmCard(e.draft); loadRecords(); break;
      case 'customer_context': renderCustomerCard(e.context); break;
      case 'turn_end':
        busy = false;
        setThinking(false);
        sendEl.disabled = false;
        inputEl.disabled = false;
        inputEl.focus();
        loadSessions();
        loadRecords();
        break;
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
      item.onclick = () => switchSession(s.id);
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
    setStatus(mcpFailures.length ? 'warn' : 'ok', mcpFailures.length ? '部分系统未连接: ' + mcpFailures.map(([n]) => n).join(', ') : '就绪');
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
        recordListEl.innerHTML = el('div', 'empty', '暂无产出').outerHTML;
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

  // 自定义（OpenAI 兼容）服务商需要额外的 Base URL 输入框。
  function syncLlmProviderUi() {
    const isCustom = llmProvider.value === 'custom';
    llmBaseUrlRow.classList.toggle('hidden', !isCustom);
    llmModel.placeholder = isCustom ? '例如 ucloud-qwen3.8-max' : '例如 deepseek-v4-flash';
  }
  llmProvider.addEventListener('change', syncLlmProviderUi);

  async function loadLlmConfigUI() {
    try {
      const res = await fetch('/api/config/llm');
      const data = await res.json();
      llmProvider.value = data.provider || 'deepseek';
      llmModel.value = data.model || '';
      llmBaseUrl.value = data.baseUrl || '';
      llmKey.value = '';
      llmKey.placeholder = data.apiKeyConfigured
        ? '已设置（留空则不修改）'
        : 'sk-... 或用 ${ENV_VAR}';
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
      provider: llmProvider.value,
      model: llmModel.value.trim(),
      apiKey: llmKey.value.trim(),
    };
    if (llmPayload.provider === 'custom') llmPayload.baseUrl = llmBaseUrl.value.trim();
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
      setStatus(mcpFailures.length ? 'warn' : 'ok', mcpFailures.length ? '部分系统未连接: ' + mcpFailures.map(([n]) => n).join(', ') : '就绪');
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '保存失败: ' + err.message;
    } finally {
      saveConfigBtn.disabled = false;
    }
  });

  // ── Agent Hemory workspace ─────────────────────────────────────

  async function ensureCustomerOptions() {
    if (!customersCache.length) customersCache = (await api('/api/customers')).customers || [];
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
   * 轮询草稿生成任务直到终态：进行中在草稿箱顶部显示 spinner 横幅；全部结束后自动刷新草稿列表。
   * 失败任务不会创建批次，只能在这里感知；jobId 为空的幂等复用任务（草稿已存在）不轮询。
   */
  function trackDraftGeneration(jobs) {
    for (const job of jobs || []) if (job.jobId) draftJobTracking.set(job.jobId, job.fingerprint);
    if (!draftJobTracking.size) return;
    if (draftJobTimer) return;
    const startedAt = Date.now();
    const tick = async () => {
      let running = 0;
      const failed = [];
      const finished = new Set();
      try {
        const ids = [...draftJobTracking.keys()];
        const { jobs: fresh } = await api(`/api/draft-jobs?ids=${encodeURIComponent(ids.join(','))}`);
        const byId = new Map((fresh || []).map((job) => [job.id, job]));
        for (const id of ids) {
          const job = byId.get(id);
          // 查不到的任务按终态处理，避免轮询空转。
          if (!job || job.status === 'succeeded' || job.status === 'failed') {
            finished.add(id);
            if (job?.status === 'failed') failed.push(job.error || '未知原因');
          } else running++;
        }
      } catch (error) { /* 轮询失败保持现状，下一轮重试 */ }
      if (running) {
        draftGenerationNotice.classList.remove('hidden');
        draftGenerationText.textContent = `正在生成草稿（${running} 个任务）…`;
        setStatus('', `正在生成草稿（${running} 个任务）…`);
      } else {
        for (const id of finished) draftJobTracking.delete(id);
        draftJobTimer = null;
        draftGenerationNotice.classList.add('hidden');
        if (failed.length) setStatus('warn', `草稿生成失败：${[...new Set(failed)].join('；').slice(0, 160)}——请在 Hemory 收件箱重新归属片段、或对既有批次点「重新生成」重试`);
        else setStatus('', '草稿生成完成');
        void loadDraftBatches();
        return;
      }
      if (Date.now() - startedAt > 180000) {
        draftJobTimer = null;
        draftGenerationNotice.classList.add('hidden');
        setStatus('warn', '草稿生成仍在后台进行，稍后点「刷新」查看');
        return;
      }
      draftJobTimer = setTimeout(() => void tick(), 2000);
    };
    draftJobTimer = setTimeout(() => void tick(), 1500);
  }

  function draftTypeLabel(type) {
    return { internal_todo: 'Agent 待办', workhour: '工时', followup: '沟通记录', suggestion: '需求', ticket: '工单', operations: '运维工单' }[type] || type;
  }

  function editableDraft(item) {
    openWorkbenchModal(`编辑${draftTypeLabel(item.type)}草稿`);
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

  async function confirmDraftBatch(batch, container) {
    const itemIds = [...container.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.dataset.itemId);
    if (!itemIds.length) return alertDialog('请选择要确认的草稿');
    try {
      const preview = await api(`/api/draft-batches/${batch.id}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds }) });
      const invalid = preview.items.filter((item) => item.validationErrors?.length);
      if (invalid.length) return alertDialog(invalid.map((item) => `${item.id}: ${item.validationErrors.join('；')}`).join('\n'));
      if (!await confirmDialog(`确认逐项执行 ${preview.items.length} 份草稿？成功项不会因其他项失败而回滚。`)) return;
      await api(`/api/draft-batches/${batch.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        items: preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })),
      }) });
      await Promise.all([loadDraftBatches(), loadActions()]);
    } catch (error) { alertDialog(error.message); }
  }

  async function loadDraftBatches() {
    const data = await api('/api/draft-batches');
    const batches = data.batches || [];
    const pending = batches.flatMap((batch) => batch.items || []).filter((item) => !['written', 'dismissed', 'stale'].includes(item.status)).length;
    draftPendingCount.textContent = pending || '';
    updateAgentNavCount();
    draftBatchList.innerHTML = '';
    if (!batches.length) return draftBatchList.append(el('div', 'workspace-empty', '还没有 Hemory 草稿'));
    for (const batch of batches) {
      const section = el('section', 'draft-batch');
      const head = el('div', 'draft-batch-head');
      const customer = customersCache.find((item) => item.id === batch.customerId);
      const title = el('div'); title.append(el('strong', null, customer?.name || batch.customerId), el('div', 'cell-sub', `${formatDateTime(batch.updatedAt)} · ${batch.generator} · ${batch.status}`));
      const confirmButton = el('button', 'primary-command small', '确认所选草稿');
      confirmButton.onclick = () => confirmDraftBatch(batch, section);
      head.append(title, confirmButton);
      // 存在校验错误（如 ONES 客户信息未解析）的草稿批次无法确认，同样允许重新生成以在问题修复后重绑参数。
      const hasBlockingErrors = (batch.items || []).some((item) => item.validationErrors?.length && !['written', 'dismissed', 'stale'].includes(item.status));
      if (['stale', 'partial', 'failed'].includes(batch.status) || hasBlockingErrors) {
        const regenerate = el('button', 'quiet-command small', '重新生成');
        regenerate.onclick = async () => {
          if (!await confirmDialog('重新生成将作废该批次未写入的草稿并按当前片段重新整理，继续？')) return;
          try {
            const { jobs } = await api(`/api/draft-batches/${batch.id}/regenerate`, { method: 'POST' });
            await loadDraftBatches();
            trackDraftGeneration(jobs || []);
          }
          catch (error) { alertDialog(error.message); }
        };
        head.append(regenerate);
      }
      section.append(head);
      for (const item of batch.items || []) {
        // 卡片整体是 label：点击任意位置即切换勾选；禁用态（written/dismissed/stale/writing）点击无效，仅去掉手型提示。
        const row = el('label', 'draft-item');
        const selector = document.createElement('input'); selector.type = 'checkbox'; selector.dataset.itemId = item.id;
        selector.disabled = ['written', 'dismissed', 'stale', 'writing'].includes(item.status);
        if (selector.disabled) row.classList.add('draft-item-disabled');
        const body = el('div', 'draft-item-body');
        const itemHead = el('div', 'draft-item-head'); itemHead.append(badge(draftTypeLabel(item.type), 'accent'), el('strong', null, item.title), badge(item.status, item.status === 'written' ? 'success' : item.status === 'failed' ? 'risk-high' : 'warning'));
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
        if (!['written', 'dismissed', 'stale', 'writing'].includes(item.status)) {
          const edit = el('button', 'quiet-command small', '编辑'); edit.type = 'button';
          edit.onclick = (event) => { event.preventDefault(); event.stopPropagation(); editableDraft(item); };
          actions.append(edit);
        }
        if (item.status === 'failed') {
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

  async function showAgentMode(mode) {
    activeAgentMode = mode;
    agentConversation.classList.toggle('hidden', mode !== 'conversation');
    hemoryInbox.classList.toggle('hidden', mode !== 'hemory');
    agentDrafts.classList.toggle('hidden', mode !== 'drafts');
    recordsPanel.classList.toggle('hidden', activeView !== 'agent' || mode !== 'conversation');
    footerEl.classList.toggle('hidden', activeView !== 'agent' || mode !== 'conversation');
    for (const tab of document.querySelectorAll('.agent-mode-tab')) tab.classList.toggle('active', tab.dataset.agentMode === mode);
    if (mode === 'hemory') await loadHemoryInbox();
    if (mode === 'drafts') await loadDraftBatches();
  }

  for (const tab of document.querySelectorAll('.agent-mode-tab')) tab.onclick = () => void showAgentMode(tab.dataset.agentMode);
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
  document.getElementById('hemorySync').onclick = async () => {
    // 未选日期时为滚动增量同步（最近 7 天，去重后只补新片段）；选了日期则同步该自然日（取已应用筛选的日期）。
    try { const run = await api('/api/hemory/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: hemoryFilter.date || undefined }) }); await pollSync(run.id); await loadHemoryInbox(); }
    catch (error) { await alertDialog(error.message); }
  };

  // ── customer workbench ─────────────────────────────────────────

  function showView(view) {
    activeView = view;
    if (view !== 'customer') activeCustomerId = null;
    const agent = view === 'agent';
    workbench.classList.toggle('hidden', agent);
    chatView.classList.toggle('hidden', !agent);
    recordsPanel.classList.toggle('hidden', !agent || activeAgentMode !== 'conversation');
    footerEl.classList.toggle('hidden', !agent || activeAgentMode !== 'conversation');
    agentSessions.classList.toggle('hidden', !agent);
    for (const [name, section] of Object.entries(viewSections)) section.classList.toggle('hidden', agent || name !== view);
    for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', item.dataset.view === view);
    if (view === 'portfolio') void loadPortfolio();
    if (view === 'actions') void loadActions();
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
    customersCache = data.customers || [];
    const high = customersCache.filter((c) => c.health === 'high').length;
    const renewal = customersCache.filter((c) => c.renewalWithin120Days).length;
    const opportunities = customersCache.reduce((sum, c) => sum + (c.opportunityCount || 0), 0);
    const candidates = customersCache.filter((c) => c.caseCandidate).length;
    portfolioMetrics.innerHTML = '';
    portfolioMetrics.append(metric('售后客户', customersCache.length), metric('120天内续约', renewal), metric('高风险', high, 'tone-danger'),
      metric('增购假设', opportunities), metric('案例候选', candidates));
    customerRows.innerHTML = '';
    portfolioEmpty.classList.toggle('hidden', customersCache.length > 0);
    for (const customer of customersCache) {
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

  function renderOnesSources(events) {
    const groups = [
      ['suggestion_feedback', '建议与反馈'],
      ['support_ticket', '工单'],
      ['operations_ticket', '运维工单'],
      ['customer_manhour', '客户工时'],
      ['private_cloud_instance', '私有云实例'],
    ];
    const grid = el('div', 'source-summary-grid');
    for (const [sourceType, label] of groups) {
      const records = events.filter((event) => event.sourceSystem === 'ones' && event.sourceType === sourceType);
      const group = el('article', 'source-summary');
      const head = el('div', 'source-summary-head');
      head.append(el('strong', null, label), badge(`${records.length} 条`, records.length ? 'accent' : ''));
      group.append(head);
      if (!records.length) {
        group.append(el('div', 'cell-muted', '暂无已归属记录'));
      } else {
        for (const event of records.slice(0, 4)) {
          const line = el('div', 'source-record');
          const status = nestedName(event.payload?.field005);
          let detail = [status, formatDate(event.occurredAt)].filter(Boolean).join(' · ');
          if (sourceType === 'customer_manhour') {
            const hours = Number(event.payload?.field019 || 0) / 100000;
            detail = `已登记 ${hours.toFixed(1)} 小时 · ${detail}`;
          }
          const title = event.url ? el('a', null, event.title) : el('span', null, event.title);
          if (event.url) { title.href = event.url; title.target = '_blank'; title.rel = 'noopener'; }
          line.append(title, el('small', null, detail));
          group.append(line);
        }
      }
      grid.append(group);
    }
    return grid;
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
      ? `ONES projectID=${target.projectId}，issueTypeID=${target.issueTypeId}。新建前先调用本地工具 get_ones_desk_required_fields（record_type=${target.recordType}）获取必填字段与完整选项 UUID 表；fieldValues 必须覆盖全部必填规格字段并包含 {"fieldID":"JrvswW8P","value":"${option?.external_id || ''}"}；实例部署类型按返回的当前客户解析值填写（CRM 使用版本=公有云版→公有云，其余→私有云）；证据不足的字段用兜底值。`
      : targetKey === 'customer_manhour'
        ? `只能向已绑定售后客户工作项 issueID=${manhour?.externalId || ''} 登记工时；先调用 get_manhour_mode，再选择对应写工具。`
        : targetKey === 'followup'
          ? `CRM 回写参数必须绑定 CSM 售后客户记录 _id=${customer.id}。`
          : '案例草稿必须在 fields 中保留 customer_id 和 customer_name，发布到 ONES Wiki 前由 CSM 确认父页面与完整内容。';
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

  function actionCard(action, customerMode) {
    const card = el('article', 'action-card');
    const head = el('div', 'action-head');
    head.append(el('strong', null, action.title), badge(action.status, `status-${action.status}`));
    card.append(head, el('p', null, action.whyNow), el('div', 'action-meta', `${action.owner || '未分配'} · ${action.dueAt ? formatDateTime(action.dueAt) : '无截止时间'} · 置信度 ${Math.round((action.confidence || 0) * 100)}%`));
    const buttons = el('div', 'row-actions');
    if (action.status === 'new') {
      const accept = el('button', 'primary-command small', '接受');
      accept.onclick = async () => { await api(`/api/action-items/${action.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'accepted' }) }); customerMode ? openCustomer(action.customerId) : loadActions(); };
      buttons.append(accept);
    }
    const edit = el('button', 'quiet-command small', '编辑'); edit.onclick = () => editAction(action); buttons.append(edit);
    if (['accepted', 'in_progress'].includes(action.status)) {
      const wecom = el('button', 'quiet-command small', action.wecomTodoId ? '已关联企微' : '同步企微待办');
      wecom.disabled = !!action.wecomTodoId;
      wecom.onclick = async () => {
        try {
          const intent = await api(`/api/action-items/${action.id}/wecom-todo-intents`, { method: 'POST' });
          window.open(intent.url, '_blank', 'noopener');
        } catch (error) { await alertDialog(error.message); }
      };
      const complete = el('button', 'quiet-command small', '完成');
      complete.onclick = async () => { const outcome = (await promptDialog('记录实际结果：', '')) ?? ''; await api(`/api/action-items/${action.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) }); customerMode ? openCustomer(action.customerId) : loadActions(); };
      buttons.append(wecom, complete);
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
    openWorkbenchModal('编辑行动事项');
    const title = inputField('行动内容', action.title);
    const why = inputField('为什么现在做', action.whyNow, 'textarea');
    const owner = inputField('负责人', action.owner);
    const wecom = inputField('企业微信 UserId', action.ownerWecomUserid);
    const due = inputField('截止时间', action.dueAt ? new Date(action.dueAt).toISOString().slice(0, 16) : '', 'datetime-local');
    const outcome = inputField('预期结果', action.expectedOutcome, 'textarea');
    const save = el('button', 'primary-command', '保存');
    save.onclick = async () => {
      await api(`/api/action-items/${action.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title: title.input.value.trim(), whyNow: why.input.value.trim(), owner: owner.input.value.trim(), ownerWecomUserid: wecom.input.value.trim(),
        dueAt: due.input.value ? new Date(due.input.value).toISOString() : null, expectedOutcome: outcome.input.value.trim(),
      }) });
      closeWorkbenchModal();
      activeCustomerId ? openCustomer(activeCustomerId) : loadActions();
    };
    workbenchModalBody.append(title.field, why.field, owner.field, wecom.field, due.field, outcome.field, save);
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
    return `沟通 ${stats.communications} 次 · 新增建议 ${stats.newSuggestions} · 新增工单 ${stats.newTickets}（解决约 ${stats.resolvedTickets ?? 'unknown'}）· 新增运维 ${stats.newOperations} · 工时 ${workhours}`;
  }

  function editWeeklyReport(customer, report, onUpdated) {
    openWorkbenchModal('编辑实施周报');
    const content = report.content || {};
    const summary = inputField('① 本周执行摘要', content.summary, 'textarea');
    const accomplishments = inputField('② 本周完成情况（每行一项：分类|日期|内容|来源，竖线分隔，可省略后两项）', (content.accomplishments || []).map((item) => [item.category, item.date, item.text, item.source].filter(Boolean).join('|')).join('\n'), 'textarea');
    const plan = inputField('③ 下周工作计划（每行一项：内容|来源，可省略来源）', (content.next_week_plan || []).map((item) => [item.text, item.source].filter(Boolean).join('|')).join('\n'), 'textarea');
    const risks = inputField('④ 问题风险与阻塞（每行一项：内容|来源，可省略来源）', (content.risks || []).map((item) => [item.text, item.source].filter(Boolean).join('|')).join('\n'), 'textarea');
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
   * 轮询周报生成任务到终态。成功后刷新面板；失败展示错误卡片 + alertDialog + 「再次生成」入口。
   * 返回最终 job（超时返回 null）。
   */
  async function pollWeeklyJob(panel, customer, weekStart, jobId) {
    const notice = panel.querySelector('.weekly-notice');
    for (let attempt = 0; attempt < 90; attempt++) {
      const data = await api(`/api/draft-jobs?ids=${encodeURIComponent(jobId)}`);
      const job = (data.jobs || [])[0];
      if (!job) throw new Error('生成任务不存在');
      if (notice) notice.textContent = `周报生成中…（${job.status === 'running' ? '模型撰写中' : '排队中'}）`;
      if (job.status === 'succeeded') {
        if (notice) notice.remove();
        await refreshWeeklyPanel(panel, customer, weekStart);
        return job;
      }
      if (job.status === 'failed') {
        if (notice) notice.remove();
        renderWeeklyFailure(panel, customer, weekStart, job);
        await alertDialog(`周报生成失败：${job.error || '未知原因'}\n\n可点击「再次生成」重试。`);
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (notice) notice.textContent = '生成超时，任务仍在后台运行；稍后切换周可查看结果。';
    return null;
  }

  function renderWeeklyFailure(panel, customer, weekStart, job) {
    const host = panel.querySelector('.weekly-body');
    host.innerHTML = '';
    const card = el('div', 'weekly-failure');
    card.append(el('strong', null, `周报生成失败（${formatDateTime(job.updatedAt)}）`));
    card.append(el('p', null, job.error || '未知原因'));
    const retry = el('button', 'primary-command small', '再次生成');
    withLoading(retry, '重新生成中…', async () => {
      try {
        const result = await api(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekStart, force: true }) });
        if (!result.jobId) { await refreshWeeklyPanel(panel, customer, weekStart); return; }
        renderWeeklyBody(panel, customer, weekStart);
        const notice = panel.querySelector('.weekly-notice');
        if (notice) notice.textContent = '周报生成中…（排队中）';
        await pollWeeklyJob(panel, customer, weekStart, result.jobId);
      } catch (error) { await alertDialog(error.message); }
    });
    card.append(retry);
    host.append(card);
  }

  async function refreshWeeklyPanel(panel, customer, weekStart) {
    const host = panel.querySelector('.weekly-body');
    host.innerHTML = '';
    host.append(el('div', 'cell-sub', '加载周报中…'));
    try { await renderWeeklyReport(panel, customer, weekStart); }
    catch (error) { host.innerHTML = ''; host.append(el('div', 'workspace-empty', error.message)); }
  }

  async function renderWeeklyReport(panel, customer, weekStart) {
    const data = await api(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`);
    const report = (data.reports || []).find((item) => item.weekStart === weekStart);
    const host = panel.querySelector('.weekly-body');
    host.innerHTML = '';
    if (!report) {
      host.append(el('div', 'workspace-empty', `${weekStart} 这一周尚未生成周报；点击「生成周报」基于该客户本周全部数据创建。`));
      return;
    }
    const statsLine = weeklyStatsLine(report.stats);
    const card = el('article', 'weekly-report-card');
    const head = el('div', 'weekly-report-head');
    const statusBadge = report.status === 'published' ? badge('已发布', 'success') : badge(`草稿 v${report.version}`, 'warning');
    head.append(el('strong', null, `${report.weekStart} ~ ${report.weekEnd} 实施周报`), statusBadge);
    card.append(head);
    if (statsLine) card.append(el('div', 'weekly-stats', statsLine));
    card.append(sectionBlock('① 本周执行摘要', el('p', 'weekly-section', report.content.summary || '（空）')));
    const accomplishments = el('ul', 'weekly-list');
    for (const item of report.content.accomplishments || []) {
      const li = el('li', null, `${item.date ? `${item.date} ` : ''}[${item.category}] ${item.text}${item.source ? `（${item.source}）` : ''}`);
      accomplishments.append(li);
    }
    if (!(report.content.accomplishments || []).length) accomplishments.append(el('li', null, '（无条目）'));
    card.append(sectionBlock('② 本周完成情况', accomplishments));
    const plan = el('ol', 'weekly-list');
    for (const item of report.content.next_week_plan || []) plan.append(el('li', null, `${item.text}${item.source ? `（${item.source}）` : ''}`));
    if (!(report.content.next_week_plan || []).length) plan.append(el('li', null, '（无条目）'));
    card.append(sectionBlock('③ 下周工作计划', plan));
    const risks = el('ul', 'weekly-list');
    for (const item of report.content.risks || []) risks.append(el('li', null, `${item.text}${item.source ? `（${item.source}）` : ''}`));
    if (!(report.content.risks || []).length) risks.append(el('li', null, '（无条目）'));
    card.append(sectionBlock('④ 问题风险与阻塞', risks));
    if (report.publishedPageId) card.append(el('div', 'cell-sub', `已发布到 ONES Wiki 页面 ${report.publishedPageId}`));
    const buttons = el('div', 'row-actions');
    if (report.status === 'draft') {
      const edit = el('button', 'quiet-command small', '编辑');
      edit.onclick = () => editWeeklyReport(customer, report, () => refreshWeeklyPanel(panel, customer, weekStart));
      buttons.append(edit);
    }
    const copy = el('button', 'quiet-command small', '复制 Markdown');
    copy.onclick = async () => {
      const lines = [`# ${customer.name} 实施周报（${report.weekStart} ~ ${report.weekEnd}）`, '',
        '## 一、本周执行摘要', '', report.content.summary || '', '',
        statsLine ? `> ${statsLine}` : '', '',
        '## 二、本周完成情况', '',
        ...(report.content.accomplishments || []).map((item) => `- [${item.category}]${item.date ? ` ${item.date}` : ''} ${item.text}${item.source ? `（${item.source}）` : ''}`), '',
        '## 三、下周工作计划', '',
        ...(report.content.next_week_plan || []).map((item, index) => `${index + 1}. ${item.text}${item.source ? `（${item.source}）` : ''}`), '',
        '## 四、问题风险与阻塞', '',
        ...(report.content.risks || []).map((item) => `- ${item.text}${item.source ? `（${item.source}）` : ''}`)];
      try { await navigator.clipboard.writeText(lines.join('\n')); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制 Markdown'; }, 1500); }
      catch (error) { await alertDialog(`复制失败：${error.message}`); }
    };
    if (report.status === 'draft') {
      const publish = el('button', 'primary-command small', '发布到 Wiki');
      withLoading(publish, '发布中…', async () => {
        try {
          const target = await pickWikiPage();
          if (!target) return;
          const preview = await api(`/api/weekly-reports/${report.id}/publish-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPageID: target.pageID }) });
          if (!await confirmDialog(`确认将 ${report.weekStart} 周报发布到 ONES Wiki「${target.title}」下？\n\n${preview.args.content.slice(0, 800)}`)) return;
          await api(`/api/weekly-reports/${report.id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: report.version, parentPageID: target.pageID, approvalHash: preview.approvalHash }) });
          await refreshWeeklyPanel(panel, customer, weekStart);
        } catch (error) { await alertDialog(error.message); }
      });
      buttons.append(publish);
      const regenerate = el('button', 'quiet-command small', '重新生成');
      withLoading(regenerate, '重新生成中…', async () => {
        try {
          const result = await api(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekStart, force: true }) });
          renderWeeklyBody(panel, customer, weekStart);
          const notice = panel.querySelector('.weekly-notice');
          if (notice) notice.textContent = '周报生成中…（排队中）';
          if (result.jobId) await pollWeeklyJob(panel, customer, weekStart, result.jobId);
        } catch (error) { await alertDialog(error.message); }
      });
      buttons.append(regenerate);
    }
    buttons.append(copy);
    card.append(buttons);
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
      try {
        notice.classList.remove('hidden');
        notice.textContent = '周报生成中…（排队中）';
        const result = await api(`/api/customers/${encodeURIComponent(customer.id)}/weekly-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekStart }) });
        if (!result.jobId) {
          notice.classList.add('hidden');
          await refreshWeeklyPanel(panel, customer, weekStart);
          return;
        }
        renderWeeklyBody(panel, customer, weekStart);
        notice.classList.remove('hidden');
        notice.textContent = '周报生成中…（排队中）';
        await pollWeeklyJob(panel, customer, weekStart, result.jobId);
      } catch (error) {
        notice.classList.add('hidden');
        await alertDialog(error.message);
      }
    });
    renderWeeklyBody(panel, customer, currentWeek());
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
    const refresh = el('button', 'quiet-command', '刷新三套系统');
    refresh.onclick = async () => { const run = await api(`/api/customers/${encodeURIComponent(customerId)}/refresh`, { method: 'POST' }); await pollSync(run.id); await openCustomer(customerId); };
    const generate = el('button', 'primary-command', '生成案例草稿');
    generate.onclick = async () => { try { const draft = await api('/api/case-drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId }) }); editCase(draft); } catch (error) { await alertDialog(error.message); } };
    const ask = el('button', 'quiet-command', '询问 Agent');
    ask.onclick = async () => {
      try {
        await ensureCustomerSession(c);
      } catch (error) { await alertDialog(error.message); return; }
      showView('agent');
      inputEl.value = `结合工作台已同步数据与最近三个月的公开动态，分析「${c.name}」的续约风险、增购机会和下一步行动`;
      inputEl.focus();
    };
    commands.append(refresh, generate, ask); head.append(title, commands); customerOverview.append(head);

    const summary = el('div', 'definition-grid');
    summary.append(definition('续约日期', formatDate(c.renewalDate)), definition('合同价值', formatMoney(c.contractValue)),
      definition('使用版本', c.usageVersion || 'unknown'), definition('最后互动', formatDate(data.lastInteractionAt ?? c.lastContactAt)), definition('数据同步', formatDateTime(c.syncedAt)));
    customerOverview.append(summary);

    const opportunities = el('div', 'opportunity-grid');
    if (!(data.opportunities || []).length) opportunities.append(el('div', 'workspace-empty', '暂无满足双证据条件的增购假设'));
    for (const item of data.opportunities || []) {
      const card = el('article', 'opportunity-card');
      card.append(el('strong', null, item.title), el('p', null, item.detail), el('div', 'cell-sub', `置信度 ${Math.round(item.confidence * 100)}%`), el('div', 'recommended', item.recommendedAction));
      opportunities.append(card);
    }
    const actions = el('div', 'action-board');
    if (!(data.actions || []).length) actions.append(el('div', 'workspace-empty', '暂无行动事项'));
    for (const action of data.actions || []) actions.append(actionCard(action, true));

    const drafts = el('div', 'case-list');
    if (!(data.caseDrafts || []).length) drafts.append(el('div', 'workspace-empty', data.caseCandidate?.eligible ? '已识别为案例候选，尚未生成草稿' : '尚未满足案例候选条件'));
    for (const draft of data.caseDrafts || []) drafts.append(caseCard(draft));

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
    overview.append(sectionBlock('续约风险', renderRisk(data.risk)), sectionBlock('增购机会', opportunities), sectionBlock('数据概览', renderOnesSources(timeline)));
    addTab('overview', '概览', overview);
    addTab('suggestion_feedback', '建议', renderOnesWorkItems(timeline, 'suggestion_feedback'), draftCommand(c, 'suggestion_feedback', timeline, data.identities));
    addTab('support_ticket', '工单', renderOnesWorkItems(timeline, 'support_ticket'), draftCommand(c, 'support_ticket', timeline, data.identities));
    addTab('operations_ticket', '运维', renderOnesWorkItems(timeline, 'operations_ticket'), draftCommand(c, 'operations_ticket', timeline, data.identities));
    addTab('customer_manhour', '工时', renderWorkhours(timeline, workhoursData), draftCommand(c, 'customer_manhour', timeline, data.identities));
    addTab('private_cloud_instance', '私有云实例', renderBusinessRecords(timeline, 'private_cloud_instance'), draftCommand(c, 'private_cloud_instance', timeline, data.identities));
    addTab('followup', '跟进记录', renderFollowups(timeline), draftCommand(c, 'followup', timeline, data.identities));
    addTab('hemory_fragments', 'Hemory 片段', buildCustomerHemoryPanel(c, hemoryFragmentsData.fragments || []));
    const casePanel = el('div');
    const caseCommands = el('div', 'row-actions');
    caseCommands.append(draftCommand(c, 'case', timeline, data.identities));
    const structuredCase = el('button', 'quiet-command small', '生成结构化案例草稿');
    structuredCase.onclick = () => generate.onclick();
    caseCommands.append(structuredCase);
    casePanel.append(caseCommands, drafts);
    addTab('cases', '客户案例', casePanel);
    addTab('weekly_report', '实施周报', buildWeeklyPanel(c));
    addTab('actions', '行动事项', actions);
    addTab('timeline', '统一时间线', renderTimeline(timeline));
    customerOverview.append(tabBar, tabBody);
    tabs[0].button.click();
  }

  async function loadActions() {
    const data = await api('/api/action-items');
    const actions = data.actions || [];
    actionNavCount.textContent = actions.filter((a) => !['completed', 'false_positive'].includes(a.status)).length || '';
    actionBoard.innerHTML = '';
    if (!actions.length) actionBoard.append(el('div', 'workspace-empty', '暂无待处理行动'));
    for (const action of actions) actionBoard.append(actionCard(action, false));
  }

  function caseCard(draft) {
    const card = el('article', 'case-card-item');
    card.append(el('strong', null, draft.title), el('div', 'cell-sub', `${draft.status === 'published' ? '已发布' : `草稿 v${draft.version}`} · ${formatDateTime(draft.updatedAt)}`));
    const buttons = el('div', 'row-actions');
    if (draft.status === 'draft') { const edit = el('button', 'quiet-command small', '编辑'); edit.onclick = () => editCase(draft); buttons.append(edit); }
    if (draft.publishedPageId) buttons.append(badge(`ONES ${draft.publishedPageId}`, 'success'));
    card.append(buttons);
    return card;
  }

  async function loadCases() {
    const data = await api('/api/case-drafts');
    caseList.innerHTML = '';
    if (!(data.drafts || []).length) caseList.append(el('div', 'workspace-empty', '暂无案例草稿'));
    for (const draft of data.drafts || []) caseList.append(caseCard(draft));
  }

  function editCase(draft) {
    openWorkbenchModal('编辑客户案例');
    const title = inputField('案例标题', draft.title);
    const fields = draft.fields || {};
    const background = inputField('客户背景', fields.background, 'textarea');
    const pain = inputField('业务痛点（每行一项）', (fields.pain_points || []).join('\n'), 'textarea');
    const solution = inputField('解决方案', fields.solution, 'textarea');
    const implementation = inputField('实施过程', fields.implementation, 'textarea');
    const results = inputField('成果（每行一项）', (fields.results || []).map((item) => typeof item === 'string' ? item : `${item.metric || ''}: ${item.value || ''}`).join('\n'), 'textarea');
    const quote = inputField('客户原话', fields.customer_quote, 'textarea');
    const lessons = inputField('可复用经验（每行一项）', (fields.reusable_lessons || []).join('\n'), 'textarea');
    const redaction = inputField('脱敏检查', fields.redaction_review, 'textarea');
    const actions = el('div', 'row-actions');
    const save = el('button', 'primary-command', '保存草稿');
    const publish = el('button', 'quiet-command', '预览并发布');
    async function saveDraft() {
      return api(`/api/case-drafts/${draft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        version: draft.version, title: title.input.value.trim(), fields: { ...fields, background: background.input.value.trim(),
          pain_points: pain.input.value.split('\n').map((x) => x.trim()).filter(Boolean), solution: solution.input.value.trim(),
          implementation: implementation.input.value.trim(), results: results.input.value.split('\n').map((x) => x.trim()).filter(Boolean),
          customer_quote: quote.input.value.trim(), reusable_lessons: lessons.input.value.split('\n').map((x) => x.trim()).filter(Boolean), redaction_review: redaction.input.value.trim() },
      }) });
    }
    save.onclick = async () => { draft = await saveDraft(); closeWorkbenchModal(); activeCustomerId ? openCustomer(activeCustomerId) : loadCases(); };
    publish.onclick = async () => {
      try {
        draft = await saveDraft();
        const target = await pickWikiPage();
        if (!target) return;
        const parentPageID = target.pageID;
        const preview = await api(`/api/case-drafts/${draft.id}/publish-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPageID }) });
        if (!await confirmDialog(`确认将“${draft.title}”发布到 ONES Wiki「${target.title}」下？\n\n${preview.args.content.slice(0, 800)}`)) return;
        draft = await api(`/api/case-drafts/${draft.id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: draft.version, parentPageID, approvalHash: preview.approvalHash }) });
        closeWorkbenchModal(); activeCustomerId ? openCustomer(activeCustomerId) : loadCases();
      } catch (error) { await alertDialog(error.message); }
    };
    actions.append(save, publish);
    workbenchModalBody.append(title.field, background.field, pain.field, solution.field, implementation.field, results.field, quote.field, lessons.field, redaction.field, actions);
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

  // ── composer ───────────────────────────────────────────────────

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = inputEl.value.trim();
    if (!text || busy || !sessionId) return;
    inputEl.value = '';
    busy = true;
    sendEl.disabled = true;
    inputEl.disabled = true;
    setThinking(true);
    try {
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
    } catch (err) {
      busy = false;
      sendEl.disabled = false;
      inputEl.disabled = false;
      setThinking(false);
      addMessage('assistant', '发送失败: ' + err.message);
    }
  });

  newSessionBtn.addEventListener('click', newSession);
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
    ['custom', '自定义（OpenAI 兼容）'],
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
    await Promise.all([loadPortfolio(), loadActions(), loadCases(), loadHemoryInbox(), loadDraftBatches()]);
    showView('portfolio');
  }

  init().catch((err) => setStatus('warn', '启动失败: ' + err.message));
})();
