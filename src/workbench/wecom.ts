import { createHash, randomBytes } from 'node:crypto';
import { WorkbenchDatabase } from './database.js';

export interface WecomConfig {
  corpId?: string;
  agentId?: string;
  secret?: string;
  h5BaseUrl?: string;
  jsSdkUrl: string;
}

export function loadWecomConfig(): WecomConfig {
  return {
    corpId: process.env.WECOM_CORP_ID,
    agentId: process.env.WECOM_AGENT_ID,
    secret: process.env.WECOM_SECRET,
    h5BaseUrl: process.env.WECOM_H5_BASE_URL?.replace(/\/$/, ''),
    jsSdkUrl: process.env.WECOM_JS_SDK_URL ?? 'https://res.wx.qq.com/open/js/jweixin-1.2.0.js',
  };
}

export function missingWecomConfig(config: WecomConfig): string[] {
  return [
    ['WECOM_CORP_ID', config.corpId],
    ['WECOM_AGENT_ID', config.agentId],
    ['WECOM_SECRET', config.secret],
    ['WECOM_H5_BASE_URL', config.h5BaseUrl],
  ].filter(([, value]) => !value).map(([name]) => name!);
}

interface CacheValue {
  value: string;
  expiresAt: number;
}

export class WecomClient {
  private accessToken?: CacheValue;
  private jsapiTicket?: CacheValue;

  constructor(readonly config = loadWecomConfig()) {}

  status(): { configured: boolean; missing: string[]; h5BaseUrl?: string; jsSdkUrl: string } {
    const missing = missingWecomConfig(this.config);
    return { configured: missing.length === 0, missing, h5BaseUrl: this.config.h5BaseUrl, jsSdkUrl: this.config.jsSdkUrl };
  }

