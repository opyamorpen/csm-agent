(function () {
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const statusEl = document.getElementById('status');
  const form = document.getElementById('composer');

  let sessionId = null;
  let busy = false;
  let pendingConfirm = null; // { cardEl }
  let maxSeq = 0;

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
    let line = '调用工具 ' + name;
    if (args && Object.keys(args).length) line += ' · ' + JSON.stringify(args).slice(0, 180);
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
    const h = el('h3', null, '待确认草稿');
    const meta = el('div', 'meta', `目标系统: ${draft.target_system} ｜ 对象: ${draft.target_object} ｜ 类型: ${draft.record_type}`);
    const title = el('div', 'summary', `标题: ${draft.title || '(无)'}`);
    const summary = el('div', 'summary', `摘要: ${draft.summary || '(无)'}`);
    const pre = el('pre', null, JSON.stringify(draft.fields ?? {}, null, 2));
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
        const decided = el('div', 'decided', approve ? '已批准，正在写入…' : '已拒绝');
        actions.replaceWith(decided);
        pendingConfirm = null;
      } catch (err) {
        actions.append(el('div', 'decided', '操作失败: ' + err.message));
      }
    };
    okBtn.onclick = () => decide(true);
    noBtn.onclick = () => decide(false);
    actions.append(okBtn, noBtn);

    card.append(h, meta, title, summary, pre, actions);
    messagesEl.appendChild(card);
    scrollDown();
    return card;
  }

  function setThinking(on) {
    const existing = messagesEl.querySelector('.thinking');
    if (on && !existing) {
      const n = el('div', 'thinking', '思考中…');
      messagesEl.appendChild(n);
      scrollDown();
    } else if (!on && existing) {
      existing.remove();
    }
  }

  function handleEvent(e) {
    if (!e) return;
    switch (e.type) {
      case 'user':
        addMessage('user', e.text);
        break;
      case 'turn_start':
        busy = true;
        setThinking(true);
        break;
      case 'text':
        addMessage('assistant', e.text);
        break;
      case 'tool_call':
        addToolLine(e.name, e.arguments);
        break;
      case 'tool_result':
        if (e.name !== 'confirm_write') {
          const line = el('div', 'tool', '← ' + e.name + ': ' + (e.result || '').slice(0, 220));
          messagesEl.appendChild(line);
          scrollDown();
        }
        break;
      case 'confirm':
        pendingConfirm = { draft: e.draft };
        addConfirmCard(e.draft);
        break;
      case 'turn_end':
        busy = false;
        setThinking(false);
        sendEl.disabled = false;
        inputEl.disabled = false;
        inputEl.focus();
        break;
      case 'done':
        break;
    }
  }

  async function init() {
    const res = await fetch('/api/sessions', { method: 'POST' });
    const data = await res.json();
    sessionId = data.id;
    if (data.mcpFailures && data.mcpFailures.length) {
      setStatus('warn', '部分系统未连接: ' + data.mcpFailures.map(([n]) => n).join(', '));
    } else {
      setStatus('ok', '就绪');
    }

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
