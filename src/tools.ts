/** ctx.tools 注册：news_* 前缀防撞名。值即契约 + render 投影。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { FeedSource, FetchCycleResult } from './core/types.js'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const err = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 插件对外操作的统一门面（index.ts 注入，避免 tools.ts 直接绑 store） */
export interface NewsService {
  listSources(): FeedSource[]
  addSource(opts: { url: string; title?: string; category?: string }): Promise<FeedSource>
  setEnabled(urlOrId: string, enabled: boolean): Promise<void>
  setSummarize(urlOrId: string, summarize: boolean): Promise<void>
  removeSource(urlOrId: string): Promise<boolean>
  importOpml(opmlText: string): Promise<{ added: number; duplicated: number; skipped: number; details?: Array<{ url: string; action: string; reason?: string }> }>
  exportOpml(): Promise<string>
  runFetch(force?: boolean, onlyFailed?: boolean, filter?: { source?: string; category?: string }): Promise<FetchCycleResult>
  /** 抓取进度（{running,done,total}），供 UI 轮询 */
  fetchProgress?(): Promise<{ running: boolean; done: number; total: number }>
  /** 中止进行中的抓取 */
  cancelFetch?(): Promise<unknown>
  /** 翻译条目（标题+摘要→中文），结果写 item.state.translation */
  translateItem?(id: string): Promise<{ ok: boolean; translation?: string; error?: string }>
  /** 日报生成进度（{running,done,total}），供 UI 轮询 */
  digestProgress?(): Promise<{ running: boolean; done: number; total: number }>
  /** 连通性测试：真实 fetcher 路径抓 url，返回 status/body 片段（验证出口/代理） */
  testFetch?(url: string, proxy?: string | boolean): Promise<{ status?: number; body?: string; error?: string }>
  status(): { sources: number; enabled: number; items: number; lastFetchAt: string; lastDigestDay: string; failures: Array<{ name: string; error: string }> }
  tune(text: string): Promise<{ ok: boolean; actions: string[]; error?: string }>
  getDigest(day?: string): Promise<{ ok: boolean; day: string; markdown?: string; error?: string }>
  regenDigest(force: boolean): Promise<{ ok: boolean; items?: number; degraded?: boolean; error?: string }>
  searchItems(q: string, limit?: number): Array<{ id: string; title: string; link: string; topic: string; fetchedAt: string; digestedDay: string }>
  feedback(id: string, action: string): Promise<{ ok: boolean; learned?: string[]; error?: string }>
  retrySource(urlOrId: string): Promise<boolean>
  /** 编辑源属性（title/category/enabled/summarize/proxy/cooldownHours） */
  updateSource(urlOrId: string, patch: Record<string, unknown>): Promise<unknown>
  /** 中止进行中的日报生成（LLM 流逐条失败→降级收尾） */
  stopDigest?(): Promise<unknown>
}

const sourceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    category: { type: 'string' },
    enabled: { type: 'boolean' },
    builtin: { type: 'boolean' },
  },
  additionalProperties: false,
} as const

const pick = (s: FeedSource) => ({ id: s.id, url: s.url, title: s.title, category: s.category, enabled: s.enabled, builtin: s.builtin })

// ---------------------------------------------------------------- tools

function newsSources(svc: NewsService) {
  return defineTool({
    name: 'news_sources',
    description: 'List effective RSS sources (builtin catalog ∪ user sources), with enabled state and last error if any.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, count: { type: 'integer' }, sources: { type: 'array', items: sourceSchema } },
        additionalProperties: false,
      },
      render: (_a, v) => {
        const list = (v.sources || []) as Array<{ title?: string; enabled?: boolean; category?: string }>
        return text(`Sources (${v.count}):\n` + list.map((s) => `- [${s.enabled ? 'on' : 'off'}] ${s.title} (${s.category})`).join('\n'))
      },
    },
    execute: async () => ({ ok: true, count: svc.listSources().length, sources: svc.listSources().map(pick) }),
  })
}

