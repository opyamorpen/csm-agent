import type { McpHub } from '../mcp/index.js';

export interface WikiSpace {
  id: string;
  name: string;
  url?: string | null;
}

export interface WikiPage {
  id: string;
  title: string;
  parentID: string;
  spaceID: string;
  canAttachChildPages: boolean;
  isArchived: boolean;
  url?: string | null;
}

/** 5 分钟缓存：空间/页面树读取走远端 MCP，避免每次打开选择器都打线上。 */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

/**
 * ONES Wiki 只读浏览（search_for_spaces / get_list_of_space_pages）。
 * 工具绑定防御式：exactTool 精确匹配 rawName，未连接或缺失时返回中文错误而不是崩掉路由。
 * ONES 返回 {result:"SUCCESS", data:{...}} 状态信封，宽容解析（信封缺失时直接找数组字段）。
 */
export class WikiService {
  private readonly spaceCache = new Map<string, CacheEntry<WikiSpace[]>>();
  private readonly pageCache = new Map<string, CacheEntry<WikiPage[]>>();

  constructor(private readonly mcp: McpHub) {}

  private tool(rawName: string): string | null {
    return this.mcp.listTools().find((tool) => tool.server === 'ones' && tool.rawName === rawName)?.publicName ?? null;
  }

  private unwrap(text: string, key: 'spaces' | 'pages'): Array<Record<string, unknown>> {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return []; }
    if (!parsed || typeof parsed !== 'object') return [];
    const record = parsed as Record<string, unknown>;
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record;
    const list = data[key];
    return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
  }

  async listSpaces(): Promise<WikiSpace[]> {
    const cached = this.spaceCache.get('all');
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const tool = this.tool('search_for_spaces');
    if (!tool) throw new Error('ONES MCP 未连接或缺少 search_for_spaces 工具，无法浏览 Wiki 页面组');
    const result = await this.mcp.call(tool, {});
    if (result.isError) throw new Error(`读取 Wiki 页面组失败: ${result.text.slice(0, 200)}`);
    const spaces = this.unwrap(result.text, 'spaces').map((item) => ({
      id: String(item.id ?? ''),
      name: String(item.name ?? '(未命名)'),
      url: typeof item.url === 'string' ? item.url : null,
    })).filter((space) => space.id);
    this.spaceCache.set('all', { at: Date.now(), value: spaces });
    return spaces;
  }

  /** 一次拉取空间内整棵页面树（含 parentID），前端本地组树、逐层展开。 */
  async listPages(spaceId: string): Promise<WikiPage[]> {
    if (!spaceId.trim()) throw new Error('缺少 spaceId');
    const cached = this.pageCache.get(spaceId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const tool = this.tool('get_list_of_space_pages');
    if (!tool) throw new Error('ONES MCP 未连接或缺少 get_list_of_space_pages 工具，无法浏览 Wiki 页面树');
    const result = await this.mcp.call(tool, { spaceId });
    if (result.isError) throw new Error(`读取 Wiki 页面树失败: ${result.text.slice(0, 200)}`);
    const pages = this.unwrap(result.text, 'pages').map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? '(未命名)'),
      parentID: String(item.parentID ?? ''),
      spaceID: String(item.spaceID ?? spaceId),
      canAttachChildPages: item.canAttachChildPages !== false,
      isArchived: item.isArchived === true,
      url: typeof item.url === 'string' ? item.url : null,
    })).filter((page) => page.id);
    this.pageCache.set(spaceId, { at: Date.now(), value: pages });
    return pages;
  }

  /** 按标题搜页（降级/快速定位用；跨空间）。 */
  async searchPages(keyword: string): Promise<WikiPage[]> {
    if (!keyword.trim()) throw new Error('缺少搜索关键词');
    const tool = this.tool('search_pages_by_title');
    if (!tool) throw new Error('ONES MCP 未连接或缺少 search_pages_by_title 工具');
    const result = await this.mcp.call(tool, { q: keyword, includeArchived: false });
    if (result.isError) throw new Error(`搜索 Wiki 页面失败: ${result.text.slice(0, 200)}`);
    return this.unwrap(result.text, 'pages').map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? '(未命名)'),
      parentID: String(item.parentID ?? ''),
      spaceID: String(item.spaceID ?? ''),
      canAttachChildPages: item.canAttachChildPages !== false,
      isArchived: item.isArchived === true,
      url: typeof item.url === 'string' ? item.url : null,
    })).filter((page) => page.id);
  }
}