  private requireConfig(): Required<Pick<WecomConfig, 'corpId' | 'agentId' | 'secret' | 'h5BaseUrl'>> {
    const missing = missingWecomConfig(this.config);
    if (missing.length) throw new Error(`企业微信未配置: ${missing.join(', ')}`);
    return this.config as Required<Pick<WecomConfig, 'corpId' | 'agentId' | 'secret' | 'h5BaseUrl'>>;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) return this.accessToken.value;
    const config = this.requireConfig();
    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
    url.searchParams.set('corpid', config.corpId);
    url.searchParams.set('corpsecret', config.secret);
    const response = await fetch(url);
    const body = await response.json() as { errcode: number; errmsg: string; access_token?: string; expires_in?: number };
    if (!response.ok || body.errcode !== 0 || !body.access_token) throw new Error(`获取企业微信 access_token 失败: ${body.errmsg || response.status}`);
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 7200) - 300) * 1000 };
    return body.access_token;
  }

  private async ticket(): Promise<string> {
    if (this.jsapiTicket && this.jsapiTicket.expiresAt > Date.now()) return this.jsapiTicket.value;
    const token = await this.token();
    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/ticket/get');
    url.searchParams.set('access_token', token);
    url.searchParams.set('type', 'agent_config');
    const response = await fetch(url);
    const body = await response.json() as { errcode: number; errmsg: string; ticket?: string; expires_in?: number };
    if (!response.ok || body.errcode !== 0 || !body.ticket) throw new Error(`获取企业微信 JS-SDK ticket 失败: ${body.errmsg || response.status}`);
    this.jsapiTicket = { value: body.ticket, expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 7200) - 300) * 1000 };
    return body.ticket;
  }

  async jsSdkConfig(pageUrl: string): Promise<Record<string, unknown>> {
    const config = this.requireConfig();
    const expectedOrigin = new URL(config.h5BaseUrl).origin;
    const actual = new URL(pageUrl);
    if (actual.origin !== expectedOrigin) throw new Error('JS-SDK 签名 URL 不在可信域名内');
    actual.hash = '';
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = randomBytes(16).toString('hex');
    const ticket = await this.ticket();
    const plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${actual.toString()}`;
    const signature = createHash('sha1').update(plain).digest('hex');
    return { corpId: config.corpId, agentId: Number(config.agentId), timestamp, nonceStr, signature, jsSdkUrl: this.config.jsSdkUrl };
  }

  async getTodo(todoId: string): Promise<{ status: number; attendees: Array<{ userid: string; status: number }>; [key: string]: unknown }> {
    const token = await this.token();
    const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/todo/get?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ todo_id: todoId }),
    });
    const body = await response.json() as any;
    if (!response.ok || body.errcode !== 0) throw new Error(`读取企业微信待办失败: ${body.errmsg || response.status}`);
    return body;
  }

  async updateTodo(todoId: string, status: 0 | 1): Promise<void> {
    const token = await this.token();
    const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/todo/update?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ todo_id: todoId, status }),
    });
    const body = await response.json() as any;
    if (!response.ok || body.errcode !== 0) throw new Error(`更新企业微信待办失败: ${body.errmsg || response.status}`);
  }
}

export class WecomTodoService {
  constructor(private readonly db: WorkbenchDatabase, readonly client = new WecomClient()) {}

  createIntent(actionItemId: string): { id: string; token: string; expiresAt: string; url: string } {
    const action = this.db.getAction(actionItemId);
    if (!action) throw new Error('action item not found');
    if (!['accepted', 'in_progress'].includes(action.status)) throw new Error('请先在工作台接受并确认该待办');
    if (!action.ownerWecomUserid) throw new Error('缺少负责人的企业微信 userid');
    const status = this.client.status();
    if (!status.configured) throw new Error(`企业微信未配置: ${status.missing.join(', ')}`);
    const intent = this.db.createTodoIntent(actionItemId);
    const url = new URL(`${status.h5BaseUrl}/wecom-todo.html`);
    url.searchParams.set('intent', intent.id);
    url.searchParams.set('token', intent.token);
    this.db.audit('csm', 'create_wecom_todo_intent', 'action_item', actionItemId, { intentId: intent.id, expiresAt: intent.expiresAt });
    return { ...intent, url: url.toString() };
  }

  getIntent(id: string, token: string): Record<string, unknown> | null {
    const intent = this.db.peekTodoIntent(id, token);
    if (!intent) return null;
    const action = this.db.getAction(intent.actionItemId);
    if (!action) return null;
    return {
      actionItemId: action.id,
      content: action.title,
      attendees: [action.ownerWecomUserid].filter(Boolean),
      endTime: action.dueAt ? Math.floor(new Date(action.dueAt).getTime() / 1000) : undefined,
      customerId: action.customerId,
      evidenceRefs: action.evidenceRefs,
    };
  }

  todoCreated(id: string, token: string, todoId: string, creatorUserid?: string): void {
    if (!todoId) throw new Error('todoId is required');
    const intent = this.db.consumeTodoIntent(id, token);
    if (!intent) throw new Error('待办意图无效、已使用或已过期');
    const action = this.db.getAction(intent.actionItemId);
    if (!action) throw new Error('action item not found');
    this.db.linkWecomTodo(action.id, todoId, creatorUserid, [action.ownerWecomUserid].filter((item): item is string => !!item));
    this.db.updateAction(action.id, { status: 'in_progress' });
    this.db.audit('wecom', 'link_todo', 'action_item', action.id, { todoId, creatorUserid });
  }

  async complete(actionItemId: string, outcome?: string): Promise<void> {
    const action = this.db.getAction(actionItemId);
    if (!action) throw new Error('action item not found');
    const link = this.db.getWecomTodoLink(actionItemId);
    if (link) await this.client.updateTodo(String(link.todo_id), 0);
    this.db.updateAction(actionItemId, { status: 'completed', outcome: outcome ?? 'CSM 在工作台确认完成' });
    if (link) this.db.updateWecomTodoStatus(actionItemId, 0);
    this.db.audit('csm', 'complete_action', 'action_item', actionItemId, { todoId: link?.todo_id, outcome });
  }

  async syncActive(): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;
    if (!this.client.status().configured) return { synced, failed };
    for (const link of this.db.listActiveWecomTodoLinks()) {
      try {
        const todo = await this.client.getTodo(String(link.todo_id));
        this.db.updateWecomTodoStatus(String(link.action_item_id), todo.status, todo.attendees ?? []);
        synced++;
      } catch {
        failed++;
      }
    }
    return { synced, failed };
  }
}

export function scheduleWecomSync(service: WecomTodoService): () => void {
  const timer = setInterval(() => void service.syncActive(), 15 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