function newsAdd(svc: NewsService) {
  return defineTool({
    name: 'news_add',
    description: 'Subscribe to an RSS/Atom feed URL. The feed is fetched and validated before saving; invalid feeds are rejected.',
    parameters: {
      url: { type: 'string', required: true, description: 'Feed URL (public http/https)' },
      title: { type: 'string', description: 'Optional label' },
      category: { type: 'string', description: 'Optional category' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, source: sourceSchema },
        additionalProperties: false,
      },
      render: (_a, v) => v.ok
        ? text(`Subscribed: ${v.source?.title} (${v.source?.url})`)
        : text(`Add failed: ${v.error}`),
    },
    execute: async (args: { url: string; title?: string; category?: string }) => {
      try {
        return { ok: true, source: pick(await svc.addSource(args)) }
      } catch (e) {
        return { ok: false, error: err(e) }
      }
    },
  })
}

function newsRemove(svc: NewsService) {
  return defineTool({
    name: 'news_remove',
    description: 'Remove a source by id/url (builtin sources are disabled via override, not deleted).',
    parameters: {
      url: { type: 'string', required: true, description: 'Source id or feed URL' },
      disable_only: { type: 'boolean', description: 'true = 仅停用（推荐用于内置源）' },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } }, additionalProperties: false },
      render: (_a, v) => text(v.ok ? 'Done.' : `Remove failed: ${v.error}`),
    },
    execute: async (args: { url: string; disable_only?: boolean }) => {
      try {
        if (args.disable_only) await svc.setEnabled(args.url, false)
        else if (!await svc.removeSource(args.url)) return { ok: false, error: 'not found (内置源请用 disable_only)' }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: err(e) }
      }
    },
  })
}

function newsFetch(svc: NewsService) {
  return defineTool({
    name: 'news_fetch',
    description: 'Run a fetch cycle over all effective sources now. Returns per-source stats.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, added: { type: 'integer' }, fetched: { type: 'integer' }, errors: { type: 'integer' } },
        additionalProperties: false,
      },
      render: (_a, v) => text(`Fetch done: +${v.added} items / ${v.fetched} fetched / ${v.errors} errors`),
    },
    execute: async () => {
      const r = await svc.runFetch()
      return { ok: true, added: r.totalAdded, fetched: r.totalFetched, errors: r.errors }
    },
  })
}

function newsStatus(svc: NewsService) {
  return defineTool({
    name: 'news_status',
    description: 'Report fetch/digest status: source/item counts, last run times, failing sources.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' }, sources: { type: 'integer' }, enabled: { type: 'integer' },
          items: { type: 'integer' }, lastFetchAt: { type: 'string' }, lastDigestDay: { type: 'string' },
          failures: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, error: { type: 'string' } }, additionalProperties: false },
          },
        },
        additionalProperties: false,
      },
      render: (_a, v) => text(
        `Status: ${v.enabled}/${v.sources} sources on, ${v.items} items\n` +
        `lastFetch=${v.lastFetchAt || 'never'} lastDigestDay=${v.lastDigestDay || 'never'}\n` +
        ((v.failures?.length ? 'Failing:\n' + v.failures.map((f) => `- ${f.name}: ${f.error}`).join('\n') : 'All sources healthy')),
      ),
    },
    execute: async () => ({ ok: true, ...svc.status() }),
  })
}

function newsImport(svc: NewsService) {
  return defineTool({
    name: 'news_import',
    description: 'Import OPML subscription text. Dedups against builtin catalog and existing sources; returns added/duplicated/skipped counts. Sources are not fetched during import — health is handled by the fetch cycle.',
    parameters: {
      opml: { type: 'string', required: true, description: 'OPML 2.0 document text' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, added: { type: 'integer' }, duplicated: { type: 'integer' }, skipped: { type: 'integer' } },
        additionalProperties: false,
      },
      render: (_a, v) => v.ok
        ? text(`Imported: +${v.added} added, ${v.duplicated} duplicated, ${v.skipped} skipped`)
        : text(`Import failed: ${v.error}`),
    },
    execute: async (args: { opml: string }) => {
      try {
        return { ok: true, ...(await svc.importOpml(args.opml)) }
      } catch (e) {
        return { ok: false, error: err(e) }
      }
    },
  })
}

function newsExport(svc: NewsService) {
  return defineTool({
    name: 'news_export',
    description: 'Export enabled sources as OPML 2.0 text (grouped by category).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, opml: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_a, v) => text(v.ok ? (v.opml ?? '') : `Export failed: ${v.error}`),
    },
    execute: async () => {
      try {
        return { ok: true, opml: await svc.exportOpml() }
      } catch (e) {
        return { ok: false, error: err(e) }
      }
    },
  })
}

