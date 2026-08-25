(async function () {
  const params = new URLSearchParams(location.search);
  const intent = params.get('intent');
  const token = params.get('token');
  const preview = document.getElementById('todoPreview');
  const status = document.getElementById('todoStatus');
  const button = document.getElementById('createTodoBtn');

  function fail(message) {
    status.className = 'form-status error';
    status.textContent = message;
    button.disabled = true;
  }

  if (!intent || !token) return fail('待办链接无效。');
  try {
    const intentResponse = await fetch(`/api/wecom/todo-intents/${encodeURIComponent(intent)}?token=${encodeURIComponent(token)}`);
    const data = await intentResponse.json();
    if (!intentResponse.ok) throw new Error(data.error || '待办意图不可用');
    preview.innerHTML = '';
    const title = document.createElement('strong'); title.textContent = data.content;
    const meta = document.createElement('div'); meta.className = 'todo-meta';
    meta.textContent = `负责人 ${data.attendees.join('、')} · ${data.endTime ? new Date(data.endTime * 1000).toLocaleString() + ' 截止' : '未设置截止时间'}`;
    preview.append(title, meta);

    const configResponse = await fetch(`/api/wecom/js-sdk-config?url=${encodeURIComponent(location.href)}`);
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.error || 'JS-SDK 配置失败');
    const sdk = document.createElement('script');
    sdk.src = config.jsSdkUrl;
    sdk.onload = () => { button.disabled = false; status.textContent = '内容已确认，请打开原生面板完成企业微信平台确认。'; };
    sdk.onerror = () => fail('企业微信 JS-SDK 加载失败。');
    document.head.appendChild(sdk);

    async function report(todoId) {
      const response = await fetch('/api/wecom/todo-created', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent, token, todoId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '待办关联失败');
      status.className = 'form-status success';
      status.textContent = '企业微信待办已创建并关联到客户行动。';
      button.disabled = true;
    }

    button.onclick = () => {
      button.disabled = true;
      const args = { content: data.content, attendees: data.attendees, end_time: data.endTime };
      if (window.wx && typeof window.wx.agentConfig === 'function') {
        window.wx.agentConfig({
          corpid: config.corpId, agentid: config.agentId, timestamp: config.timestamp,
          nonceStr: config.nonceStr, signature: config.signature, jsApiList: ['createTodo'],
          success() {
            window.wx.invoke('createTodo', args, (result) => {
              const message = result.err_msg || result.errMsg;
              if (message === 'createTodo:ok') void report(result.todoId).catch((error) => fail(error.message));
              else if (message === 'createTodo:cancel') fail('你取消了创建，工作台待办保持不变。');
              else fail(message || '企业微信创建待办失败');
            });
          },
          fail(result) { fail(result.errMsg || '企业微信应用身份校验失败'); },
        });
      } else if (window.ww && typeof window.ww.createTodo === 'function') {
        window.ww.createTodo({
          content: data.content, attendees: data.attendees, endTime: data.endTime,
          success(result) { void report(result.todoId).catch((error) => fail(error.message)); },
          fail(result) { fail(result.errMsg || '企业微信创建待办失败'); },
        });
      } else {
        fail('请在企业微信自建应用内打开此页面。');
      }
    };
  } catch (error) {
    fail(error.message);
  }
})();
