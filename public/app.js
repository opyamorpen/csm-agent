(function () {
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const statusEl = document.getElementById('status');
  const form = document.getElementById('composer');

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsClose = document.getElementById('settingsClose');
  const settingsModal = document.getElementById('settingsModal');
  const serverList = document.getElementById('serverList');
  const addServerBtn = document.getElementById('addServer');
  const saveConfigBtn = document.getElementById('saveConfig');
  const configResult = document.getElementById('configResult');

  let sessionId = null;
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

  function addMessage(cls, text) {
    const n = el('div', 'msg ' + cls, text);
    messagesEl.appendChild(n);
    scrollDown();
    return n;
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
      case 'confirm': addConfirmCard(e.draft); break;
      case 'turn_end':
        busy = false;
        setThinking(false);
        sendEl.disabled = false;
        inputEl.disabled = false;
        inputEl.focus();
        break;
    }
  }

  // ── MCP 配置面板 ────────────────────────────────────────────────

  function field(labelText) {
    const wrap = el('div', 'field');
    wrap.append(el('label', null, labelText));
    return wrap;
  }

  function makeInput(cls, value, placeholder) {
    const i = document.createElement('input');
    i.className = cls;
    i.value = value ?? '';
    if (placeholder) i.placeholder = placeholder;
    return i;
  }

  function makeSelect(cls, options, value) {
    const s = document.createElement('select');
    s.className = cls;
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      s.append(opt);
    }
    s.value = value;
    return s;
  }

  function makeTextarea(cls, value, placeholder) {
    const t = document.createElement('textarea');
    t.className = cls;
    t.value = value ?? '';
    if (placeholder) t.placeholder = placeholder;
    return t;
  }

  // Normalize a stored server into editor-friendly plain values.
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

    // http fields
    const httpRow = el('div', 'row js-http');
    const urlF = field('URL'); urlF.append(makeInput('js-url', server.url, 'https://.../mcp'));
    const authF = field('Authorization（可用 ${ENV_VAR}）'); authF.append(makeInput('js-auth', server.authorization, 'Bearer ${CRM_MCP_TOKEN}'));
    httpRow.append(urlF, authF);
    box.append(httpRow);

    // stdio fields
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
    const wpF = field('写操作关键词（逗号分隔，用于确认闸门）'); wpF.append(makeInput('js-write', server.writeToolPatterns, 'create, update, delete, add'));
    wpRow.append(wpF);
    box.append(wpRow);

    // connection status
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
      for (const s of data.servers) {
        serverList.append(renderServerEditor(normalizeServer(s), mcpFailures));
      }
      configResult.textContent = '';
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '加载失败: ' + err.message;
    }
  }

  settingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    loadMcpConfigUI();
  });
  settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
  settingsModal.addEventListener('click', (ev) => { if (ev.target === settingsModal) settingsModal.classList.add('hidden'); });

  addServerBtn.addEventListener('click', () => {
    serverList.append(renderServerEditor(normalizeServer({ transport: 'streamable-http' }), []));
  });

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
        configResult.textContent = fails.length
          ? '已保存；未连接: ' + fails.map(([n, e]) => `${n}(${e})`).join('; ')
          : '已保存，全部连接成功。';
        // refresh editors' status
        serverList.innerHTML = '';
        for (const s of data.servers) serverList.append(renderServerEditor(normalizeServer(s), fails));
        refreshGlobalStatus();
      }
    } catch (err) {
      configResult.className = 'err';
      configResult.textContent = '保存失败: ' + err.message;
    } finally {
      saveConfigBtn.disabled = false;
    }
  });

  function refreshGlobalStatus() {
    const fails = mcpFailures;
    setStatus(fails.length ? 'warn' : 'ok', fails.length ? '部分系统未连接: ' + fails.map(([n]) => n).join(', ') : '就绪');
  }

  // ── chat bootstrap ─────────────────────────────────────────────

  async function init() {
    const res = await fetch('/api/sessions', { method: 'POST' });
    const data = await res.json();
    sessionId = data.id;
    mcpFailures = data.mcpFailures || [];
    refreshGlobalStatus();

    const es = new EventSource(`/api/sessions/${sessionId}/events`);
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

  init().catch((err) => setStatus('warn', '启动失败: ' + err.message));
})();