function newsTune(svc: NewsService) {
  return defineTool({
    name: 'news_tune',
    description: 'Tune RSS recommendation preferences via natural language, e.g. "多推 AI、少推币圈、屏蔽裁员" or "重置". Applies immediately to the next digest.',
    parameters: {
      text: { type: 'string', required: true, description: 'Tuning instruction in natural language' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      render: (_a, v) => text(v.ok ? `Tuning applied: ${(v.actions ?? []).join('; ')}` : `Tune failed: ${v.error}`),
    },
    execute: async (args) => svc.tune(String(args.text ?? '')),
  })
}

const strArr = { type: 'array', items: { type: 'string' } } as const

function newsDigest(svc: NewsService) {
  return defineTool({
    name: 'news_digest',
    description: 'Read the daily digest markdown. Pass day=YYYY-MM-DD for a specific day; default today.',
    parameters: { day: { type: 'string', description: 'YYYY-MM-DD; default today' } },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, day: { type: 'string' }, markdown: { type: 'string' }, error: { type: 'string' } }, additionalProperties: false },
      render: (_a, v) => text(v.ok ? (v.markdown ?? '(empty)') : `digest: ${v.error}`),
    },
    execute: async (args: { day?: string }) => svc.getDigest(args.day),
  })
}

function newsRegen(svc: NewsService) {
  return defineTool({
    name: 'news_regen',
    description: 'Regenerate today\'s digest. force=true recomputes including already-digested items.',
    parameters: { force: { type: 'boolean', description: 'Include already-digested items (default false)' } },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, items: { type: 'number' }, degraded: { type: 'boolean' }, error: { type: 'string' } }, additionalProperties: false },
      render: (_a, v) => text(v.ok ? `regenerated: ${v.items} items${v.degraded ? ' (degraded)' : ''}` : `regen failed: ${v.error}`),
    },
    execute: async (args: { force?: boolean }) => svc.regenDigest(!!args.force),
  })
}

function newsSearch(svc: NewsService) {
  return defineTool({
    name: 'news_search',
    description: 'Search collected news items by keyword over title+summary.',
    parameters: {
      q: { type: 'string', required: true, description: 'keyword' },
      limit: { type: 'number', description: 'max results (default 20)' },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'object', additionalProperties: true } } }, additionalProperties: false },
      render: (_a, v) => text((v.items ?? []).map((i: { title?: string; topic?: string }) => `• ${i.title}（${i.topic}）`).join('\n') || 'no match'),
    },
    execute: async (args: { q: string; limit?: number }) => ({ ok: true, items: svc.searchItems(args.q, args.limit) }),
  })
}

function newsFeedback(svc: NewsService) {
  return defineTool({
    name: 'news_feedback',
    description: 'Mark an item like/dislike/read to tune future digests.',
    parameters: {
      id: { type: 'string', required: true, description: 'item id' },
      action: { type: 'string', required: true, description: 'like|dislike|unlike|read|unread|hide|unhide' },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' }, learned: strArr }, additionalProperties: false },
      render: (_a, v) => text(v.ok ? `recorded${v.learned?.length ? `; learned: ${v.learned.join(', ')}` : ''}` : `feedback failed: ${v.error}`),
    },
    execute: async (args: { id: string; action: string }) => svc.feedback(args.id, args.action),
  })
}

/** 注册全部 news_* 工具；返回 disposer。 */
export function registerTools(ctx: Context, svc: NewsService): () => void {
  const ds = [
    ctx.tools.register(newsSources(svc)),
    ctx.tools.register(newsAdd(svc)),
    ctx.tools.register(newsRemove(svc)),
    ctx.tools.register(newsFetch(svc)),
    ctx.tools.register(newsStatus(svc)),
    ctx.tools.register(newsImport(svc)),
    ctx.tools.register(newsExport(svc)),
    ctx.tools.register(newsTune(svc)),
    ctx.tools.register(newsDigest(svc)),
    ctx.tools.register(newsRegen(svc)),
    ctx.tools.register(newsSearch(svc)),
    ctx.tools.register(newsFeedback(svc)),
  ]
  return () => ds.forEach((d) => d())
}
