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
  const hemoryDate = document.getElementById('hemoryDate');
  const hemoryStatus = document.getElementById('hemoryStatus');
  const hemoryCustomer = document.getElementById('hemoryCustomer');
  const hemoryCustomerOptions = document.getElementById('hemoryCustomerOptions');
  const hemoryFragmentList = document.getElementById('hemoryFragmentList');
  const draftBatchList = document.getElementById('draftBatchList');
  const globalSync = document.getElementById('globalSync');
  const customerSearch = document.getElementById('customerSearch');
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
  let es = null;
  let busy = false;
  let maxSeq = 0;
  let mcpFailures = [];

  function setStatus(cls, text) {
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
    statusEl.lastChild.textContent = text;
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
  const SOURCE_TYPE_LABEL = {
    customer_snapshot: 'CRM 客户资料',
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
      const res = await fetch('/api/sessions');
      const data = await res.json();
      renderSessionList(data.sessions || []);
    } catch (_) { /* ignore */ }
  }

  function renderSessionList(sessions) {
    sessionListEl.innerHTML = '';
    for (const s of sessions) {
      const item = el('div', 'session-item' + (s.id === sessionId ? ' active' : ''));
      const t = el('span', 't', s.title || '新对话');
      const ops = el('span', 'ops');
      const rename = el('button', 'ren', '✎');
      const del = el('button', 'del', '✕');
      rename.onclick = (ev) => { ev.stopPropagation(); renameSession(s.id, s.title); };
      del.onclick = (ev) => { ev.stopPropagation(); deleteSession(s.id); };
      ops.append(rename, del);
      item.append(t, ops);
      item.onclick = () => switchSession(s.id);
      sessionListEl.appendChild(item);
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
    clearMessages();
    connectEvents(id);
    renderSessionList(await (await fetch('/api/sessions')).json().then((d) => d.sessions));
    setStatus(mcpFailures.length ? 'warn' : 'ok', mcpFailures.length ? '部分系统未连接: ' + mcpFailures.map(([n]) => n).join(', ') : '就绪');
  }

  async function newSession() {
    const res = await fetch('/api/sessions', { method: 'POST' });
    const data = await res.json();
    await switchSession(data.id);
    loadSessions();
  }

  async function renameSession(id, oldTitle) {
    const title = prompt('会话名称：', oldTitle || '');
    if (title === null || !title.trim()) return;
    await fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    loadSessions();
  }

  async function deleteSession(id) {
    if (!confirm('删除该会话？此操作不可恢复。')) return;
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (id === sessionId) {
      await newSession();
    } else {
      loadSessions();
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

  async function loadLlmConfigUI() {
    try {
      const res = await fetch('/api/config/llm');
      const data = await res.json();
      llmProvider.value = data.provider || 'deepseek';
      llmModel.value = data.model || '';
      llmKey.value = '';
      llmKey.placeholder = data.apiKeyConfigured
        ? '已设置（留空则不修改）'
        : 'sk-... 或用 ${ENV_VAR}';
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '加载失败: ' + err.message;
    }
  }

  settingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    loadLlmConfigUI();
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
        results.push('模型: ' + llmData.provider + '/' + llmData.model + ' 已生效');
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

  function chinaDate() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  async function ensureCustomerOptions() {
    if (!customersCache.length) customersCache = (await api('/api/customers')).customers || [];
    hemoryCustomerOptions.innerHTML = '';
    for (const customer of customersCache) {
      const option = document.createElement('option');
      option.value = `${customer.name} (${customer.id})`;
      hemoryCustomerOptions.append(option);
    }
  }

  function selectedHemoryFragments() {
    return [...hemoryFragmentList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.dataset.eventId);
  }

  async function loadHemoryInbox() {
    await ensureCustomerOptions();
    const params = new URLSearchParams({ status: hemoryStatus.value, limit: '500' });
    if (hemoryDate.value) params.set('date', hemoryDate.value);
    const data = await api(`/api/hemory/fragments?${params}`);
    const fragments = data.fragments || [];
    if (hemoryStatus.value === 'pending') hemoryPendingCount.textContent = fragments.length || '';
    hemoryFragmentList.innerHTML = '';
    if (!fragments.length) {
      hemoryFragmentList.append(el('div', 'workspace-empty', hemoryStatus.value === 'pending' ? '当前没有待归属片段' : '没有符合条件的 Hemory 片段'));
      return;
    }
    let recording = '';
    for (const fragment of fragments) {
      const recordingId = fragment.payload?.recordingId || 'unknown';
      if (recordingId !== recording) {
        recording = recordingId;
        hemoryFragmentList.append(el('div', 'fragment-group-title', `录音 ${recordingId}`));
      }
      const row = el('label', 'hemory-fragment');
      const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.eventId = fragment.id; check.dataset.payloadHash = fragment.payloadHash;
      const body = el('div', 'fragment-body');
      const head = el('div', 'fragment-head');
      head.append(el('strong', null, fragment.payload?.topic || fragment.title), badge(fragment.attributionStatus === 'confirmed' ? '已归属' : fragment.attributionStatus === 'ambiguous' ? '有歧义' : '待归属', fragment.attributionStatus === 'confirmed' ? 'success' : 'warning'));
      const evidence = document.createElement('details');
      evidence.className = 'fragment-evidence';
      evidence.append(el('summary', null, '查看原文证据'), el('pre', null, fragment.payload?.transcript || '无原文'));
      const speakers = Array.isArray(fragment.payload?.speakers) && fragment.payload.speakers.length ? fragment.payload.speakers.join('、') : '发言人未知';
      body.append(head, el('p', null, fragment.payload?.summary || fragment.title), evidence,
        el('div', 'cell-sub', `${formatDateTime(fragment.payload?.startAt || fragment.occurredAt)} - ${formatDateTime(fragment.payload?.endAt || fragment.occurredAt)} · ${speakers} · ${fragment.customerId ? `CRM ${fragment.customerId}` : '未绑定客户'} · ${fragment.id}`));
      row.append(check, body); hemoryFragmentList.append(row);
    }
  }

  async function updateHemoryAttribution(clear) {
    const eventIds = selectedHemoryFragments();
    if (!eventIds.length) return alert('请先选择片段');
    let customerId = null;
    if (!clear) {
      const input = hemoryCustomer.value.trim();
      const customer = customersCache.find((item) => input === `${item.name} (${item.id})` || input === item.id || input === item.name);
      if (!customer) return alert('请选择一个唯一的 CRM 客户');
      customerId = customer.id;
    }
    const expectedHashes = Object.fromEntries([...hemoryFragmentList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => [input.dataset.eventId, input.dataset.payloadHash]));
    await api('/api/hemory/fragments/attribution', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventIds, customerId, expectedHashes }) });
    await Promise.all([loadHemoryInbox(), loadDraftBatches()]);
  }

  function draftTypeLabel(type) {
    return { internal_todo: 'Agent 待办', workhour: '工时', followup: '沟通记录', suggestion: '需求', ticket: '工单' }[type] || type;
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
      } catch (error) { alert(error.message); }
    };
    workbenchModalBody.append(title.field, summary.field, fields.field, tool.field, args.field, unknowns.field, save);
  }

  async function confirmDraftBatch(batch, container) {
    const itemIds = [...container.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.dataset.itemId);
    if (!itemIds.length) return alert('请选择要确认的草稿');
    try {
      const preview = await api(`/api/draft-batches/${batch.id}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds }) });
      const invalid = preview.items.filter((item) => item.validationErrors?.length);
      if (invalid.length) return alert(invalid.map((item) => `${item.id}: ${item.validationErrors.join('；')}`).join('\n'));
      if (!confirm(`确认逐项执行 ${preview.items.length} 份草稿？成功项不会因其他项失败而回滚。`)) return;
      await api(`/api/draft-batches/${batch.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        items: preview.items.map(({ id, version, approvalHash }) => ({ id, version, approvalHash })),
      }) });
      await Promise.all([loadDraftBatches(), loadActions()]);
    } catch (error) { alert(error.message); }
  }

  async function loadDraftBatches() {
    const data = await api('/api/draft-batches');
    const batches = data.batches || [];
    const pending = batches.flatMap((batch) => batch.items || []).filter((item) => !['written', 'dismissed', 'stale'].includes(item.status)).length;
    draftPendingCount.textContent = pending || '';
    draftBatchList.innerHTML = '';
    if (!batches.length) return draftBatchList.append(el('div', 'workspace-empty', '还没有 Hemory 草稿'));
    for (const batch of batches) {
      const section = el('section', 'draft-batch');
      const head = el('div', 'draft-batch-head');
      const customer = customersCache.find((item) => item.id === batch.customerId);
      const title = el('div'); title.append(el('strong', null, customer?.name || batch.customerId), el('div', 'cell-sub', `${formatDateTime(batch.updatedAt)} · ${batch.generator} · ${batch.status}`));
      const confirmButton = el('button', 'primary-command small', '确认所选草稿');
      confirmButton.onclick = () => confirmDraftBatch(batch, section);
      head.append(title, confirmButton); section.append(head);
      for (const item of batch.items || []) {
        const row = el('article', 'draft-item');
        const selector = document.createElement('input'); selector.type = 'checkbox'; selector.dataset.itemId = item.id;
        selector.disabled = ['written', 'dismissed', 'stale', 'writing'].includes(item.status);
        const body = el('div', 'draft-item-body');
        const itemHead = el('div', 'draft-item-head'); itemHead.append(badge(draftTypeLabel(item.type), 'accent'), el('strong', null, item.title), badge(item.status, item.status === 'written' ? 'success' : item.status === 'failed' ? 'risk-high' : 'warning'));
        body.append(itemHead, el('p', null, item.summary));
        if (item.validationErrors?.length) body.append(el('div', 'draft-errors', item.validationErrors.join('；')));
        if (item.error) body.append(el('div', 'draft-errors', item.error));
        const actions = el('div', 'row-actions');
        if (!['written', 'dismissed', 'stale', 'writing'].includes(item.status)) { const edit = el('button', 'quiet-command small', '编辑'); edit.onclick = () => editableDraft(item); actions.append(edit); }
        if (item.status === 'failed') { const retry = el('button', 'quiet-command small', '重试'); retry.onclick = async () => { try { await api(`/api/draft-items/${item.id}/retry`, { method: 'POST' }); await loadDraftBatches(); } catch (error) { alert(error.message); } }; actions.append(retry); }
        if (item.result?.actionItemId) { const open = el('button', 'quiet-command small', '打开 Agent 待办'); open.onclick = () => showView('actions'); actions.append(open); }
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
  hemoryDate.value = chinaDate();
  hemoryStatus.onchange = () => void loadHemoryInbox();
  hemoryDate.onchange = () => void loadHemoryInbox();
  document.getElementById('hemoryAssign').onclick = () => void updateHemoryAttribution(false);
  document.getElementById('hemoryClear').onclick = () => void updateHemoryAttribution(true);
  document.getElementById('refreshDrafts').onclick = () => void loadDraftBatches();
  document.getElementById('hemorySync').onclick = async () => {
    try { const run = await api('/api/hemory/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: hemoryDate.value || chinaDate() }) }); await pollSync(run.id); await loadHemoryInbox(); }
    catch (error) { alert(error.message); }
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
    const data = await api(`/api/customers?q=${encodeURIComponent(customerSearch.value.trim())}`);
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
      card.append(el('span', null, key), el('strong', null, item.known ? `${item.score}/${item.weight}` : 'unknown'), el('small', null, item.reason));
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

  function renderMeetings(events) {
    const meetings = events.filter((event) => event.sourceSystem === 'hemory' && event.sourceType === 'ai_topic_segment');
    if (!meetings.length) return el('div', 'workspace-empty', '暂无已确认归属的会议沟通记录');
    const list = el('div', 'meeting-list');
    for (const event of meetings.slice(0, 12)) {
      const item = el('article', 'meeting-record');
      item.append(el('strong', null, event.title), el('p', null, event.payload?.summary || ''),
        el('div', 'cell-sub', `${formatDateTime(event.payload?.startAt || event.occurredAt)} · ${(event.payload?.speakers || []).join('、') || '发言人未知'}`));
      list.append(item);
    }
    return list;
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
      item.append(head, el('div', 'cell-sub', `发生 ${formatDateTime(event.occurredAt)} · 同步 ${formatDateTime(event.syncedAt)} · 置信度 ${Math.round((event.confidence || 0) * 100)}%`));
      if (sourceType === 'customer_manhour') {
        const registered = Number(event.payload?.field019 || 0) / 100000;
        const remaining = Number(event.payload?.field020 || 0) / 100000;
        item.append(el('div', 'record-facts', `已登记 ${registered.toFixed(1)} 小时 · 剩余 ${remaining.toFixed(1)} 小时`));
      }
      item.append(el('div', 'evidence-id', `证据 ${event.id}`));
      list.append(item);
    }
    return list;
  }

  function renderFollowups(customer, events) {
    const records = events.filter((event) => event.sourceSystem === 'crm' && event.sourceType === 'followup');
    const list = el('div', 'business-record-list');
    if (customer.nextAction) {
      const current = el('article', 'business-record');
      current.append(el('strong', null, '当前跟进'), el('p', null, customer.nextAction), el('div', 'cell-sub', `最后互动 ${formatDateTime(customer.lastContactAt)}`));
      list.append(current);
    }
    for (const event of records) {
      const item = el('article', 'business-record');
      item.append(el('strong', null, event.title), el('div', 'cell-sub', formatDateTime(event.occurredAt)));
      list.append(item);
    }
    return list.childElementCount ? list : el('div', 'workspace-empty', '暂无已同步跟进记录');
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
      ? `ONES projectID=${target.projectId}，issueTypeID=${target.issueTypeId}。新建前调用 get_issue_fields；fieldValues 必须包含 {"fieldID":"JrvswW8P","value":"${option?.external_id || ''}"}。`
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
    button.onclick = () => startAgentDraft(customer, targetKey, timeline, identities).catch((error) => alert(error.message));
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
        } catch (error) { alert(error.message); }
      };
      const complete = el('button', 'quiet-command small', '完成');
      complete.onclick = async () => { const outcome = prompt('记录实际结果：', '') || ''; await api(`/api/action-items/${action.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) }); customerMode ? openCustomer(action.customerId) : loadActions(); };
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

  async function openCustomer(customerId) {
    activeCustomerId = customerId;
    activeView = 'customer';
    workbench.classList.remove('hidden'); chatView.classList.add('hidden'); document.getElementById('records').classList.add('hidden'); footerEl.classList.add('hidden'); agentSessions.classList.add('hidden');
    for (const [name, section] of Object.entries(viewSections)) section.classList.toggle('hidden', name !== 'customer');
    const data = await api(`/api/customers/${encodeURIComponent(customerId)}/overview`);
    const c = data.customer;
    const timeline = data.timeline || [];
    customerOverview.innerHTML = '';
    const head = el('div', 'customer-detail-head');
    const title = el('div'); title.append(el('h1', null, c.name), el('p', null, [c.shortName, c.industry, c.csmName && `CSM ${c.csmName}`].filter(Boolean).join(' · ')));
    const commands = el('div', 'row-actions');
    const refresh = el('button', 'quiet-command', '刷新三套系统');
    refresh.onclick = async () => { const run = await api(`/api/customers/${encodeURIComponent(customerId)}/refresh`, { method: 'POST' }); await pollSync(run.id); await openCustomer(customerId); };
    const generate = el('button', 'primary-command', '生成案例草稿');
    generate.onclick = async () => { try { const draft = await api('/api/case-drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId }) }); editCase(draft); } catch (error) { alert(error.message); } };
    const ask = el('button', 'quiet-command', '询问 Agent');
    ask.onclick = () => { showView('agent'); inputEl.value = `基于已同步上下文分析「${c.name}」的续约风险、增购机会和下一步行动`; inputEl.focus(); };
    commands.append(refresh, generate, ask); head.append(title, commands); customerOverview.append(head);

    const summary = el('div', 'definition-grid');
    summary.append(definition('续约日期', formatDate(c.renewalDate)), definition('合同价值', formatMoney(c.contractValue)), definition('产品', (c.products || []).join('、')),
      definition('最后互动', formatDate(c.lastContactAt)), definition('合同状态', c.contractStatus), definition('数据同步', formatDateTime(c.syncedAt)));
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
    addTab('suggestion_feedback', '建议', renderBusinessRecords(timeline, 'suggestion_feedback'), draftCommand(c, 'suggestion_feedback', timeline, data.identities));
    addTab('support_ticket', '工单', renderBusinessRecords(timeline, 'support_ticket'), draftCommand(c, 'support_ticket', timeline, data.identities));
    addTab('operations_ticket', '运维', renderBusinessRecords(timeline, 'operations_ticket'), draftCommand(c, 'operations_ticket', timeline, data.identities));
    addTab('customer_manhour', '工时', renderBusinessRecords(timeline, 'customer_manhour'), draftCommand(c, 'customer_manhour', timeline, data.identities));
    addTab('private_cloud_instance', '私有云实例', renderBusinessRecords(timeline, 'private_cloud_instance'), draftCommand(c, 'private_cloud_instance', timeline, data.identities));
    addTab('followup', '跟进记录', renderFollowups(c, timeline), draftCommand(c, 'followup', timeline, data.identities));
    addTab('meetings', '会议沟通', renderMeetings(timeline));
    const casePanel = el('div');
    const caseCommands = el('div', 'row-actions');
    caseCommands.append(draftCommand(c, 'case', timeline, data.identities));
    const structuredCase = el('button', 'quiet-command small', '生成结构化案例草稿');
    structuredCase.onclick = () => generate.onclick();
    caseCommands.append(structuredCase);
    casePanel.append(caseCommands, drafts);
    addTab('cases', '客户案例', casePanel);
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
        const parentPageID = prompt('ONES 案例库父页面 ID：', '') || '';
        if (!parentPageID) return;
        const preview = await api(`/api/case-drafts/${draft.id}/publish-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPageID }) });
        if (!confirm(`确认将“${draft.title}”写入 ONES Wiki？\n\n${preview.args.content.slice(0, 800)}`)) return;
        draft = await api(`/api/case-drafts/${draft.id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: draft.version, parentPageID, approvalHash: preview.approvalHash }) });
        closeWorkbenchModal(); activeCustomerId ? openCustomer(activeCustomerId) : loadCases();
      } catch (error) { alert(error.message); }
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

  // ── boot ───────────────────────────────────────────────────────

  const PROVIDERS = [
    ['deepseek', 'DeepSeek'],
    ['openai', 'OpenAI'],
    ['anthropic', 'Anthropic (Claude)'],
    ['moonshotai', 'Moonshot (Kimi)'],
    ['groq', 'Groq'],
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
