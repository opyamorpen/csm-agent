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
    card.append(
      el('h3', null, '待确认草稿'),
      el('div', 'meta', `目标系统: ${draft.target_system} ｜ 对象: ${draft.target_object} ｜ 类型: ${draft.record_type}`),
      el('div', 'summary', `标题: ${draft.title || '(无)'}`),
      el('div', 'summary', `摘要: ${draft.summary || '(无)'}`),
      el('pre', null, JSON.stringify(draft.fields ?? {}, null, 2)),
    );
    const actions = el('div', 'actions');
    const okBtn = el('button', 'approve', '批准写入');
    const noBtn = el('button', 'reject', '拒绝');
    const decide = async (approve) => {
      okBtn.disabled = noBtn.disabled = true;
      try {
        await fetch(`/api/sessions/${sessionId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve }),
        });
        actions.replaceWith(el('div', 'decided', approve ? '已批准，正在写入…' : '已拒绝'));
        loadRecords();
      } catch (err) {
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

  function normalizeServer(s) {
    return {
      name: s.name ?? '',
      transport: s.transport === 'stdio' ? 'stdio' : 'streamable-http',
      command: s.command ?? '',
      args: (s.args ?? []).join(' '),
      env: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      url: s.url ?? '',
      authorization: (s.headers && s.headers.Authorization) || '',
      writeToolPatterns: (s.writeToolPatterns ?? []).join(', '),
    };
  }

  function renderServerEditor(server, failures) {
    const box = el('div', 'server-editor');
    const head = el('div', 'ed-head');
    const title = el('div', 'title', server.name || '(未命名)');
    const remove = el('button', 'remove', '删除');
    head.append(title, remove);
    box.append(head);

    const row1 = el('div', 'row');
    const nameF = field('名称（serverName）'); nameF.append(makeInput('js-name', server.name, '例如 crm'));
    const transF = field('传输方式'); transF.append(makeSelect('js-transport',
      [{ value: 'stdio', label: 'stdio（本地命令/npx）' }, { value: 'streamable-http', label: 'streamable-http（远程 URL）' }], server.transport));
    row1.append(nameF, transF);
    box.append(row1);

    const httpRow = el('div', 'row js-http');
    const urlF = field('URL'); urlF.append(makeInput('js-url', server.url, 'https://.../mcp'));
    const authF = field('Authorization（可用 ${ENV_VAR}）'); authF.append(makeInput('js-auth', server.authorization, 'Bearer ${CRM_MCP_TOKEN}'));
    httpRow.append(urlF, authF);
    box.append(httpRow);

    const stdioRow = el('div', 'row js-stdio');
    const cmdF = field('命令'); cmdF.append(makeInput('js-command', server.command, 'npx'));
    const argsF = field('参数（空格分隔）'); argsF.append(makeInput('js-args', server.args, '-y mcp-remote https://...'));
    stdioRow.append(cmdF, argsF);
    box.append(stdioRow);

    const envRow = el('div', 'row js-stdio');
    const envF = field('环境变量（每行 KEY=VALUE）'); envF.append(makeTextarea('js-env', server.env, 'ONES_MCP_TOKEN=${ONES_MCP_TOKEN}'));
    envRow.append(envF);
    box.append(envRow);

    const wpRow = el('div', 'row');
    const wpF = field('写操作关键词（逗号分隔）'); wpF.append(makeInput('js-write', server.writeToolPatterns, 'create, update, delete, add'));
    wpRow.append(wpF);
    box.append(wpRow);

    const statusLine = el('div', 'status-line');
    const failure = failures.find(([n]) => n === server.name);
    if (failure) { statusLine.classList.add('fail'); statusLine.textContent = '未连接: ' + failure[1]; }
    else { statusLine.classList.add('ok'); statusLine.textContent = '已连接'; }
    box.append(statusLine);

    const syncVisibility = () => {
      const isHttp = transF.querySelector('select').value === 'streamable-http';
      httpRow.style.display = isHttp ? '' : 'none';
      stdioRow.style.display = isHttp ? 'none' : '';
      envRow.style.display = isHttp ? 'none' : '';
      title.textContent = nameF.querySelector('input').value.trim() || '(未命名)';
    };
    transF.querySelector('select').addEventListener('change', syncVisibility);
    nameF.querySelector('input').addEventListener('input', syncVisibility);
    syncVisibility();
    remove.addEventListener('click', () => box.remove());
    return box;
  }

  function collectServers() {
    const out = [];
    for (const box of serverList.querySelectorAll('.server-editor')) {
      const name = box.querySelector('.js-name').value.trim();
      const transport = box.querySelector('.js-transport').value;
      const url = box.querySelector('.js-url').value.trim();
      const authorization = box.querySelector('.js-auth').value.trim();
      const command = box.querySelector('.js-command').value.trim();
      const args = box.querySelector('.js-args').value.trim().split(/\s+/).filter(Boolean);
      const envText = box.querySelector('.js-env').value;
      const write = box.querySelector('.js-write').value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!name) continue;
      const env = {};
      for (const line of envText.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const server = { name, transport, writeToolPatterns: write };
      if (transport === 'stdio') {
        server.command = command;
        if (args.length) server.args = args;
        if (Object.keys(env).length) server.env = env;
      } else {
        server.url = url;
        if (authorization) server.headers = { Authorization: authorization };
      }
      out.push(server);
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

  settingsBtn.addEventListener('click', () => { settingsModal.classList.remove('hidden'); loadMcpConfigUI(); });
  settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
  settingsModal.addEventListener('click', (ev) => { if (ev.target === settingsModal) settingsModal.classList.add('hidden'); });

  addServerBtn.addEventListener('click', () => serverList.append(renderServerEditor(normalizeServer({ transport: 'streamable-http' }), [])));

  saveConfigBtn.addEventListener('click', async () => {
    const servers = collectServers();
    saveConfigBtn.disabled = true;
    configResult.className = '';
    configResult.textContent = '保存并重连中…';
    try {
      const res = await fetch('/api/config/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers }),
      });
      const data = await res.json();
      if (!res.ok) {
        configResult.className = 'err';
        configResult.textContent = '保存失败: ' + (data.error || res.status);
      } else {
        configResult.className = 'ok';
        const fails = data.failures || [];
        mcpFailures = fails;
        configResult.textContent = fails.length
          ? '已保存；未连接: ' + fails.map(([n, e]) => `${n}(${e})`).join('; ')
          : '已保存，全部连接成功。';
        serverList.innerHTML = '';
        for (const s of data.servers) serverList.append(renderServerEditor(normalizeServer(s), fails));
        setStatus(fails.length ? 'warn' : 'ok', fails.length ? '部分系统未连接: ' + fails.map(([n]) => n).join(', ') : '就绪');
      }
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '保存失败: ' + err.message;
    } finally {
      saveConfigBtn.disabled = false;
    }
  });

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
  }

  init().catch((err) => setStatus('warn', '启动失败: ' + err.message));
})();
